import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createDurableTurnQueue} from '../src/turns/durable-turn-queue.mjs';
import {createDwellServer} from '../server.mjs';

const waitFor=async(predicate,timeout=1000)=>{const start=Date.now();while(!predicate()){if(Date.now()-start>timeout)throw new Error('timed out');await new Promise(resolve=>setTimeout(resolve,5))}};
const fixture=async(options={})=>{const dir=await mkdtemp(join(tmpdir(),'qiuqiu-turn-queue-'));return{dir,path:join(dir,'queue.json'),cleanup:async()=>{await new Promise(resolve=>setTimeout(resolve,30));await rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:20})},...options}};

test('durable queue runs A B C in FIFO order with one active dispatch',async()=>{
  const f=await fixture(),started=[],finishers=[],events=new Map();let active=0,maxActive=0;
  const queue=createDurableTurnQueue({path:f.path,retryMs:5,dispatch:async(item,emit)=>{active++;maxActive=Math.max(maxActive,active);started.push(item.prompt);emit({type:'turn_started',turnId:item.turnId});await new Promise(resolve=>finishers.push(()=>{emit({type:'turn_done',turnId:item.turnId});active--;resolve()}))}});await queue.initialize();
  for(const prompt of ['A','B','C'])await queue.enqueue({clientRequestId:`id-${prompt}`,runtimeId:'claude-main',prompt},{emit:event=>{const list=events.get(prompt)||[];list.push(event.type);events.set(prompt,list)}});
  await waitFor(()=>started.length===1);assert.deepEqual(started,['A']);assert.equal(queue.snapshot().pending,2);finishers.shift()();
  await waitFor(()=>started.length===2);assert.deepEqual(started,['A','B']);finishers.shift()();
  await waitFor(()=>started.length===3);finishers.shift()();await waitFor(()=>queue.snapshot().active===0);
  assert.deepEqual(started,['A','B','C']);assert.equal(maxActive,1);assert.deepEqual([...events.values()].map(list=>list.at(-1)),['turn_done','turn_done','turn_done']);await f.cleanup();
});

test('a failed item is recorded and the next FIFO item still runs',async()=>{
  const f=await fixture(),received=[];
  const queue=createDurableTurnQueue({path:f.path,retryMs:5,dispatch:async(item,emit)=>{received.push(item.prompt);emit({type:'turn_started',turnId:item.turnId});emit(item.prompt==='A'?{type:'turn_error',turnId:item.turnId,error:'fixture failure'}:{type:'turn_done',turnId:item.turnId})}});await queue.initialize();
  await queue.enqueue({clientRequestId:'failure-A',runtimeId:'claude-main',prompt:'A'});await queue.enqueue({clientRequestId:'failure-B',runtimeId:'claude-main',prompt:'B'});await waitFor(()=>queue.snapshot().items.every(item=>['finished','failed'].includes(item.status)));
  assert.deepEqual(received,['A','B']);assert.deepEqual(queue.snapshot().items.map(item=>item.status),['failed','finished']);await f.cleanup();
});

test('server-confirmed pending items survive restart and keep their order',async()=>{
  const f=await fixture();let ready=false;
  const first=createDurableTurnQueue({path:f.path,retryMs:5,canDispatch:async()=>ready,dispatch:async()=>{throw new Error('must not dispatch')}});await first.initialize();
  await first.enqueue({clientRequestId:'persist-A',runtimeId:'claude-main',prompt:'A'});await first.enqueue({clientRequestId:'persist-B',runtimeId:'claude-main',prompt:'B'});
  const stored=JSON.parse(await readFile(f.path,'utf8'));assert.deepEqual(stored.records.map(item=>item.prompt),['A','B']);
  const received=[];const second=createDurableTurnQueue({path:f.path,retryMs:5,canDispatch:async()=>ready,dispatch:async(item,emit)=>{received.push(item.prompt);emit({type:'turn_started',turnId:item.turnId});emit({type:'turn_done',turnId:item.turnId})}});await second.initialize();assert.equal(second.snapshot().pending,2);ready=true;await second.drain();await waitFor(()=>received.length===2);assert.deepEqual(received,['A','B']);await f.cleanup();
});

test('duplicate clientRequestId is idempotent and dispatches exactly once',async()=>{
  const f=await fixture();let dispatches=0,release;
  const queue=createDurableTurnQueue({path:f.path,retryMs:5,dispatch:async(item,emit)=>{dispatches++;emit({type:'turn_started',turnId:item.turnId});await new Promise(resolve=>{release=()=>{emit({type:'turn_done',turnId:item.turnId});resolve()}})}});await queue.initialize();
  const first=await queue.enqueue({clientRequestId:'same-request',runtimeId:'claude-main',prompt:'A'});const retry=await queue.enqueue({clientRequestId:'same-request',runtimeId:'claude-main',prompt:'A'});await waitFor(()=>dispatches===1);assert.equal(first.created,true);assert.equal(retry.created,false);release();await waitFor(()=>queue.snapshot().active===0);assert.equal(dispatches,1);await f.cleanup();
});

test('closed RSC/runtime gate keeps items pending without assigning an owner',async()=>{
  const f=await fixture();let open=false,dispatches=0;
  const queue=createDurableTurnQueue({path:f.path,retryMs:5,canDispatch:async()=>open,dispatch:async(item,emit)=>{dispatches++;emit({type:'turn_started',turnId:item.turnId});emit({type:'turn_done',turnId:item.turnId})}});await queue.initialize();await queue.enqueue({clientRequestId:'rsc-B',runtimeId:'claude-main',prompt:'B'});await new Promise(resolve=>setTimeout(resolve,30));assert.equal(dispatches,0);assert.equal(queue.snapshot().items[0].turnId,null);open=true;await queue.drain();await waitFor(()=>dispatches===1);assert.equal(queue.snapshot().items[0].status,'finished');await f.cleanup();
});

test('HTTP retry with the same clientRequestId attaches to one durable queue item',async()=>{
  const f=await fixture(),queue=createDurableTurnQueue({path:f.path,retryMs:10,canDispatch:async()=>false,dispatch:async()=>{throw new Error('must remain pending')}});await queue.initialize();
  const runtime={requestRecovery:()=>({status:'NOT_FOUND'})},server=createDwellServer({claudeRuntime:runtime,turnQueue:queue});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`,clientRequestId='12345678-1234-4123-8123-123456789abc',body=JSON.stringify({config:{runtime:'claude_tmux',runtimeId:'claude-main'},messages:[{role:'user',content:'once'}],clientRequestId});
  try{const first=await fetch(`${base}/api/chat`,{method:'POST',headers:{'content-type':'application/json'},body}),retry=await fetch(`${base}/api/chat`,{method:'POST',headers:{'content-type':'application/json'},body});assert.equal(first.status,200);assert.equal(retry.status,200);assert.equal(queue.records().length,1);assert.equal(queue.snapshot().pending,1);await first.body.cancel();await retry.body.cancel();const recovery=await (await fetch(`${base}/api/chat/recovery/by-request/${clientRequestId}`)).json();assert.equal(recovery.status,'PENDING')}
  finally{await new Promise(resolve=>server.close(resolve));await f.cleanup()}
});
