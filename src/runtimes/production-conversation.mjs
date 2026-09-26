import {FRONTEND_MESSAGE_TOOL,isExternalUserPrompt} from './rsc/authoritative-turns.mjs';
import {contentBlocks,textContent} from './rsc/transcript-parser.mjs';

const DEFAULT_MAX_BYTES=1024*1024;
const imageContext=/^<frontend_image_context>[\s\S]*?<\/frontend_image_context>(?:\r?\n){0,2}/;

function activeAncestry(records){
  const byId=new Map(records.filter(record=>typeof record.uuid==='string').map(record=>[record.uuid,record])),ancestry=new Set();let cursor=[...records].reverse().find(record=>typeof record.uuid==='string'&&record.isSidechain!==true)?.uuid||null;
  while(cursor&&!ancestry.has(cursor)){const record=byId.get(cursor);if(!record)break;ancestry.add(cursor);cursor=record.parentUuid||null}
  return {byId,ancestry};
}

function replayableTurns(records){
  const branch=activeAncestry(records),turns=[];
  for(let index=0;index<records.length;index++){
    const user=records[index];if(!isExternalUserPrompt(user)||!branch.ancestry.has(user.uuid))continue;
    let end=index+1;while(end<records.length&&!isExternalUserPrompt(records[end]))end++;
    const segment=records.slice(index,end).filter(record=>!record.uuid||branch.ancestry.has(record.uuid));
    if(segment.some(record=>record.isSidechain||record.uuid&&record.parentUuid&&!branch.byId.has(record.parentUuid)))continue;
    if(segment.some(record=>record.type==='system'&&/stop.?failure/i.test(record.subtype||'')))continue;
    const stopIndex=segment.findIndex(record=>record.type==='system'&&record.subtype==='stop_hook_summary'),durationIndex=segment.findIndex(record=>record.type==='system'&&record.subtype==='turn_duration');
    if(stopIndex<0||durationIndex<stopIndex)continue;
    const pending=new Set(),frontend=[],ordinary=[];let invalid=false;
    for(const record of segment){
      for(const block of contentBlocks(record)){
        if(block?.type==='tool_use'&&typeof block.id==='string')pending.add(block.id);
        if(block?.type==='tool_result'&&(typeof block.tool_use_id!=='string'||!pending.delete(block.tool_use_id)))invalid=true;
        if(block?.type==='tool_use'&&block.name===FRONTEND_MESSAGE_TOOL){const input=block.input;if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==1||typeof input.text!=='string'||!input.text.trim()||input.text.length>16384)invalid=true;else frontend.push({text:input.text,timestamp:record.timestamp||null})}
      }
      if(record.type==='assistant'&&textContent(record)&&!record.attributionMcpServer&&!record.attributionMcpTool)ordinary.push({text:textContent(record),timestamp:record.timestamp||null});
    }
    if(invalid||pending.size)continue;const assistant=frontend.length?frontend:ordinary,userText=textContent(user).replace(imageContext,'').trim();if(!userText||!assistant.length)continue;
    turns.push({userText,startTimestamp:user.timestamp||null,endTimestamp:segment[durationIndex].timestamp||null,assistantMessages:assistant});
  }
  return turns;
}

export function productionConversationSnapshot(records,{maxBytes=DEFAULT_MAX_BYTES}={}){
  const turns=replayableTurns(records),selected=[];
  let bytes=0;
  for(let index=turns.length-1;index>=0;index--){
    const turn=turns[index],messages=[
      {role:'user',content:turn.userText,createdAt:turn.startTimestamp||turn.endTimestamp||null},
      ...turn.assistantMessages.map(message=>({role:'assistant',content:message.text,createdAt:message.timestamp||turn.endTimestamp||null}))
    ];
    const size=Buffer.byteLength(JSON.stringify(messages),'utf8');
    if(bytes+size>maxBytes){if(selected.length)break;return {available:false,messages:[],truncated:true}}
    selected.push(messages);bytes+=size;
  }
  const messages=selected.reverse().flat();
  return {available:messages.length>0,messages,truncated:selected.length<turns.length};
}
