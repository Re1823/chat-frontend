import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createCompactRotationCoordinator,createTranscriptCompactReader} from '../src/runtimes/rsc/compact-rotation.mjs';

const sessionA='11111111-1111-4111-8111-111111111111',sessionB='22222222-2222-4222-8222-222222222222';
const compact=(sessionId=sessionA,id='compact-a')=>({compactId:`${sessionId}:${id}`,sessionId,uuid:id,timestamp:'2026-09-21T00:29:09.768Z'});
const base=()=>({currentProductionSessionId:sessionA,lastGoodSessionId:sessionA,preparedTargetSessionId:sessionA,handoffState:'ACTIVE',handoffGeneration:1,operationGeneration:1,operationId:'rscop_generation_0001'});
function fixture({active=false,latest=null,state=base()}={}){
 let current=structuredClone(state),isActive=active,seen=latest,rotations=0;
 const coordinator=createCompactRotationCoordinator({loadState:async()=>structuredClone(current),saveState:async value=>(current=structuredClone(value)),latestCompact:async sessionId=>seen?.sessionId===sessionId?seen:null,isActive:()=>isActive,now:()=>`time-${rotations}`,rotate:async pending=>{rotations++;current={...current,pendingRotation:null,lastConsumedCompact:{...pending,consumedAt:`done-${rotations}`,generation:current.handoffGeneration},handoffState:'ACTIVE'};return {status:'ROTATED'}}});
 return {coordinator,state:()=>current,rotations:()=>rotations,setActive:value=>{isActive=value},setLatest:value=>{seen=value},setState:value=>{current=value}};
}

test('compact during active turn becomes pending and rotates exactly once after FINISHED',async()=>{const f=fixture({active:true,latest:compact()});assert.equal((await f.coordinator.observe()).status,'PENDING');assert.equal(f.rotations(),0);f.setActive(false);await f.coordinator.turnFinished();assert.equal(f.rotations(),1)});
test('compact while idle rotates exactly once',async()=>{const f=fixture({latest:compact()});await f.coordinator.observe();assert.equal(f.rotations(),1)});
test('observer restart reconciles compact to one deferred pending rotation',async()=>{const f=fixture({latest:compact()});await f.coordinator.reconcile();await f.coordinator.reconcile();assert.equal(f.rotations(),0);assert.equal(f.state().pendingRotation.compactId,compact().compactId)});
test('same compact observed twice never duplicates rotation',async()=>{const f=fixture({latest:compact()});await f.coordinator.observe();await f.coordinator.observe();assert.equal(f.rotations(),1)});
test('frontend reconnect and recovery observations do not create a Claude turn or duplicate rotation',async()=>{const f=fixture({latest:compact()}),claudeTurns=[];await f.coordinator.observe();await f.coordinator.observe();claudeTurns.push(...[]);assert.equal(f.rotations(),1);assert.deepEqual(claudeTurns,[])});
test('no compact never rotates',async()=>{const f=fixture();assert.equal((await f.coordinator.observe()).status,'NO_COMPACT');assert.equal(f.rotations(),0)});
test('already consumed old compact is ignored',async()=>{const marker=compact(),state={...base(),lastConsumedCompact:{...marker,consumedAt:'before',generation:1}};const f=fixture({latest:marker,state});assert.equal((await f.coordinator.observe()).status,'ALREADY_CONSUMED');assert.equal(f.rotations(),0)});
test('next generation compact rotates again',async()=>{const first=compact(),f=fixture({latest:first});await f.coordinator.observe();f.setState({...f.state(),currentProductionSessionId:sessionB,lastGoodSessionId:sessionB,preparedTargetSessionId:sessionB,handoffGeneration:2,operationGeneration:2});f.setLatest(compact(sessionB,'compact-b'));await f.coordinator.observe();assert.equal(f.rotations(),2)});
test('reader detects a compact boundary without requiring a following event',async()=>{const root=await mkdtemp(join(tmpdir(),'compact-reader-'));await mkdir(root,{recursive:true});const path=join(root,`${sessionA}.jsonl`),row={type:'system',subtype:'compact_boundary',sessionId:sessionA,uuid:'compact-final',timestamp:'now'};await writeFile(path,JSON.stringify(row));const read=createTranscriptCompactReader({projectDir:root});assert.equal((await read(sessionA)).compactId,`${sessionA}:compact-final`)});
