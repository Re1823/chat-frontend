import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createImageStore, IMAGE_LIMITS, IMAGE_ID_PATTERN } from '../src/photos/image-store.mjs';
import { createPhotosStore, ALBUM_ID_PATTERN, PHOTO_ID_PATTERN } from '../src/photos/photos-store.mjs';
import { createPhotosMcpHandler, photosMcpTools } from '../src/photos/photos-mcp.mjs';
import { createClaudeTmuxRuntime } from '../src/runtimes/claude-tmux.mjs';
import { createTurnStore } from '../src/turns/turn-store.mjs';
import { createClaudeIngress } from '../src/hooks/claude-ingress.mjs';
import { createDwellServer } from '../server.mjs';

const makeImage = (format='png', width=80, height=60, metadata=false) => {
  let image=sharp({create:{width,height,channels:3,background:{r:20,g:100,b:220}}});
  if(metadata)image=image.withMetadata({orientation:1,exif:{IFD0:{Copyright:'private fixture'},IFD3:{GPSLatitudeRef:'N'}}});
  return format==='jpeg'?image.jpeg().toBuffer():format==='webp'?image.webp().toBuffer():image.png().toBuffer();
};
const root = () => mkdtemp(join(tmpdir(),'qiuqiu-photos-test-'));

test('image store accepts JPEG PNG WebP, creates opaque IDs, strips metadata and writes private optimized files',async()=>{
  const dir=await root(),store=createImageStore({rootDir:dir});
  for(const [format,mime] of [['jpeg','image/jpeg'],['png','image/png'],['webp','image/webp']]){
    const result=await store.add({data:await makeImage(format,80,60,format==='jpeg'),mime});
    assert.match(result.imageId,IMAGE_ID_PATTERN);assert.equal(result.mime,mime);assert.equal(result.width,80);assert.equal(result.height,60);
    const record=store.get(result.imageId),metadata=await sharp(await readFile(record.contentPath)).metadata();
    assert.equal(metadata.exif,undefined);assert.equal(metadata.icc,undefined);if(process.platform!=='win32')assert.equal((await stat(record.contentPath)).mode&0o777,0o600);
    assert(!record.contentPath.includes('private fixture'));
  }
});

test('image store rejects MIME spoofing, malformed/oversized/pixel-bomb data and unsafe IDs',async()=>{
  const dir=await root(),limits={...IMAGE_LIMITS,maxFileBytes:1000,maxPixels:100},store=createImageStore({rootDir:dir,limits});
  await assert.rejects(store.add({data:await makeImage('png'),mime:'image/jpeg'}),error=>error.code==='unsupported_image_type');
  await assert.rejects(store.add({data:Buffer.from('<svg><script/></svg>'),mime:'image/png'}),error=>error.code==='unsupported_image_type');
  await assert.rejects(store.add({data:Buffer.alloc(1001),mime:'image/png'}),error=>error.code==='image_too_large');
  await assert.rejects(store.add({data:await makeImage('png',20,20),mime:'image/png'}),error=>['invalid_image','image_dimensions_exceeded'].includes(error.code));
  for(const id of ['../secret','img_/etc/passwd','x'])await assert.rejects(store.readPublic(id),error=>error.code==='invalid_image_id');
});

test('turn binding is atomic, current-turn-only, single-use across turns, and TTL cleanup removes bytes',async()=>{
  let clock=1000;const dir=await root(),store=createImageStore({rootDir:dir,now:()=>clock,limits:{...IMAGE_LIMITS,tempTtlMs:100,completedTtlMs:20}});
  const image=await store.add({data:await makeImage(),mime:'image/png'}),path=store.get(image.imageId).contentPath;
  await store.bind([image.imageId],{turnId:'turn_one',clientRequestId:'request_one'});
  await assert.rejects(store.readForTurn(image.imageId,'turn_two'),error=>error.code==='image_not_bound_to_active_turn');
  assert.equal((await store.readForTurn(image.imageId,'turn_one')).mime,'image/png');
  await assert.rejects(store.bind([image.imageId],{turnId:'turn_two',clientRequestId:'request_two'}),error=>error.code==='image_already_bound');
  await assert.rejects(store.bind([image.imageId],{turnId:'turn_one',clientRequestId:'request_one'}),error=>['duplicate_image_turn','image_already_bound'].includes(error.code));
  await store.finishTurn('turn_one');clock+=21;await store.cleanup();await assert.rejects(readFile(path),error=>error.code==='ENOENT');
});

