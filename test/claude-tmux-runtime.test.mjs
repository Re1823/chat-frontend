import assert from 'node:assert/strict';
import test from 'node:test';
import { createClaudeIngress } from '../src/hooks/claude-ingress.mjs';
import { createClaudeTmuxRuntime } from '../src/runtimes/claude-tmux.mjs';
import { createTurnStore } from '../src/turns/turn-store.mjs';

function fixture({state='connected',stopTimeoutMs=20}={}){
  const runtimeRecord={runtimeId:'runtime-main',sessionName:'dwell',workspace:'/srv/app'};const prompts=[],interrupts=[];
  const transport={sendPrompt:async value=>prompts.push(value),interrupt:async value=>interrupts.push(value)};
  const registry={load:async()=>runtimeRecord,get:()=>runtimeRecord,reconcile:async()=>({state,runtime:runtimeRecord,inspection:{alive:state==='connected'}})};
  const runtime=createClaudeTmuxRuntime({config:{enabled:true,submitDelayMs:250,stopTimeoutMs},transport,registry,turnStore:createTurnStore(),ingress:createClaudeIngress()});
  return {runtime,prompts,interrupts};
}

test('runtime maps canonical ordered frames to existing turn events',async()=>{
  const {runtime,prompts}=fixture();const events=[];await runtime.initialize();
  await runtime.chat({runtimeId:'runtime-main',turnId:'turn-1',prompt:'only new prompt',emit:event=>events.push(event)});
  assert.equal(prompts[0].prompt,'only new prompt');
  await runtime.ingestRaw({event:'message_display',message_id:'m',index:1,delta:'B'});
  await runtime.ingestRaw({event:'message_display',message_id:'m',index:0,delta:'A'});
  await runtime.ingestRaw({event:'message_display',message_id:'m',index:2,delta:'C',final:true});
  await runtime.ingestRaw({event:'Stop'});
  assert.deepEqual(events.map(event=>event.type),['turn_started','segment_delta','segment_delta','segment_delta','segment_done','turn_done']);
  assert.equal(events.filter(event=>event.type==='segment_delta').map(event=>event.delta).join(''),'ABC');
});

test('stop waits for confirmation and late stop closes an unconfirmed turn once',async()=>{
  const {runtime,interrupts}=fixture({stopTimeoutMs:5});const events=[];await runtime.initialize();
  await runtime.chat({runtimeId:'runtime-main',turnId:'turn-stop',prompt:'x',emit:event=>events.push(event)});
  assert.deepEqual(await runtime.stop({runtimeId:'runtime-main',turnId:'turn-stop'}),{ok:false,status:'stop_unconfirmed',error:'已发送 Escape，但当前回复尚未确认停止。'});
  assert.deepEqual(interrupts,['dwell']);assert.deepEqual(events.map(x=>x.type),['turn_started']);
  await runtime.ingestRaw({event:'Stop'});await runtime.ingestRaw({event:'Stop'});
  assert.deepEqual(events.map(x=>x.type),['turn_started','segment_done','turn_stopped']);
});

test('runtime reports missing sessions without starting a turn',async()=>{
  const {runtime}=fixture({state:'missing'});await runtime.initialize();
  await assert.rejects(runtime.preflight('runtime-main'),error=>error.statusCode===404&&/session 不存在/.test(error.message));
});

test('runtime serializes concurrent raw hook adaptation before applying frames',async()=>{
  const events=[],record={runtimeId:'runtime-main',sessionName:'dwell',workspace:'/srv/app'};
  let release;const gate=new Promise(resolve=>{release=resolve});let calls=0;
  const ingress={adapt:async raw=>{calls++;if(raw.order===1)await gate;return {kind:'assistant_frame',messageId:'m',sequence:raw.order-1,text:String(raw.order),final:false,textMode:'delta'}}};
  const registry={load:async()=>record,get:()=>record,reconcile:async()=>({state:'connected',runtime:record,inspection:{alive:true}})};
  const runtime=createClaudeTmuxRuntime({config:{enabled:true,submitDelayMs:250,stopTimeoutMs:10},transport:{sendPrompt:async()=>{},interrupt:async()=>{}},registry,turnStore:createTurnStore(),ingress});
  await runtime.initialize();await runtime.chat({runtimeId:'runtime-main',turnId:'t',prompt:'x',emit:event=>events.push(event)});
  const first=runtime.ingestRaw({order:1});const second=runtime.ingestRaw({order:2});await new Promise(resolve=>setTimeout(resolve,1));
  assert.equal(calls,1);release();await Promise.all([first,second]);
  assert.equal(events.filter(event=>event.type==='segment_delta').map(event=>event.delta).join(''),'12');
});
