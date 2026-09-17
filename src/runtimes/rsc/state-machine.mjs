import {readFile} from 'node:fs/promises';
import {atomicWriteJson,sha256} from './evidence.mjs';

export const RSC_STATES=Object.freeze(['IDLE','PREPARING','PREPARED','VALIDATED','ACTIVATING','STARTING_TARGET','TARGET_READY','CANDIDATE_ACTIVE','COMMITTED','ROLLBACK','ROLLED_BACK']);
const transitions=new Map([
 ['IDLE',['PREPARING']],['PREPARING',['PREPARED','ROLLBACK']],['PREPARED',['VALIDATED','ROLLBACK']],['VALIDATED',['ACTIVATING','ROLLBACK']],
 ['ACTIVATING',['STARTING_TARGET','ROLLBACK']],['STARTING_TARGET',['TARGET_READY','ROLLBACK']],['TARGET_READY',['CANDIDATE_ACTIVE','ROLLBACK']],['CANDIDATE_ACTIVE',['COMMITTED','ROLLBACK']],['ROLLBACK',['ROLLED_BACK']]
]);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest=/^[0-9a-f]{64}$/;
const fail=reason=>Object.assign(new Error(reason),{reason});

export function createCarryoverState({conversationId,sourceSessionId,targetSessionId,preparedTargetSha256,postResumeTargetSha256=null,now=()=>new Date().toISOString()}={}){
 if(!/^[A-Za-z0-9_.-]{1,120}$/.test(conversationId||'')||!uuid.test(sourceSessionId||'')||!uuid.test(targetSessionId||'')||!digest.test(preparedTargetSha256||'')||postResumeTargetSha256&&!digest.test(postResumeTargetSha256))throw fail('INVALID_CARRYOVER_STATE');
 const timestamp=now();return {conversationId,sourceSessionId,targetSessionId,lastGoodSessionId:sourceSessionId,preparedTargetSha256,postResumeTargetSha256,resumeMutationExpected:Boolean(postResumeTargetSha256),state:'IDLE',createdAt:timestamp,updatedAt:timestamp,failureReason:null};
}
export function transitionCarryover(current,next,{failureReason=null,now=()=>new Date().toISOString()}={}){
 if(!RSC_STATES.includes(next)||!transitions.get(current.state)?.includes(next))throw fail('INVALID_STATE_TRANSITION');
 const value={...current,state:next,updatedAt:now()};if(next==='ROLLBACK'||next==='ROLLED_BACK')value.failureReason=failureReason||current.failureReason||'ACTIVATION_FAILED';if(next==='COMMITTED'){value.lastGoodSessionId=value.targetSessionId;value.failureReason=null}return value;
}
export function validateResumeMutation({preparedBytes,currentBytes,targetSessionId}){
 if(sha256(preparedBytes)===sha256(currentBytes))return {valid:true,resumeMutationExpected:false,postResumeTargetSha256:sha256(currentBytes)};
 if(currentBytes.length<=preparedBytes.length||!currentBytes.subarray(0,preparedBytes.length).equals(preparedBytes))return {valid:false,reason:'UNKNOWN_TARGET_MUTATION'};
 const extra=currentBytes.subarray(preparedBytes.length).toString('utf8').trim().split(/\r?\n/).filter(Boolean);if(!extra.length||extra.length>4)return {valid:false,reason:'UNKNOWN_TARGET_MUTATION'};
 let records;try{records=extra.map(JSON.parse)}catch{return {valid:false,reason:'UNKNOWN_TARGET_MUTATION'}}
 const signatures={
  'atis-latch':['atis','sessionId','type'],'file-history-snapshot':['isSnapshotUpdate','messageId','snapshot','type'],mode:['mode','sessionId','type'],'permission-mode':['permissionMode','sessionId','type']
 },order=['atis-latch','file-history-snapshot','mode','permission-mode'],start=order.length-records.length;
 if(records.some((record,index)=>record.type!==order[start+index]||!signatures[record.type]||Object.keys(record).sort().join(',')!==signatures[record.type].sort().join(',')||record.message!==undefined||(record.type!=='file-history-snapshot'&&record.sessionId!==targetSessionId)))return {valid:false,reason:'UNKNOWN_TARGET_MUTATION'};
 return {valid:true,resumeMutationExpected:true,postResumeTargetSha256:sha256(currentBytes)};
}
export function createCarryoverStateStore({path}){let value=null;return {async load(){value=JSON.parse(await readFile(path,'utf8'));return value},get(){return value},async save(next){value=next;await atomicWriteJson(path,next);return next},async transition(next,options){return this.save(transitionCarryover(value,next,options))}}}
