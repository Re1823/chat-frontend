import assert from 'node:assert/strict';
import test from 'node:test';
import { createClaudeIngress } from '../src/hooks/claude-ingress.mjs';
import { createClaudeTmuxRuntime } from '../src/runtimes/claude-tmux.mjs';
import { createTurnStore } from '../src/turns/turn-store.mjs';

function fixture({state='connected',stopTimeoutMs=20}={}){
  const runtimeRecord={runtimeId:'runtime-main',sessionName:'dwell',workspace:'/srv/app'};const prompts=[],interrupts=[];
  const completions=[];const transport={sendPrompt:async value=>prompts.push(value),interrupt:async value=>interrupts.push(value),complete:async value=>completions.push(value)};
  const registry={load:async()=>runtimeRecord,get:()=>runtimeRecord,reconcile:async()=>({state,runtime:runtimeRecord,inspection:{alive:state==='connected'}})};
  const runtime=createClaudeTmuxRuntime({config:{enabled:true,submitDelayMs:250,stopTimeoutMs},transport,registry,turnStore:createTurnStore(),ingress:createClaudeIngress()});
  return {runtime,prompts,interrupts,completions};
}

test('runtime keeps ordinary MessageDisplay frames internal while preserving completion',async()=>{
  const {runtime,prompts,completions}=fixture();const events=[];await runtime.initialize();
  await runtime.chat({runtimeId:'runtime-main',turnId:'turn-1',prompt:'only new prompt',emit:event=>events.push(event)});
  assert.equal(prompts[0].prompt,'only new prompt');
  assert.deepEqual(await runtime.ingestRaw({event:'message_display',message_id:'m',index:1,delta:'B'}),{accepted:true,reason:'internal_only'});
  assert.deepEqual(await runtime.ingestRaw({event:'message_display',message_id:'m',index:0,delta:'A'}),{accepted:true,reason:'internal_only'});
  assert.deepEqual(await runtime.ingestRaw({event:'message_display',message_id:'m',index:2,delta:'C',final:true}),{accepted:true,reason:'internal_only'});
  await runtime.ingestRaw({event:'Stop'});
  assert.deepEqual(events.map(event=>event.type),['turn_started','segment_done','turn_done']);
  assert.equal(events.some(event=>event.type==='segment_delta'),false);
  assert.deepEqual(completions,['turn-1']);
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
  assert.equal(events.some(event=>event.type==='segment_delta'),false);assert.equal(calls,2);
});

test('disabled runtime never auto-creates a missing session',async()=>{
  let creates=0;
  const record={runtimeId:'runtime-main',sessionName:'dwell',workspace:'/root'};
  const registry={load:async()=>record,get:()=>record,reconcile:async()=>({state:'missing',runtime:record})};
  const transport={createSession:async()=>{creates++}};
  const runtime=createClaudeTmuxRuntime({config:{enabled:false,autoCreate:true},transport,registry,turnStore:createTurnStore(),ingress:createClaudeIngress()});
  assert.equal((await runtime.initialize()).state,'missing');
  assert.equal(creates,0);
});

test('client disconnect before bridge send discards the Node turn without sending',async()=>{
  const {runtime,prompts}=fixture();await runtime.initialize();const controller=new AbortController();
  controller.abort();
  await assert.rejects(runtime.chat({runtimeId:'runtime-main',turnId:'turn-before-send',prompt:'x',emit:()=>{},signal:controller.signal}),/client disconnected/);
  assert.equal(prompts.length,0);assert.equal(runtime.hasActiveTurn(),false);
});

test('client disconnect after bridge send stays detached until Stop completes it',async()=>{
  const {runtime,prompts,completions}=fixture();await runtime.initialize();const controller=new AbortController();
  await runtime.chat({runtimeId:'runtime-main',turnId:'turn-detached',prompt:'x',emit:()=>{},signal:controller.signal});
  controller.abort();assert.equal(prompts.length,1);assert.equal(runtime.hasActiveTurn(),true);
  await runtime.ingestRaw({event:'Stop'});
  assert.equal(runtime.hasActiveTurn(),false);assert.deepEqual(completions,['turn-detached']);
  await runtime.chat({runtimeId:'runtime-main',turnId:'turn-next',prompt:'next',emit:()=>{}});
  assert.equal(prompts.length,2);
});

test('terminal emit failure detaches transport while retaining the completed turn journal',async()=>{
  const {runtime}=fixture();await runtime.initialize();
  await runtime.chat({runtimeId:'runtime-main',turnId:'turn-emit-fails',prompt:'x',emit:event=>{if(event.type==='turn_done')throw new Error('closed response')}});
  await runtime.ingestRaw({event:'Stop'});
  assert.equal(runtime.hasActiveTurn(),false);
  const replay=runtime.turnEvents('turn-emit-fails',0);assert.deepEqual(replay.events.map(event=>event.type),['turn_started','segment_done','turn_done']);assert.equal(replay.finished,true);
});

const waitFor=async check=>{for(let index=0;index<100;index++){if(check())return;await new Promise(resolve=>setTimeout(resolve,2))}throw new Error('condition not reached')};

