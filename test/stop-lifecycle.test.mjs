import assert from 'node:assert/strict';
import test from 'node:test';
import {createBridgeActiveTurn} from '../deploy/bridge-active-turn.mjs';
import {createBridgeStopController} from '../deploy/bridge-stop.mjs';
import {createClaudeTmuxRuntime} from '../src/runtimes/claude-tmux.mjs';
import {createClaudeIngress} from '../src/hooks/claude-ingress.mjs';
import {createTurnStore} from '../src/turns/turn-store.mjs';

function fixture({hookOnEscape=false}={}){
  const state=createBridgeActiveTurn(),events=[],logs=[];let escapes=0,runtime;
  const stop=createBridgeStopController({state,log:(event,turnId)=>logs.push({event,turnId}),sendEscape:async()=>{escapes++;if(hookOnEscape)await runtime.ingestRaw({event:'Stop'})}});
  const record={runtimeId:'runtime-main',sessionName:'dwell',workspace:'/root'};
  runtime=createClaudeTmuxRuntime({config:{enabled:true,stopTimeoutMs:5},registry:{load:async()=>record,get:()=>record,reconcile:async()=>({state:'connected',runtime:record})},turnStore:createTurnStore(),ingress:createClaudeIngress(),log:entry=>logs.push(entry),transport:{sendPrompt:async({turnId})=>{state.reserve(turnId);state.markSent(turnId)},interrupt:(_,id)=>stop.stop(id),complete:async id=>state.complete(id)}});
  return {state,events,logs,runtime,stop,escapes:()=>escapes,start:async(id='test-turn',signal)=>runtime.chat({signal,runtimeId:record.runtimeId,turnId:id,prompt:'mock only',emit:e=>events.push(e)}),halt:(id='test-turn')=>runtime.stop({runtimeId:record.runtimeId,turnId:id})};
}
const inactive=f=>{assert.equal(f.runtime.hasActiveTurn(),false);assert.equal(f.runtime.activeTurnId(),null);assert.equal(f.state.status().active,false);assert.equal(f.state.status().activeTurnId,null)};

test('A: normal Stop during Escape and duplicate complete close both sides once',async()=>{
  const f=fixture({hookOnEscape:true});await f.start();assert.equal((await f.halt()).status,'stopped');inactive(f);
  assert.equal(f.events.filter(e=>e.type==='turn_stopped').length,1);assert.equal(f.escapes(),1);
});
test('B: Escape release without any hook finalizes Node, including a disconnected subscriber',async()=>{
  const f=fixture();await f.start();const result=await f.halt();assert.equal(result.ok,true);assert.equal(result.status,'stop_unconfirmed');assert.equal(result.stopSent,true);assert.equal(result.turnReleased,true);inactive(f);
  assert.equal(f.events.at(-1).type,'turn_stopped');assert(f.logs.some(e=>e.event==='node_finalized'));
});
test('C: concurrent/repeated stop is idempotent and cannot stop a newer turn',async()=>{
  const f=fixture();await f.start();await Promise.all([f.halt(),f.halt()]);assert.equal(f.escapes(),1);assert.equal((await f.halt()).status,'already_stopped');
  await f.start('next-turn');assert.equal((await f.halt()).status,'already_stopped');assert.equal((await f.stop.stop('test-turn')).status,'already_stopped');assert.equal(f.state.get().turnId,'next-turn');assert.equal(f.runtime.activeTurnId(),'next-turn');await f.halt('next-turn');inactive(f);
});
test('D: late Stop/StopFailure after release are ignored, tagged stale hooks cannot close a new turn',async()=>{
  const f=fixture();await f.start();await f.halt();for(const event of ['Stop','StopFailure'])assert.equal((await f.runtime.ingestRaw({event})).accepted,false);inactive(f);
  await f.start('next-turn');assert.equal((await f.runtime.ingestRaw({event:'Stop',turnId:'test-turn'})).accepted,false);assert.equal(f.runtime.activeTurnId(),'next-turn');await f.halt('next-turn');
});
test('E: unknown turnId or runtimeId remains an error with no Escape',async()=>{
  const f=fixture();await f.start();await assert.rejects(f.halt('wrong'),e=>e.statusCode===409);await assert.rejects(f.stop.stop('wrong'),e=>e.status===409);await assert.rejects(f.runtime.stop({runtimeId:'wrong',turnId:'test-turn'}),e=>e.statusCode===409);assert.equal(f.escapes(),0);assert.equal(f.state.get().turnId,'test-turn');
});
test('F: MessageDisplay and normal Stop still emit the established normal completion sequence',async()=>{
  const f=fixture();await f.start();await f.runtime.ingestRaw({event:'MessageDisplay',message_id:'m',index:0,delta:'mock reply',final:true});await f.runtime.ingestRaw({event:'Stop'});inactive(f);assert.equal(f.escapes(),0);assert.deepEqual(f.events.map(e=>e.type),['turn_started','segment_delta','segment_done','turn_done']);
});
test('failed Escape never claims release or clears the bridge active turn',async()=>{
  const state=createBridgeActiveTurn();state.reserve('t');state.markSent('t');const stop=createBridgeStopController({state,sendEscape:async()=>{throw new Error('failed')}});await assert.rejects(stop.stop('t'),/failed/);assert.equal(state.get().turnId,'t');assert.equal(stop.isPending(),false);
});

