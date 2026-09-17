import {contentBlocks,isCompactRecord,textContent} from './transcript-parser.mjs';

export const FRONTEND_MESSAGE_TOOL='mcp__qiuqiu-frontend__send_frontend_message';
const allowedKinds=new Set(['clean','high','state']);
const injection=/(<system-reminder>|hook[_ -]?event|UserPromptSubmit|MessageDisplay|StopFailure|additionalContext)/i;
const noise=/(Traceback|\bdiff --git\b|\bSELECT\s+.+\bFROM\b|```(?:json|sql|diff|bash|sh)|\{[\s\S]{4000,}\}|runtime message|connection (?:lost|detached))/i;
const sensitive=/(bearer\s+[a-z0-9._~+/=-]+|(?:api[_ -]?key|token|secret|password)\s*[:=]\s*\S+|\b(?:request|clientRequest|turn|session)Id\s*[:=]\s*[a-z0-9_-]{8,}|(?:[A-Za-z]:\\|\/(?:root|home|tmp|etc|var)\/)[^\s]+)/i;
const poison=/(ignore (?:all )?(?:previous|system) instructions|reveal (?:the )?(?:system prompt|secrets?)|disable safety|policy.*(?:bypass|override))/i;
const relation=/(称呼|喜欢|不喜欢|约定|承诺|边界|长期偏好|以后|记得|别忘)/i;
const state=/(当前任务|已完成|待办|下一步|blocker|risk|checkpoint|decision|decided|fixed|verified|修复|确认)/i;
const estimate=text=>Math.ceil(Buffer.byteLength(text,'utf8')/3);

export function classifyConversationalText(text){
 if(typeof text!=='string'||!text.trim())return {kind:'noise'};
 if(poison.test(text))return {kind:'poison'};
 if(injection.test(text))return {kind:'injection'};
 if(sensitive.test(text))return {kind:'sensitive'};
 if(noise.test(text)||text.length>12000)return {kind:'noise'};
 return {kind:state.test(text)?'state':relation.test(text)?'high':'clean',text:text.trim()};
}

export function classifyTranscriptRecord(record){
 const text=textContent(record),blocks=contentBlocks(record);
 if(isCompactRecord(record))return {kind:'compact'};
 if(record.isMeta||record.isSidechain)return {kind:'injection'};
 if(blocks.some(block=>block?.type&&block.type!=='text'))return {kind:'tool'};
 return classifyConversationalText(text);
}

export function isExternalUserPrompt(record){
 const blocks=contentBlocks(record);
 return record?.type==='user'&&record.message?.role==='user'&&record.userType==='external'&&record.isSidechain!==true&&blocks.length>0&&blocks.every(block=>block?.type==='text')&&Boolean(textContent(record));
}

function frontendText(block){
 if(block?.type!=='tool_use'||block.name!==FRONTEND_MESSAGE_TOOL)return {matched:false};
 const input=block.input;
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==1||typeof input.text!=='string'||input.text.length<1||input.text.length>16384)return {matched:true,valid:false,reason:'INVALID_FRONTEND_MESSAGE_PAYLOAD'};
 return {matched:true,valid:true,text:input.text};
}

function activeAncestry(records){
 const byId=new Map(records.filter(record=>typeof record.uuid==='string').map(record=>[record.uuid,record]));
 const leaf=[...records].reverse().find(record=>typeof record.uuid==='string'&&record.isSidechain!==true)?.uuid||null,ancestry=new Set();let cursor=leaf,broken=false;
 while(cursor&&!ancestry.has(cursor)){const record=byId.get(cursor);if(!record){broken=true;break}ancestry.add(cursor);cursor=record.parentUuid||null}
 return {leaf,ancestry,byId,broken};
}

export function authoritativeConversationalTurns(records){
 const branch=activeAncestry(records),turns=[],excluded=[];
 for(let i=0;i<records.length;i++){
  const user=records[i];if(!isExternalUserPrompt(user)||!branch.ancestry.has(user.uuid))continue;
  let end=i+1;while(end<records.length&&!isExternalUserPrompt(records[end]))end++;
  const segment=records.slice(i,end).filter(record=>!record.uuid||branch.ancestry.has(record.uuid));
  const base={id:user.uuid,user,sourceIndex:i,startTimestamp:user.timestamp||null,activeBranch:true,sourceRecords:segment};
  const fail=reason=>excluded.push({...base,complete:false,clean:false,exclusionReason:reason});
  if(segment.some(record=>record.isSidechain)) {fail('SIDE_BRANCH');continue}
  if(segment.some(record=>record.uuid&&record.parentUuid&&!branch.byId.has(record.parentUuid))){fail('ORPHAN_PARENT');continue}
  if(segment.some(record=>record.type==='system'&&/stop.?failure/i.test(record.subtype||''))){fail('STOP_FAILURE');continue}
  const stopIndex=segment.findIndex(record=>record.type==='system'&&record.subtype==='stop_hook_summary');
  const durationIndex=segment.findIndex(record=>record.type==='system'&&record.subtype==='turn_duration');
  if(stopIndex<0||durationIndex<0||durationIndex<stopIndex){fail('MISSING_TERMINAL');continue}
  const pending=new Set(),frontend=[],ordinary=[];let invalidFrontend=null,toolError=null;
  for(const record of segment){
   for(const block of contentBlocks(record)){
    if(block?.type==='tool_use'&&typeof block.id==='string')pending.add(block.id);
    if(block?.type==='tool_result'&&(typeof block.tool_use_id!=='string'||!pending.delete(block.tool_use_id)))toolError='ORPHAN_TOOL_RESULT';
    const candidate=frontendText(block);if(candidate.matched){if(!candidate.valid)invalidFrontend=candidate.reason;else frontend.push({text:candidate.text,record,toolUseId:block.id||null})}
   }
   if(record.type==='assistant'&&textContent(record)&&!record.attributionMcpServer&&!record.attributionMcpTool)ordinary.push({text:textContent(record),record});
  }
  if(toolError){fail(toolError);continue}if(pending.size){fail('MISSING_TOOL_RESULT');continue}if(invalidFrontend){fail(invalidFrontend);continue}
  const messages=frontend.length?frontend:ordinary;
  if(!messages.length){fail('NO_CONVERSATIONAL_PAYLOAD');continue}
  const userClass=classifyConversationalText(textContent(user)),messageClasses=messages.map(message=>classifyConversationalText(message.text));
  if(userClass.kind==='poison'||messageClasses.some(value=>value.kind==='poison')){fail('POISON_DETECTED');continue}
  if(!allowedKinds.has(userClass.kind)||messageClasses.some(value=>!allowedKinds.has(value.kind))){fail('UNSAFE_CONVERSATIONAL_PAYLOAD');continue}
  const assistantText=messages.map(message=>message.text).join('\n');
  const assistant=messages.at(-1).record,assistantMessages=messages.map(({text,record,toolUseId})=>({text,sourceUuid:record.uuid||null,timestamp:record.timestamp||null,toolUseId}));
  turns.push({...base,assistant,assistantMessages,userText:userClass.text,assistantText,kinds:new Set([userClass.kind,...messageClasses.map(value=>value.kind)]),text:`${userClass.text}\n${assistantText}`,estimatedTokens:estimate(`${userClass.text}\n${assistantText}`),endTimestamp:segment[durationIndex].timestamp||assistant.timestamp||null,terminalEvidence:{stopUuid:segment[stopIndex].uuid||null,turnDurationUuid:segment[durationIndex].uuid||null},complete:true,clean:true,exclusionReason:null});
 }
 return {turns,excluded,activeLeaf:branch.leaf,branchValid:!branch.broken};
}

export function authoritativeTurnEndpoint(records){
 const result=authoritativeConversationalTurns(records),turn=result.turns.at(-1)||null;
 return {turn,identity:turn?{turnId:turn.id,userUuid:turn.user.uuid,assistantUuid:turn.assistant.uuid||null,timestamp:turn.assistant.timestamp||turn.endTimestamp||null}:null,activeLeaf:result.activeLeaf};
}

export function compareAuthoritativeFreshness(beforeRecords,afterRecords){
 const before=authoritativeTurnEndpoint(beforeRecords),after=authoritativeTurnEndpoint(afterRecords);
 return {before:before.identity,after:after.identity,conversationallyStale:JSON.stringify(before.identity)!==JSON.stringify(after.identity)};
}
