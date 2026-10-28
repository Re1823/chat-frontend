import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(check){for(let i=0;i<100;i++){if(await check())return;await pause(20)}throw Error('timed out')}
async function port(){const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const value=server.address().port;await new Promise(resolve=>server.close(resolve));return value}
async function post(url,body){const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:response.status,body:await response.json()}}

test('original WebSocket protocol, opt-in chat, disabled rejection, and capture/control survive',async t=>{
  const dir=await mkdtemp(fileURLToPath(new URL('../.tmp/bridge-chat-',import.meta.url)));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  await mkdir(join(dir,'viewfinder'));
  const token='test-'+randomUUID(),secret='s'.repeat(40),httpPort=await port(),wsPort=await port(),frontendPort=await port();
  await writeFile(join(dir,'viewfinder','config.json'),JSON.stringify({token}));
  const forwarded=[];
  const frontend=http.createServer(async(req,res)=>{
    if(req.url==='/api/chat/queue/status'){res.writeHead(200,{'content-type':'application/json'});res.end('{}');return}
    let raw='';for await(const chunk of req)raw+=chunk;
    forwarded.push({path:req.url,body:JSON.parse(raw),secret:req.headers['x-viewfinder-chat-secret']===secret});
    res.writeHead(200,{'content-type':'application/json'});res.end('{"ok":true}');
  });
  await new Promise(resolve=>frontend.listen(frontendPort,'127.0.0.1',resolve));
  t.after(async()=>{frontend.closeAllConnections();await new Promise(resolve=>frontend.close(resolve))});
  const child=spawn(process.execPath,[fileURLToPath(new URL('../scripts/viewfinder-bridge.mjs',import.meta.url))],{
    cwd:fileURLToPath(new URL('..',import.meta.url)),env:{...process.env,APPDATA:dir,SCREENPEEK_SYNC_SECRET:secret,SCREENPEEK_FRONTEND_PORT:String(frontendPort),VIEWFINDER_HTTP_PORT:String(httpPort),VIEWFINDER_WS_PORT:String(wsPort)},stdio:'ignore'
  });
  t.after(()=>{if(!child.killed)child.kill()});
  const api=`http://127.0.0.1:${httpPort}`;
  await waitFor(async()=>{try{return (await post(api+'/api/internal/vf-chat-status',{})).status===200}catch{return false}});
  const offline=await post(api+'/api/internal/vf-chat-sync',{enabled:true,epoch:randomUUID()});
  assert.equal(offline.body.connected,false);
  assert.deepEqual((await post(api+'/api/internal/vf-activity',{})).body,{ok:true,connected:false,pending:0,uncertain:false});
  const received=[];
  const ws=new WebSocket(`ws://127.0.0.1:${wsPort}/?token=${encodeURIComponent(token)}`);
  ws.addEventListener('message',event=>{
    const msg=JSON.parse(event.data);received.push(msg);
    if(msg.type==='vf_capture'||msg.type==='vf_action'){
      const jpeg=Buffer.concat([Buffer.from([0xff,0xd8]),Buffer.alloc(120,1),Buffer.from([0xff,0xd9])]).toString('base64');
      ws.send(JSON.stringify({type:'vf_shot',requestId:msg.requestId,data:jpeg,desc:'fixture'}));
    }
  });
  await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true})});
  t.after(()=>ws.close());ws.send(JSON.stringify({type:'vf_hello'}));
  await waitFor(()=>received.some(message=>message.type==='vf_ready'));
  ws.send(JSON.stringify({type:'chat',content:'停用期间'}));
  await waitFor(()=>received.some(message=>message.type==='error'));
  assert.equal(forwarded.length,0);
  const epoch=randomUUID();
  assert.equal((await post(api+'/api/internal/vf-chat-sync',{enabled:true,epoch})).body.enabled,true);
  assert.equal(received.some(message=>message.type==='history'),true);
  ws.send(JSON.stringify({type:'chat',content:'取景框发来'}));
  await waitFor(()=>forwarded.some(item=>item.path.endsWith('/message')));
  const delivery=forwarded.find(item=>item.path.endsWith('/message'));
  assert.equal(delivery.body.text,'取景框发来');assert.equal(delivery.body.epoch,epoch);assert.equal(delivery.secret,true);
  assert.match(delivery.body.clientRequestId,/^[0-9a-f-]{36}$/);
  assert.equal((await post(api+'/api/internal/vf-chat-event',{epoch,eventId:'done:1',type:'done',text:'第一句|||第二句'})).body.ok,true);
  await waitFor(()=>received.some(message=>message.type==='done'));
  assert.equal(received.find(message=>message.type==='done').text,'第一句|||第二句');
  assert.equal((await post(api+'/api/internal/vf-capture',{mode:'temp',inline:true})).body.mime,'image/jpeg');
  assert.equal((await post(api+'/api/internal/vf-action',{action:{type:'move',x:1,y:2}})).body.desc,'fixture');
  await post(api+'/api/internal/vf-chat-sync',{enabled:false,epoch});
  const before=forwarded.filter(item=>item.path.endsWith('/message')).length;
  ws.send(JSON.stringify({type:'chat',content:'停用以后'}));await pause(100);
  assert.equal(forwarded.filter(item=>item.path.endsWith('/message')).length,before);
  ws.close();await waitFor(async()=>{const value=await post(api+'/api/internal/vf-chat-status',{});return !value.body.connected});
  assert.equal((await post(api+'/api/internal/vf-chat-sync',{enabled:true,epoch:randomUUID()})).body.connected,false);
});
