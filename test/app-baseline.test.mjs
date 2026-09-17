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
    requestAnimationFrame: timing.requestAnimationFrame,
    cancelAnimationFrame: timing.cancelAnimationFrame,
    visualViewport: timing.visualViewport,
    innerHeight: 800,
    localStorage: {
      getItem: key => storage.has(key) ? storage.get(key) : null,
      setItem: (key, value) => storage.set(key, String(value))
    },
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    document: {
      body:new FakeElement(),
      documentElement: {clientHeight:800,style:{setProperty:(name,value)=>{rootStyles[name]=value}}},
      querySelector: get,
      querySelectorAll: timing.querySelectorAll || (() => []),
      createElement: () => new FakeElement()
    }
  };
  vm.createContext(context);
  vm.runInContext(`${appSource}\n;globalThis.__appTest={showChat,showMemory:()=>{memoryLoaded=true;showMemory()},renderMessages,resumeConnectionCheck,recoverConnection,recoverLegacySuppressedFinals,renderChatMessage,syncComposerHeight,generateId,getTogetherDays,toast,positionToast,syncVisualViewport,scheduleVisualViewportSync,setViewportBottomAnchor,cancelViewportBottomAnchor,presets,runtimePresets,profile,persist,newChat,selectProvider,refreshRuntimeStatus,buildContinuation,openContinuation,startContinuation,applyTurnEvent,applyRequestEvent,messagesNearBottom,scrollMessagesToBottom,createStreamingView,readTurnStream,send,openThoughtProcess,closeThoughtProcess,renderThoughtSheet,getState:()=>({activeProvider,profiles,sessions,activeId,activeAppView,sending,activeTurnId,tmuxStatus,keepBottomThroughViewportResize})};`, context);
  return { api: context.__appTest, get, storage, rootStyles, context };
}

test('thought process event stays out of ordinary assistant body and shows a turn-bound cloud',()=>{const {api}=loadApp(),out={role:'assistant',content:'final',turnId:'turn-a',createdAt:1};api.applyTurnEvent(out,{type:'thought_process',turnId:'turn-a',items:[{id:'i',type:'thinking',text:'reason'}]});assert.equal(out.content,'final');const html=api.renderChatMessage(out,null);assert.match(html,/data-thought-turn="turn-a"/);assert.doesNotMatch(html,/reason/)});
test('assistant without thought process has no cloud button',()=>{const {api}=loadApp();assert.doesNotMatch(api.renderChatMessage({role:'assistant',content:'final',turnId:'turn-a',createdAt:1},null),/thought-cloud/)});
test('legacy suppression flag cannot erase real final assistant text',()=>{const {api}=loadApp(),out={role:'assistant',content:'final',turnId:'turn-a'};api.applyTurnEvent(out,{type:'thought_process',turnId:'turn-a',items:[{id:'i',type:'thinking',text:'reason'}],suppressOrdinaryBody:true});assert.equal(out.content,'final');assert.equal(out.thoughtProcess.items.length,1)});
test('GET-only legacy recovery restores journaled final text without a POST',async()=>{const sessions=[{id:'s',provider:'claude',messages:[{role:'assistant',content:'',turnId:'turn-a',thoughtProcess:{items:[{type:'thinking'}]}}]}],calls=[];const {api}=loadApp({'dwell.sessions':JSON.stringify(sessions),'dwell.active':'s'},async(url,init)=>{calls.push([url,init]);return new Response(JSON.stringify({events:[{type:'segment_delta',delta:'one'},{type:'segment_delta',delta:' two'},{type:'turn_done'}]}),{status:200,headers:{'content-type':'application/json'}})});assert.equal(await api.recoverLegacySuppressedFinals(),true);assert.equal(api.getState().sessions[0].messages[0].content,'one two');assert.deepEqual(calls.map(([,init])=>init?.method||'GET'),['GET','GET'])});
test('wrong turn cannot bind thought process',()=>{const {api}=loadApp(),out={role:'assistant',content:'final',turnId:'turn-a'};api.applyTurnEvent(out,{type:'thought_process',turnId:'turn-b',items:[{id:'i',type:'thinking',text:'x'}]});assert.equal(out.thoughtProcess,undefined)});
test('thought snapshot replacement merges streaming updates without duplicate items',()=>{const {api}=loadApp(),out={role:'assistant',content:'',turnId:'t'};api.applyTurnEvent(out,{type:'thought_process',turnId:'t',items:[{id:'i',type:'thinking',text:'a'}]});api.applyTurnEvent(out,{type:'thought_process',turnId:'t',items:[{id:'i',type:'thinking',text:'ab'}]});assert.deepEqual(JSON.parse(JSON.stringify(out.thoughtProcess.items)),[{id:'i',type:'thinking',text:'ab'}])});

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
  assert.equal(bubble.textContent,output.content);
  assert.equal(box.scrollTop,box.scrollHeight-box.clientHeight);
  assert.equal(box.streamBubble,bubble);

  output.content+='**final**';
  view.update({type:'segment_delta',delta:'**final**'});
  assert.equal(bubble.innerHTML,'');
  view.finish();
  assert.equal(bubble.textContent,output.content);
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

