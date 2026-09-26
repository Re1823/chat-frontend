import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

class FakeElement {
  constructor() {
    this.value = '';
    this.textContent = '';
    this.innerHTML = '';
    this.hidden = false;
    this.disabled = false;
    this.dataset = {};
    this.style = {};
    this.scrollHeight = 20;
    this.scrollTop = 0;
    this.clientHeight = 20;
    this.className = '';
    this.classList = { add() {}, remove() {}, toggle() {} };
    this.rect = {top:650};
    this.children=[];
  }
  focus() {}
  setAttribute(name,value) { this[name]=String(value); }
  removeAttribute(name) { delete this[name]; }
  getBoundingClientRect() { return this.rect; }
  querySelector() { return this.streamBubble || null; }
  click() { this.onclick?.(); }
  append(...children){this.children.push(...children)}
  replaceChildren(...children){this.children=[...children]}
  setPointerCapture(){} releasePointerCapture(){}
}

function loadApp(initialStorage = {}, fetchImpl = async () => { throw new Error('unexpected fetch'); }, cryptoImpl = { randomUUID: () => 'generated-session-id' }, timing = {}) {
  const elements = new Map();
  const get = selector => {
    if (!elements.has(selector)) elements.set(selector, new FakeElement());
    return elements.get(selector);
  };
  const storage = new Map(Object.entries(initialStorage));
  const rootStyles = {};
  class TestURL extends URL {}
  TestURL.createObjectURL=()=> 'blob:test';TestURL.revokeObjectURL=()=>{};
  const location={origin:'https://qiuqiu.reesia.xyz',pathname:'/',href:'https://qiuqiu.reesia.xyz/',search:'',hash:'',...(timing.location||{})};
  const context = {
    console,
    TextDecoder,
    Blob,
    Response,
    AbortController,
    crypto: cryptoImpl,
    fetch: fetchImpl,
    setTimeout: timing.setTimeout || (fn => { fn(); return 1; }),
    clearTimeout: timing.clearTimeout || (()=>{}),
    navigator: timing.navigator,
    performance: timing.performance,
    addEventListener: timing.addEventListener,
    location,
    history: timing.history||{state:null,replaceState(){}},
    matchMedia: timing.matchMedia || (()=>({matches:false})),
    requestAnimationFrame: timing.requestAnimationFrame,
    cancelAnimationFrame: timing.cancelAnimationFrame,
    visualViewport: timing.visualViewport,
    innerHeight: 800,
    localStorage: {
      getItem: key => storage.has(key) ? storage.get(key) : null,
      setItem: (key, value) => storage.set(key, String(value))
    },
    URL: TestURL,
    document: {
      body:new FakeElement(),
      visibilityState:timing.visibilityState||'visible',
      documentElement: {clientHeight:800,style:{setProperty:(name,value)=>{rootStyles[name]=value}}},
      querySelector: get,
      querySelectorAll: timing.querySelectorAll || (() => []),
      createElement: () => new FakeElement()
    }
  };
  vm.createContext(context);
  vm.runInContext(`${appSource}\n;globalThis.__appTest={showChat,showMemory:()=>{memoryLoaded=true;showMemory()},openUserHub,openConnections,restoreMainChatFromNavigation,restoreAvailableProductionRuntime,restoreColdProductionConversation,restoreStoredConversation,capturePageshowDiagnostic,finishColdResumeDiagnostic,renderMessages,resumeConnectionCheck,recoverConnection,recoverLegacySuppressedFinals,renderChatMessage,renderChatHistory,visibleMessageSearchText,findChatSearchResults,localDayKey,visibleMessageTimestamp,dayDividerMarkup,buildCalendarDays,syncComposerHeight,generateId,getTogetherDays,toast,positionToast,syncVisualViewport,scheduleVisualViewportSync,setViewportBottomAnchor,cancelViewportBottomAnchor,presets,runtimePresets,profile,persist,newChat,selectProvider,refreshRuntimeStatus,buildContinuation,openContinuation,startContinuation,applyTurnEvent,applyRequestEvent,messagesNearBottom,scrollMessagesToBottom,createStreamingView,readTurnStream,send,openThoughtProcess,closeThoughtProcess,renderThoughtSheet,setActiveIdForTest:value=>{activeId=value},getState:()=>({activeProvider,profiles,sessions,activeId,activeAppView,sending,activeTurnId,tmuxStatus,keepBottomThroughViewportResize})};`, context);
  return { api: context.__appTest, get, storage, rootStyles, context };
}

test('pageshow diagnostic compares frozen memory with storage without hydrating, selecting or rendering',async()=>{
  const diagnostics=[],handlers=[];
  const fetchImpl=async(url,init={})=>{assert.equal(url,'/api/client-diagnostics/pageshow');diagnostics.push(JSON.parse(init.body));return new Response(JSON.stringify({ok:true}),{status:202})};
  const navigator={standalone:false,onLine:true,serviceWorker:{controller:{scriptURL:'/sw.js?v=pwa24-recovery1'},addEventListener(){}}};
  const fixture=loadApp({},fetchImpl,{randomUUID:()=> '01234567-89ab-4cde-8f01-23456789abcd'},{navigator,performance:{getEntriesByType:type=>type==='navigation'?[{type:'back_forward'}]:[]},addEventListener:(name,handler)=>{if(name==='pageshow')handlers.push(handler)}});
  const stored=[{id:'stored-only',provider:'claude_tmux',messages:[{role:'assistant',content:'private fixture'}]}];fixture.storage.set('dwell.sessions',JSON.stringify(stored));fixture.storage.set('dwell.active','stored-only');
  for(const handler of handlers)handler({persisted:true});await new Promise(resolve=>setImmediate(resolve));
  const snapshot=diagnostics[0];assert.equal(snapshot.eventPersisted,true);assert.equal(snapshot.navigationType,'back_forward');assert.equal(snapshot.memorySessionsCount,0);assert.equal(snapshot.storedSessionsCount,1);assert.equal(snapshot.memoryActiveIdPresent,false);assert.equal(snapshot.storedActiveIdPresent,true);assert.equal(snapshot.storedActiveIdValid,true);assert.equal(snapshot.storedCurrentMessageCount,1);assert.equal(snapshot.sessionCountMatches,false);assert.equal(snapshot.activeSelectionMatches,false);assert.equal(snapshot.onboardingVisible,true);assert.equal(snapshot.renderReason,'no_current_session');assert.equal(snapshot.serviceWorkerControllerPresent,true);assert.equal(fixture.api.getState().sessions.length,0);assert.equal(fixture.api.getState().activeId,'');assert.equal(fixture.storage.get('dwell.active'),'stored-only');assert.doesNotMatch(JSON.stringify(snapshot),/stored-only|private fixture/)
});

test('notification cold open consumes its marker and reports one bounded bootstrap snapshot before recovery',async()=>{
  const diagnostics=[],replaced=[],calls=[],session={id:'private-session-id',provider:'claude_tmux',messages:[{role:'assistant',content:'private message',delivery:{phase:'finished'}}]};
  const fetchImpl=async(url,init={})=>{calls.push(url);if(url==='/api/client-diagnostics/notification-cold-resume'){diagnostics.push(JSON.parse(init.body));return new Response(JSON.stringify({ok:true}),{status:202})}if(url==='/api/runtimes/claude-tmux/status')return new Response(JSON.stringify({state:'connected',runtimeId:'private-runtime-id',active:false,activeTurnId:null}),{status:200});throw new Error(`unexpected fetch ${url}`)};
  const navigator={standalone:true,onLine:true,serviceWorker:{controller:{scriptURL:'/sw.js?v=pwa24-recovery1'},addEventListener(){}}},history={state:{safe:true},replaceState:(state,title,url)=>replaced.push({state,title,url})};
  const fixture=loadApp({'dwell.provider':'claude_tmux','dwell.sessions':JSON.stringify([session]),'dwell.active':'stale-private-id'},fetchImpl,{randomUUID:()=> '01234567-89ab-4cde-8f01-23456789abcd'},{navigator,history,location:{origin:'https://qiuqiu.reesia.xyz',pathname:'/',href:'https://qiuqiu.reesia.xyz/?qiuqiu_resume=notification',search:'?qiuqiu_resume=notification',hash:''},performance:{getEntriesByType:type=>type==='navigation'?[{type:'navigate'}]:[]},matchMedia:query=>({matches:query==='(display-mode: standalone)'})});
  for(let index=0;index<8;index++)await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(replaced,[{state:{safe:true},title:'',url:'/'}]);assert.equal(diagnostics.length,1);const snapshot=diagnostics[0];assert.equal(snapshot.resumeIntentPresent,true);assert.equal(snapshot.resumePath,'notification_cold_open');assert.equal(snapshot.scriptVersion,'pwa24-recovery1');assert.equal(snapshot.cacheVersion,'pwa24-recovery1');assert.equal(snapshot.navigationType,'navigate');assert.equal(snapshot.memorySessionsCount,1);assert.equal(snapshot.memoryActiveIdPresent,true);assert.equal(snapshot.memoryActiveIdValid,false);assert.equal(snapshot.storedSessionsCount,1);assert.equal(snapshot.storedActiveIdValid,false);assert.equal(snapshot.sessionCountMatches,true);assert.equal(snapshot.activeSelectionMatches,true);assert.equal(snapshot.restoreStoredConversationEntered,true);assert.equal(snapshot.restoreStoredConversationSelected,true);assert.equal(snapshot.selectedMessageCount,1);assert.equal(snapshot.restoreInterruptedEntered,true);assert.equal(snapshot.restoreInterruptedReason,'no_eligible_recovery_anchor');assert.equal(snapshot.restoreAvailableEntered,false);assert.equal(snapshot.restoreAvailableReason,'already_claude_runtime');assert.equal(snapshot.runtimeHttpStatus,200);assert.equal(snapshot.runtimeState,'connected');assert.equal(snapshot.finalCurrentSessionPresent,true);assert.equal(snapshot.finalCurrentMessageCount,1);assert.equal(snapshot.onboarding,false);assert.equal(snapshot.onboardingReason,'not_onboarding');assert.equal(calls.filter(url=>url==='/api/client-diagnostics/notification-cold-resume').length,1);assert.doesNotMatch(JSON.stringify(snapshot),/private-session-id|stale-private-id|private message|private-runtime-id|qiuqiu_resume/);assert.equal(fixture.api.getState().activeId,'private-session-id')
});

