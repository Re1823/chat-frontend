import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {mkdtemp,readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createDwellServer} from '../server.mjs';
import {createPushSubscriptionStore} from '../src/push/subscription-store.mjs';
import {createPushService,safePushTarget} from '../src/push/service.mjs';

const publicUrl=new URL('../public/',import.meta.url),read=name=>readFile(new URL(name,publicUrl),'utf8');
const installationId='12345678-1234-4123-8123-123456789abc';
const subscription=(endpoint='https://push.example/device',expirationTime=null)=>({endpoint,expirationTime,keys:{p256dh:'A'.repeat(64),auth:'B'.repeat(24)}});

test('notification permission is click-only and no private VAPID key reaches public assets',async()=>{
  const [app,html,worker]=await Promise.all([read('app.js'),read('index.html'),read('sw.js')]);
  const toggle=app.match(/async function toggleNotifications\(\)\{[\s\S]*?\n\}/)?.[0]||'';
  assert.match(toggle,/Notification\.requestPermission\(\)/);assert.equal((app.match(/Notification\.requestPermission\(\)/g)||[]).length,1);
  assert.match(app,/notificationsButton'\)\.onclick=toggleNotifications/);assert.match(html,/id="notificationsButton"/);
  for(const source of [app,html,worker])assert.doesNotMatch(source,/QIUQIU_VAPID_PRIVATE_KEY|BEGIN (?:EC |)PRIVATE KEY/);
});

test('subscription store validates, persists, removes, and purges expired records',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'push-store-')),path=join(dir,'subscriptions.json'),clock={value:1000},store=createPushSubscriptionStore({path,now:()=>clock.value});await store.initialize();assert.deepEqual(JSON.parse(await readFile(path,'utf8')),{version:1,records:[]});
  await store.upsert({installationId,subscription:subscription()});assert.equal((await store.list()).length,1);assert.equal((await stat(path)).mode&0o777,process.platform==='win32'?(await stat(path)).mode&0o777:0o600);
  assert.equal(await store.remove({installationId,endpoint:'https://push.example/device'}),true);assert.equal((await store.list()).length,0);
  await store.upsert({installationId,subscription:subscription('https://push.example/expired',1500)});clock.value=2000;assert.equal((await store.list()).length,0);
  await assert.rejects(store.upsert({installationId,subscription:{endpoint:'http://insecure',keys:{p256dh:'x',auth:'y'}}}),/invalid_push_subscription/);
});

test('subscription API stays same-origin, bounded, durable, and exposes only the public key',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'push-api-')),store=createPushSubscriptionStore({path:join(dir,'subscriptions.json')});await store.initialize();
  const service={ready:true,publicConfig:()=>({supported:true,publicKey:'public-only'})},server=createDwellServer({claudeRuntime:{},pushStore:store,pushService:service});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  try{
    const config=await (await fetch(base+'/api/push/config')).json();assert.deepEqual(config,{supported:true,publicKey:'public-only'});assert.equal('privateKey' in config,false);
    const saved=await fetch(base+'/api/push/subscriptions',{method:'POST',headers:{'content-type':'application/json','sec-fetch-site':'same-origin',origin:base},body:JSON.stringify({installationId,subscription:subscription()})});assert.equal(saved.status,201);assert.equal((await store.list()).length,1);
    const cross=await fetch(base+'/api/push/subscriptions',{method:'POST',headers:{'content-type':'application/json','sec-fetch-site':'cross-site',origin:'https://evil.example'},body:'{}'});assert.equal(cross.status,403);
    const oversized=await fetch(base+'/api/push/subscriptions',{method:'POST',headers:{'content-type':'application/json','sec-fetch-site':'same-origin',origin:base},body:JSON.stringify({padding:'x'.repeat(33000)})});assert.equal(oversized.status,413);
    const removed=await fetch(base+'/api/push/subscriptions',{method:'DELETE',headers:{'content-type':'application/json','sec-fetch-site':'same-origin',origin:base},body:JSON.stringify({installationId,endpoint:'https://push.example/device'})});assert.equal(removed.status,200);assert.equal((await store.list()).length,0);
    assert.equal((await fetch(base+'/api/push/send',{method:'POST'})).status,405);
  }finally{await new Promise(resolve=>server.close(resolve))}
});