test('Photos uses SQLite metadata plus durable files; promotion survives temp TTL and supports albums',async()=>{
  let clock=5000;const dir=await root(),images=createImageStore({rootDir:join(dir,'chat'),now:()=>clock,limits:{...IMAGE_LIMITS,tempTtlMs:50}}),image=await images.add({data:await makeImage('webp'),mime:'image/webp'});
  const photos=await createPhotosStore({dbPath:join(dir,'db','photos.sqlite'),storageDir:join(dir,'durable'),imageStore:images,now:()=>clock});
  const album=await photos.createAlbum({name:'Fixtures',mood:'calm',note:'test',createdBy:'user'});assert.match(album.albumId,ALBUM_ID_PATTERN);
  const saved=await photos.promote({imageId:image.imageId,albumId:album.albumId,note:'kept',sourceTurnId:'turn',sourceMessageId:'message',savedBy:'user'});assert.match(saved.photoId,PHOTO_ID_PATTERN);
  assert.equal(photos.listAlbums()[0].photoCount,1);assert.equal(photos.listPhotos({albumId:album.albumId})[0].note,'kept');
  clock+=51;await images.cleanup();assert.equal((await photos.readPhoto(saved.photoId)).mime,'image/webp');
  if(process.platform!=='win32'){assert.equal((await stat(join(dir,'db','photos.sqlite'))).mode&0o777,0o600);assert.equal((await stat(join(dir,'durable','images',`${saved.photoId}.bin`))).mode&0o777,0o600)}
  photos.close();
});

test('Photos MCP tools enforce opaque IDs and structured saved-photo delivery',async()=>{
  const names=photosMcpTools.map(tool=>tool.name);assert.deepEqual(names,['save_frontend_photo_to_photos','create_photo_album','list_photo_albums','list_photos','read_saved_photo','send_saved_photo_to_frontend']);
  const photoId='photo_'+Buffer.alloc(24,1).toString('base64url'),calls=[],handler=createPhotosMcpHandler({photosStore:{createAlbum:async a=>({albumId:'alb',...a}),listAlbums:()=>[],listPhotos:()=>[],getPhoto:id=>id===photoId?{photoId,mime:'image/jpeg',width:80,height:60}:null,readPhoto:async id=>({data:Buffer.from('image'),mime:'image/jpeg'}),promote:async a=>{calls.push(a);return{photoId:'photo'}}},readCurrentTurnImage:async(id,turn)=>calls.push({id,turn}),currentTurnId:()=> 'active_turn',sendSavedPhoto:async(photo,text)=>{calls.push({photo,text});return{delivered:true}}});
  const read=await handler({name:'read_saved_photo',arguments:{photoId}});assert.equal(read.content[0].type,'image');assert.equal(read.content[0].mimeType,'image/jpeg');
  const sent=await handler({name:'send_saved_photo_to_frontend',arguments:{photoId,text:'look'}});assert.deepEqual(JSON.parse(sent.content[0].text),{delivered:true});assert.equal(calls[0].photo.photoId,photoId);assert.equal(calls[0].text,'look');
  await assert.rejects(handler({name:'read_saved_photo',arguments:{photoId:'x',path:'/etc/passwd'}}),/Invalid/);
  const imageId='img_'+Buffer.alloc(32,1).toString('base64url');await handler({name:'save_frontend_photo_to_photos',arguments:{imageId,note:'keep'}});assert.deepEqual(calls[1],{id:imageId,turn:'active_turn'});
});