async function coldProductionFixture({storedSessions=[],snapshotStatus=200}={}){
  const calls=[],recovered=[{role:'user',content:'哥哥我到图书馆了',createdAt:'2026-09-24T06:22:43.000Z'},{role:'assistant',content:'去吧，穿厚点',createdAt:'2026-09-24T06:22:44.000Z'}];
  const fetchImpl=async(url,init={})=>{calls.push(url);if(url==='/api/runtimes/claude-tmux/status')return new Response(JSON.stringify({state:'connected',runtimeId:'claude-main',active:false,activeTurnId:null}),{status:200});if(url==='/api/runtimes/claude-tmux/production-conversation')return new Response(JSON.stringify(snapshotStatus===200?{available:true,messages:recovered}:{available:false}),{status:snapshotStatus});if(url==='/api/client-diagnostics/notification-cold-resume')return new Response(JSON.stringify({ok:true}),{status:202});throw new Error(`unexpected fetch ${url}`)};
  const navigator={standalone:true,onLine:true,serviceWorker:{controller:{scriptURL:'/sw.js?v=pwa24-recovery1'},addEventListener(){}}},storage={'dwell.provider':'claude_tmux','dwell.sessions':JSON.stringify(storedSessions),'dwell.active':storedSessions[0]?.id||''},fixture=loadApp(storage,fetchImpl,{randomUUID:()=> '01234567-89ab-4cde-8f01-23456789abcd'},{navigator,history:{state:null,replaceState(){}},location:{origin:'https://qiuqiu.reesia.xyz',pathname:'/',href:'https://qiuqiu.reesia.xyz/?qiuqiu_resume=notification',search:'?qiuqiu_resume=notification',hash:''},performance:{getEntriesByType:()=>[{type:'navigate'}]},matchMedia:query=>({matches:query==='(display-mode: standalone)'})});
  for(let index=0;index<10;index++)await new Promise(resolve=>setImmediate(resolve));return {...fixture,calls,recovered}
}

test('cold installed PWA with empty local storage restores the real production conversation',async()=>{const fixture=await coldProductionFixture();const state=fixture.api.getState();assert.equal(fixture.calls.filter(url=>url==='/api/runtimes/claude-tmux/production-conversation').length,1);assert.equal(state.sessions.length,1);assert.equal(state.activeId,state.sessions[0].id);assert.equal(state.sessions[0].provider,'claude_tmux');assert.deepEqual(JSON.parse(JSON.stringify(state.sessions[0].messages)),fixture.recovered);assert.match(fixture.get('#messages').innerHTML,/哥哥我到图书馆了/);assert.doesNotMatch(fixture.get('#messages').innerHTML,/接一条路进来/)});

test('cold installed PWA stays on onboarding when production has no recoverable conversation',async()=>{const fixture=await coldProductionFixture({snapshotStatus:404});assert.equal(fixture.calls.filter(url=>url==='/api/runtimes/claude-tmux/production-conversation').length,1);assert.equal(fixture.api.getState().sessions.length,0);assert.match(fixture.get('#messages').innerHTML,/接一条路进来/)});

test('cold installed PWA with a local session never invokes production conversation discovery',async()=>{const local={id:'local-chat',provider:'claude_tmux',messages:[{role:'user',content:'本地历史'}]},fixture=await coldProductionFixture({storedSessions:[local]});assert.equal(fixture.calls.includes('/api/runtimes/claude-tmux/production-conversation'),false);assert.equal(fixture.api.getState().activeId,'local-chat');assert.equal(fixture.api.getState().sessions.length,1)});

test('notification navigation repairs a stale conversation anchor, refreshes runtime, and replays the existing chat turn',async()=>{
  const handlers={},calls=[],navigator={standalone:true,onLine:true,serviceWorker:{addEventListener:(name,handler)=>{handlers[name]=handler}}};
  const fetchImpl=async url=>{calls.push(url);if(url.includes('/events?'))return new Response(JSON.stringify({turnId:'turn-1',state:'finished',receivedByRuntime:true,finished:true,recoverable:true,latestSeq:2,events:[{type:'segment_delta',turnId:'turn-1',delta:'恢复完成',seq:1},{type:'turn_done',turnId:'turn-1',seq:2}]}));return new Response(JSON.stringify({state:'connected',runtimeId:'claude-main'}),{status:200})};
  const sessions=[{id:'chat-1',provider:'claude_tmux',messages:[{role:'user',content:'还在这里'},{role:'assistant',content:'',pending:true,delivery:{clientRequestId:'request-1',turnId:'turn-1',phase:'connection_lost',runtimeId:'claude-main',lastAppliedSeq:0}}]}];
  const {api}=loadApp({'dwell.provider':'claude_tmux','dwell.sessions':JSON.stringify(sessions),'dwell.active':'stale-chat'},fetchImpl,undefined,{navigator:{...navigator,standalone:false}});
  api.openUserHub();api.openConnections();assert.equal(api.getState().activeAppView,'user-hub');
  handlers.message({data:{type:'qiuqiu-open-chat',target:'/'}});await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(api.getState().activeAppView,'chat');assert.equal(api.getState().activeId,'chat-1');assert.equal(api.getState().sessions[0].messages[0].content,'还在这里');assert.equal(api.getState().sessions[0].messages[1].content,'恢复完成');assert.equal(api.getState().activeProvider,'claude_tmux');assert(calls.includes('/api/runtimes/claude-tmux/status'));assert(calls.some(url=>url.includes('/api/chat/turn/turn-1/events?afterSeq=0')));
});

async function notificationResumeFixture({sessions=[],activeId='',activeProvider='claude_tmux'}={}){
  const diagnostics=[],calls=[],fetchImpl=async(url,init={})=>{calls.push(url);if(url==='/api/client-diagnostics/notification-resume'){diagnostics.push(JSON.parse(init.body));return new Response(JSON.stringify({ok:true}),{status:202})}if(url==='/api/runtimes/claude-tmux/status')return new Response(JSON.stringify({state:'connected',runtimeId:'claude-main',active:false,activeTurnId:null}),{status:200});if(url.includes('/events?'))return new Response(JSON.stringify({turnId:'turn-fixture',state:'finished',receivedByRuntime:true,finished:true,recoverable:true,latestSeq:1,events:[{type:'turn_done',turnId:'turn-fixture',seq:1}]}),{status:200});throw new Error(`unexpected fetch ${url}`)};
  let standalone=false;const storage={'dwell.provider':activeProvider,'dwell.sessions':JSON.stringify(sessions),'dwell.active':activeId},navigator={standalone:false,onLine:true,serviceWorker:{addEventListener(){}}},fixture=loadApp(storage,fetchImpl,{randomUUID:()=>crypto.randomUUID()},{navigator,matchMedia:query=>({matches:query==='(display-mode: standalone)'&&standalone})});standalone=true;navigator.standalone=true;if(activeId&&!sessions.some(session=>session.id===activeId))fixture.api.setActiveIdForTest(activeId);await fixture.api.restoreMainChatFromNavigation();for(let index=0;index<8;index++)await new Promise(resolve=>setImmediate(resolve));return {...fixture,diagnostics,calls}
}

test('notification resume diagnostics identify missing local sessions',async()=>{const {diagnostics}=await notificationResumeFixture(),local=diagnostics.find(item=>item.stage==='local_state'),recovery=diagnostics.find(item=>item.stage==='recovery'),final=diagnostics.find(item=>item.stage==='final_render');assert.equal(local.sessionsCount,0);assert.equal(local.claudeRuntimeSessionCount,0);assert.equal(local.activeIdPresent,false);assert.equal(local.activeIdValid,false);assert.equal(local.restoreSelected,false);assert.equal(local.selectedMessageCount,null);assert.equal(recovery.restoreEntered,false);assert.equal(recovery.recoveryReason,'no_current_session');assert.equal(final.onboarding,true);assert.equal(final.onboardingReason,'no_current_session');assert.equal(final.displayMode,'standalone');assert.equal(final.navigatorStandalone,true);assert.equal(final.locationOrigin,'https://qiuqiu.reesia.xyz');assert.equal(final.locationPathname,'/')});

test('notification resume diagnostics identify an empty current session',async()=>{const session={id:'empty',provider:'claude_tmux',messages:[]},{diagnostics}=await notificationResumeFixture({sessions:[session],activeId:'empty'}),local=diagnostics.find(item=>item.stage==='local_state'),recovery=diagnostics.find(item=>item.stage==='recovery'),final=diagnostics.find(item=>item.stage==='final_render');assert.equal(local.activeIdValid,true);assert.equal(local.restoreSelected,true);assert.equal(local.selectedMessageCount,0);assert.equal(recovery.restoreEntered,true);assert.equal(recovery.eligibleRecoveryAnchorCount,0);assert.equal(recovery.recoveryReason,'no_eligible_recovery_anchor');assert.equal(final.onboardingReason,'current_session_empty')});

