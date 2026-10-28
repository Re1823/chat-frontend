import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,sep} from 'node:path';
import {parseThoughtTaggedMessage,stripThoughtTagFromHistory} from '../src/non/thought-tag.mjs';
import {createThoughtAuthoring} from '../src/non/thought-authoring.mjs';
import {createFrontendDelivery} from '../src/presentation/frontend-delivery.mjs';
import {createTurnStore} from '../src/turns/turn-store.mjs';
import {openNonStore} from '../src/non/store.mjs';
import {DRIVE_KEYS,KNOWN_GROW_PER_HOUR,SATURATE_CEIL,SATURATE_FLOOR,INTENT_CANDIDATE_BAND,
  QIUQIU_SUBJECTIVE_VOICE,QIUQIU_DESIRE_CONFIG} from '../src/non/drive.mjs';
import {QIUQIU_THOUGHT_CONFIG,decayFlit,reachedKnownPromotionThreshold,tickFixation} from '../src/non/thoughts.mjs';
import {productionConversationSnapshot} from '../src/runtimes/production-conversation.mjs';
import {authoritativeConversationalTurns,FRONTEND_MESSAGE_TOOL} from '../src/runtimes/rsc/authoritative-turns.mjs';
import {rewriteTurns} from '../src/runtimes/rsc/writer.mjs';
import {createClaudeTurnQueue,createDwellServer} from '../server.mjs';

const a='12345678-1234-4123-8123-123456789abc',b='12345678-1234-4123-8123-123456789abd';
async function fixture(run){
  const dir=await mkdtemp(join(tmpdir(),'non-phase4-'));
  try {await run(join(dir,'desire.sqlite'));}
  finally {const actual=await realpath(dir),root=await realpath(tmpdir());
    if(!actual.startsWith(root+sep)||!actual.split(sep).at(-1).startsWith('non-phase4-'))throw Error('unsafe test cleanup');
    await rm(actual,{recursive:true,force:false});}
}

test('author values and Qiuqiu choices remain explicitly separated',()=>{
  assert.equal(QIUQIU_THOUGHT_CONFIG.initialStrength,.50);
  assert.equal(decayFlit(.50),.41);
  assert.equal(reachedKnownPromotionThreshold(.80),false);
  assert.equal(reachedKnownPromotionThreshold(.81),true);
  assert.equal(tickFixation(.78,0).driveDelta,.18);
  assert.equal(tickFixation(.8,2).exits,true);
  assert.deepEqual(KNOWN_GROW_PER_HOUR,{possess:.105,monitor:.090,crave:.060,share:.045,
    libido:.020,curiosity:.030,boredom:.030,social:.025,duty:.022,reflection:.013,grieve:0,anger:0});
  assert.equal(SATURATE_CEIL,.80);assert.equal(SATURATE_FLOOR,.65);
  assert.equal(INTENT_CANDIDATE_BAND,.12);
  assert.equal(Object.keys(QIUQIU_SUBJECTIVE_VOICE).length,14);
  assert.equal(DRIVE_KEYS.includes('touch')&&DRIVE_KEYS.includes('joy'),true);
  assert.equal(QIUQIU_DESIRE_CONFIG.satisfaction.monitor_checked.monitor,.70);
  assert.equal(QIUQIU_DESIRE_CONFIG.satisfaction.duty_completed.duty,.50);
});

