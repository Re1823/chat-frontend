import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,sep} from 'node:path';
import {createDesireShadow,DESIRE_SHADOW_FLAGS} from '../src/non/desire-shadow.mjs';
import {createDesireDashboard} from '../src/non/desire-dashboard.mjs';
import {openNonStore} from '../src/non/store.mjs';
import {DRIVE_KEYS,QIUQIU_DESIRE_CONFIG} from '../src/non/drive.mjs';
import {createClaudeTurnQueue} from '../server.mjs';

const turnId='12345678-1234-4123-8123-123456789abc';
const HOUR=3_600_000;
const waitFor=async predicate=>{const start=Date.now();while(!await predicate()){if(Date.now()-start>3000)throw new Error('timed out');await new Promise(resolve=>setTimeout(resolve,10))}};
async function fixture(run){
  const dir=await mkdtemp(join(tmpdir(),'non-phase3-'));
  let failure;
  try{await run({path:join(dir,'desire.sqlite'),queuePath:join(dir,'queue.json')})}
  catch(error){failure=error}
  finally{const resolved=await realpath(dir),root=await realpath(tmpdir());if(!resolved.startsWith(root+sep)||!resolved.split(sep).at(-1).startsWith('non-phase3-'))throw Error('unsafe cleanup');try{await rm(resolved,{recursive:true,force:false,maxRetries:3,retryDelay:20})}catch(error){if(!failure)throw error}}
  if(failure)throw failure;
}
const event=(eventType,at=1_000,extras={})=>({turnId,eventType,at,source:'authoritative_chat',productionTurn:true,
  role:eventType==='user_message'?'user':'assistant',...(eventType==='assistant_message'?{messageSource:'authoritative_chat'}:{}),...extras});

test('synthetic authoritative event initializes 14 values, persists, and UI reads without advancing',async()=>fixture(async({path})=>{
  assert.deepEqual(DESIRE_SHADOW_FLAGS,{SHADOW_ONLY:true,AWARENESS_ENABLED:false,PROACTIVE_ENABLED:false,WHITELIST_RECALL_ENABLED:false});
  const logs=[],shadow=createDesireShadow({path,now:()=>1_000,random:()=>0,log:record=>logs.push(record)});
  assert.equal((await createDesireDashboard({path}).snapshot()).available,false);
  assert.equal((await shadow.observe(event('user_message'))).status,'accepted');
  const store=await openNonStore({path});
  const first=store.loadDesire();
  assert.deepEqual(Object.keys(first.state.values),DRIVE_KEYS);
  assert.equal(first.state.values.touch,QIUQIU_DESIRE_CONFIG.initialValue);
  assert.equal(first.state.values.grieve,0);
  assert.equal(first.state.lastUpdatedAt,1_000);
  assert.equal(first.thoughts.length,0);
  assert.equal(store.schemaTables().includes('desire_shadow_events'),true);
  store.close();
  const dashboard=createDesireDashboard({path,now:()=>10*HOUR});
  const snapshot=await dashboard.snapshot();
  assert.equal(snapshot.available,true);assert.equal(snapshot.snapshot.lastUpdatedAt,1_000);
  assert.equal(snapshot.thoughts.length,0);assert.equal(snapshot.recallEnabled,false);
  assert.equal(logs[0].driveUpdated,true);
}));

test('completed event progresses elapsed time; same timestamp and duplicate identity are idempotent after restart',async()=>fixture(async({path})=>{
  let shadow=createDesireShadow({path,now:()=>1_000,random:()=>0,log:()=>{}});
  await shadow.observe(event('user_message'));
  const at=1_000+HOUR;
  assert.equal((await shadow.observe(event('turn_completed',at))).status,'accepted');
  let store=await openNonStore({path});let state=store.loadDesire().state;
  assert.equal(state.lastUpdatedAt,at);assert.ok(Math.abs(state.values.touch-(.1+QIUQIU_DESIRE_CONFIG.touchGrowPerHour))<1e-12);
  assert.ok(state.pick?.winner);store.close();
  shadow=createDesireShadow({path,now:()=>at,random:()=>.99,log:()=>{}});
  assert.equal((await shadow.observe(event('turn_completed',at))).status,'duplicate_ignored');
  assert.equal((await shadow.observe(event('assistant_message',at))).status,'accepted');
  store=await openNonStore({path});assert.deepEqual(store.loadDesire().state,state);store.close();
  assert.equal((await shadow.observe(event('user_message',at+10*HOUR,{turnId:'12345678-1234-4123-8123-123456789abd'}))).status,'accepted');
  store=await openNonStore({path});assert.equal(store.loadDesire().state.lastAppliedMs,6*HOUR);store.close();
}));

