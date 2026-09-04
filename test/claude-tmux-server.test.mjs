import assert from 'node:assert/strict';
import test from 'node:test';
import { createClaudeIngress } from '../src/hooks/claude-ingress.mjs';
import { createClaudeTmuxRuntime } from '../src/runtimes/claude-tmux.mjs';
import { createTurnStore } from '../src/turns/turn-store.mjs';
import { createDwellServer } from '../server.mjs';

const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const close=server=>new Promise(resolve=>server.close(resolve));

function runtimeFixture(){
  const record={runtimeId:'runtime-main',sessionName:'dwell',workspace:'/srv/app'},prompts=[],interrupts=[];
  const transport={sendPrompt:async value=>prompts.push(value),interrupt:async value=>interrupts.push(value)};
  const registry={load:async()=>record,get:()=>record,reconcile:async()=>({state:'connected',runtime:record,inspection:{alive:true}})};
  const runtime=createClaudeTmuxRuntime({config:{enabled:true,submitDelayMs:250,stopTimeoutMs:100},transport,registry,turnStore:createTurnStore(),ingress:createClaudeIngress()});
  return {runtime,prompts,interrupts};
}

test('server dispatches tmux chat, accepts protected hooks and streams NDJSON',async()=>{
  const fixture=runtimeFixture();await fixture.runtime.initialize();
  const server=createDwellServer({claudeRuntime:fixture.runtime,hookSecret:'secret'});const port=await listen(server);const base=`http://127.0.0.1:${port}`;
  try{
    const response=await fetch(`${base}/api/chat`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({config:{runtime:'claude_tmux',runtimeId:'runtime-main'},messages:[{role:'user',content:'old'},{role:'assistant',content:'history'},{role:'user',content:'new only'}]})});
    assert.equal(fixture.prompts[0].prompt,'new only');
    const unauthorized=await fetch(`${base}/api/internal/claude-code/events`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(unauthorized.status,401);
    for(const payload of [{event:'message_display',message_id:'m',index:0,delta:'Hi',final:true},{event:'Stop'}]){
      const hook=await fetch(`${base}/api/internal/claude-code/events`,{method:'POST',headers:{'content-type':'application/json','x-dwell-hook-secret':'secret'},body:JSON.stringify(payload)});assert.equal(hook.status,200);
    }
    const events=(await response.text()).trim().split('\n').map(JSON.parse);
    assert.deepEqual(events.map(event=>event.type),['turn_started','segment_delta','segment_done','turn_done']);
  }finally{await close(server)}
});

test('stop endpoint sends Escape and waits for a real late Stop hook',async()=>{
  const fixture=runtimeFixture();await fixture.runtime.initialize();
  const server=createDwellServer({claudeRuntime:fixture.runtime,hookSecret:'secret'});const port=await listen(server);const base=`http://127.0.0.1:${port}`;
  try{
    const response=await fetch(`${base}/api/chat`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({config:{runtime:'claude_tmux',runtimeId:'runtime-main'},messages:[{role:'user',content:'long'}]})});
    const stopPromise=fetch(`${base}/api/chat/stop`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({runtimeId:'runtime-main',turnId:fixture.prompts[0].turnId})});
    await new Promise(resolve=>setTimeout(resolve,5));
    await fetch(`${base}/api/internal/claude-code/events`,{method:'POST',headers:{'content-type':'application/json','x-dwell-hook-secret':'secret'},body:JSON.stringify({event:'Stop'})});
    const stop=await stopPromise;assert.equal(stop.status,200);assert.deepEqual(fixture.interrupts,['dwell']);
    const events=(await response.text()).trim().split('\n').map(JSON.parse);assert.equal(events.at(-1).type,'turn_stopped');
  }finally{await close(server)}
});

test('send failure after streaming starts emits a structured terminal error',async()=>{
  const fixture=runtimeFixture();
  fixture.runtime=createClaudeTmuxRuntime({
    config:{enabled:true,submitDelayMs:250,stopTimeoutMs:100},
    transport:{sendPrompt:async()=>{throw new Error('bridge send failed')}},
    registry:{load:async()=>({runtimeId:'runtime-main',sessionName:'dwell'}),get:()=>({runtimeId:'runtime-main',sessionName:'dwell'}),reconcile:async()=>({state:'connected',runtime:{runtimeId:'runtime-main',sessionName:'dwell'}})},
    turnStore:createTurnStore(),ingress:createClaudeIngress()
  });
  await fixture.runtime.initialize();
  const server=createDwellServer({claudeRuntime:fixture.runtime,hookSecret:'secret'});const port=await listen(server);
  try{
    const response=await fetch(`http://127.0.0.1:${port}/api/chat`,{method:'POST',headers:{'content-type':'application/json','accept':'application/x-ndjson'},body:JSON.stringify({config:{runtime:'claude_tmux',runtimeId:'runtime-main'},messages:[{role:'user',content:'test'}]})});
    assert.equal(response.status,200);
    const events=(await response.text()).trim().split('\n').map(JSON.parse);
    assert.deepEqual(events.map(event=>event.type),['turn_started','turn_error']);
    assert.equal(events[1].error,'bridge send failed');
  }finally{await close(server)}
});