test('HTTP stop acknowledgement and duplicate return 200; status exposes Node inactive',async()=>{
  const {createDwellServer}=await import('../server.mjs');
  const f=fixture();await f.start();const server=createDwellServer({claudeRuntime:f.runtime});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
  try{
    for(let i=0;i<2;i++){const response=await fetch(base+'/api/chat/stop',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({runtimeId:'runtime-main',turnId:'test-turn'})});assert.equal(response.status,200);assert.equal((await response.json()).ok,true)}
    const status=await (await fetch(base+'/api/runtimes/claude-tmux/status')).json();assert.equal(status.active,false);assert.equal(status.activeTurnId,null);inactive(f);
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r))}
});


test('network G: detached stream keeps ownership until Stop/complete, then readback is finished',async()=>{
 const f=fixture(),abort=new AbortController();await f.start('detached',abort.signal);abort.abort();
 assert.equal(f.runtime.turnStatus('detached').receivedByRuntime,true);assert.equal(f.runtime.turnStatus('detached').detached,true);assert.equal(f.runtime.hasActiveTurn(),true);
 await f.runtime.ingestRaw({event:'MessageDisplay',message_id:'m',index:0,delta:'private mock body',final:true});await f.runtime.ingestRaw({event:'Stop'});inactive(f);
 const status=f.runtime.turnStatus('detached');assert.equal(status.finished,true);assert.equal(status.hasOutput,true);assert.equal(status.active,false);assert.ok(!JSON.stringify(status).includes('private mock body'));
});

test('network D: disconnect after turn_started but before send records not_delivered',async()=>{
 const f=fixture(),abort=new AbortController();await assert.rejects(f.runtime.chat({runtimeId:'runtime-main',turnId:'unsent',prompt:'mock',signal:abort.signal,emit:()=>abort.abort()}));inactive(f);
 assert.equal(f.runtime.turnStatus('unsent').state,'not_delivered');assert.equal(f.runtime.turnStatus('unsent').receivedByRuntime,false);
});

test('network status GET is read-only, unknown stays unknown, no body is exposed',async()=>{
 const {createDwellServer}=await import('../server.mjs');const f=fixture();await f.start();const server=createDwellServer({claudeRuntime:f.runtime});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 try{
  const response=await fetch(base+'/api/chat/turn/test-turn/status');assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');const status=await response.json();assert.equal(status.receivedByRuntime,true);assert.equal(status.active,true);assert.equal(f.escapes(),0);
  for(const key of ['prompt','content','transcript','secret','env','argv'])assert.ok(!(key in status));
  const missing=await fetch(base+'/api/chat/turn/missing/status');assert.equal(missing.status,404);assert.deepEqual(await missing.json(),{turnId:'missing',state:'unknown',receivedByRuntime:null});assert.equal(f.runtime.activeTurnId(),'test-turn');
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await f.halt()}
});
