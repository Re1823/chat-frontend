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
  }
  focus() {}
  setAttribute(name,value) { this[name]=String(value); }
  getBoundingClientRect() { return this.rect; }
  querySelector() { return this.streamBubble || null; }
  click() { this.onclick?.(); }
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
    setTimeout: fn => { fn(); return 1; },
    clearTimeout() {},
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
      documentElement: {clientHeight:800,style:{setProperty:(name,value)=>{rootStyles[name]=value}}},
      querySelector: get,
      querySelectorAll: () => [],
      createElement: () => new FakeElement()
    }
  };
  vm.createContext(context);
  vm.runInContext(`${appSource}\n;globalThis.__appTest={generateId,toast,positionToast,syncVisualViewport,scheduleVisualViewportSync,setViewportBottomAnchor,cancelViewportBottomAnchor,presets,runtimePresets,profile,persist,newChat,selectProvider,refreshRuntimeStatus,buildContinuation,openContinuation,startContinuation,applyTurnEvent,messagesNearBottom,scrollMessagesToBottom,createStreamingView,readTurnStream,send,getState:()=>({activeProvider,profiles,sessions,activeId,sending,activeTurnId,tmuxStatus,keepBottomThroughViewportResize})};`, context);
  return { api: context.__appTest, get, storage, rootStyles };
}

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