test('busy Claude tmux send action calls stop with runtimeId and turnId',async()=>{
  const calls=[];let streamController;
  const stream=new ReadableStream({start(controller){streamController=controller}});
  const fetchImpl=async(url,init={})=>{
    calls.push({url,init});
    if(url.includes('/status'))return new Response(JSON.stringify({enabled:true,state:'connected'}),{status:200,headers:{'content-type':'application/json'}});
    if(url==='/api/chat/stop'){streamController.enqueue(new TextEncoder().encode('{"type":"turn_stopped","turnId":"turn-stop"}\n'));streamController.close();return new Response(JSON.stringify({ok:true,status:'stopped'}),{status:200,headers:{'content-type':'application/json'}})}
    return new Response(stream,{status:200,headers:{'content-type':'application/x-ndjson'}});
  };
  const {api,get}=loadApp({},fetchImpl);api.selectProvider('claude_tmux');await api.refreshRuntimeStatus();get('#input').value='长回复';
  const sending=api.send();await Promise.resolve();streamController.enqueue(new TextEncoder().encode('{"type":"turn_started","turnId":"turn-stop"}\n'));await new Promise(resolve=>setTimeout(resolve,0));
  await api.send();await sending;
  const stop=calls.find(call=>call.url==='/api/chat/stop');assert.deepEqual(JSON.parse(stop.init.body),{runtimeId:'claude-main',turnId:'turn-stop'});
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
  assert.ok(first);assert.ok(second);assert.notEqual(first,second);assert.match(first,/^[0-9a-f-]+$/);
});

