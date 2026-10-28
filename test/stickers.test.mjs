import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import sharp from 'sharp';
import {createStickerStore} from '../src/stickers/store.mjs';
import {createImageStore} from '../src/photos/image-store.mjs';
import {createTurnStore} from '../src/turns/turn-store.mjs';
import {createFrontendDelivery} from '../src/presentation/frontend-delivery.mjs';
import {createMcpHandler} from '../src/presentation/frontend-message-mcp.mjs';
import {createDwellServer} from '../server.mjs';

async function fixture(t){const root=fileURLToPath(new URL('../tmp/',import.meta.url));await mkdir(root,{recursive:true});const dir=await mkdtemp(join(root,'qiuqiu-stickers-'));t.after(()=>rm(dir,{recursive:true,force:true}));return {dir,store:await createStickerStore({dir})}}
const gif=Buffer.from('R0lGODlhAgACAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACAAAACwAAAAAAgACAAAIBgABCAQQEAAh+QQBDAABACwAAAAAAgACAIEAAP8AAAAAAAAAAAAIBgABCAQQEAA7','base64');
const animatedWebp=Buffer.from('UklGRsQAAABXRUJQVlA4WAoAAAACAAAAAQAAAQAAQU5JTQYAAAAAAAAAAABBTk1GSgAAAAAAAAAAAAEAAAEAAFAAAAJWUDggMgAAADABAJ0BKgIAAgABQCYloAADcAD+8ut///mwP/bz/wR6Af//0uD//pcH//S4P/SkAAAAQU5NRkYAAAAAAAAAAAABAAABAAB4AAAAVlA4IC4AAAA0AQCdASoCAAIAAAAmJaAAA3AA/vtV4///S4P/+lwf/9Lg/9Lg//rV5Vesq6AA','base64');

test('GIF/WebP bytes survive upload, restart and deletion; descriptions and owners are required',async t=>{
  const {dir,store}=await fixture(t);
  const webp=animatedWebp;assert.equal((await sharp(gif).metadata()).pages,2);assert.equal((await sharp(webp).metadata()).pages,2);
  await assert.rejects(store.add({data:gif,mime:'image/gif',owner:'assistant',name:'a',description:''}),/description/);
  await assert.rejects(store.add({data:webp,mime:'image/webp',owner:'other',name:'a',description:'b'}),/owner/);
  const user=await store.add({data:gif,mime:'image/gif',owner:'user',name:'招手',description:'轻轻招手',emotion_tags:['高兴']});
  const assistant=await store.add({data:webp,mime:'image/webp',owner:'assistant',name:'点头',description:'点头回应',emotion_tags:['赞同']});
  assert.deepEqual((await store.media(user.id)).data,gif);
  assert.deepEqual((await store.media(assistant.id)).data,webp);
  assert.equal((await store.media(user.id,'thumbnail')).mime,'image/png');
  assert.throws(()=>store.get(user.id,'assistant'),/not_found/);
  const reopened=await createStickerStore({dir});assert.equal(reopened.list().length,2);
  await reopened.delete(user.id);assert.equal(reopened.list().length,1);assert.deepEqual((await reopened.media(user.id)).data,gif);
});

test('assistant sticker delivery is turn bound, owner checked, replayable and idempotent',async t=>{
  const {store}=await fixture(t);const webp=animatedWebp;
  const own=await store.add({data:webp,mime:'image/webp',owner:'assistant',name:'点头',description:'点头回应'});
  const user=await store.add({data:webp,mime:'image/webp',owner:'user',name:'挥手',description:'挥手回应'});
  const turnStore=createTurnStore(),events=[];turnStore.start({runtimeId:'claude-main',turnId:'turn-1',emit:event=>events.push(event)});
  const delivery=createFrontendDelivery({turnStore,runtimeId:'claude-main',stickerStore:store}),send=delivery.bindSticker();
  assert.throws(()=>send({stickerId:user.id},'sticker-request-1'),/not_found/);
  const first=send({stickerId:own.id},'sticker-request-1');assert.equal(send({stickerId:own.id},'sticker-request-1').messageId,first.messageId);
  assert.equal(events.filter(event=>event.type==='assistant_sticker').length,1);
  assert.equal(turnStore.status('turn-1').hasOutput,true);
  assert.equal(turnStore.replay('turn-1',0).events[0].sticker.id,own.id);
  turnStore.finish('claude-main','turn-1',{type:'turn_done',turnId:'turn-1'});
  assert.throws(()=>send({stickerId:own.id},'sticker-request-2'),/ended/);
});