test('thought snapshot is journaled in order, incrementally replaced and recoverable after completion',async()=>{
  const events=[],logs=[],record={runtimeId:'runtime-main',sessionName:'dwell',workspace:'/srv/app'};
  let snapshot={version:1,cursor:10,items:[{id:'a',type:'thinking',text:'first',order:0}]};
  const turnStore=createTurnStore(),runtime=createClaudeTmuxRuntime({config:{enabled:true,runtimeId:'runtime-main',submitDelayMs:0,stopTimeoutMs:10},transport:{sendPrompt:async()=>{},thoughtSnapshot:async()=>snapshot,complete:async()=>{}},registry:{load:async()=>record,get:()=>record,reconcile:async()=>({state:'connected',runtime:record})},turnStore,ingress:createClaudeIngress(),log:value=>logs.push(value)});
  await runtime.initialize();await runtime.chat({runtimeId:'runtime-main',turnId:'thought-turn',prompt:'fixture',emit:event=>events.push(event)});await waitFor(()=>events.some(event=>event.type==='thought_process'));
  snapshot={version:1,cursor:20,items:[{id:'a',type:'thinking',text:'first extended',order:0},{id:'tool',type:'tool_call',toolName:'Read',displayName:'读取',inputSummary:'',status:'completed',order:1},{id:'b',type:'thinking',text:'second',order:2}]};
  await waitFor(()=>events.filter(event=>event.type==='thought_process').length===2);await runtime.ingestRaw({event:'Stop'});
  const replay=runtime.turnEvents('thought-turn',0),thoughts=replay.events.filter(event=>event.type==='thought_process');
  assert.deepEqual(thoughts.map(event=>event.items.map(item=>item.id)),[['a'],['a','tool','b']]);
  assert.deepEqual(replay.events.map(event=>event.seq),replay.events.map((_,index)=>index+1));
  assert.equal(replay.events.at(-1).type,'turn_done');assert.equal(replay.finished,true);assert.equal(logs.some(entry=>entry.event==='thought_sync_error'),false);
});

test('thought polling failure is safely observable and a later poll retries successfully',async()=>{
  const events=[],logs=[],record={runtimeId:'runtime-main',sessionName:'dwell',workspace:'/srv/app'};let calls=0;
  const turnStore=createTurnStore(),runtime=createClaudeTmuxRuntime({config:{enabled:true,runtimeId:'runtime-main',submitDelayMs:0,stopTimeoutMs:10},transport:{sendPrompt:async()=>{},thoughtSnapshot:async()=>{calls++;if(calls===1)throw Object.assign(new Error('private payload must not be logged'),{statusCode:504});return {version:1,cursor:30,items:[{id:'safe',type:'thinking',text:'private thought'}]}},complete:async()=>{}},registry:{load:async()=>record,get:()=>record,reconcile:async()=>({state:'connected',runtime:record})},turnStore,ingress:createClaudeIngress(),log:value=>logs.push(value)});
  await runtime.initialize();await runtime.chat({runtimeId:'runtime-main',turnId:'retry-turn',prompt:'fixture',emit:event=>events.push(event)});await waitFor(()=>events.some(event=>event.type==='thought_process'));await runtime.ingestRaw({event:'Stop'});
  const failure=logs.find(entry=>entry.event==='thought_sync_error'),recovery=logs.find(entry=>entry.event==='thought_sync_recovered');
  assert.deepEqual({pipelineStage:failure.pipelineStage,errorClass:failure.errorClass,errorCode:failure.errorCode,turnId:failure.turnId},{pipelineStage:'transport',errorClass:'Error',errorCode:'504',turnId:'retry-turn'});
  assert.equal(JSON.stringify(logs).includes('private payload must not be logged'),false);assert.equal(JSON.stringify(logs).includes('private thought'),false);assert.equal(recovery.failureCount,1);
});

test('turn without thought or tool items emits no thought cloud event',async()=>{
  const events=[],record={runtimeId:'runtime-main',sessionName:'dwell',workspace:'/srv/app'};
  const runtime=createClaudeTmuxRuntime({config:{enabled:true,runtimeId:'runtime-main',submitDelayMs:0,stopTimeoutMs:10},transport:{sendPrompt:async()=>{},thoughtSnapshot:async()=>({version:1,cursor:1,items:[]}),complete:async()=>{}},registry:{load:async()=>record,get:()=>record,reconcile:async()=>({state:'connected',runtime:record})},turnStore:createTurnStore(),ingress:createClaudeIngress(),log:()=>{}});
  await runtime.initialize();await runtime.chat({runtimeId:'runtime-main',turnId:'plain-turn',prompt:'fixture',emit:event=>events.push(event)});await runtime.ingestRaw({event:'message_display',message_id:'m',index:0,delta:'ordinary final',final:true});await runtime.ingestRaw({event:'Stop'});
  assert.equal(events.some(event=>event.type==='thought_process'),false);assert.equal(events.some(event=>event.type==='segment_delta'),false);
});
