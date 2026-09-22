import {open,stat} from 'node:fs/promises';

export function nativeCompactIdentity(record,sessionId){
 if(!record||record.type!=='system'||record.subtype!=='compact_boundary'||record.sessionId!==sessionId)return null;
 const marker=record.uuid||record.timestamp;
 return typeof marker==='string'&&marker?`${sessionId}:${marker}`:null;
}

export function createTranscriptCompactReader({projectDir}){
 let currentSession=null,offset=0,remainder='',latest=null;
 const reset=sessionId=>{currentSession=sessionId;offset=0;remainder='';latest=null};
 return async sessionId=>{
  if(sessionId!==currentSession)reset(sessionId);
  const path=`${projectDir}/${sessionId}.jsonl`,size=(await stat(path)).size;
  if(size<offset)reset(sessionId);
  if(size===offset)return latest;
  const length=size-offset,buffer=Buffer.alloc(length),handle=await open(path,'r');
  try{await handle.read(buffer,0,length,offset)}finally{await handle.close()}
  offset=size;const text=remainder+buffer.toString('utf8'),parts=text.split(/\r?\n/);remainder=parts.pop()||'';
  const inspect=line=>{let record;try{record=JSON.parse(line)}catch{return false}const compactId=nativeCompactIdentity(record,sessionId);if(compactId)latest={compactId,sessionId,uuid:record.uuid||null,timestamp:record.timestamp||null};return true};
  for(const line of parts)inspect(line);
  if(remainder&&inspect(remainder))remainder='';
  return latest;
 };
}

export function createCompactRotationCoordinator({loadState,saveState,latestCompact,isActive,rotate,now=()=>new Date().toISOString(),log=()=>{}}){
 let chain=Promise.resolve();
 const serial=task=>{const result=chain.then(task);chain=result.catch(()=>undefined);return result};
 const consumed=(state,compact)=>state.lastConsumedCompact?.compactId===compact.compactId;
 const rotatePending=async()=>{
  const state=await loadState(),pending=state.pendingRotation;
  if(!pending||pending.deferUntilTurnFinished||isActive()||!['ACTIVE','VALIDATED'].includes(state.handoffState))return {status:'PENDING',pendingRotation:pending||null};
  log({event:'rotation_triggered',compactId:pending.compactId,sessionId:pending.sessionId});
  return rotate(pending,state);
 };
 const check=async mode=>{
  let state=await loadState();const compact=await latestCompact(state.currentProductionSessionId);
  if(!compact)return {status:'NO_COMPACT'};
  if(consumed(state,compact))return {status:'ALREADY_CONSUMED',compact};
  if(state.pendingRotation?.compactId!==compact.compactId){
   if(!['ACTIVE','VALIDATED'].includes(state.handoffState))return {status:'STATE_BLOCKED',compact};
   const deferUntilTurnFinished=mode==='reconcile'||isActive();
   state=await saveState({...state,pendingRotation:{...compact,detectedAt:now(),detectedBy:mode,deferUntilTurnFinished},updatedAt:now()});
   log({event:'compact_observed',compactId:compact.compactId,sessionId:compact.sessionId,mode,deferUntilTurnFinished});
  }else if(mode==='turn_finished'&&state.pendingRotation.deferUntilTurnFinished){
   state=await saveState({...state,pendingRotation:{...state.pendingRotation,deferUntilTurnFinished:false,releasedAt:now()},updatedAt:now()});
  }
  if(mode==='reconcile'||isActive())return {status:'PENDING',pendingRotation:state.pendingRotation};
  return rotatePending();
 };
 return {
  reconcile(){return serial(()=>check('reconcile'))},
  observe(){return serial(()=>check('live'))},
  turnFinished(){return serial(()=>check('turn_finished'))}
 };
}