test('generateId survives an HTTP non-secure context without Web Crypto UUID support',()=>{
  const {api}=loadApp({},undefined,null);const first=api.generateId(),second=api.generateId();
  assert.ok(first);assert.ok(second);assert.notEqual(first,second);assert.doesNotThrow(()=>api.newChat());assert.ok(api.getState().activeId);
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

test('bridge-confirmed stop clears UI before EOF and the old EOF cannot clear the next request',async()=>{
  const controls=[];let chats=0;
  const fetchImpl=async(url)=>{
    if(url.includes('/status'))return new Response(JSON.stringify({state:'connected'}),{headers:{'content-type':'application/json'}});
    if(url==='/api/chat/stop')return new Response(JSON.stringify({ok:true,status:'stop_unconfirmed',turnId:'one',stopSent:true,turnReleased:true}),{headers:{'content-type':'application/json'}});
    const id=++chats===1?'one':'two';return new Response(new ReadableStream({start(controller){controls.push(controller);controller.enqueue(new TextEncoder().encode(JSON.stringify({type:'turn_started',turnId:id})+'\n'+JSON.stringify({type:'segment_delta',turnId:id,delta:'保留正文'})+'\n'))}}),{headers:{'content-type':'application/x-ndjson'}});
  };
  const {api,get}=loadApp({},fetchImpl);api.selectProvider('claude_tmux');await api.refreshRuntimeStatus();get('#input').value='first';const first=api.send();await new Promise(r=>setTimeout(r,0));
  await api.send();assert.equal(api.getState().sending,false);assert.equal(get('#toast').textContent,'已停止');
  get('#input').value='second';const second=api.send();await new Promise(r=>setTimeout(r,0));assert.equal(api.getState().activeTurnId,'two');
  controls[0].close();await first;assert.equal(api.getState().sending,true);assert.equal(api.getState().activeTurnId,'two');
  controls[1].enqueue(new TextEncoder().encode('{"type":"turn_done","turnId":"two"}\n'));await second;assert.equal(api.getState().sending,false);assert.equal(api.getState().sessions[0].messages[1].content,'保留正文');
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

test('live stream survives Memory navigation and resumes partial and subsequent output in current DOM',async()=>{
  const f=await liveViewFixture();assert.equal(f.out().pending,true);assert.equal(f.bubble().classList.contains('thinking'),true);
  f.api.showMemory();await f.emit({type:'segment_delta',delta:'first'});f.api.showChat();
  assert.equal(f.bubble().textContent,'first');assert.equal(f.api.getState().activeTurnId,'view-turn');assert.equal(f.api.getState().sending,true);
  await f.emit({type:'segment_delta',delta:' second'});assert.equal(f.bubble().textContent,'first second');
  assert.deepEqual(f.counts(),{aborts:0,cancels:0});assert.equal(f.calls.filter(x=>x==='/api/chat').length,1);assert(!f.calls.includes('/api/chat/stop'));
  await f.emit({type:'turn_done'});await f.done;assert.equal(f.api.getState().sending,false);assert.equal(f.out().pending,false);
});

test('sidebar and returning Chat preserve active thinking before first body without abort or stop',async()=>{
  const f=await liveViewFixture();f.get('#menuBtn').click();f.get('#menuBtn').click();f.api.showChat();
  assert.equal(f.bubble().classList.contains('thinking'),true);assert.equal(f.out().pending,true);
  assert.equal(f.api.getState().activeTurnId,'view-turn');assert.deepEqual(f.counts(),{aborts:0,cancels:0});assert(!f.calls.includes('/api/chat/stop'));
  await f.emit({type:'segment_delta',delta:'body'});assert.equal(f.bubble().textContent,'body');assert.equal(f.bubble().classList.contains('thinking'),false);
  await f.emit({type:'turn_done'});await f.done;
});

test('rerender detaches old bubble but later deltas and finalize update only replacement',async()=>{
  const f=await liveViewFixture(),old=f.bubble();f.api.renderMessages(false);const fresh=f.bubble();assert.notEqual(old,fresh);assert.equal(old.detached,true);
  await f.emit({type:'segment_delta',delta:'new node body'});assert.equal(fresh.textContent,'new node body');assert.equal(old.textContent,'正在想…');
  await f.emit({type:'turn_done'});await f.done;assert.equal(fresh.innerHTML,'new node body');
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

test('presentation: failed tool produces no event/bubble and ordinary MessageDisplay remains unchanged',async()=>{
  const f=await liveViewFixture();assert.equal(f.out().toolMessages,undefined);
  await f.emit({type:'segment_delta',delta:'ordinary reply after tool error'});await f.emit({type:'turn_done'});await f.done;
  assert.equal(f.out().toolMessages,undefined);assert.equal(f.bubble().innerHTML,'ordinary reply after tool error');
});

test('presentation: tool deliveries survive Memory/sidebar and destroyed message DOM',async()=>{
  const f=await liveViewFixture();await f.emit(toolFrame('one','first'));f.api.showMemory();f.get('#menuBtn').click();
  f.get('#messages').innerHTML='';await f.emit(toolFrame('two','second'));f.api.showChat();
  assert.equal(assistantArticles(f.get('#messages').innerHTML),2);assert.equal(f.api.getState().sending,true);
  f.api.renderMessages(false);await f.emit(toolFrame('three','third'));assert.equal(assistantArticles(f.get('#messages').innerHTML),3);
  assert.deepEqual(f.counts(),{aborts:0,cancels:0});await f.emit({type:'turn_done'});await f.done;
});

test('presentation: explicit Stop retains already sent bubbles and clears generating once',async()=>{
  const f=await liveViewFixture();await f.emit(toolFrame('one','first'));await f.emit(toolFrame('two','second'));
  await f.api.send();assert.equal(f.api.getState().sending,false);assert.equal(f.out().toolMessages.length,2);
  assert.equal(assistantArticles(f.get('#messages').innerHTML),2);assert.equal(f.calls.filter(x=>x==='/api/chat/stop').length,1);
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