test('notification resume diagnostics record stale-anchor repair and journal replay attempt',async()=>{const session={id:'stored-claude',provider:'claude_tmux',messages:[{role:'user',content:'fixture only'},{role:'assistant',content:'',delivery:{clientRequestId:'request-fixture',turnId:'turn-fixture',phase:'connection_lost',runtimeId:'claude-main',lastAppliedSeq:0}}]},{diagnostics,calls}=await notificationResumeFixture({sessions:[session],activeId:'stale'}),local=diagnostics.find(item=>item.stage==='local_state'),runtime=diagnostics.find(item=>item.stage==='runtime_refresh'),recovery=diagnostics.find(item=>item.stage==='recovery');assert.equal(local.activeIdPresent,true);assert.equal(local.activeIdValid,false);assert.equal(local.restoreSelected,true);assert.equal(local.selectedMessageCount,2);assert.equal(recovery.eligibleRecoveryAnchorCount,1);assert.equal(recovery.journalReplayAttemptedCount,1);assert.equal(recovery.recoveryReason,'replay_attempted');assert.equal(runtime.runtimeHttpStatus,200);assert.equal(runtime.runtimeState,'connected');assert.equal(runtime.runtimeActive,false);assert.equal(runtime.runtimeActiveTurnPresent,false);assert(calls.some(url=>url.includes('/api/chat/turn/turn-fixture/events')))});

test('notification resume diagnostics distinguish populated history without a recovery anchor',async()=>{const session={id:'complete',provider:'claude_tmux',messages:[{role:'user',content:'fixture only'},{role:'assistant',content:'done',delivery:{phase:'finished'}}]},{diagnostics}=await notificationResumeFixture({sessions:[session],activeId:'complete'}),recovery=diagnostics.find(item=>item.stage==='recovery'),final=diagnostics.find(item=>item.stage==='final_render');assert.equal(recovery.restoreEntered,true);assert.equal(recovery.eligibleRecoveryAnchorCount,0);assert.equal(recovery.journalReplayAttemptedCount,0);assert.equal(recovery.recoveryReason,'no_eligible_recovery_anchor');assert.equal(final.onboarding,false);assert.equal(final.onboardingReason,'not_onboarding')});

test('standalone cold start adopts the connected production runtime through normal status recovery',async()=>{
  const handlers={},navigator={standalone:true,onLine:true,serviceWorker:{addEventListener:(name,handler)=>{handlers[name]=handler}}};
  const fetchImpl=async url=>{assert.equal(url,'/api/runtimes/claude-tmux/status');return new Response(JSON.stringify({state:'connected',runtimeId:'production-runtime'}),{status:200})};
  const {api,storage}=loadApp({},fetchImpl,undefined,{navigator});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(api.getState().activeAppView,'chat');assert.equal(api.getState().activeProvider,'claude_tmux');assert.equal(api.getState().tmuxStatus.state,'connected');assert.equal(storage.get('dwell.provider'),'claude_tmux');assert.equal(JSON.parse(storage.get('dwell.profiles')).claude_tmux.runtimeId,'production-runtime');assert.equal(typeof handlers.message,'function');
});

test('thought process event stays out of ordinary assistant body and shows a turn-bound cloud',()=>{const {api}=loadApp(),out={role:'assistant',content:'final',turnId:'turn-a',createdAt:1};api.applyTurnEvent(out,{type:'thought_process',turnId:'turn-a',items:[{id:'i',type:'thinking',text:'reason'}]});assert.equal(out.content,'final');const html=api.renderChatMessage(out,null);assert.match(html,/data-thought-turn="turn-a"/);assert.doesNotMatch(html,/reason/)});
test('assistant without thought process has no cloud button',()=>{const {api}=loadApp();assert.doesNotMatch(api.renderChatMessage({role:'assistant',content:'final',turnId:'turn-a',createdAt:1},null),/thought-cloud/)});
test('legacy suppression flag cannot erase real final assistant text',()=>{const {api}=loadApp(),out={role:'assistant',content:'final',turnId:'turn-a'};api.applyTurnEvent(out,{type:'thought_process',turnId:'turn-a',items:[{id:'i',type:'thinking',text:'reason'}],suppressOrdinaryBody:true});assert.equal(out.content,'final');assert.equal(out.thoughtProcess.items.length,1)});
test('legacy segment recovery cannot reintroduce terminal-only assistant text',async()=>{const sessions=[{id:'s',provider:'claude',messages:[{role:'assistant',content:'',turnId:'turn-a',thoughtProcess:{items:[{type:'thinking'}]}}]}],calls=[];const {api}=loadApp({'dwell.sessions':JSON.stringify(sessions),'dwell.active':'s'},async(url,init)=>{calls.push([url,init]);return new Response(JSON.stringify({events:[{type:'segment_delta',delta:'terminal only'},{type:'turn_done'}]}),{status:200,headers:{'content-type':'application/json'}})});assert.equal(await api.recoverLegacySuppressedFinals(),false);assert.equal(api.getState().sessions[0].messages[0].content,'');assert.equal(calls.length,0)});
test('wrong turn cannot bind thought process',()=>{const {api}=loadApp(),out={role:'assistant',content:'final',turnId:'turn-a'};api.applyTurnEvent(out,{type:'thought_process',turnId:'turn-b',items:[{id:'i',type:'thinking',text:'x'}]});assert.equal(out.thoughtProcess,undefined)});
test('thought snapshot replacement merges streaming updates without duplicate items',()=>{const {api}=loadApp(),out={role:'assistant',content:'',turnId:'t'};api.applyTurnEvent(out,{type:'thought_process',turnId:'t',items:[{id:'i',type:'thinking',text:'a'}]});api.applyTurnEvent(out,{type:'thought_process',turnId:'t',items:[{id:'i',type:'thinking',text:'ab'}]});assert.deepEqual(JSON.parse(JSON.stringify(out.thoughtProcess.items)),[{id:'i',type:'thinking',text:'ab'}])});
test('album_saved binds only to its turn, deduplicates and survives serialized chat rendering',()=>{const {api}=loadApp(),out={role:'assistant',content:'saved',turnId:'turn-a',createdAt:1},photo={photoId:'photo_01234567890123456789012345678901',albumName:'嘉宝果',note:'第一张画',savedAt:123,savedBy:'assistant'};api.applyTurnEvent(out,{type:'album_saved',turnId:'turn-b',photo});assert.equal(out.albumEvents,undefined);api.applyTurnEvent(out,{type:'album_saved',turnId:'turn-a',photo});api.applyTurnEvent(out,{type:'album_saved',turnId:'turn-a',photo});assert.equal(out.albumEvents.length,1);const html=api.renderChatMessage(JSON.parse(JSON.stringify(out)),null);assert.match(html,/album-save-card/);assert.match(html,/存进了「嘉宝果」/);assert.match(html,/秋秋 收藏了/);assert.match(html,/第一张画/)});

test('chat search supports Chinese substring and case-insensitive English while excluding thought and album metadata',()=>{
  const {api}=loadApp(),messages=[
    {role:'user',content:'我到图书馆啦'},
    {role:'assistant',content:'',toolMessages:[{content:'Remember the Biscuit'}],thoughtProcess:{items:[{text:'图书馆内部推理'}]}},
    {role:'assistant',content:'',thoughtProcess:{items:[{text:'SECRET THINKING'}]}},
    {role:'assistant',content:'',albumEvents:[{photo:{photoId:'photo_01234567890123456789012345678901',albumName:'Biscuit Album'}}]}
  ];
  assert.deepEqual(JSON.parse(JSON.stringify(api.findChatSearchResults(messages,'图书馆'))).map(item=>item.index),[0]);
  assert.deepEqual(JSON.parse(JSON.stringify(api.findChatSearchResults(messages,'bIScUiT'))).map(item=>item.index),[1]);
  assert.equal(api.findChatSearchResults(messages,'SECRET').length,0);
  assert.equal(api.findChatSearchResults(messages,'Album').length,0);
  assert.equal(api.findChatSearchResults(messages,'   ').length,0);
});

test('local calendar days and presentation-only dividers respect natural-day boundaries',()=>{
  const {api}=loadApp(),day1=new Date(2026,8,23,23,58).getTime(),day2=new Date(2026,8,24,0,2).getTime(),day3=new Date(2026,8,25,9,5).getTime();
  const messages=[{role:'user',content:'a',createdAt:day1},{role:'assistant',content:'b',createdAt:day1+1000},{role:'assistant',content:'',thoughtProcess:{items:[{text:'hidden'}]},createdAt:day2},{role:'user',content:'c',createdAt:day2},{role:'assistant',content:'d',createdAt:day2+1000},{role:'user',content:'e',createdAt:day3}];
  const output=api.renderChatHistory(messages);
  assert.equal((output.match(/chat-day-divider/g)||[]).length,2);
  assert.doesNotMatch(output.slice(0,output.indexOf('data-message-index="0"')),/chat-day-divider/);
  assert.match(output,/9月24日 · 00:02/);
  assert.match(output,/9月25日 · 09:05/);
  assert.equal(api.localDayKey(new Date(2026,8,24,0,1)),'2026-09-24');
  const days=api.buildCalendarDays(2026,8,'2026-09-23','2026-09-25','2026-09-24').filter(Boolean);
  assert.equal(days.find(day=>day.key==='2026-09-22').disabled,true);
  assert.equal(days.find(day=>day.key==='2026-09-24').selected,true);
});

test('keeps the established provider presets and storage keys', () => {
  const session = { id:'old', title:'保留', provider:'relay', created:123, messages:[{role:'user',content:'你好'}] };
  const profiles = { relay:{ base:'https://relay.example/v1', key:'secret', model:'model-x', protocol:'chat', system:'简洁' } };
  const { api, storage } = loadApp({
    'dwell.provider':'relay',
    'dwell.profiles':JSON.stringify(profiles),
    'dwell.sessions':JSON.stringify([session]),
    'dwell.active':'old'
  });

  assert.deepEqual(JSON.parse(JSON.stringify(api.presets)), {
    claude:{name:'Claude',icon:'C',base:'https://api.anthropic.com',model:'claude-sonnet-4-5',protocol:'anthropic'},
    relay:{name:'中转站',icon:'↗',base:'https://api.openai.com/v1',model:'gpt-5',protocol:'chat'},
    chatgpt:{name:'ChatGPT',icon:'◎',base:'https://api.openai.com/v1',model:'chat-latest',protocol:'responses'},
    codex:{name:'Codex',icon:'⌘',base:'https://api.openai.com/v1',model:'gpt-5.6-sol',protocol:'responses'}
  });
  api.persist();
  assert.deepEqual(JSON.parse(storage.get('dwell.sessions')), [session]);
  assert.deepEqual(JSON.parse(storage.get('dwell.profiles')), profiles);
  assert.equal(storage.get('dwell.provider'), 'relay');
  assert.equal(storage.get('dwell.active'), 'old');
});