test('Qiuqiu hidden adapter accepts at most one complete, bounded, known-drive suffix',()=>{
  assert.deepEqual(parseThoughtTaggedMessage('普通回复'),{visibleText:'普通回复',thought:null,tagged:false});
  const valid=parseThoughtTaggedMessage('普通回复\n<念 drive="curiosity">我想知道她看见了什么</念>');
  assert.equal(valid.visibleText,'普通回复');assert.deepEqual(valid.thought,{dimension:'curiosity',text:'我想知道她看见了什么'});
  for(const key of DRIVE_KEYS)assert.equal(parseThoughtTaggedMessage(`好<念 drive="${key}">我有个念头</念>`).thought.dimension,key);
  for(const bad of ['好<念 drive="curiosity">未闭合','好</念>','好<念 drive="unknown">我想</念>',
    '好<念 drive="joy"></念>','好<念 drive="joy">x</念><念 drive="joy">y</念>',
    `好<念 drive="joy">${'字'.repeat(121)}</念>`,'<念 drive="joy">我想</念>'])
    assert.throws(()=>parseThoughtTaggedMessage(bad),/INVALID_THOUGHT_TAG/);
  assert.equal(stripThoughtTagFromHistory('好<念 drive="joy">秘密</念>'),'好');
  assert.equal(stripThoughtTagFromHistory('好<念 drive="joy">未闭合'),'好');
  assert.equal(parseThoughtTaggedMessage('前文<念 drive="joy">我真开心</念>后文').visibleText,'前文后文');
  assert.equal(stripThoughtTagFromHistory('前文<念 drive="unknown">秘密</念>后文'),'前文后文');
  assert.equal(stripThoughtTagFromHistory('前文<念 drive="joy">甲</念>中间<念 drive="joy">乙</念>后文'),'前文中间后文');
});

test('synthetic Claude tool text writes one flit before emitting visible text; replay and reconnect do not rewrite',async()=>fixture(async path=>{
  const store=createTurnStore(),events=[];
  const writer=createThoughtAuthoring({path,now:()=>1_000});
  const delivery=createFrontendDelivery({turnStore:store,runtimeId:'claude-main',
    recordThought:({turnId,thought})=>writer({turnId,thought})});
  store.start({runtimeId:'claude-main',turnId:a,emit:event=>events.push(event)});
  const send=delivery.bind();
  await send({text:'普通回复'},'plain-request-identity');
  assert.equal(events.at(-1).text,'普通回复');
  const tagged='另一颗气泡<念 drive="curiosity">我想知道她看见了什么</念>';
  const receipt=await send({text:tagged},'tagged-request-identity');
  assert.equal(events.at(-1).text,'另一颗气泡');assert.equal(events.some(e=>JSON.stringify(e).includes('<念')),false);
  let db=await openNonStore({path});let loaded=db.loadDesire();
  assert.equal(loaded.thoughts.length,1);assert.equal(loaded.thoughts[0].strength,.50);
  assert.equal(loaded.thoughts[0].dimension,'curiosity');db.close();
  assert.equal((await send({text:tagged},'tagged-request-identity')).duplicate,true);
  assert.equal(store.replay(a,0).events.filter(e=>e.type==='assistant_message').length,2);
  await send({text:'第三颗<念 drive="touch">另一个念头</念>'},'third-request-identity');
  db=await openNonStore({path});assert.equal(db.loadDesire().thoughts.length,1);db.close();
  store.finish('claude-main',a,{type:'turn_done',turnId:a});
  const next=createFrontendDelivery({turnStore:store,runtimeId:'claude-main',recordThought:({turnId,thought})=>writer({turnId,thought})});
  store.start({runtimeId:'claude-main',turnId:b,emit:event=>events.push(event)});
  await next.bind()({text:'又想到<念 drive="curiosity">我想知道她看见了什么</念>'},'next-request-identity');
  db=await openNonStore({path});loaded=db.loadDesire();assert.equal(loaded.thoughts.length,1);
  assert.equal(loaded.thoughts[0].strength,.65);db.close();
  assert.equal(receipt.ok,true);
}));

test('malformed/unknown/multiple tags create no Thought and never leak protocol',()=>{
  const store=createTurnStore(),events=[];
  store.start({runtimeId:'claude-main',turnId:a,emit:event=>events.push(event)});
  const send=createFrontendDelivery({turnStore:store,runtimeId:'claude-main'}).bind();
  send({text:'可见<念 drive="joy">半截'},'malformed-identity');
  send({text:'前<念 drive="unknown">秘密</念>后'},'unknown-identity');
  send({text:'前<念 drive="joy">甲</念>中<念 drive="joy">乙</念>后'},'multiple-identity');
  send({text:'可见<念 drive="joy">秘密</念>'},'valid-disabled-identity');
  assert.deepEqual(events.map(e=>e.text),['可见','前后','前中后','可见']);
  assert.equal(JSON.stringify(events).includes('<念'),false);
});

