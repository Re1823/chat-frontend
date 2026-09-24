import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';
import {createDwellServer} from '../server.mjs';

const publicUrl=new URL('../public/',import.meta.url);
const read=name=>readFile(new URL(name,publicUrl),'utf8');

test('manifest installs the existing chat root as a standalone 秋秋 app',async()=>{
  const manifest=JSON.parse(await read('manifest.webmanifest'));
  assert.equal(manifest.name,'秋秋');assert.equal(manifest.short_name,'秋秋');
  assert.equal(manifest.start_url,'/');assert.equal(manifest.scope,'/');assert.equal(manifest.display,'standalone');
  assert.deepEqual(manifest.icons.map(icon=>icon.sizes),['192x192','512x512']);
  for(const [name,size] of [['app-icon-192.png',192],['app-icon-512.png',512],['apple-touch-icon-180.png',180]]){const metadata=await sharp(fileURLToPath(new URL(name,publicUrl))).metadata();assert.equal(metadata.width,size);assert.equal(metadata.height,size)}
});

test('index exposes iOS metadata and registers the versioned root service worker',async()=>{
  const [html,app]=await Promise.all([read('index.html'),read('app.js')]);
  assert.match(html,/viewport-fit=cover/);assert.match(html,/rel="manifest" href="\/manifest\.webmanifest\?v=pwa1"/);assert.match(html,/rel="apple-touch-icon" sizes="180x180"/);assert.match(html,/apple-mobile-web-app-capable" content="yes"/);assert.match(html,/app\.js\?v=pwa1/);
  assert.match(app,/serviceWorker\.register\('\/sw\.js\?v=pwa1',\{scope:'\/'\}\)/);
});

test('service worker bypasses API and handles only its explicit static shell',async()=>{
  const source=await read('sw.js'),handlers={};
  const context={URL,fetch:async()=>{throw new Error('network should not run')},caches:{match:async()=>({cached:true})},self:{location:{origin:'https://qiuqiu.reesia.xyz'},addEventListener:(name,handler)=>{handlers[name]=handler}}};vm.createContext(context);vm.runInContext(source,context);
  let apiHandled=false;handlers.fetch({request:{method:'GET',url:'https://qiuqiu.reesia.xyz/api/chat'},respondWith:()=>{apiHandled=true}});assert.equal(apiHandled,false);
  let postHandled=false;handlers.fetch({request:{method:'POST',url:'https://qiuqiu.reesia.xyz/app.js?v=pwa1'},respondWith:()=>{postHandled=true}});assert.equal(postHandled,false);
  let shellPromise;handlers.fetch({request:{method:'GET',url:'https://qiuqiu.reesia.xyz/app.js?v=pwa1'},respondWith:value=>{shellPromise=value}});assert.ok(shellPromise);assert.deepEqual(await shellPromise,{cached:true});
  assert.match(source,/type\.startsWith\(SHELL_TYPES\.get\(asset\)\)/);assert.doesNotMatch(source,/['"]\/(?:index\.html)?['"]/);assert.doesNotMatch(source,/indexedDB|localStorage/);
});

test('activating pwa1 deletes only older qiuqiu shell caches',async()=>{
  const source=await read('sw.js'),handlers={},deleted=[];
  const context={URL,fetch:async()=>{},caches:{keys:async()=>['qiuqiu-shell-old','qiuqiu-shell-pwa1','unrelated'],delete:async name=>{deleted.push(name)}},self:{location:{origin:'https://qiuqiu.reesia.xyz'},clients:{claim:async()=>{}},skipWaiting:async()=>{},addEventListener:(name,handler)=>{handlers[name]=handler}}};vm.createContext(context);vm.runInContext(source,context);
  let activation;handlers.activate({waitUntil:value=>{activation=value}});await activation;assert.deepEqual(deleted,['qiuqiu-shell-old']);
});

test('standalone shell uses 100vh while visualViewport chat sizing stays intact',async()=>{
  const [css,app]=await Promise.all([read('style.css'),read('app.js')]);
  assert.match(css,/@media\(display-mode:standalone\)\{html,body\{height:100vh;min-height:100vh;background:var\(--bg\)\}\}/);
  assert.match(css,/\.app\{[^}]*height:var\(--vv-bottom,100dvh\)/);assert.match(app,/function syncVisualViewport\(\)/);assert.match(app,/globalThis\.visualViewport\?\.addEventListener\?\.\('resize',scheduleVisualViewportSync\)/);
});

test('static server serves manifest and icons with PWA MIME types',async()=>{
  const server=createDwellServer({claudeRuntime:{}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  try{const manifest=await fetch(base+'/manifest.webmanifest'),icon=await fetch(base+'/app-icon-192.png'),worker=await fetch(base+'/sw.js');assert.equal(manifest.status,200);assert.match(manifest.headers.get('content-type'),/^application\/manifest\+json/);assert.equal(icon.headers.get('content-type'),'image/png');assert.equal(worker.status,200);assert.match(worker.headers.get('content-type'),/^text\/javascript/)}finally{await new Promise(resolve=>server.close(resolve))}
});