test('continuation filters transient failures without mutating the source session', () => {
  const source = {
    id:'source', title:'原任务', provider:'claude', created:1,
    messages:[
      {role:'user',content:'必须保留原会话，继续完成测试'},
      {role:'assistant',content:'已经完成第一步'},
      {role:'assistant',content:'没接通：network'},
      {role:'assistant',content:'',pending:true},
      {role:'user',content:'下一步补齐流式聊天测试'}
    ]
  };
  const before = JSON.stringify(source);
  const { api } = loadApp({'dwell.sessions':JSON.stringify([source]), 'dwell.active':'source'});
  const pack = api.buildContinuation(api.getState().sessions[0]);

  assert.equal(pack.kept, 3);
  assert.equal(pack.total, 5);
  assert.ok(pack.text.includes('[续窗启动包]'));
  assert.ok(pack.text.includes('下一步补齐流式聊天测试'));
  assert.ok(!pack.text.includes('没接通：network'));
  assert.ok(pack.text.length <= 24000);
  assert.equal(JSON.stringify(api.getState().sessions[0]), before);
});

test('a continued session preserves linkage and sends its bridge as system context', async () => {
  const calls = [];
  const source = { id:'source', title:'项目', provider:'relay', created:1, messages:[{role:'user',content:'旧任务'}] };
  const profiles = { relay:{base:'https://relay.example/v1',key:'k',model:'m',protocol:'chat',system:'基础提示'} };
  const fetchImpl = async (url, init) => {
    calls.push({url, body:JSON.parse(init.body)});
    return new Response('{"type":"turn_started","turnId":"t"}\n{"type":"segment_delta","turnId":"t","delta":"流"}\n{"type":"segment_delta","turnId":"t","delta":"式"}\n{"type":"turn_done","turnId":"t"}\n', {status:200,headers:{'content-type':'application/x-ndjson'}});
  };
  const { api, get } = loadApp({
    'dwell.provider':'relay', 'dwell.profiles':JSON.stringify(profiles),
    'dwell.sessions':JSON.stringify([source]), 'dwell.active':'source'
  }, fetchImpl);
  api.openContinuation();
  get('#continueDraft').value = '用户确认的启动包';
  api.startContinuation();

  const state = api.getState();
  assert.equal(state.sessions[0].continuedFrom, 'source');
  assert.equal(state.sessions[1].continuedTo, 'generated-session-id');
  assert.equal(state.sessions[1].messages.length, 1);
  get('#input').value = '继续';
  await api.send();

  assert.equal(calls[0].url, '/api/chat');
  assert.equal(calls[0].body.config.protocol, 'chat');
  assert.equal(calls[0].body.config.protocol, 'chat');
  assert.equal(calls[0].body.messages[0].content, '基础提示');
  assert.ok(calls[0].body.messages[1].content.includes('用户确认的启动包'));
  assert.equal(state.sessions[0].messages.at(-1).content, '流式');
  assert.equal(state.sessions[0].messages.at(-1).pending, false);
});

test('the browser stream reader remains compatible with legacy SSE frames', async () => {
  const { api } = loadApp();
  const output = {content:''};
  const response = new Response('data: {"delta":"旧"}\n\ndata: {"delta":"协议"}\n\ndata: {"done":true}\n\n', {status:200,headers:{'content-type':'text/event-stream'}});
  await api.readTurnStream(response, output);
  assert.equal(output.content, '旧协议');
});

test('streaming view batches many deltas into one frame and keeps the current bubble node', () => {
  const frames=[];
  const cancelled=[];
  const {api,get}=loadApp({},undefined,undefined,{
    requestAnimationFrame:fn=>{frames.push(fn);return frames.length},
    cancelAnimationFrame:id=>cancelled.push(id)
  });
  const box=get('#messages');
  const bubble=new FakeElement();
  box.streamBubble=bubble;
  box.scrollHeight=1000;
  box.scrollTop=700;
  box.clientHeight=300;
  const output={content:''};
  api.setViewportBottomAnchor(true);
  const view=api.createStreamingView(output);

  for(let index=0;index<80;index+=1){output.content+=String(index%10);view.update({type:'segment_delta',delta:String(index%10)})}
  assert.equal(frames.length,1);
  assert.equal(bubble.textContent,'');

  frames[0]();
  assert.equal(bubble.textContent,'');
  assert.equal(box.scrollTop,700);
  assert.equal(box.streamBubble,bubble);

  output.content+='**final**';
  view.update({type:'segment_delta',delta:'**final**'});
  assert.equal(bubble.innerHTML,'');
  view.finish();
  assert.equal(bubble.textContent,'');
  assert.match(bubble.innerHTML,/<strong>final<\/strong>/);
  assert.deepEqual(cancelled,[2]);
});

test('toast preserves long errors and follows a growing composer', () => {
  const {api,get}=loadApp();
  const footer=get('main>footer');
  const detail=`发送失败：\ncrypto.randomUUID is not a function.\n${'x'.repeat(500)}`;

  footer.rect={top:700};
  api.toast(detail);
  assert.equal(get('#toast').textContent,detail);
  assert.equal(get('#toast').style.bottom,'116px');
  assert.equal(get('#toast').style.maxHeight,'320px');

  footer.rect={top:590};
  api.positionToast();
  assert.equal(get('#toast').style.bottom,'226px');
  assert.equal(get('#toast').textContent,detail);
});

test('visual viewport geometry includes offsetTop when the Safari viewport is shifted', () => {
  const visualViewport={height:844,offsetTop:0,addEventListener(){}};
  const {api,rootStyles}=loadApp({},undefined,undefined,{visualViewport});
  assert.equal(rootStyles['--vv-height'],'844px');
  assert.equal(rootStyles['--vv-offset-top'],'0px');
  assert.equal(rootStyles['--vv-bottom'],'844px');
  assert.equal(Number.parseInt(rootStyles['--vv-offset-top']),0);
  assert.equal(visualViewport.height+visualViewport.offsetTop,844);

  visualViewport.height=500;
  api.syncVisualViewport();
  assert.equal(rootStyles['--vv-height'],'500px');
  assert.equal(rootStyles['--vv-offset-top'],'0px');
  assert.equal(rootStyles['--vv-bottom'],'500px');
  assert.equal(visualViewport.height+visualViewport.offsetTop,500);

  visualViewport.offsetTop=120;
  api.syncVisualViewport();
  assert.equal(rootStyles['--vv-height'],'500px');
  assert.equal(rootStyles['--vv-offset-top'],'120px');
  assert.equal(rootStyles['--vv-bottom'],'620px');
  assert.equal(Number.parseInt(rootStyles['--vv-offset-top']),120);
  assert.equal(visualViewport.height+visualViewport.offsetTop,620);
});

test('viewport open and close preserve bottom intent without a send or turn', () => {
  const frames=[];
  const visualViewport={height:844,offsetTop:0,addEventListener(){}};
  const {api,get}=loadApp({},undefined,undefined,{visualViewport,requestAnimationFrame:fn=>{frames.push(fn);return frames.length}});
  const messages=get('#messages');
  messages.scrollHeight=1200;
  messages.clientHeight=400;
  messages.scrollTop=790;
  api.scheduleVisualViewportSync();
  messages.clientHeight=240;
  frames.shift()();
  frames.shift()();
  assert.equal(messages.scrollTop,960);
  assert.equal(api.getState().keepBottomThroughViewportResize,true);

  visualViewport.height=844;
  api.scheduleVisualViewportSync();
  messages.clientHeight=400;
  frames.shift()();
  frames.shift()();
  assert.equal(messages.scrollTop,800);
  assert.equal(api.getState().keepBottomThroughViewportResize,true);

  api.cancelViewportBottomAnchor();
  messages.clientHeight=400;
  messages.scrollTop=300;
  api.scheduleVisualViewportSync();
  messages.clientHeight=240;
  frames.shift()();
  frames.shift()();
  assert.equal(messages.scrollTop,300);
  assert.equal(api.getState().keepBottomThroughViewportResize,false);
});

test('Claude tmux reuses the chat flow but sends only the newest user prompt',async()=>{
  const calls=[];
  const fetchImpl=async(url,init={})=>{
    calls.push({url,init});
    if(url.includes('/status'))return new Response(JSON.stringify({enabled:true,state:'connected',runtimeId:'claude-main',sessionName:'dwell'}),{status:200,headers:{'content-type':'application/json'}});
    return new Response('{"type":"turn_started","turnId":"turn-web"}\n{"type":"segment_delta","turnId":"turn-web","delta":"收到"}\n{"type":"segment_done","turnId":"turn-web"}\n{"type":"turn_done","turnId":"turn-web"}\n',{status:200,headers:{'content-type':'application/x-ndjson'}});
  };
  const {api,get}=loadApp({},fetchImpl);api.selectProvider('claude_tmux');await api.refreshRuntimeStatus();
  get('#input').value='只发这一条';await api.send();
  const chat=calls.find(call=>call.url==='/api/chat');const body=JSON.parse(chat.init.body);
  assert.equal(body.config.runtime,'claude_tmux');assert.deepEqual(body.messages,[{role:'user',content:'只发这一条'}]);
  assert.equal(api.getState().sessions[0].messages.at(-1).content,'收到');
});