test('replay, recovery, tool, internal, proactive and untrusted sources never initialize Desire',async()=>fixture(async({path})=>{
  const shadow=createDesireShadow({path,log:()=>{}});
  for(const variant of [{replay:true},{recovery:true},{tool:true},{internal:true},{proactive:true},
    {source:'dashboard'},{productionTurn:false},{role:'tool'},{messageSource:'tool',eventType:'assistant_message',role:'assistant'}]) {
    assert.equal((await shadow.observe(event('user_message',1_000,variant))).status,'skipped');
  }
  const store=await openNonStore({path});assert.equal(store.loadDesire().state,null);store.close();
}));

test('plain text and retired structured-experience material never create Thought',async()=>fixture(async({path})=>{
  const logs=[],shadow=createDesireShadow({path,log:record=>logs.push(record)});
  await shadow.observe(event('user_message',1_000,{text:'PRIVATE_CHAT_BODY',thinking:'PRIVATE_THINKING',toolOutput:'PRIVATE_TOOL'}));
  let store=await openNonStore({path});assert.equal(store.loadDesire().thoughts.length,0);store.close();
  const second='12345678-1234-4123-8123-123456789abd';
  await shadow.observe(event('turn_completed',1_001,{turnId:second,material:{origin:'structured_experience',dimension:'curiosity',text:'看见一只小鸟'}}));
  store=await openNonStore({path});assert.equal(store.loadDesire().thoughts.length,0);store.close();
  assert.equal(JSON.stringify(logs).includes('PRIVATE_CHAT_BODY'),false);
  assert.equal(JSON.stringify(logs).includes('看见一只小鸟'),false);
  const bytes=await readFile(path);
  assert.equal(bytes.includes(Buffer.from('PRIVATE_CHAT_BODY')),false);
  assert.equal(bytes.includes(Buffer.from('PRIVATE_THINKING')),false);
  assert.equal(bytes.includes(Buffer.from('PRIVATE_TOOL')),false);
}));

test('only verified structured action applies existing satisfaction, atomically and once',async()=>fixture(async({path})=>{
  const shadow=createDesireShadow({path,log:()=>{}});
  await shadow.observe(event('user_message',1_000));
  const next='12345678-1234-4123-8123-123456789abd';
  await shadow.observe(event('turn_completed',1_000,{turnId:next,action:{origin:'verified_system_event',name:'duty_completed'}}));
  let store=await openNonStore({path});const first=store.loadDesire().state;
  assert.equal(first.values.duty,.05);assert.equal(first.satisfactionEvents.length,1);store.close();
  await shadow.observe(event('turn_completed',1_000,{turnId:next,action:{origin:'verified_system_event',name:'duty_completed'}}));
  store=await openNonStore({path});assert.deepEqual(store.loadDesire().state,first);store.close();
}));

test('shadow DB failure returns bounded error without raw text',async()=>{
  const logs=[],shadow=createDesireShadow({path:'bad',openStore:async()=>{throw Error('PRIVATE_CHAT_BODY')},log:record=>logs.push(record)});
  assert.equal((await shadow.observe(event('user_message',1_000,{text:'PRIVATE_CHAT_BODY'}))).status,'error');
  assert.equal(JSON.stringify(logs).includes('PRIVATE_CHAT_BODY'),false);
});

