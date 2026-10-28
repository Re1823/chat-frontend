import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createDurableTurnQueue} from '../src/turns/durable-turn-queue.mjs';
import {createViewfinderChatSync} from '../src/viewfinder-chat/sync.mjs';
import {createDwellServer} from '../server.mjs';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(check){for(let i=0;i<100;i++){if(check())return;await pause(5)}throw Error('timed out')}

async function fixture(t,{held=false}={}){
  const dir=await mkdtemp(fileURLToPath(new URL('../.tmp/screenpeek-sync-',import.meta.url)));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const bridge=[],dispatched=[],release=[];
  let online=true,owner='pid:uuid';
  const queue=createDurableTurnQueue({path:join(dir,'queue.json'),retryMs:5,dispatch:async(item,emit)=>{
    dispatched.push(item.prompt);
    emit({type:'turn_started',turnId:item.turnId});
    if(held)await new Promise(resolve=>release.push(resolve));
    emit({type:'assistant_message',source:'tool',messageId:`${item.clientRequestId}:1`,text:'第一句',turnId:item.turnId});
    emit({type:'assistant_message',source:'tool',messageId:`${item.clientRequestId}:2`,text:'第二句',turnId:item.turnId});
    emit({type:'thought_process',text:'不可广播'});
    emit({type:'turn_done',turnId:item.turnId});
  }});
  await queue.initialize();t.after(()=>queue.close());
  const sync=createViewfinderChatSync({turnQueue:queue,identity:async()=>owner,heartbeatMs:15000,postBridge:async(path,body)=>{
    if(!online)throw Error('offline');
    bridge.push({path,...body});
    if(path.endsWith('vf-chat-status'))return {ok:true,connected:true};
    if(path.endsWith('vf-chat-sync'))return {ok:true,connected:true,enabled:body.enabled};
    return {ok:true};
  }});
  const appSecret='a'.repeat(32),helperSecret='b'.repeat(32);
  const server=createDwellServer({turnQueue:queue,viewfinderChatSync:sync,viewfinderChatSecret:appSecret,frontendDeliverySecret:helperSecret,claudeRuntime:{}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))});
  const base=`http://127.0.0.1:${server.address().port}`;
  const post=async(path,body,secret=appSecret)=>{
    const response=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json','x-viewfinder-chat-secret':secret,'x-frontend-delivery-secret':secret},body:JSON.stringify(body)});
    return {status:response.status,body:await response.json()};
  };
  return {queue,sync,bridge,dispatched,release,base,post,appSecret,helperSecret,setOnline:value=>online=value,setOwner:value=>owner=value};
}

test('default off, authenticated enable, connection status, rejected input, and no replay',async t=>{
  const f=await fixture(t),id=randomUUID();
  assert.equal(f.sync.snapshot().enabled,false);
  assert.deepEqual((await f.post('/api/internal/viewfinder-chat/message',{epoch:'none',clientRequestId:id,text:'拒绝'})).body,{ok:false,error:'sync_disabled'});
  assert.equal(f.queue.snapshot().total,0);
  assert.equal((await f.post('/api/internal/viewfinder-chat/sync',{enabled:true},'wrong')).status,401);
  f.setOnline(false);
  assert.equal((await f.post('/api/internal/viewfinder-chat/sync',{enabled:true},f.helperSecret)).body.enabled,false);
  f.setOnline(true);
  assert.equal((await f.post('/api/internal/viewfinder-chat/sync',{enabled:true},f.helperSecret)).body.connected,true);
  const epoch=f.sync.snapshot().epoch;
  assert.equal((await f.post('/api/internal/viewfinder-chat/sync',{enabled:false},f.helperSecret)).body.enabled,false);
  assert.equal((await f.post('/api/internal/viewfinder-chat/message',{epoch,clientRequestId:id,text:'停用期间'})).body.ok,false);
  assert.equal((await f.post('/api/internal/viewfinder-chat/sync',{enabled:true},f.helperSecret)).body.enabled,true);
  assert.notEqual(f.sync.snapshot().epoch,epoch);
  assert.equal(f.sync.events().events.length,0);
});

