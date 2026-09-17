import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createTurnStore } from '../src/turns/turn-store.mjs';
import { createFrontendDelivery } from '../src/presentation/frontend-delivery.mjs';
import { createMcpHandler, createLocalDelivery, createLocalImageReader, frontendMessageTool, timeAnchorTool, frontendImageTool, validateFrontendDeliverySecret } from '../src/presentation/frontend-message-mcp.mjs';
import { photosMcpTools } from '../src/photos/photos-mcp.mjs';
import { createDwellServer } from '../server.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createClaudeTmuxRuntime } from '../src/runtimes/claude-tmux.mjs';
import { createClaudeIngress } from '../src/hooks/claude-ingress.mjs';
import { createBridgeActiveTurn } from '../deploy/bridge-active-turn.mjs';
import { createBridgeStopController } from '../deploy/bridge-stop.mjs';

function fixture() {
  const turnStore=createTurnStore(),events=[];
  const delivery=createFrontendDelivery({turnStore,runtimeId:'claude-main'});
  const start=(turnId='one')=>turnStore.start({runtimeId:'claude-main',turnId,emit:e=>events.push(e)});
  return {turnStore,events,delivery,start};
}
test('helper accepts only a resolved, well-formed delivery credential',()=>{assert.equal(validateFrontendDeliverySecret('s'.repeat(64)),'s'.repeat(64));for(const value of ['',undefined,'short','contains space','${DWELL_FRONTEND_DELIVERY_SECRET}'])assert.equal(validateFrontendDeliverySecret(value),'')});
test('delivery: one and three calls emit immediately on one active turn without finalize',()=>{
  const f=fixture();f.start();const send=f.delivery.bind();
  for(let i=0;i<3;i++){send({text:'message '+i},'request-identity-'+i);assert.equal(f.events.length,i+1)}
  assert(f.events.every(e=>e.type==='assistant_message'&&e.turnId==='one'&&e.source==='tool'));
  assert.equal(new Set(f.events.map(e=>e.messageId)).size,3);assert.equal(f.turnStore.get().closed,false);
  assert.equal(f.turnStore.status('one').hasOutput,true);
});
test('delivery: missing active or foreign runtime rejects instead of using latest turn',()=>{
  const f=fixture();assert.throws(()=>f.delivery.bind(),/No active/);
  f.turnStore.start({runtimeId:'other',turnId:'foreign',emit:()=>assert.fail()});assert.throws(()=>f.delivery.bind(),/No active/);
});
test('delivery: payload cannot select a turn/session/target or arbitrary capability',()=>{
  const f=fixture();f.start();const send=f.delivery.bind();
  for(const key of ['turnId','sessionId','target','channel','URL','path','command','model','metadata','recipient'])assert.throws(()=>send({text:'body',[key]:'anything'},'request-identity-1'),/Expected only/);
  for(const body of [null,[],{}, {text:''},{text:'  '},{text:3},{text:'x'.repeat(16385)}])assert.throws(()=>send(body,'request-identity-1'));
  assert.equal(f.events.length,0);
});
test('delivery: an old bound request cannot append to a newer turn',()=>{
  const f=fixture();f.start();const old=f.delivery.bind();f.turnStore.finish('claude-main','one',{type:'turn_done',turnId:'one'});f.start('two');
  assert.throws(()=>old({text:'late'},'request-identity-late'),/ended/);assert.equal(f.events.length,1);
});
test('delivery: duplicate receipt is idempotent, changed text or cross-turn identity is rejected',()=>{
  const f=fixture();f.start();const send=f.delivery.bind(),first=send({text:'hello'},'request-identity-1');
  assert.equal(send({text:'hello'},'request-identity-1').messageId,first.messageId);assert.equal(f.events.length,1);
  assert.throws(()=>send({text:'different'},'request-identity-1'),/Stale/);
  f.turnStore.finish('claude-main','one',{type:'turn_done',turnId:'one'});f.start('two');assert.throws(()=>f.delivery.bind()({text:'hello'},'request-identity-1'),/Stale/);
});
test('delivery: stopping preserves accepted messages and rejects further sends',()=>{
  const f=fixture();f.start();const send=f.delivery.bind();send({text:'one'},'request-identity-1');send({text:'two'},'request-identity-2');
  f.turnStore.requestStop('claude-main','one');assert.throws(()=>send({text:'three'},'request-identity-3'),/stopping/);
  f.turnStore.finish('claude-main','one',{type:'turn_stopped',turnId:'one'});assert.equal(f.turnStore.get(),null);
  assert.deepEqual(f.events.filter(e=>e.type==='assistant_message').map(e=>e.text),['one','two']);
});
test('delivery: detached stream journals accepted tool output for replay without a live emit',()=>{
  const f=fixture();f.start();f.turnStore.detached('one');const receipt=f.delivery.bind()({text:'recover me'},'request-identity-1');
  assert.ok(receipt.messageId);assert.equal(f.events.length,0);assert.equal(f.turnStore.status('one').hasOutput,true);assert.deepEqual(f.turnStore.replay('one',0).events.map(event=>event.text),['recover me']);
});
test('MCP exposes the delivery and read-only time tools; duplicate delivery calls do not append twice',async()=>{
  let calls=0;const handle=createMcpHandler({deliver:async()=>{calls++;return{ok:true,messageId:'receipt'}}});
  const rpc=(id,method,params)=>handle({jsonrpc:'2.0',id,method,params});
  await rpc(1,'initialize',{protocolVersion:'2025-06-18'});
  const tools=(await rpc(2,'tools/list')).result.tools;assert.deepEqual(tools,[frontendMessageTool,timeAnchorTool,frontendImageTool,...photosMcpTools]);
  assert.deepEqual(Object.keys(tools[0].inputSchema.properties),['text']);assert.equal(tools[0].inputSchema.additionalProperties,false);
  const params={name:'send_frontend_message',arguments:{text:'hello'}};
  const [a,b]=await Promise.all([rpc(3,'tools/call',params),rpc(3,'tools/call',params)]);assert.deepEqual(a,b);assert.equal(calls,1);
  assert((await rpc(3,'tools/call',{...params,arguments:{text:'changed'}})).error);
  assert.equal((await rpc(4,'tools/call',{...params,arguments:{text:'x',target:'Telegram'}})).result.isError,true);assert.equal(calls,1);
  assert((await rpc(5,'tools/call',{name:'exec',arguments:{text:'x'}})).error);
});
test('MCP image reader accepts only one opaque ID and returns true ImageContent',async()=>{
  const id='img_'+Buffer.alloc(32,7).toString('base64url');let reads=0;
  const handle=createMcpHandler({deliver:async()=>{},readFrontendImage:async value=>{reads++;assert.equal(value,id);return{data:Buffer.from('png'),mime:'image/png'}}});
  await handle({jsonrpc:'2.0',id:1,method:'initialize'});
  const response=await handle({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'read_frontend_image',arguments:{imageId:id}}});
  assert.deepEqual(response.result.content,[{type:'image',data:Buffer.from('png').toString('base64'),mimeType:'image/png'}]);assert.equal(reads,1);
  for(const arguments_ of [{imageId:'../secret'},{imageId:id,path:'/etc/passwd'},{}])assert((await handle({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'read_frontend_image',arguments:arguments_}})).error);
  assert.equal(reads,1);
});
test('local image reader uses one fixed loopback endpoint and rejects redirects or non-image output',async()=>{
  const id='img_'+Buffer.alloc(32,9).toString('base64url');let calls=0;
  const read=createLocalImageReader('s'.repeat(32),async(url,init)=>{calls++;assert.equal(url,'http://127.0.0.1:4173/api/internal/frontend-image');assert.equal(init.redirect,'error');assert.deepEqual(JSON.parse(init.body),{imageId:id});return new Response(Buffer.from('x'),{headers:{'content-type':'image/webp'}})});
  assert.deepEqual(await read(id),{data:Buffer.from('x'),mime:'image/webp'});assert.equal(calls,1);
});
test('MCP tool failures are explicit and never automatically retried',async()=>{
  let calls=0;const handle=createMcpHandler({deliver:async()=>{calls++;throw new Error('No active frontend turn')}});
  await handle({jsonrpc:'2.0',id:1,method:'initialize'});
  const result=await handle({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'send_frontend_message',arguments:{text:'x'}}});
  assert.equal(result.result.isError,true);assert.equal(calls,1);
});
test('MCP transport uses only fixed loopback endpoint, refuses redirects and makes one attempt',async()=>{
  let calls=0;const send=createLocalDelivery('s'.repeat(32),async(url,init)=>{
    calls++;assert.equal(url,'http://127.0.0.1:4173/api/internal/frontend-message');assert.equal(init.redirect,'error');assert.deepEqual(JSON.parse(init.body),{text:'hello'});
    return new Response('',{status:409});
  });await assert.rejects(send({text:'hello'},'request-identity-1'),/rejected/);assert.equal(calls,1);
});
test('authenticated endpoint rejects public-origin, wrong credentials and arbitrary target; valid tool is live',async t=>{
  const f=fixture();f.start();const secret='test-secret-'.repeat(4);
  const server=createDwellServer({claudeRuntime:{bindFrontendDelivery:()=>f.delivery.bind()},frontendDeliverySecret:secret});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close()});
  const url=`http://127.0.0.1:${server.address().port}/api/internal/frontend-message`;
  const post=(body,headers={})=>fetch(url,{method:'POST',headers:{'content-type':'application/json','x-frontend-delivery-secret':secret,'x-frontend-delivery-id':'request-identity-1',...headers},body:JSON.stringify(body)});
  assert.equal((await post({text:'hello'},{origin:'https://public.example'})).status,403);
  assert.equal((await post({text:'hello'},{'x-frontend-delivery-secret':'wrong'})).status,401);
  assert.equal((await post({text:'hello',turnId:'other'})).status,400);
  assert.equal(f.events.length,0);assert.equal((await post({text:'hello'})).status,200);assert.equal(f.events.length,1);
});
test('endpoint binds before body read: delayed body cannot reach a later active turn',async t=>{
  const f=fixture();f.start();let captured;const bound=new Promise(r=>captured=r),secret='x'.repeat(32);
  const server=createDwellServer({claudeRuntime:{bindFrontendDelivery:()=>{const send=f.delivery.bind();captured();return send}},frontendDeliverySecret:secret});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close()});
  const status=new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:'/api/internal/frontend-message',method:'POST',headers:{'x-frontend-delivery-secret':secret,'x-frontend-delivery-id':'request-identity-1','transfer-encoding':'chunked'}},res=>{res.resume();resolve(res.statusCode)});
    req.on('error',reject);req.write('{');
    bound.then(()=>{f.turnStore.finish('claude-main','one',{type:'turn_done',turnId:'one'});f.start('two');req.end('"text":"late"}')});
  });assert.equal(await status,409);assert.equal(f.events.filter(e=>e.type==='assistant_message').length,0);
});

