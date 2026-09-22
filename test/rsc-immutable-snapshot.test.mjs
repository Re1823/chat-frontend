import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {access,mkdtemp,mkdir,readFile,utimes,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {refineTranscript} from '../src/runtimes/rsc/refiner.mjs';
import {prepareShadowCarryover} from '../src/runtimes/rsc/phase2.mjs';
import {createCompactRotationCoordinator} from '../src/runtimes/rsc/compact-rotation.mjs';

const sourceId='11111111-1111-4111-8111-111111111111';
const targetId='22222222-2222-4222-8222-222222222222';
const jsonl=records=>Buffer.from(records.map(JSON.stringify).join('\n')+'\n');
const record=(type,content,uuid=crypto.randomUUID())=>({parentUuid:null,isSidechain:false,userType:'external',cwd:'/fixture',sessionId:sourceId,version:'2.1.236',gitBranch:'',type,message:{role:type,content},uuid,timestamp:'2026-09-22T10:41:16.142Z'});
const chain=records=>records.map((value,index)=>({...value,parentUuid:index?records[index-1].uuid:null}));
const metadata=(subtype,extra={})=>({parentUuid:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',isSidechain:false,type:'system',subtype,sessionId:sourceId,uuid:crypto.randomUUID(),timestamp:'2026-09-22T10:41:19.743Z',...extra});
const baseRecords=()=>chain([record('user',[{type:'text',text:'remember our boundary'}],'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),record('assistant',[{type:'text',text:'I remember the required state'}],'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),metadata('stop_hook_summary',{uuid:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'}),metadata('turn_duration',{uuid:'dddddddd-dddd-4ddd-8ddd-dddddddddddd'})]);
const stopAttachment=()=>({parentUuid:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',isSidechain:false,type:'attachment',sessionId:sourceId,uuid:crypto.randomUUID(),timestamp:'2026-09-22T10:41:19.548Z',attachment:{type:'hook_success',hookEvent:'Stop',hookName:'Stop',exitCode:200}});
async function fixture(){const root=await mkdtemp(join(tmpdir(),'rsc-snapshot-')),projectDir=join(root,'project'),evidenceDir=join(root,'evidence'),sourcePath=join(projectDir,`${sourceId}.jsonl`);await mkdir(projectDir);await mkdir(evidenceDir);await writeFile(sourcePath,jsonl(baseRecords()));return {root,projectDir,evidenceDir,sourcePath}}
const append=async(path,...records)=>writeFile(path,Buffer.concat([await readFile(path),jsonl(records)]));
const missing=path=>access(path).then(()=>false,()=>true);

test('FINISHED snapshot tolerates Stop lifecycle append and creates candidate',async()=>{
 const f=await fixture();
 const prepared=await prepareShadowCarryover({...f,sourceSessionId:sourceId,targetSessionId:targetId,beforeFinalSourceCheck:()=>append(f.sourcePath,stopAttachment(),metadata('stop_hook_summary'),metadata('turn_duration'))});
 assert.equal(prepared.targetSessionId,targetId);
 assert.equal(prepared.evidence.sourceCutoffBytes,jsonl(baseRecords()).length);
 assert.equal(prepared.evidence.sourceCutoffLastSemanticUuid,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
 assert.equal((await readFile(prepared.targetPath,'utf8')).trim().split('\n').length,2);
});

test('usage metadata appended after snapshot does not invalidate refine',async()=>{
 const f=await fixture();
 const refined=await refineTranscript({sourcePath:f.sourcePath,sourceSessionId:sourceId,targetSessionId:targetId,beforeStableCheck:()=>append(f.sourcePath,metadata('usage',{usage:{input_tokens:1,output_tokens:1}}))});
 assert.equal(refined.evidence.result,'PASS');
 assert.equal(refined.targetRecords.length,2);
});

test('mtime-only source change does not invalidate immutable bytes',async()=>{
 const f=await fixture();
 const refined=await refineTranscript({sourcePath:f.sourcePath,sourceSessionId:sourceId,targetSessionId:targetId,beforeStableCheck:()=>utimes(f.sourcePath,new Date(),new Date(Date.now()+1000))});
 assert.equal(refined.evidence.result,'PASS');
});

test('new user after snapshot fails closed and leaves no candidate',async()=>{
 const f=await fixture(),targetPath=join(f.projectDir,`${targetId}.jsonl`);
 await assert.rejects(prepareShadowCarryover({...f,sourceSessionId:sourceId,targetSessionId:targetId,beforeFinalSourceCheck:()=>append(f.sourcePath,record('user',[{type:'text',text:'new turn'}]))}),/SOURCE_CHANGED_DURING_REFINE/);
 assert.equal(await missing(targetPath),true);
});

test('new assistant semantic content after snapshot fails closed',async()=>{
 const f=await fixture();
 const refined=await refineTranscript({sourcePath:f.sourcePath,sourceSessionId:sourceId,targetSessionId:targetId,beforeStableCheck:()=>append(f.sourcePath,record('assistant',[{type:'text',text:'new response'}]))});
 assert.equal(refined.evidence.reason,'SOURCE_CHANGED_DURING_REFINE');
 assert.deepEqual(refined.targetRecords,[]);
});

test('tool execution after snapshot fails closed',async()=>{
 const f=await fixture();
 const refined=await refineTranscript({sourcePath:f.sourcePath,sourceSessionId:sourceId,targetSessionId:targetId,beforeStableCheck:()=>append(f.sourcePath,{...stopAttachment(),attachment:{type:'hook_success',hookEvent:'PostToolUse',hookName:'PostToolUse',toolUseID:'tool-1',exitCode:0}})});
 assert.equal(refined.evidence.reason,'SOURCE_CHANGED_DURING_REFINE');
});

test('same immutable snapshot produces deterministic refined content',async()=>{
 const a=await fixture(),b=await fixture();
 const first=await refineTranscript({sourcePath:a.sourcePath,sourceSessionId:sourceId,targetSessionId:targetId});
 const second=await refineTranscript({sourcePath:b.sourcePath,sourceSessionId:sourceId,targetSessionId:targetId});
 const semantic=records=>records.map(row=>({type:row.type,role:row.message.role,content:row.message.content,timestamp:row.timestamp,sessionId:row.sessionId}));
 assert.deepEqual(semantic(first.targetRecords),semantic(second.targetRecords));
 assert.equal(first.evidence.sourceSha256,second.evidence.sourceSha256);
 assert.equal(first.evidence.sourceCutoffBytes,second.evidence.sourceCutoffBytes);
});

test('pending compact retries once, dedupes candidate, and consumes only after success',async()=>{
 const compact={compactId:`${sourceId}:compact-a`,sessionId:sourceId,uuid:'compact-a',timestamp:'2026-09-21T00:29:09.768Z'};
 let state={currentProductionSessionId:sourceId,lastGoodSessionId:sourceId,preparedTargetSessionId:sourceId,handoffState:'ACTIVE',handoffGeneration:2,pendingRotation:{...compact,deferUntilTurnFinished:true}},attempts=0,candidates=0;
 const coordinator=createCompactRotationCoordinator({loadState:async()=>structuredClone(state),saveState:async value=>(state=structuredClone(value)),latestCompact:async()=>compact,isActive:()=>false,rotate:async pending=>{attempts++;if(attempts===1){state={...state,pendingRotation:{...pending,deferUntilTurnFinished:true}};throw new Error('previous harmless failure')}candidates++;state={...state,pendingRotation:null,lastConsumedCompact:{...pending,consumedAt:'done',generation:3}};return {status:'ROTATED'}}});
 await assert.rejects(coordinator.turnFinished(),/previous harmless failure/);
 assert.equal(state.lastConsumedCompact,undefined);
 assert.equal(candidates,0);
 await coordinator.turnFinished();
 await coordinator.observe();
 assert.equal(attempts,2);
 assert.equal(candidates,1);
 assert.equal(state.lastConsumedCompact.compactId,compact.compactId);
 assert.equal(state.pendingRotation,null);
});