test('ScreenPeek uses one durable FIFO, idempotent retries, concurrent ordering, and official multi-bubble replies',async t=>{
  const f=await fixture(t,{held:true});await f.sync.set(true);
  const epoch=f.sync.snapshot().epoch,a=randomUUID(),b=randomUUID();
  assert.equal((await f.post('/api/internal/viewfinder-chat/message',{epoch,clientRequestId:a,text:'来自取景框 A'})).body.created,true);
  assert.equal((await f.post('/api/internal/viewfinder-chat/message',{epoch,clientRequestId:a,text:'来自取景框 A'})).body.created,false);
  assert.equal((await f.post('/api/internal/viewfinder-chat/message',{epoch,clientRequestId:b,text:'来自取景框 B'})).body.created,true);
  await waitFor(()=>f.dispatched.length===1);
  assert.deepEqual(f.dispatched,['来自取景框 A']);
  f.release.shift()();await waitFor(()=>f.dispatched.length===2);
  f.release.shift()();await waitFor(()=>f.sync.events().events.filter(e=>e.type==='turn_done').length===2);
  assert.deepEqual(f.dispatched,['来自取景框 A','来自取景框 B']);
  assert.equal(f.queue.snapshot().total,2);
  await waitFor(()=>f.bridge.filter(e=>e.type==='done').length===2);
  assert.deepEqual(f.bridge.filter(e=>e.type==='done').map(e=>e.text),['第一句|||第二句','第一句|||第二句']);
  assert.equal(f.sync.events().events.some(e=>e.type==='thought_process'),false);
  assert.equal(f.sync.events().events.filter(e=>e.type==='user_message').length,2);
});

test('PWA turn is relayed only during active epoch; closing leaves FIFO work but stops ScreenPeek output',async t=>{
  const f=await fixture(t,{held:true});await f.sync.set(true);
  const epoch=f.sync.snapshot().epoch,id=randomUUID();
  const subscriber={emit:event=>f.sync.turnEvent(id,event),end(){}};
  const result=await f.queue.enqueue({clientRequestId:id,source:'user',runtimeId:'claude-main',conversationId:'claude-main',prompt:'PWA 消息',imageIds:[]},subscriber);
  assert.equal(result.created,true);f.sync.accepted({clientRequestId:id,text:'PWA 消息',source:'pwa',acceptedEpoch:epoch});
  await waitFor(()=>f.dispatched.length===1);
  await waitFor(()=>f.bridge.some(e=>e.type==='resend'));
  assert.equal(f.bridge.filter(e=>e.type==='resend').at(-1).text,'PWA 消息');
  await f.sync.set(false);
  f.release.shift()();await waitFor(()=>f.queue.snapshot().active===0);
  assert.equal(f.bridge.filter(e=>e.type==='done').length,0);
  assert.equal(f.sync.events().events.some(e=>e.type==='assistant_message'),false);
  assert.equal((await f.post('/api/internal/viewfinder-chat/message',{epoch,clientRequestId:randomUUID(),text:'late'})).body.ok,false);
  await f.sync.set(true);
  assert.equal(f.bridge.filter(e=>e.type==='resend').length,1);
});

test('ScreenPeek accepted turn completes in PWA after sync closes, without leaking back to ScreenPeek',async t=>{
  const f=await fixture(t,{held:true});await f.sync.set(true);
  const id=randomUUID(),epoch=f.sync.snapshot().epoch;
  assert.equal((await f.post('/api/internal/viewfinder-chat/message',{epoch,clientRequestId:id,text:'accepted'})).body.ok,true);
  await waitFor(()=>f.dispatched.length===1);
  await f.sync.set(false);f.release.shift()();
  await waitFor(()=>f.sync.events().events.some(e=>e.type==='turn_done'));
  assert.equal(f.sync.events().events.filter(e=>e.type==='assistant_message').length,2);
  assert.equal(f.bridge.some(e=>e.type==='done'),false);
});

test('real PWA HTTP chat route feeds the same queue and ScreenPeek relay with event cursor dedup',async t=>{
  const f=await fixture(t);await f.sync.set(true);
  const id=randomUUID(),body={config:{runtime:'claude_tmux',runtimeId:'claude-main'},messages:[{role:'user',content:'PWA 路由消息'}],clientRequestId:id};
  const response=await fetch(f.base+'/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal(response.status,200);await response.text();
  await waitFor(()=>f.bridge.some(event=>event.type==='done'));
  assert.deepEqual(f.dispatched,['PWA 路由消息']);
  assert.equal(f.bridge.find(event=>event.type==='resend').text,'PWA 路由消息');
  const first=await (await fetch(f.base+'/api/chat/viewfinder-sync/events?after=0')).json();
  assert.equal(first.events.filter(event=>event.type==='user_message').length,1);
  assert.equal(first.events.filter(event=>event.type==='assistant_message').length,2);
  const next=await (await fetch(f.base+`/api/chat/viewfinder-sync/events?after=${first.latestId}`)).json();
  assert.deepEqual(next.events,[]);
});

test('disconnect, session change, heartbeat loss, and disabled interval suppress old events',async t=>{
  const f=await fixture(t);await f.sync.set(true);const first=f.sync.snapshot().epoch;
  assert.equal(f.sync.disconnected(first).enabled,false);
  assert.equal((await f.post('/api/internal/viewfinder-chat/message',{epoch:first,clientRequestId:randomUUID(),text:'old'})).body.ok,false);
  await f.sync.set(true);const second=f.sync.snapshot().epoch;
  assert.notEqual(first,second);
  f.setOwner('different:uuid');assert.equal((await f.sync.heartbeat(second)).enabled,false);
  assert.equal(f.sync.events().events.length,0);
});