test('notification resume diagnostics accept only bounded same-origin fixed-schema events',async()=>{
  const records=[],server=createDwellServer({clientDiagnosticLog:record=>records.push(record)});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`,payload={version:1,correlationId:'0123456789ab',sequence:1,stage:'notification_received',resumePath:'notification_existing_client',displayMode:'standalone',navigatorStandalone:true,locationOrigin:base,locationPathname:'/',sessionsCount:null,claudeRuntimeSessionCount:null,activeIdPresent:null,activeIdValid:null,restoreSelected:null,selectedMessageCount:null,eligibleRecoveryAnchorCount:null,restoreEntered:null,recoveryReason:'not_reached',journalReplayAttemptedCount:null,runtimeRequestExecuted:false,runtimeHttpStatus:null,runtimeState:'not_requested',runtimeActive:null,runtimeActiveTurnPresent:null,onboarding:null,onboardingReason:'not_rendered'},headers={'content-type':'application/json','sec-fetch-site':'same-origin',origin:base};
  try{const accepted=await fetch(base+'/api/client-diagnostics/notification-resume',{method:'POST',headers,body:JSON.stringify(payload)});assert.equal(accepted.status,202);assert.equal(records.length,1);assert.equal(records[0].component,'client_diagnostic');assert.equal(records[0].event,'notification_resume');assert.equal(records[0].locationOrigin,base);assert.doesNotMatch(JSON.stringify(records[0]),/chat body|clientRequestId|turnId|subscription|authorization/i);
    const extra=await fetch(base+'/api/client-diagnostics/notification-resume',{method:'POST',headers,body:JSON.stringify({...payload,message:'arbitrary text'})});assert.equal(extra.status,400);
    const cross=await fetch(base+'/api/client-diagnostics/notification-resume',{method:'POST',headers:{...headers,'sec-fetch-site':'cross-site',origin:'https://evil.example'},body:JSON.stringify({...payload,locationOrigin:'https://evil.example'})});assert.equal(cross.status,403);
    const oversized=await fetch(base+'/api/client-diagnostics/notification-resume',{method:'POST',headers,body:JSON.stringify({...payload,padding:'x'.repeat(5000)})});assert.equal(oversized.status,413);assert.equal(records.length,1)
  }finally{await new Promise(resolve=>server.close(resolve))}
});

test('internal sender cleans expired endpoints without exposing or blocking healthy subscriptions',async()=>{
  const removed=[],store={list:async()=>[{installationId:'a',subscription:subscription('https://push.example/gone')},{installationId:'b',subscription:subscription('https://push.example/live')}],removeEndpoint:async endpoint=>{removed.push(endpoint)}},sent=[];
  const transport={setVapidDetails:(subject,publicKey,privateKey)=>{assert.equal(subject,'mailto:owner@example.com');assert.equal(publicKey,'pub');assert.equal(privateKey,'private')},sendNotification:async sub=>{sent.push(sub.endpoint);if(sub.endpoint.endsWith('/gone'))throw Object.assign(new Error('gone'),{statusCode:410})}};
  const service=createPushService({store,transport,vapid:{subject:'mailto:owner@example.com',publicKey:'pub',privateKey:'private'}}),result=await service.sendPush({title:'秋秋',body:'有一条新消息',target:'/'});
  assert.deepEqual(result,{sent:1,removed:1,failed:0});assert.deepEqual(sent,['https://push.example/gone','https://push.example/live']);assert.deepEqual(removed,['https://push.example/gone']);
});

function loadWorker({windows=[]}={}){const sourcePromise=read('sw.js');return sourcePromise.then(source=>{const handlers={},shown=[],opened=[];const clients={matchAll:async()=>windows,openWindow:async target=>{opened.push(target);return {target}}};const context={URL,fetch:async()=>{},caches:{},self:{location:{origin:'https://qiuqiu.reesia.xyz'},registration:{showNotification:async(title,options)=>shown.push({title,options})},clients,addEventListener:(name,handler)=>{handlers[name]=handler}}};vm.createContext(context);vm.runInContext(source,context);return {handlers,shown,opened}})}

test('push shows a minimal notification and notification click restores an existing PWA without reloading it',async()=>{
  let navigated=null,focused=0,message=null;const existing={url:'https://qiuqiu.reesia.xyz/',postMessage:value=>{message=value},navigate:async target=>{navigated=target;return existing},focus:async()=>{focused++}},worker=await loadWorker({windows:[existing]});
  let pending;worker.handlers.push({data:{json:()=>({title:'秋秋',body:'回复好了',target:'/',tag:'turn-123','extra':'ignored'})},waitUntil:value=>{pending=value}});await pending;assert.deepEqual(JSON.parse(JSON.stringify(worker.shown[0])),{title:'秋秋',options:{body:'回复好了',icon:'/app-icon-192.png',data:{target:'/'},tag:'turn-123'}});
  worker.handlers.notificationclick({notification:{data:{target:'/'},close(){}},waitUntil:value=>{pending=value}});await pending;assert.equal(navigated,null);assert.equal(focused,1);assert.deepEqual(JSON.parse(JSON.stringify(message)),{type:'qiuqiu-open-chat',target:'/'});assert.deepEqual(worker.opened,[]);
});

test('notification click cold-starts the PWA and malicious deep links fall back to root',async()=>{
  const worker=await loadWorker();let pending;worker.handlers.notificationclick({notification:{data:{target:'https://evil.example/steal'},close(){}},waitUntil:value=>{pending=value}});await pending;assert.deepEqual(worker.opened,['/']);assert.equal(safePushTarget('//evil.example/path'),'/');
});

test('Phase 1 viewport and API bypass invariants remain intact in pwa23',async()=>{
  const [css,app,worker]=await Promise.all([read('style.css'),read('app.js'),read('sw.js')]);assert.match(css,/@media\(display-mode:standalone\)\{html,body\{height:100vh;min-height:100vh/);assert.match(app,/function syncVisualViewport\(\)/);assert.match(worker,/url\.pathname\.startsWith\('\/api\/'\)\)return/);assert.doesNotMatch(worker,/caches\.match[^\n]+\/api/);
});