test('HTTP upload, image-only turn, active-turn MCP read and journal replay carry IDs but never base64 or paths',async t=>{
  const dir=await root(),imageStore=createImageStore({rootDir:join(dir,'images')}),events=[],prompts=[];
  const record={runtimeId:'runtime-main',sessionName:'dwell',workspace:'/root'},transport={sendPrompt:async value=>prompts.push(value),complete:async()=>{}},registry={load:async()=>record,get:()=>record,reconcile:async()=>({state:'connected',runtime:record})};
  const runtime=createClaudeTmuxRuntime({config:{enabled:true,runtimeId:'runtime-main',submitDelayMs:0,stopTimeoutMs:10},transport,registry,turnStore:createTurnStore(),ingress:createClaudeIngress(),imageStore,log:()=>{}});await runtime.initialize();
  const secret='s'.repeat(32),server=createDwellServer({claudeRuntime:runtime,frontendDeliverySecret:secret,imageStore});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close()});const base=`http://127.0.0.1:${server.address().port}`;
  const form=new FormData();form.append('images',new Blob([await makeImage('png')],{type:'image/png'}),'../../private.png');const uploaded=await fetch(`${base}/api/chat/images`,{method:'POST',body:form});assert.equal(uploaded.status,201);const image=(await uploaded.json()).images[0];assert.match(image.imageId,IMAGE_ID_PATTERN);assert(!JSON.stringify(image).includes('private.png'));assert(!JSON.stringify(image).includes(dir));
  const response=await fetch(`${base}/api/chat`,{method:'POST',headers:{'content-type':'application/json','accept':'application/x-ndjson'},body:JSON.stringify({config:{runtime:'claude_tmux',runtimeId:'runtime-main'},messages:[{role:'user',content:''}],clientRequestId:'request_image_only',imageIds:[image.imageId]})});
  await new Promise(resolve=>setTimeout(resolve,0));assert.equal(prompts.length,1);assert(prompts[0].prompt.includes(image.imageId));assert(!prompts[0].prompt.includes(dir));assert.deepEqual(Object.keys(prompts[0]).sort(),['delayMs','prompt','sessionName','turnId']);
  const internal=await fetch(`${base}/api/internal/frontend-image`,{method:'POST',headers:{'content-type':'application/json','x-frontend-delivery-secret':secret},body:JSON.stringify({imageId:image.imageId})});assert.equal(internal.status,200);assert.equal(internal.headers.get('content-type'),'image/png');
  const foreign='img_'+Buffer.alloc(32,3).toString('base64url');assert.equal((await fetch(`${base}/api/internal/frontend-image`,{method:'POST',headers:{'content-type':'application/json','x-frontend-delivery-secret':secret},body:JSON.stringify({imageId:foreign})})).status,404);
  await runtime.ingestRaw({event:'Stop'});const frames=(await response.text()).trim().split('\n').map(JSON.parse);assert.deepEqual(frames.map(frame=>frame.type),['turn_started','user_images','segment_done','turn_done']);const replay=runtime.turnEvents(frames[0].turnId,0);const serialized=JSON.stringify(replay);assert(serialized.includes(image.imageId));assert(!serialized.includes(image.data||'never'));assert(!serialized.includes(dir));assert(!serialized.includes('iVBOR'));
  const form2=new FormData();form2.append('images',new Blob([await makeImage('jpeg')],{type:'image/jpeg'}),'second.jpg');const image2=(await (await fetch(`${base}/api/chat/images`,{method:'POST',body:form2})).json()).images[0];
  const withText=await fetch(`${base}/api/chat`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({config:{runtime:'claude_tmux',runtimeId:'runtime-main'},messages:[{role:'user',content:'请看颜色'}],clientRequestId:'request_image_text',imageIds:[image2.imageId]})});await new Promise(resolve=>setTimeout(resolve,0));assert(prompts.at(-1).prompt.endsWith('请看颜色'));assert(prompts.at(-1).prompt.includes(image2.imageId));await runtime.ingestRaw({event:'Stop'});await withText.text();
  const form3=new FormData();form3.append('images',new Blob([await makeImage('png')],{type:'image/png'}),'third.png');const image3=(await (await fetch(`${base}/api/chat/images`,{method:'POST',body:form3})).json()).images[0];const duplicate=await fetch(`${base}/api/chat`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({config:{runtime:'claude_tmux',runtimeId:'runtime-main'},messages:[{role:'user',content:'duplicate'}],clientRequestId:'request_image_text',imageIds:[image3.imageId]})});assert.equal(duplicate.status,409);assert.equal(prompts.length,2);
  const filepath=await fetch(`${base}/api/chat`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({config:{runtime:'claude_tmux',runtimeId:'runtime-main'},messages:[{role:'user',content:'x'}],clientRequestId:'fresh',imageIds:[],filepath:'/etc/passwd'})});assert.equal(filepath.status,400);
});