test('busy Claude tmux shows A B C immediately and keeps every request independent without Stop',async()=>{
  const calls=[],streamControllers=[];let ids=0;
  const fetchImpl=async(url,init={})=>{
    calls.push({url,init});
    if(url.includes('/status'))return new Response(JSON.stringify({enabled:true,state:'connected'}),{status:200,headers:{'content-type':'application/json'}});
    return new Response(new ReadableStream({start(controller){streamControllers.push(controller)}}),{status:200,headers:{'content-type':'application/x-ndjson'}});
  };
  const {api,get}=loadApp({},fetchImpl,{randomUUID:()=>`request-${++ids}`});api.selectProvider('claude_tmux');await api.refreshRuntimeStatus();get('#input').value='A';
  const first=api.send();await Promise.resolve();streamControllers[0].enqueue(new TextEncoder().encode('{"type":"turn_started","turnId":"turn-A"}\n'));get('#input').value='B';get('#input').oninput();assert.equal(get('#send').disabled,false);
  const second=api.send();await Promise.resolve();get('#input').value='C';get('#input').oninput();assert.equal(get('#send').disabled,false);const third=api.send();await Promise.resolve();
  assert.equal(calls.filter(call=>call.url==='/api/chat').length,3);assert.equal(calls.some(call=>call.url==='/api/chat/stop'),false);assert.equal(api.getState().sessions[0].messages.filter(message=>message.role==='user').map(message=>message.content).join(','),'A,B,C');
  streamControllers[0].enqueue(new TextEncoder().encode('{"type":"turn_done","turnId":"turn-A"}\n'));streamControllers[0].close();streamControllers[1].enqueue(new TextEncoder().encode('{"type":"turn_started","turnId":"turn-B"}\n{"type":"turn_done","turnId":"turn-B"}\n'));streamControllers[1].close();streamControllers[2].enqueue(new TextEncoder().encode('{"type":"turn_started","turnId":"turn-C"}\n{"type":"turn_done","turnId":"turn-C"}\n'));streamControllers[2].close();await Promise.all([first,second,third]);assert.equal(api.getState().sending,false);
});

test('a successful API connection test persists the provider and refreshes composer state',async()=>{
  const fetchImpl=async url=>{assert.equal(url,'/api/test');return new Response(JSON.stringify({ok:true,model:'deepseek-v4-flash'}),{status:200,headers:{'content-type':'application/json'}})};
  const {api,get,storage}=loadApp({},fetchImpl);api.selectProvider('relay');get('#base').value='https://api.deepseek.com/v1';get('#key').value='browser-only-key';get('#model').value='deepseek-v4-flash';get('#protocol').value='chat';
  await get('#test').onclick();
  assert.deepEqual(JSON.parse(storage.get('dwell.profiles')).relay,{base:'https://api.deepseek.com/v1',key:'browser-only-key',model:'deepseek-v4-flash',protocol:'chat',system:''});
  get('#input').value='你好';get('#input').oncompositionend();assert.equal(get('#send').disabled,false);
});

test('generateId uses crypto.randomUUID when available',()=>{
  let next=0;const {api}=loadApp({},undefined,{randomUUID:()=>`native-${++next}`});
  assert.equal(api.generateId(),'native-1');assert.equal(api.generateId(),'native-2');
});