test('MCP -> authenticated Node -> active turn -> fake bridge Stop closes once and keeps deliveries',async t=>{
  const bridge=createBridgeActiveTurn(),events=[],turnStore=createTurnStore();let escapes=0;
  const stopper=createBridgeStopController({state:bridge,sendEscape:async()=>{escapes++}});
  const record={runtimeId:'claude-main',sessionName:'dwell-claude',workspace:'/root'};
  const runtime=createClaudeTmuxRuntime({config:{enabled:true,runtimeId:'claude-main',stopTimeoutMs:5},turnStore,ingress:createClaudeIngress(),log:()=>{},registry:{get:()=>record,reconcile:async()=>({state:'connected',runtime:record})},transport:{sendPrompt:async({turnId})=>{bridge.reserve(turnId);bridge.markSent(turnId)},interrupt:(_,id)=>stopper.stop(id),complete:async id=>bridge.complete(id)}});
  await runtime.chat({runtimeId:'claude-main',turnId:'integration',prompt:'fake transport only',emit:e=>events.push(e)});
  const secret='z'.repeat(32),server=createDwellServer({claudeRuntime:runtime,frontendDeliverySecret:secret});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close()});
  const deliver=createLocalDelivery(secret,(url,init)=>{assert.equal(url,'http://127.0.0.1:4173/api/internal/frontend-message');return fetch(`http://127.0.0.1:${server.address().port}/api/internal/frontend-message`,init)});
  const handle=createMcpHandler({deliver});await handle({jsonrpc:'2.0',id:0,method:'initialize'});
  for(let id=1;id<=2;id++){assert(!(await handle({jsonrpc:'2.0',id,method:'tools/call',params:{name:'send_frontend_message',arguments:{text:'independent '+id}}})).result.isError);assert.equal(events.filter(e=>e.type==='assistant_message').length,id)}
  assert.equal(runtime.hasActiveTurn(),true);assert.equal(bridge.status().active,true);
  await runtime.stop({runtimeId:'claude-main',turnId:'integration'});await runtime.stop({runtimeId:'claude-main',turnId:'integration'});
  assert.equal(escapes,1);assert.equal(runtime.hasActiveTurn(),false);assert.equal(bridge.status().active,false);assert.equal(runtime.activeTurnId(),null);
  assert.equal(events.filter(e=>e.type==='assistant_message').length,2);assert.equal(events.filter(e=>e.type==='turn_stopped').length,1);
  assert.equal((await handle({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'send_frontend_message',arguments:{text:'late'}}})).result.isError,true);
});

test('real stdio MCP process fails closed before protocol startup without its credential',async()=>{
  const child=spawn(process.execPath,[fileURLToPath(new URL('../src/presentation/frontend-message-mcp.mjs',import.meta.url))],{env:{...process.env,DWELL_FRONTEND_DELIVERY_SECRET:''},stdio:['pipe','pipe','pipe']});
  let output='',errors='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>errors+=c);
  const exit=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)});
  child.stdin.end();assert.equal(await exit,78);assert.equal(output,'');assert.match(errors,/credential unavailable/);assert.doesNotMatch(errors,/DWELL_FRONTEND_DELIVERY_SECRET|\$\{/);
});