test('MCP sticker tools expose only assistant metadata and send once per request identity',async()=>{
  const id='stk_'+Buffer.alloc(24,7).toString('base64url');let sent=0;
  const handle=createMcpHandler({deliver:async()=>({ok:true}),listStickers:async()=>[{id,name:'点头',description:'点头回应',emotion_tags:['赞同']}],sendSticker:async()=>{sent++;return {ok:true}}});
  const rpc=(requestId,method,params)=>handle({jsonrpc:'2.0',id:requestId,method,params});await rpc(1,'initialize');
  const tools=(await rpc(2,'tools/list')).result.tools.map(item=>item.name);assert(tools.includes('list_available_stickers'));assert(tools.includes('send_sticker'));
  const list=(await rpc(3,'tools/call',{name:'list_available_stickers',arguments:{}})).result;assert.equal(JSON.parse(list.content[0].text)[0].id,id);
  const params={name:'send_sticker',arguments:{sticker_id:id}};await Promise.all([rpc(4,'tools/call',params),rpc(4,'tools/call',params)]);assert.equal(sent,1);
});


test('sticker HTTP upload, original media, listing and owner rejection stay on local test server',async t=>{
  const {store}=await fixture(t);const server=createDwellServer({stickerStore:store,claudeRuntime:{}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close()});
  const base=`http://127.0.0.1:${server.address().port}`,form=new FormData();
  form.append('owner','assistant');form.append('name','点头');form.append('description','轻轻点头');form.append('emotion_tags','赞同');form.append('file',new Blob([gif],{type:'image/gif'}),'nod.gif');
  const upload=await fetch(base+'/api/stickers',{method:'POST',body:form});assert.equal(upload.status,201,await upload.clone().text());const item=await upload.json();
  assert.equal(item.owner,'assistant');assert.equal((await (await fetch(base+item.url)).arrayBuffer()).byteLength,gif.length);
  assert.equal((await (await fetch(base+'/api/stickers')).json()).items.length,1);
  const chat=await fetch(base+'/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({config:{runtime:'claude_tmux'},messages:[{role:'user',content:'hello'}],stickerId:item.id})});
  assert.equal(chat.status,400);assert.equal((await chat.json()).error,'invalid_user_sticker');
});

test('user GIF/WebP sticker sends its PNG first frame through the existing Claude image reader',async t=>{
  const {dir,store}=await fixture(t),imageStore=createImageStore({rootDir:join(dir,'images')}),secret='s'.repeat(32);
  let activeTurnId=null,server;
  const received=[];
  const runtime={preflight:async()=>{},reserveRequest:()=>({created:true}),releaseRequest:()=>{},activeTurnId:()=>activeTurnId,isTerminalEvent:event=>event.type==='turn_done',async chat({prompt,images,turnId,emit}){
    activeTurnId=turnId;
    assert.equal(images.length,1);
    assert(prompt.includes(images[0].imageId));
    const preview=await fetch(`http://127.0.0.1:${server.address().port}/api/internal/frontend-image`,{method:'POST',headers:{'content-type':'application/json','x-frontend-delivery-secret':secret},body:JSON.stringify({imageId:images[0].imageId})});
    assert.equal(preview.status,200);assert.equal(preview.headers.get('content-type'),'image/png');
    const png=Buffer.from(await preview.arrayBuffer());assert.equal((await sharp(png).metadata()).format,'png');
    received.push({prompt,png});emit({type:'turn_done',turnId});activeTurnId=null;
  }};
  server=createDwellServer({stickerStore:store,imageStore,claudeRuntime:runtime,frontendDeliverySecret:secret});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close()});
  for(const [data,mime,name,index] of [[gif,'image/gif','招手',1],[animatedWebp,'image/webp','点头',2]]){
    const sticker=await store.add({data,mime,owner:'user',name,description:'开心地回应',emotion_tags:['开心']});
    const response=await fetch(`http://127.0.0.1:${server.address().port}/api/chat`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({config:{runtime:'claude_tmux',runtimeId:'claude-main'},messages:[{role:'user',content:index===1?'你好':''}],clientRequestId:`sticker-preview-${index}`,stickerId:sticker.id})});
    assert.equal(response.status,200,await response.clone().text());await response.text();
    assert.match(received.at(-1).prompt,new RegExp(name));assert.match(received.at(-1).prompt,/开心地回应.*开心.*请先调用 mcp__qiuqiu-frontend__read_frontend_image/);
    assert.deepEqual((await store.media(sticker.id)).data,data);
  }
  assert.equal(received.length,2);
});