test('generateId falls back to crypto.getRandomValues with non-empty unique ids',()=>{
  let seed=0;const {api}=loadApp({},undefined,{getRandomValues:bytes=>{bytes.fill(++seed);return bytes}});
  const first=api.generateId(),second=api.generateId();
  assert.ok(first);assert.ok(second);assert.notEqual(first,second);assert.match(first,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('generateId survives an HTTP non-secure context without Web Crypto UUID support',()=>{
  const {api}=loadApp({},undefined,null);const first=api.generateId(),second=api.generateId();
  assert.ok(first);assert.ok(second);assert.notEqual(first,second);assert.match(first,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);assert.doesNotThrow(()=>api.newChat());assert.ok(api.getState().activeId);
});


test('chat groups timestamps without inventing dates for legacy messages',()=>{
  const {api}=loadApp();
  const old={role:'assistant',content:'我就知道。'};
  assert.match(api.renderChatMessage(old,null),/时间未记录/);
  assert.doesNotMatch(api.renderChatMessage(old,old),/message-time/);
  const fresh={role:'user',content:'1',createdAt:new Date(2026,8,5,12,34,56).getTime()};
  assert.match(api.renderChatMessage(fresh,old),/9\/5 12:34:56/);
  assert.match(api.renderChatMessage(fresh,old),/class="message user"/);
  assert.match(api.renderChatMessage({role:'assistant',content:'<script>'},null),/&lt;script&gt;/);
});

test('anniversary uses inclusive local calendar dates without DST-sensitive elapsed time',()=>{
  const {api}=loadApp();
  assert.equal(api.getTogetherDays(new Date(2026,5,15,23,59)),1);
  assert.equal(api.getTogetherDays(new Date(2026,5,16,0,1)),2);
  assert.equal(api.getTogetherDays(new Date(2026,5,14,12)),1);
});

test('composer height tracks the measured footer instead of a fixed message inset',()=>{
  const {api,get,rootStyles}=loadApp();
  get('main>footer').rect={top:600,height:132};api.syncComposerHeight();
  assert.equal(rootStyles['--composer-h'],'132px');
  get('main>footer').rect={top:500,height:232};api.syncComposerHeight();
  assert.equal(rootStyles['--composer-h'],'232px');
});

test('send pointerdown keeps the focused composer in place without submitting',()=>{
  const {get,context}=loadApp();
  const input=get('#input'),button=get('#send');
  input.value='只发送一次';context.document.activeElement=input;
  let prevented=0;
  button.onpointerdown({preventDefault(){prevented++}});
  assert.equal(prevented,1);
  assert.equal(input.value,'只发送一次');
  assert.equal(typeof button.onclick,'function');
});


test('iOS settles viewport bursts before committing geometry or scrolling across three keyboard cycles',()=>{
  const timers=new Map(),frames=[];let timerId=0;
  const vv={height:844,offsetTop:0,width:390,scale:1};
  const {api,get,rootStyles}=loadApp({},undefined,undefined,{visualViewport:vv,navigator:{userAgent:'iPhone'},setTimeout:fn=>{timers.set(++timerId,fn);return timerId},clearTimeout:id=>timers.delete(id),requestAnimationFrame:fn=>frames.push(fn)});
  const fireTimer=()=>{const [id,fn]=[...timers].at(-1);timers.delete(id);fn()};
  const box=get('#messages');box.scrollHeight=1200;box.clientHeight=400;
  api.setViewportBottomAnchor(true);
  for(let cycle=0;cycle<3;cycle++){
    for(const finalHeight of [500,844]){
      const before=rootStyles['--vv-bottom'];box.scrollTop=0;
      vv.height=600;vv.offsetTop=90;api.scheduleVisualViewportSync();
      fireTimer();frames.shift()();
      vv.height=finalHeight;vv.offsetTop=0;api.scheduleVisualViewportSync();
      frames.shift()(); // stale second frame must not commit
      api.syncComposerHeight();
      assert.equal(rootStyles['--vv-bottom'],before);
      assert.equal(box.scrollTop,0);
      fireTimer();frames.shift()();frames.shift()();frames.shift()();frames.shift()();
      assert.equal(rootStyles['--vv-bottom'],finalHeight+'px');
      assert.equal(box.scrollTop,800);
    }
  }
});

test('iOS rechecks geometry between stable frames even without another viewport event',()=>{
  const timers=new Map(),frames=[];let id=0;
  const vv={height:844,offsetTop:0,width:390,scale:1};
  const {api,rootStyles}=loadApp({},undefined,undefined,{visualViewport:vv,navigator:{userAgent:'iPhone'},setTimeout:fn=>{timers.set(++id,fn);return id},clearTimeout:id=>timers.delete(id),requestAnimationFrame:fn=>frames.push(fn)});
  api.scheduleVisualViewportSync();timers.get(id)();frames.shift()();vv.height=500;frames.shift()();
  assert.equal(rootStyles['--vv-height'],'844px');
  timers.get(id)();frames.shift()();frames.shift()();assert.equal(rootStyles['--vv-height'],'500px');
});

test('one completed request cannot clear a later active request',async()=>{
  const controls=[];let chats=0;
  const fetchImpl=async(url)=>{
    if(url.includes('/status'))return new Response(JSON.stringify({state:'connected'}),{headers:{'content-type':'application/json'}});
    const id=++chats===1?'one':'two';return new Response(new ReadableStream({start(controller){controls.push(controller);controller.enqueue(new TextEncoder().encode(JSON.stringify({type:'turn_started',turnId:id})+'\n'+JSON.stringify({type:'segment_delta',turnId:id,delta:'保留正文'})+'\n'))}}),{headers:{'content-type':'application/x-ndjson'}});
  };
  let ids=0;const {api,get}=loadApp({},fetchImpl,{randomUUID:()=>`request-${++ids}`});api.selectProvider('claude_tmux');await api.refreshRuntimeStatus();get('#input').value='first';const first=api.send();await new Promise(r=>setTimeout(r,0));
  get('#input').value='second';const second=api.send();await new Promise(r=>setTimeout(r,0));assert.equal(api.getState().activeTurnId,'two');
  controls[0].enqueue(new TextEncoder().encode('{"type":"turn_done","turnId":"one"}\n'));controls[0].close();await first;assert.equal(api.getState().sending,true);assert.equal(api.getState().activeTurnId,'two');
  controls[1].enqueue(new TextEncoder().encode('{"type":"turn_done","turnId":"two"}\n'));await second;assert.equal(api.getState().sending,false);assert.equal(api.getState().sessions[0].messages.filter(message=>message.role==='assistant').map(message=>message.content).join('|'),'保留正文|保留正文');
});


for(const [name,status,notice,retry,sending] of [
 ['B received active',{state:'received',receivedByRuntime:true,active:true,finished:false,recoverable:true,latestSeq:2,events:[]},'已经收到',false,true],
 ['C completed replay',{state:'finished',receivedByRuntime:true,finished:true,recoverable:true,latestSeq:3,events:[{type:'turn_done',turnId:'lost',seq:3}]},'',false,false],
 ['D not delivered',{state:'not_delivered',receivedByRuntime:false,finished:true,recoverable:true,latestSeq:2,events:[]},'没有成功送达',true,false],
 ['unknown journal',null,'内容没有完整传回来',false,false]
])test('network recovery '+name,async()=>{
 let posts=0,queries=0;
 const timers=new Map();let id=0;
 const {api,get}=loadApp({},async url=>{
  if(url.startsWith('/api/chat/turn/')){queries++;return new Response(JSON.stringify(status?{turnId:'lost',...status}:{state:'unknown'}),{status:status?200:404})}
  if(url.includes('/status'))return new Response(JSON.stringify({state:'connected'}));
  assert.equal(url,'/api/chat');posts++;
  return new Response('{"type":"turn_started","turnId":"lost","seq":1}\n{"type":"segment_delta","turnId":"lost","delta":"保留正文","seq":2}\n',{headers:{'content-type':'application/x-ndjson'}});
 },undefined,{setTimeout:(fn,ms)=>{timers.set(++id,{fn,ms});return id},clearTimeout:id=>timers.delete(id),navigator:{onLine:true}});
 api.selectProvider('claude_tmux');await api.refreshRuntimeStatus();get('#input').value='fake only';await api.send();
 const out=api.getState().sessions[0].messages.at(-1);
 assert.equal(out.content,'保留正文');if(notice)assert.match(out.delivery.notice,new RegExp(notice));else assert.equal(out.delivery.notice,'');assert.equal(out.delivery.retryAllowed,retry);assert.equal(api.getState().sending,sending);assert.equal(posts,1);assert.equal(queries,1);assert.equal(out.delivery.lastAppliedSeq,status?.latestSeq||2);
 // Repeated foreground/online signals only query and are rate limited.
 for(let i=0;i<10;i++)api.resumeConnectionCheck();await Promise.resolve();assert.equal(posts,1);assert.equal(queries,1);
 assert.doesNotMatch(api.renderChatMessage(out,null),/Load failed|Failed to fetch|ECONNRESET/);
});

for(const errorText of ['Load failed','AbortError','Failed to fetch','NetworkError','ECONNRESET','stream canceled by remote','502','504','socket hang up'])test('A/E pre-turn '+errorText+' offers explicit retry without posting twice',async()=>{
 let posts=0,lookups=0;const {api,get}=loadApp({},async(url,options)=>{if(url.includes('/status'))return new Response(JSON.stringify({state:'connected'}));if(url.includes('/recovery/by-request/')){lookups++;return new Response(JSON.stringify({status:'EXPIRED'}))}if((options?.method||'GET')==='POST'){posts++;throw new TypeError(errorText)}throw new Error('unexpected request')});
 api.selectProvider('claude_tmux');await api.refreshRuntimeStatus();get('#input').value='fake only';await api.send();const out=api.getState().sessions[0].messages.at(-1);
 assert.equal(posts,1);assert.equal(lookups,1);assert.equal(api.getState().sending,false);assert.equal(out.delivery.retryAllowed,true);assert.match(api.renderChatMessage(out,null),/重新发送/);assert.equal(out.content,'');assert.ok(!out.delivery.notice.includes(errorText));api.resumeConnectionCheck();assert.equal(posts,1);
});

test('pre-turn disconnect resolves request id then replays one multi-bubble result without another POST',async()=>{
 let posts=0,lookups=0,replays=0;const {api,get}=loadApp({},async(url,options)=>{
  if(url.includes('/status'))return new Response(JSON.stringify({state:'connected'}));
  if(url.includes('/recovery/by-request/')){lookups++;return new Response(JSON.stringify({status:'FOUND',turnId:'recovered-turn'}))}
  if(url.includes('/api/chat/turn/recovered-turn/events')){replays++;return new Response(JSON.stringify({turnId:'recovered-turn',state:'finished',receivedByRuntime:true,finished:true,recoverable:true,latestSeq:4,events:[{type:'turn_started',turnId:'recovered-turn',seq:1},{type:'assistant_message',turnId:'recovered-turn',messageId:'one',text:'第一颗',source:'tool',seq:2},{type:'assistant_message',turnId:'recovered-turn',messageId:'two',text:'第二颗',source:'tool',seq:3},{type:'turn_done',turnId:'recovered-turn',seq:4}]}))}
  if((options?.method||'GET')==='POST'){posts++;throw new TypeError('Load failed')}throw new Error('unexpected request '+url);
 });
 api.selectProvider('claude_tmux');await api.refreshRuntimeStatus();get('#input').value='fixture';await api.send();const session=api.getState().sessions[0];
 assert.equal(posts,1);assert.equal(lookups,1);assert.equal(replays,1);assert.equal(session.messages.at(-1).toolMessages.map(message=>message.content).join('|'),'第一颗|第二颗');assert.equal(api.getState().sending,false);assert.doesNotMatch(session.messages.map(message=>message.delivery?.notice||'').join(' '),/重新发送|可能没有发出去/);
});

for(const initialStatus of ['PENDING','NOT_FOUND'])test(`pre-turn lookup tolerates transient ${initialStatus} before FOUND`,async()=>{
 let posts=0,lookups=0;const {api,get}=loadApp({},async(url,options)=>{
  if(url.includes('/status'))return new Response(JSON.stringify({state:'connected'}));
  if(url.includes('/recovery/by-request/'))return new Response(JSON.stringify(++lookups===1?{status:initialStatus}:{status:'FOUND',turnId:'eventual-turn'}),{status:initialStatus==='NOT_FOUND'&&lookups===1?404:200});
  if(url.includes('/events?'))return new Response(JSON.stringify({turnId:'eventual-turn',state:'finished',receivedByRuntime:true,finished:true,recoverable:true,latestSeq:3,events:[{type:'turn_started',turnId:'eventual-turn',seq:1},{type:'segment_delta',turnId:'eventual-turn',delta:'eventual reply',seq:2},{type:'turn_done',turnId:'eventual-turn',seq:3}]}));
  if((options?.method||'GET')==='POST'){posts++;throw new TypeError('Load failed')}throw new Error('unexpected request');
 });
 api.selectProvider('claude_tmux');await api.refreshRuntimeStatus();get('#input').value='fixture';await api.send();assert.equal(posts,1);assert.equal(lookups,2);assert.equal(api.getState().sessions[0].messages.at(-1).content,'eventual reply');assert.equal(api.getState().sending,false);
});

test('Safari reload recovers a pre-turn descriptor by request id using GET only',async()=>{
 const calls=[],session={id:'restored',provider:'claude_tmux',messages:[{role:'user',content:'fixture'},{role:'assistant',content:'',pending:true,delivery:{clientRequestId:'saved-request',turnId:null,runtimeId:'claude-main',phase:'pre_turn',lastAppliedSeq:0}}]};
 const {api}=loadApp({'dwell.provider':'claude_tmux','dwell.active':'restored','dwell.sessions':JSON.stringify([session])},async(url,options)=>{calls.push({url,method:options?.method||'GET'});if(url.includes('/recovery/by-request/'))return new Response(JSON.stringify({status:'FOUND',turnId:'reload-turn'}));if(url.includes('/events?'))return new Response(JSON.stringify({turnId:'reload-turn',state:'finished',receivedByRuntime:true,finished:true,recoverable:true,latestSeq:3,events:[{type:'turn_started',turnId:'reload-turn',seq:1},{type:'segment_delta',turnId:'reload-turn',delta:'恢复正文',seq:2},{type:'turn_done',turnId:'reload-turn',seq:3}]}));return new Response(JSON.stringify({state:'connected'}))},undefined,{setTimeout:(fn)=>{queueMicrotask(fn);return 1},clearTimeout(){}});
 await new Promise(resolve=>setTimeout(resolve,10));assert.ok(calls.some(call=>call.url.includes('/recovery/by-request/saved-request')));assert.ok(calls.every(call=>call.method==='GET'));assert.equal(api.getState().sessions[0].messages.at(-1).content,'恢复正文');assert.equal(api.getState().sending,false);
});

test('replay ignores duplicate sequences and rejects a sequence gap',()=>{
 const {api}=loadApp();const out={role:'assistant',content:'',pending:true,createdAt:1},request={out,lastAppliedSeq:0,clientRequestId:'c',turnId:'turn',phase:'connection_lost',runtimeId:'claude-main'};
 assert.equal(api.applyRequestEvent(request,{type:'turn_started',turnId:'turn',seq:1}),true);
 assert.equal(api.applyRequestEvent(request,{type:'segment_delta',turnId:'turn',delta:'A',seq:2}),true);
 assert.equal(api.applyRequestEvent(request,{type:'segment_delta',turnId:'turn',delta:'A',seq:2}),false);assert.equal(out.content,'A');assert.equal(request.lastAppliedSeq,2);
 assert.throws(()=>api.applyRequestEvent(request,{type:'segment_delta',turnId:'turn',delta:'C',seq:4}),/turn_sequence_gap/);assert.equal(out.content,'A');assert.equal(request.lastAppliedSeq,2);
});

test('simultaneous lifecycle recovery signals share one replay request and never POST',async()=>{
 let resolveReplay,replayCalls=0,posts=0;const pending=new Promise(resolve=>{resolveReplay=resolve});
 const session={id:'restored',provider:'claude_tmux',messages:[{role:'user',content:'fixture'},{role:'assistant',content:'partial',delivery:{clientRequestId:'request',turnId:'turn',runtimeId:'claude-main',phase:'streaming',lastAppliedSeq:2}}]};
 const {api}=loadApp({'dwell.provider':'claude_tmux','dwell.active':'restored','dwell.sessions':JSON.stringify([session])},async(url,options)=>{if((options?.method||'GET')==='POST')posts++;if(!url.includes('/events?'))return new Response(JSON.stringify({state:'connected'}));replayCalls++;await pending;return new Response(JSON.stringify({turnId:'turn',state:'received',receivedByRuntime:true,finished:false,recoverable:true,latestSeq:2,events:[]}))},undefined,{setTimeout:()=>1,navigator:{onLine:true}});
 for(let i=0;i<8;i++)api.resumeConnectionCheck();await Promise.resolve();assert.equal(replayCalls,1);resolveReplay();await Promise.resolve();await Promise.resolve();assert.equal(replayCalls,1);assert.equal(posts,0);
});


test('explicit resend button is the only path to a second POST after pre-turn failure',async()=>{
 let posts=0;const button=new FakeElement();button.dataset={recovery:'retry',request:'generated-session-id'};
 const {api,get}=loadApp({},async(url,options)=>{if(url.includes('/status'))return new Response(JSON.stringify({state:'connected'}));if(url.includes('/recovery/by-request/'))return new Response(JSON.stringify({status:'EXPIRED'}));if((options?.method||'GET')!=='POST')throw new Error('unexpected request');if(++posts===1)throw new TypeError('Load failed');return new Response('{"type":"turn_started","turnId":"retry"}\n{"type":"turn_done","turnId":"retry"}\n',{headers:{'content-type':'application/x-ndjson'}})},undefined,{querySelectorAll:selector=>selector==='[data-recovery]'?[button]:[]});
 api.selectProvider('claude_tmux');await api.refreshRuntimeStatus();get('#input').value='fake retry';await api.send();assert.equal(posts,1);button.click();button.click();await new Promise(r=>setTimeout(r,0));assert.equal(posts,2);assert.equal(api.getState().sending,false);
});


test('Safari page reload restores only read-only status for an interrupted turn',async()=>{
 const calls=[];const session={id:'restored',provider:'claude_tmux',messages:[{role:'user',content:'private fixture'},{role:'assistant',content:'partial',delivery:{clientRequestId:'original',turnId:'original-turn',runtimeId:'claude-main',phase:'streaming'}}]};
 const {api}=loadApp({'dwell.provider':'claude_tmux','dwell.active':'restored','dwell.sessions':JSON.stringify([session])},async (url,options)=>{calls.push({url,method:options?.method||'GET'});return new Response(JSON.stringify(url.includes('/api/chat/turn/')?{turnId:'original-turn',state:'finished',finished:true,receivedByRuntime:true}:{state:'connected'}))},undefined,{setTimeout:()=>1});
 await new Promise(r=>setTimeout(r,0));assert.ok(calls.some(c=>c.url.includes('/api/chat/turn/')));assert.ok(calls.every(c=>c.method==='GET'));assert.equal(api.getState().sending,false);assert.equal(api.getState().sessions[0].messages.at(-1).content,'partial');
});
test('fixed Claude pill displays Sonnet 4.6 and cannot open settings or select a model', async () => {
  const {api,get}=loadApp({'dwell.provider':'claude_tmux'},async url=>{
    assert.equal(url,'/api/runtimes/claude-tmux/status');
    return new Response(JSON.stringify({state:'connected',active:false,activeTurnId:null}));
  });
  await api.refreshRuntimeStatus();
  let opened=0;get('#settings').classList.add=()=>opened++;
  assert.equal(get('#modelLabel').textContent,'Sonnet 4.6');
  assert.equal(get('#modelBtn').disabled,true);
  get('#modelBtn').click();
  assert.equal(opened,0);
  assert.equal(Object.hasOwn(api.profile('claude_tmux'),'model'),false);
});

test('OB drawer returns to Chat for three cycles and an existing conversation',()=>{
  const sessionButton=new FakeElement();sessionButton.dataset.id='kept';
  const kept={id:'kept',title:'哥哥我回来了！',provider:'claude_tmux',created:1,messages:[]};
  const {api,get}=loadApp({'dwell.active':'kept','dwell.sessions':JSON.stringify([kept])},undefined,undefined,{querySelectorAll:selector=>selector==='.session'?[sessionButton]:[]}),aside=get('aside'),classes=new Set();aside.classList={add:value=>classes.add(value),remove:value=>classes.delete(value),contains:value=>classes.has(value),toggle:value=>classes.has(value)?classes.delete(value):classes.add(value)};
  for(let i=0;i<3;i++){api.showMemory();get('aside').classList.add('on');get('#chatNav').click();assert.equal(api.getState().activeAppView,'chat');assert.equal(get('aside').classList.contains('on'),false)}
  api.showMemory();get('aside').classList.add('on');sessionButton.click();assert.equal(api.getState().activeAppView,'chat');assert.equal(api.getState().activeId,'kept');assert.equal(get('aside').classList.contains('on'),false);
});

async function liveViewFixture(){
  const calls=[];let source,aborts=0,cancels=0;
  const stream=new ReadableStream({start(c){source=c},cancel(){cancels++}});
  const {api,get}=loadApp({'dwell.provider':'claude_tmux'},async(url,init={})=>{
    calls.push(url);
    if(url==='/api/chat'){init.signal.addEventListener('abort',()=>aborts++);return new Response(stream,{headers:{'content-type':'application/x-ndjson'}})}
    if(url==='/api/chat/stop')return new Response(JSON.stringify({ok:true,status:'stopped'}));
    return new Response(JSON.stringify({state:'connected',active:false,activeTurnId:null}));
  });
  const box=get('#messages');let html='',nodes=new Map();
  Object.defineProperty(box,'innerHTML',{get:()=>html,set(value){
    for(const node of nodes.values())node.detached=true;
    html=value;nodes=new Map();
    for(const match of value.matchAll(/data-message-view="(\d+)"[\s\S]*?<div class="bubble ([^"]*)">([\s\S]*?)<\/div><\/article>/g)){
      const node=new FakeElement(),classes=new Set(match[2].split(/\s+/).filter(Boolean));
      node.textContent=match[3];node.classList={toggle(k,on){if(on)classes.add(k);else classes.delete(k)},contains:k=>classes.has(k),remove:k=>classes.delete(k)};
      nodes.set(match[1],node);
    }
  }});
  box.querySelector=selector=>nodes.get(selector.match(/data-message-view="(\d+)"/)?.[1])||null;
  await api.refreshRuntimeStatus();get('#input').value='mock stream fixture';const done=api.send();
  const tick=()=>new Promise(r=>setTimeout(r,0));await tick();
  const emit=async event=>{source.enqueue(new TextEncoder().encode(JSON.stringify(event)+'\n'));await tick()};
  await emit({type:'turn_started',turnId:'view-turn'});
  return {api,get,done,emit,tick,calls,disconnect:()=>source.error(new TypeError('Load failed')),bubble:()=>[...nodes.values()].at(-1),out:()=>api.getState().sessions[0].messages.at(-1),counts:()=>({aborts,cancels})};
}

test('live stream survives Memory navigation while ordinary text stays hidden until complete',async()=>{
  const f=await liveViewFixture();assert.equal(f.out().pending,true);assert.equal(assistantArticles(f.get('#messages').innerHTML),0);
  f.api.showMemory();await f.emit({type:'segment_delta',delta:'first'});f.api.showChat();
  assert.equal(assistantArticles(f.get('#messages').innerHTML),0);assert.equal(f.api.getState().activeTurnId,'view-turn');assert.equal(f.api.getState().sending,true);
  await f.emit({type:'segment_delta',delta:' second'});assert.equal(assistantArticles(f.get('#messages').innerHTML),0);
  assert.deepEqual(f.counts(),{aborts:0,cancels:0});assert.equal(f.calls.filter(x=>x==='/api/chat').length,1);assert(!f.calls.includes('/api/chat/stop'));
  await f.emit({type:'turn_done'});await f.done;assert.equal(f.api.getState().sending,false);assert.equal(f.out().pending,false);assert.match(f.get('#messages').innerHTML,/first second/);
});

test('sidebar and returning Chat preserve a hidden pending ordinary reply without abort or stop',async()=>{
  const f=await liveViewFixture();f.get('#menuBtn').click();f.get('#menuBtn').click();f.api.showChat();
  assert.equal(assistantArticles(f.get('#messages').innerHTML),0);assert.equal(f.out().pending,true);
  assert.equal(f.api.getState().activeTurnId,'view-turn');assert.deepEqual(f.counts(),{aborts:0,cancels:0});assert(!f.calls.includes('/api/chat/stop'));
  await f.emit({type:'segment_delta',delta:'body'});assert.equal(assistantArticles(f.get('#messages').innerHTML),0);
  await f.emit({type:'turn_done'});await f.done;assert.match(f.get('#messages').innerHTML,/body/);
});

test('rerender does not expose ordinary deltas and finalizes once into the current DOM',async()=>{
  const f=await liveViewFixture();f.api.renderMessages(false);assert.equal(assistantArticles(f.get('#messages').innerHTML),0);
  await f.emit({type:'segment_delta',delta:'new node body'});assert.equal(assistantArticles(f.get('#messages').innerHTML),0);
  await f.emit({type:'turn_done'});await f.done;assert.equal(assistantArticles(f.get('#messages').innerHTML),1);assert.match(f.get('#messages').innerHTML,/new node body/);
});

test('completed assistant bubble follows existing bottom intent without stealing an active history scroll',async()=>{
  const atBottom=await liveViewFixture(),bottomBox=atBottom.get('#messages');bottomBox.scrollHeight=1000;bottomBox.clientHeight=300;bottomBox.scrollTop=700;atBottom.api.setViewportBottomAnchor(true);await atBottom.emit({type:'segment_delta',delta:'final at bottom'});bottomBox.scrollHeight=1400;await atBottom.emit({type:'turn_done'});await atBottom.done;assert.equal(bottomBox.scrollTop,1100);
  const readingHistory=await liveViewFixture(),historyBox=readingHistory.get('#messages');historyBox.scrollHeight=1000;historyBox.clientHeight=300;historyBox.scrollTop=700;readingHistory.api.setViewportBottomAnchor(true);readingHistory.api.cancelViewportBottomAnchor();historyBox.scrollTop=180;await readingHistory.emit({type:'segment_delta',delta:'final while reading'});historyBox.scrollHeight=1400;await readingHistory.emit({type:'turn_done'});await readingHistory.done;assert.equal(historyBox.scrollTop,180);
});

test('stream state continues without its chat DOM and never writes into another conversation',async()=>{
  const f=await liveViewFixture(),session=f.api.getState().sessions[0];f.api.newChat();
  await f.emit({type:'segment_delta',delta:'original conversation'});assert.equal(session.messages.at(-1).content,'original conversation');assert.equal(f.bubble(),undefined);
  assert.deepEqual(f.counts(),{aborts:0,cancels:0});await f.emit({type:'turn_done'});await f.done;
});

const toolFrame=(id,text,turnId='view-turn')=>({type:'assistant_message',turnId,messageId:id,text,source:'tool'});
const assistantArticles=html=>(html.match(/class="message "/g)||[]).length;

test('presentation: one and three successful tool messages render immediately with one timestamp and keep generating',async()=>{
  const f=await liveViewFixture();
  for(let i=1;i<=3;i++){
    await f.emit(toolFrame('tool-'+i,'independent '+i));
    const html=f.get('#messages').innerHTML;assert.equal(assistantArticles(html),i);assert(html.includes('independent '+i));
    assert.equal((html.match(/class="message-time "/g)||[]).length,1);assert.equal(f.api.getState().sending,true);
  }
  assert.equal(f.out().toolMessages.length,3);assert(f.out().toolMessages.every(m=>m.turnId==='view-turn'));
  await f.emit({type:'turn_done'});await f.done;assert.equal(assistantArticles(f.get('#messages').innerHTML),3);
});

test('presentation: whole MessageDisplay duplicate is hidden but original text remains in state',async()=>{
  const f=await liveViewFixture();await f.emit(toolFrame('one','first'));await f.emit(toolFrame('two','second'));
  await f.emit({type:'segment_delta',delta:'first\n\nsecond'});await f.emit({type:'segment_done'});
  assert.equal(assistantArticles(f.get('#messages').innerHTML),2);assert.equal(f.out().content,'first\n\nsecond');
  await f.emit({type:'turn_done'});await f.done;assert.equal(assistantArticles(f.get('#messages').innerHTML),2);
});

test('presentation: genuinely new final body or prefix extension is retained after partial tool delivery',async()=>{
  const f=await liveViewFixture();await f.emit(toolFrame('one','first'));
  await f.emit({type:'segment_delta',delta:'first, with a genuinely new addition'});await f.emit({type:'segment_done'});
  assert.equal(assistantArticles(f.get('#messages').innerHTML),2);assert(f.get('#messages').innerHTML.includes('genuinely new addition'));
  await f.emit({type:'turn_done'});await f.done;
});

test('presentation: a completed turn with no explicit delivery leaves no placeholder bubble',async()=>{
  const f=await liveViewFixture();assert.equal(f.out().toolMessages,undefined);
  await f.emit({type:'turn_done'});await f.done;
  assert.equal(f.out().toolMessages,undefined);assert.equal(assistantArticles(f.get('#messages').innerHTML),0);assert.doesNotMatch(f.get('#messages').innerHTML,/对面没有返回文字|正在想/);
});

test('presentation: tool deliveries survive Memory/sidebar and destroyed message DOM',async()=>{
  const f=await liveViewFixture();await f.emit(toolFrame('one','first'));f.api.showMemory();f.get('#menuBtn').click();
  f.get('#messages').innerHTML='';await f.emit(toolFrame('two','second'));f.api.showChat();
  assert.equal(assistantArticles(f.get('#messages').innerHTML),2);assert.equal(f.api.getState().sending,true);
  f.api.renderMessages(false);await f.emit(toolFrame('three','third'));assert.equal(assistantArticles(f.get('#messages').innerHTML),3);
  assert.deepEqual(f.counts(),{aborts:0,cancels:0});await f.emit({type:'turn_done'});await f.done;
});

test('presentation: Send never invokes Stop while a reply is active',async()=>{
  const f=await liveViewFixture();await f.emit(toolFrame('one','first'));await f.emit(toolFrame('two','second'));
  await f.api.send();assert.equal(f.api.getState().sending,true);assert.equal(f.out().toolMessages.length,2);
  assert.equal(assistantArticles(f.get('#messages').innerHTML),2);assert.equal(f.calls.filter(x=>x==='/api/chat/stop').length,0);
  await f.emit({type:'turn_stopped'});await f.done;assert.equal(f.out().toolMessages.length,2);
});

test('presentation: duplicate event and wrong turn cannot duplicate history; persisted tool messages rerender once',async()=>{
  const f=await liveViewFixture();await f.emit(toolFrame('one','first'));await f.emit(toolFrame('one','first'));await f.emit(toolFrame('foreign','wrong','other-turn'));
  assert.equal(f.out().toolMessages.length,1);await f.emit({type:'turn_done'});await f.done;
  const serialized=JSON.parse(JSON.stringify(f.out()));const html=f.api.renderChatMessage(serialized,{role:'user'});
  assert.equal(assistantArticles(html),1);assert.equal((html.match(/class="message-time "/g)||[]).length,1);
  assert(!html.includes('wrong'));assert.equal(f.calls.filter(x=>x==='/api/chat').length,1);
});

test('presentation: real stream disconnect retains accepted tool messages and does not resend chat or tools',async()=>{
  const f=await liveViewFixture();await f.emit(toolFrame('one','retained delivery'));f.disconnect();await f.done;
  assert.equal(f.out().toolMessages.length,1);assert.equal(f.out().toolMessages[0].content,'retained delivery');
  assert.equal(f.calls.filter(x=>x==='/api/chat').length,1);assert(!f.calls.includes('/api/chat/stop'));
  assert(f.calls.some(x=>x.includes('/api/chat/turn/view-turn/events?afterSeq=')));
});

test('presentation: completed tool-only history remains available to continuation without mutating stored history',()=>{
  const {api}=loadApp();const message={role:'assistant',content:'',pending:false,toolMessages:[{content:'已经完成第一件事'},{content:'需要保留第二件事'}]};
  const before=JSON.stringify(message),result=api.buildContinuation({title:'history',messages:[{role:'user',content:'继续'},message]});
  assert(result.text.includes('已经完成第一件事'));assert(result.text.includes('需要保留第二件事'));assert.equal(JSON.stringify(message),before);
});

test('presentation: ordinary assistant normalizes only br tags and trims only edge newlines',()=>{
  const {api}=loadApp();
  for(const [content,expected] of [
    ['<br><br>你好','你好'],
    ['第一句<br>第二句','第一句\n第二句'],
    ['第一句<br><br>第二句','第一句\n\n第二句'],
    ['第一句<br/>第二句','第一句\n第二句'],
    ['第一句<br />第二句','第一句\n第二句'],
    ['<BR>你好','你好'],
    ['你好<br><br>','你好'],
    ['ordinary unchanged','ordinary unchanged']
  ]){
    const html=api.renderChatMessage({role:'assistant',content},null);
    assert(html.includes(expected));assert(!html.includes('&lt;br'));
  }
  assert(api.renderChatMessage({role:'assistant',content:'  第一行<br>第二行  '},null).includes('  第一行\n第二行  '));
});

test('presentation: non-br HTML stays escaped while user and tool br text stay unchanged',()=>{
  const {api}=loadApp();
  assert.match(api.renderChatMessage({role:'assistant',content:'<b>hello</b>'},null),/&lt;b&gt;hello&lt;\/b&gt;/);
  assert.match(api.renderChatMessage({role:'assistant',content:'<script>alert(1)<\/script>'},null),/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(api.renderChatMessage({role:'user',content:'<br>hello'},null),/&lt;br&gt;hello/);
  assert.match(api.renderChatMessage({role:'assistant',source:'tool',content:'<br>hello'},null),/&lt;br&gt;hello/);
});

test('image messages render real img elements from opaque IDs without base64, paths, or unsafe stored URLs',()=>{
  const {api}=loadApp(),id='img_'+Buffer.alloc(32,4).toString('base64url');
  const html=api.renderChatMessage({role:'user',content:'看这个',images:[{imageId:id,mime:'image/png',width:80,height:60,contentUrl:'javascript:alert(1)'},{imageId:'../secret',contentUrl:'file:///etc/passwd'}]},null);
  assert.match(html,new RegExp(`<img src="/api/chat/images/${id}/content"`));assert.match(html,/class="message-images count-1"/);assert.match(html,/message-text/);assert(!html.includes('javascript:'));assert(!html.includes('file:'));assert(!html.includes('base64'));
  const imageOnly=api.renderChatMessage({role:'assistant',content:'',images:[{imageId:id,mime:'image/png'}]},null);assert.match(imageOnly,/image-only/);assert(!imageOnly.includes('正在想'));
});

test('presentation: real-style br aggregation keeps three tool bubbles through Stop and reload',async()=>{
  const f=await liveViewFixture(),texts=[
    '哈，所以他现在活得好好的，就是因为大家都怕事，没人戳穿他。',
    '不过这种人迟早翻车，人设立得越高摔得越响，等着看就行了。',
    '你朋友现在还和他有联系吗，还是早断干净了？'
  ];
  await f.emit(toolFrame('one',texts[0]));await f.emit(toolFrame('two',texts[1]));await f.emit(toolFrame('three',texts[2]));
  await f.emit({type:'segment_delta',delta:'<br><br>'+texts[2]});await f.emit({type:'segment_done'});
  let html=f.get('#messages').innerHTML;
  assert.equal(assistantArticles(html),3);assert(!html.includes('&lt;br'));assert(!html.includes('<br>'));
  assert.equal(f.out().content,'<br><br>'+texts[2]);assert.equal(f.out().toolMessages.length,3);
  await f.api.send();assert.equal(f.out().toolMessages.length,3);await f.emit({type:'turn_stopped'});await f.done;
  const restored=JSON.parse(JSON.stringify(f.out()));html=f.api.renderChatMessage(restored,{role:'user'});
  assert.equal(assistantArticles(html),3);assert(!html.includes('&lt;br'));assert(!html.includes('<br>'));
  assert.equal((html.match(/class="message-time "/g)||[]).length,1);
});
