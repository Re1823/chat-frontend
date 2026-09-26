import {createHash} from 'node:crypto';

const canonical=value=>String(value??'').replace(/\r\n?/g,'\n').trim();
export const promptDigest=value=>createHash('sha256').update(canonical(value)).digest('hex');

export function negativeAcceptanceDecision({windowElapsed=false,writeInProgress=false,idleStableCount=0}={}){
  return windowElapsed&&!writeInProgress&&idleStableCount>=3
    ?{state:'delivery_failed',code:'DELIVERY_NOT_ACCEPTED'}
    :{state:'waiting',code:null};
}

export function isIdleScreenSemantic(semantic={}){
  return semantic.kind==='READY'||(semantic.kind==='UNKNOWN'&&semantic.interactive!==true)
}

function completePrefix(buffer){
  const bytes=Buffer.isBuffer(buffer)?buffer:Buffer.from(buffer||'');
  const last=bytes.lastIndexOf(0x0a);
  return {bytes,completeOffset:last<0?0:last+1,trailingPartial:last+1<bytes.length};
}

function parsePrefix(buffer,limit){
  const records=[];let offset=0;
  for(const raw of buffer.subarray(0,limit).toString('utf8').split('\n')){
    const length=Buffer.byteLength(raw,'utf8')+1,startedAt=offset;offset+=length;
    if(!raw.trim())continue;
    try{records.push({record:JSON.parse(raw.replace(/\r$/,'')),startedAt,endedAt:offset})}
    catch{return {records,malformed:true,malformedOffset:startedAt}}
  }
  return {records,malformed:false,malformedOffset:null};
}

function externalUserText(record){
  if(record?.type!=='user'||record?.message?.role!=='user'||record?.isSidechain===true)return null;
  if(record.userType!==undefined&&record.userType!=='external')return null;
  const content=record.message.content;
  if(typeof content==='string')return canonical(content);
  if(!Array.isArray(content)||!content.length||content.some(block=>block?.type!=='text'||typeof block.text!=='string'))return null;
  return canonical(content.map(block=>block.text).join('\n'));
}

export function captureTranscriptBaseline({buffer,stat,sessionId}={}){
  const prefix=completePrefix(buffer),parsed=parsePrefix(prefix.bytes,prefix.completeOffset);
  if(parsed.malformed)return {valid:false,reason:'MALFORMED_BASELINE',malformedOffset:parsed.malformedOffset};
  if(prefix.trailingPartial)return {valid:false,reason:'BASELINE_WRITE_IN_PROGRESS'};
  const semantic=[...parsed.records].reverse().find(({record})=>record?.type==='user'||record?.type==='assistant')?.record;
  return {valid:true,sessionId,dev:Number(stat?.dev),ino:Number(stat?.ino),offset:prefix.completeOffset,lastSemanticUuid:semantic?.uuid||null};
}

export function inspectTranscriptAcceptance({baseline,buffer,stat,sessionId,expectedDigest}={}){
  if(!baseline||baseline.valid!==true||baseline.sessionId!==sessionId)return {state:'delivery_uncertain',reason:'BASELINE_MISMATCH'};
  if(Number(stat?.dev)!==baseline.dev||Number(stat?.ino)!==baseline.ino)return {state:'delivery_uncertain',reason:'TRANSCRIPT_REPLACED'};
  const prefix=completePrefix(buffer);
  if(prefix.completeOffset<baseline.offset)return {state:'delivery_uncertain',reason:'TRANSCRIPT_TRUNCATED'};
  const tail=prefix.bytes.subarray(baseline.offset,prefix.completeOffset),parsed=parsePrefix(tail,tail.length);
  if(parsed.malformed)return {state:'delivery_uncertain',reason:'MALFORMED_COMPLETE_RECORD',malformedOffset:baseline.offset+parsed.malformedOffset};
  let conflictingUser=false,conflictingOutput=false;
  for(const {record,startedAt,endedAt} of parsed.records){
    const recordSession=record?.sessionId||record?.session_id||null;
    if(recordSession&&recordSession!==sessionId)continue;
    const text=externalUserText(record);if(text===null){if(record?.type==='assistant'||record?.type==='system'&&['stop_hook_summary','turn_duration'].includes(record?.subtype))conflictingOutput=true;continue}
    if(promptDigest(text)===expectedDigest)return {state:'input_accepted',reason:null,userUuid:record.uuid||null,recordOffset:baseline.offset+startedAt,recordEndOffset:baseline.offset+endedAt};
    conflictingUser=true;
  }
  if(conflictingUser)return {state:'delivery_uncertain',reason:'CONFLICTING_EXTERNAL_USER'};
  if(conflictingOutput)return {state:'delivery_uncertain',reason:'CONFLICTING_OUTPUT_EVIDENCE'};
  return {state:'waiting',reason:prefix.trailingPartial?'write_in_progress':'NO_ACCEPTANCE_RECORD',writeInProgress:prefix.trailingPartial};
}

export function deriveRecoveryBaseline({buffer,stat,sessionId,createdAt}={}){
  const prefix=completePrefix(buffer),parsed=parsePrefix(prefix.bytes,prefix.completeOffset);
  if(parsed.malformed)return {valid:false,reason:'MALFORMED_BASELINE'};
  const cutoff=Date.parse(createdAt);if(!Number.isFinite(cutoff))return {valid:false,reason:'INVALID_CREATED_AT'};
  let offset=0,lastSemanticUuid=null;
  for(const entry of parsed.records){
    const timestamp=Date.parse(entry.record?.timestamp||'');
    if(Number.isFinite(timestamp)&&timestamp>=cutoff)break;
    offset=entry.endedAt;
    if(entry.record?.type==='user'||entry.record?.type==='assistant')lastSemanticUuid=entry.record.uuid||lastSemanticUuid;
  }
  return {valid:true,sessionId,dev:Number(stat?.dev),ino:Number(stat?.ino),offset,lastSemanticUuid,derived:true};
}