test('Thought DB failure is bounded and chat delivery remains successful once',async()=>{
  const store=createTurnStore(),events=[],diagnostics=[];
  store.start({runtimeId:'claude-main',turnId:a,emit:event=>events.push(event)});
  const send=createFrontendDelivery({turnStore:store,runtimeId:'claude-main',
    recordThought:async()=>{throw Error('PRIVATE_DB_PATH_AND_THOUGHT')},
    onThoughtDiagnostic:record=>diagnostics.push(record)}).bind();
  const text='前<念 drive="joy">PRIVATE_THOUGHT</念>后';
  const first=await send({text},'failed-write-identity');
  assert.equal(first.ok,true);assert.deepEqual(events.map(e=>e.text),['前后']);
  assert.equal((await send({text},'failed-write-identity')).duplicate,true);
  assert.equal(events.length,1);
  assert.equal(JSON.stringify(diagnostics).includes('PRIVATE'),false);
  assert.deepEqual(diagnostics.map(d=>d.status),['write_failed']);
});

test('internal HTTP delivery waits for the async Thought write and returns a real receipt',async t=>fixture(async path=>{
  const turnStore=createTurnStore(),events=[],secret='phase4-secret-'.repeat(3);
  turnStore.start({runtimeId:'claude-main',turnId:a,emit:event=>events.push(event)});
  const delivery=createFrontendDelivery({turnStore,runtimeId:'claude-main',
    recordThought:createThoughtAuthoring({path,now:()=>1_000})});
  const server=createDwellServer({claudeRuntime:{bindFrontendDelivery:()=>delivery.bind()},
    frontendDeliverySecret:secret});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();server.close()});
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/internal/frontend-message`,{
    method:'POST',headers:{'content-type':'application/json','x-frontend-delivery-secret':secret,
      'x-frontend-delivery-id':'phase4-http-delivery'},
    body:JSON.stringify({text:'前<念 drive="joy">我被这件事点亮了</念>后'})});
  assert.equal(response.status,200);
  const receipt=await response.json();
  assert.equal(receipt.ok,true);assert.equal(typeof receipt.messageId,'string');
  assert.deepEqual(events.map(event=>event.text),['前后']);
  const db=await openNonStore({path});assert.equal(db.loadDesire().thoughts.length,1);db.close();
}));

test('an in-flight hidden write never streams a tag fragment or a premature bubble',async()=>{
  const store=createTurnStore(),events=[];
  store.start({runtimeId:'claude-main',turnId:a,emit:event=>events.push(event)});
  let finish;
  const pending=new Promise(resolve=>{finish=resolve});
  const send=createFrontendDelivery({turnStore:store,runtimeId:'claude-main',
    recordThought:()=>pending}).bind();
  const receipt=send({text:'可见<念 drive="joy">私密念头</念>'},'pending-request-identity');
  assert.equal(events.length,0);
  finish({written:true});await receipt;
  assert.deepEqual(events.map(event=>event.type),['assistant_message']);
  assert.equal(events[0].text,'可见');
  assert.equal(JSON.stringify(store.replay(a,0)).includes('私密念头'),false);
});

test('consumer transcript views strip hidden suffix instead of feeding raw text into later context',()=>{
  const user={uuid:'u',parentUuid:null,type:'user',userType:'external',message:{role:'user',content:'hello'}};
  const tool={uuid:'t',parentUuid:'u',type:'assistant',message:{role:'assistant',content:[{type:'tool_use',id:'call',name:FRONTEND_MESSAGE_TOOL,input:{text:'可见<念 drive="joy">SECRET_THOUGHT</念>'}}]}};
  const result={uuid:'r',parentUuid:'t',type:'user',message:{role:'user',content:[{type:'tool_result',tool_use_id:'call',content:'ok'}]}};
  const stop={uuid:'s',parentUuid:'r',type:'system',subtype:'stop_hook_summary'};
  const duration={uuid:'d',parentUuid:'s',type:'system',subtype:'turn_duration'};
  const records=[user,tool,result,stop,duration];
  const rsc=authoritativeConversationalTurns(records).turns[0];
  assert.equal(rsc.assistantText,'可见');
  assert.equal(JSON.stringify(rsc.assistantMessages).includes('SECRET_THOUGHT'),false);
  const snapshot=productionConversationSnapshot(records);
  assert.equal(snapshot.messages.at(-1).content,'可见');
  assert.equal(JSON.stringify(snapshot).includes('SECRET_THOUGHT'),false);
  const compactPrefix=rewriteTurns([rsc],'new-session');
  assert.equal(JSON.stringify(compactPrefix).includes('SECRET_THOUGHT'),false);
});

test('queued user prompt contains no Thought capability while image context stays intact',async()=>fixture(async path=>{
  await createThoughtAuthoring({path,now:()=>1_000})({turnId:a,
    thought:{dimension:'joy',text:'SECRET_THOUGHT'}});
  const queuePath=path+'.queue',prompts=[];
  const imageId='img_'+ 'a'.repeat(43);
  const imageStore={bind:async ids=>ids.map(id=>({imageId:id})),leaseTurn:()=>{}};
  const runtime={reserveRequest:()=>({created:true}),preflight:async()=>{},hasActiveTurn:()=>false,
    status:async()=>({state:'connected'}),isTerminalEvent:e=>e.type==='turn_done',
    chat:async({prompt,emit,turnId})=>{prompts.push(prompt);emit({type:'turn_started',turnId});emit({type:'turn_done',turnId})}};
  const queue=createClaudeTurnQueue({path:queuePath,claudeRuntime:runtime,imageStore,retryMs:5});
  await queue.initialize();
  await queue.enqueue({clientRequestId:'phase4-prompt',runtimeId:'claude-main',prompt:'用户的普通消息'});
  const waitForIdle=async(expectedCount)=>{const start=Date.now();while(queue.snapshot().items.length!==expectedCount||queue.snapshot().items.at(-1)?.status!=='finished'||queue.snapshot().running){
    if(Date.now()-start>10000)throw Error('queue fixture timeout');
    await new Promise(resolve=>setTimeout(resolve,10));
  }};
  await waitForIdle(1);
  await queue.enqueue({clientRequestId:'phase4-image',runtimeId:'claude-main',prompt:'请看这张图',imageIds:[imageId]});
  await waitForIdle(2);
  queue.close();
  assert.equal(prompts.length,2);
  assert.equal(prompts[0],'用户的普通消息');
  assert.match(prompts[1],/^<frontend_image_context>\n/);
  assert.match(prompts[1],new RegExp(imageId));
  assert.match(prompts[1],/\n<\/frontend_image_context>\n\n请看这张图$/);
  for(const prompt of prompts){
    assert.equal(prompt.includes('<frontend_thought_capability>'),false);
    assert.equal(prompt.includes('没有念头就不要写'),false);
    assert.equal(prompt.includes('SECRET_THOUGHT'),false);
  }
}));

test('direct chat route sends plain user text even if a backend Thought flag is supplied',async t=>{
  const prompts=[];
  const runtime={preflight:async()=>{},chat:async({prompt,emit,turnId})=>{
    prompts.push(prompt);emit({type:'turn_done',turnId});
  },isTerminalEvent:event=>event.type==='turn_done'};
  const server=createDwellServer({claudeRuntime:runtime,thoughtAuthoringEnabled:true});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();server.close()});
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/chat`,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
      config:{runtime:'claude_tmux',runtimeId:'claude-main'},
      messages:[{role:'user',content:'旧消息'},{role:'assistant',content:'旧回复'},
        {role:'user',content:'这是一条普通用户消息'}]})});
  assert.equal(response.status,200);await response.text();
  assert.deepEqual(prompts,['这是一条普通用户消息']);
});
