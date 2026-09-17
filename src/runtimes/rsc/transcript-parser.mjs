import {createHash} from 'node:crypto';
import {readFile,stat} from 'node:fs/promises';

export const RSC_FAILURES=Object.freeze({MALFORMED_JSONL:'MALFORMED_JSONL',SOURCE_CHANGED_DURING_REFINE:'SOURCE_CHANGED_DURING_REFINE',UNKNOWN_TRANSCRIPT_SCHEMA:'UNKNOWN_TRANSCRIPT_SCHEMA',INCOMPLETE_TAIL:'INCOMPLETE_TAIL',POISON_DETECTED:'POISON_DETECTED'});
const knownTypes=new Set(['user','assistant','system','summary','progress','file-history-snapshot','queue-operation','custom-title','mode','permission-mode','atis-latch','bridge-session','attachment','last-prompt','ai-title']);
const hash=value=>createHash('sha256').update(value).digest('hex');
const identity=s=>({dev:s.dev,ino:s.ino,size:s.size,mtimeMs:s.mtimeMs});
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs;
const fail=reason=>Object.assign(new Error(reason),{reason});

export async function snapshotSource(path){const before=await stat(path),body=await readFile(path);return {path,body,identity:identity(before),sha256:hash(body)}}
export async function assertSourceStable(snapshot){const after=identity(await stat(snapshot.path));if(!same(snapshot.identity,after))throw fail(RSC_FAILURES.SOURCE_CHANGED_DURING_REFINE);const body=await readFile(snapshot.path);if(hash(body)!==snapshot.sha256)throw fail(RSC_FAILURES.SOURCE_CHANGED_DURING_REFINE);return true}
export function parseTranscript(buffer,{sourceSessionId}={}){
 if(!sourceSessionId)throw new TypeError('sourceSessionId is required');const records=[];let lineNumber=0;
 for(const raw of buffer.toString('utf8').split(/\r?\n/)){lineNumber++;if(!raw.trim())continue;let record;try{record=JSON.parse(raw)}catch{throw fail(RSC_FAILURES.MALFORMED_JSONL)}
  if(!record||typeof record!=='object'||Array.isArray(record)||!knownTypes.has(record.type))throw fail(RSC_FAILURES.UNKNOWN_TRANSCRIPT_SCHEMA);
  if(record.sessionId&&record.sessionId!==sourceSessionId)throw fail(RSC_FAILURES.UNKNOWN_TRANSCRIPT_SCHEMA);
  if(['user','assistant'].includes(record.type)&&(!record.message||record.message.role!==record.type||!['string','object'].includes(typeof record.message.content)))throw fail(RSC_FAILURES.UNKNOWN_TRANSCRIPT_SCHEMA);
  records.push({...record,__line:lineNumber});
 }
 return records;
}
export function contentBlocks(record){const content=record.message?.content;if(typeof content==='string')return [{type:'text',text:content}];if(!Array.isArray(content))return [];return content}
export function textContent(record){return contentBlocks(record).filter(block=>block?.type==='text'&&typeof block.text==='string').map(block=>block.text).join('\n').trim()}
export function inspectToolIntegrity(records){
 const pending=new Set();let valid=true,incompleteTail=false;
 for(const record of records){for(const block of contentBlocks(record)){if(block?.type==='tool_use'&&typeof block.id==='string')pending.add(block.id);if(block?.type==='tool_result'){const id=block.tool_use_id;if(typeof id!=='string'||!pending.delete(id))valid=false}}}
 if(pending.size){valid=false;incompleteTail=true}return {valid,incompleteTail,pending:[...pending]};
}
export function isCompactRecord(record){return record.type==='system'&&record.subtype==='compact_boundary'||record.isCompactSummary===true||record.type==='summary'}
export function buildNarrativeSpine(){return {enabled:false,records:[]}}