test('upload endpoint rejects too many images and non-images without exposing filenames',async t=>{
  const dir=await root(),imageStore=createImageStore({rootDir:dir}),server=createDwellServer({imageStore});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close()});const base=`http://127.0.0.1:${server.address().port}`;
  const many=new FormData();for(let i=0;i<5;i++)many.append('images',new Blob([await makeImage()],{type:'image/png'}),`${i}.png`);assert.equal((await fetch(`${base}/api/chat/images`,{method:'POST',body:many})).status,413);
  const bad=new FormData();bad.append('images',new Blob([Buffer.from('<html>bad</html>')],{type:'image/png'}),'secret.html');const response=await fetch(`${base}/api/chat/images`,{method:'POST',body:bad});assert.equal(response.status,415);assert.equal((await response.json()).error,'unsupported_image_type');
});

test('Photos HTTP APIs create/list/promote/read metadata and binary content without storing image blobs in SQLite',async t=>{
  const dir=await root(),imageStore=createImageStore({rootDir:join(dir,'temp')}),uploaded=await imageStore.add({data:await makeImage('jpeg'),mime:'image/jpeg'}),dbPath=join(dir,'photos','photos.sqlite');
  const photosStore=await createPhotosStore({dbPath,storageDir:join(dir,'durable'),imageStore});const server=createDwellServer({imageStore,photosStore});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();photosStore.close()});const base=`http://127.0.0.1:${server.address().port}`;
  const albumResponse=await fetch(`${base}/api/photos/albums`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Album',note:'safe'})});assert.equal(albumResponse.status,201);const album=await albumResponse.json();
  const promotedResponse=await fetch(`${base}/api/photos/promote`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({imageId:uploaded.imageId,albumId:album.albumId,note:'saved'})});assert.equal(promotedResponse.status,201);const photo=await promotedResponse.json();
  assert.equal((await (await fetch(`${base}/api/photos/albums`)).json()).albums[0].photoCount,1);assert.equal((await (await fetch(`${base}/api/photos?albumId=${album.albumId}`)).json()).photos[0].photoId,photo.photoId);assert.equal((await fetch(`${base}/api/photos/${photo.photoId}/content`)).headers.get('content-type'),'image/jpeg');assert.equal((await fetch(`${base}/api/photos/${photo.photoId}/thumbnail`)).status,200);
  const attachedResponse=await fetch(`${base}/api/photos/${photo.photoId}/attach`,{method:'POST'});assert.equal(attachedResponse.status,201);const attached=await attachedResponse.json();assert.match(attached.imageId,IMAGE_ID_PATTERN);assert.notEqual(attached.imageId,uploaded.imageId);assert.equal(attached.mime,'image/jpeg');
  const db=await readFile(dbPath);assert(!db.includes((await imageStore.readPublic(uploaded.imageId)).data.toString('base64')));assert(!db.includes('/tmp/'));assert(!db.includes(dir));
  assert.equal((await fetch(`${base}/api/photos/../secret/content`)).status,404);
});