test('a failed shadow transaction records neither event identity nor partial state',async()=>fixture(async({path})=>{
  const store=await openNonStore({path});
  const identity={eventId:`${turnId}:user_message`,turnId,eventType:'user_message',occurredAt:1_000};
  assert.throws(()=>store.applyDesireShadowEvent(identity, staging=>{
    staging.saveDesire({values:{touch:.1},lastUpdatedAt:1_000},[]);
    throw Error('fixture rollback');
  }),/fixture rollback/);
  assert.equal(store.loadDesire().state,null);
  assert.equal(store.applyDesireShadowEvent(identity, staging=>{
    staging.saveDesire({values:{touch:.1},lastUpdatedAt:1_000},[]);
    return 'committed';
  }).duplicate,false);
  assert.equal(store.applyDesireShadowEvent(identity,()=>{throw Error('must dedup')}).duplicate,true);
  store.close();
}));

test('FIFO completion sends metadata only; tool delivery, failures, retries and observer rejection cannot alter chat',async()=>fixture(async({path,queuePath})=>{
  const logs=[],shadow=createDesireShadow({path,log:record=>logs.push(record)});
  const prompts=[],outputs=[];
  const runtime={reserveRequest:()=>({created:true}),preflight:async()=>{},hasActiveTurn:()=>false,
    status:async()=>({state:'connected'}),isTerminalEvent:e=>['turn_done','turn_error','turn_stopped'].includes(e.type),
    chat:async({prompt,emit,turnId})=>{prompts.push(prompt);emit({type:'turn_started',turnId});if(prompt==='FAIL'){emit({type:'turn_error',turnId,error:'fixture failure'});return}emit({type:'assistant_message',turnId,source:'tool',text:'PRIVATE_TOOL_OUTPUT'});emit({type:'turn_done',turnId})}};
  const queue=createClaudeTurnQueue({path:queuePath,claudeRuntime:runtime,desireShadow:shadow,retryMs:5});await queue.initialize();
  await queue.enqueue({clientRequestId:'synthetic-1',runtimeId:'claude-main',prompt:'PRIVATE_USER_BODY'},
    {emit:e=>outputs.push(e)});
  await waitFor(()=>queue.snapshot().items[0]?.status==='finished');
  await waitFor(()=>logs.filter(x=>x.status==='accepted').length===2);
  assert.deepEqual(prompts,['PRIVATE_USER_BODY']);
  assert.equal(outputs.some(e=>e.type==='assistant_message'&&e.text==='PRIVATE_TOOL_OUTPUT'),true);
  const store=await openNonStore({path});
  const result=store.loadDesire();assert.equal(result.thoughts.length,0);
  assert.equal(result.state.satisfactionEvents.length,0);store.close();
  assert.deepEqual(logs.filter(x=>x.status==='accepted').map(x=>x.eventType),['user_message','turn_completed']);
  assert.equal(JSON.stringify(logs).includes('PRIVATE_USER_BODY'),false);
  assert.equal(JSON.stringify(logs).includes('PRIVATE_TOOL_OUTPUT'),false);
  const retry=await queue.enqueue({clientRequestId:'synthetic-1',runtimeId:'claude-main',prompt:'PRIVATE_USER_BODY'});
  assert.equal(retry.created,false);
  await queue.enqueue({clientRequestId:'synthetic-failed',runtimeId:'claude-main',prompt:'FAIL'});
  await waitFor(()=>queue.snapshot().items.at(-1)?.status==='failed');
  assert.equal(logs.filter(x=>x.status==='accepted').length,2);
  assert.deepEqual(prompts,['PRIVATE_USER_BODY','FAIL']);
  queue.close();

  const failedPath=queuePath+'.failed';
  const badQueue=createClaudeTurnQueue({path:failedPath,claudeRuntime:runtime,desireShadow:{observe(){return Promise.reject(Error('shadow failure'))}},retryMs:5});
  await badQueue.initialize();await badQueue.enqueue({clientRequestId:'synthetic-2',runtimeId:'claude-main',prompt:'untouched'});
  await waitFor(()=>badQueue.snapshot().items[0]?.status==='finished');badQueue.close();
}));
