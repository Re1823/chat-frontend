import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import test from 'node:test';
import {ROOT_BRIDGE_SOCKET,createRootBridgeClient,createRootBridgeTransport} from '../src/runtimes/root-bridge-transport.mjs';

function fakeConnection(response,{error,timeout}={}){
  const socket=new EventEmitter();
  socket.setEncoding=()=>{};socket.setTimeout=()=>{};socket.destroy=()=>{};
  socket.end=payload=>{socket.payload=payload;queueMicrotask(()=>{if(response!==undefined)socket.emit('data',response);socket.emit('end')})};
  queueMicrotask(()=>error?socket.emit('error',error):timeout?socket.emit('timeout'):socket.emit('connect'));
  return socket;
}

test('bridge client always connects to the fixed Unix socket',async()=>{
  let path,socket;
  const request=createRootBridgeClient({connect:value=>{path=value;return socket=fakeConnection('{"ok":true,"running":false}\n')}});
  assert.equal((await request({op:'status'})).running,false);
  assert.equal(path,ROOT_BRIDGE_SOCKET);
  assert.deepEqual(JSON.parse(socket.payload),{op:'status'});
});

test('transport maps methods to the five fixed bridge operations without root parameters',async()=>{
  const calls=[],sendCalls=[];
  const request=async message=>{calls.push(message);return message.op==='status'?{ok:true,running:true}:{ok:true,created:true}};
  const sendRequest=async message=>{sendCalls.push(message);return {ok:true}};
  const transport=createRootBridgeTransport({request,sendRequest});
  assert.equal(await transport.hasSession('ignored'),true);
  assert.deepEqual(await transport.inspectSession('ignored'),{exists:true,alive:true,panes:[]});
  assert.deepEqual(await transport.createSession({sessionName:'evil',workspace:'/tmp',command:'sh',args:['-c','id']}),{created:true});
  await transport.sendPrompt({sessionName:'evil',turnId:'turn-1',prompt:'hello'});
  await transport.interrupt('evil','turn-1');
  await transport.complete('turn-1');
  assert.deepEqual(calls,[{op:'status'},{op:'status'},{op:'ensure'},{op:'stop',turnId:'turn-1'},{op:'complete',turnId:'turn-1'}]);
  assert.deepEqual(sendCalls,[{op:'send',turnId:'turn-1',prompt:'hello'}]);
});

test('transport gives send a dedicated five second client while status keeps the short default',async()=>{
  const timeouts=[];
  const connect=()=>{const socket=fakeConnection('{"ok":true,"running":true}\n');socket.setTimeout=value=>timeouts.push(value);return socket};
  const transport=createRootBridgeTransport({request:createRootBridgeClient({connect}),sendRequest:createRootBridgeClient({connect,timeoutMs:5000})});
  await transport.hasSession();
  await transport.sendPrompt({turnId:'turn-2',prompt:'hello'});
  assert.deepEqual(timeouts,[1500,5000]);
});

test('send client accepts a delayed success before its five second deadline',async()=>{
  const connect=()=>{
    const socket=new EventEmitter();
    socket.setEncoding=()=>{};
    socket.setTimeout=(value,callback)=>{socket.timer=setTimeout(()=>socket.emit('timeout'),value)};
    socket.destroy=()=>clearTimeout(socket.timer);
    socket.end=payload=>{
      socket.payload=payload;
      setTimeout(()=>{clearTimeout(socket.timer);socket.emit('data','{"ok":true}\n');socket.emit('end')},2500);
    };
    queueMicrotask(()=>socket.emit('connect'));
    return socket;
  };
  const request=createRootBridgeClient({connect,timeoutMs:5000});
  const started=Date.now();
  assert.equal((await request({op:'send',turnId:'turn-delayed',prompt:'test'})).ok,true);
  assert.ok(Date.now()-started>=2400);
});

test('bridge client rejects when peer closes without a response',async()=>{
  const connect=()=>{
    const socket=new EventEmitter();
    socket.setEncoding=()=>{};socket.setTimeout=()=>{};socket.destroy=()=>{};
    socket.end=()=>queueMicrotask(()=>socket.emit('end'));
    queueMicrotask(()=>socket.emit('connect'));
    return socket;
  };
  await assert.rejects(createRootBridgeClient({connect})({op:'status'}),/malformed JSON/);
});

test('bridge client reports connection, timeout, malformed and HTTP-like bridge errors',async()=>{
  const cases=[
    [()=>fakeConnection(undefined,{error:new Error('denied')}),503,/unavailable/],
    [()=>fakeConnection(undefined,{timeout:true}),504,/timeout/],
    [()=>fakeConnection('not-json'),502,/malformed JSON/],
    [()=>fakeConnection('{"ok":false,"status":403,"error":"forbidden"}'),403,/forbidden/],
    [()=>fakeConnection('{"ok":false,"status":500,"error":"bridge failed"}'),500,/bridge failed/]
  ];
  for(const [connect,status,message] of cases){
    const request=createRootBridgeClient({connect,timeoutMs:1});
    await assert.rejects(request({op:'status'}),error=>error.statusCode===status&&message.test(error.message));
  }
});
