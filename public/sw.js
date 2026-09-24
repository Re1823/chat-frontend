const CACHE_PREFIX='qiuqiu-shell-';
const CACHE_NAME='qiuqiu-shell-pwa1';
const SHELL_ASSETS=[
  '/style.css?v=queue1',
  '/app.js?v=pwa1',
  '/manifest.webmanifest?v=pwa1',
  '/app-icon-192.png',
  '/app-icon-512.png',
  '/apple-touch-icon-180.png'
];
const SHELL_KEYS=new Set(SHELL_ASSETS);
const SHELL_TYPES=new Map([
  ['/style.css?v=queue1','text/css'],
  ['/app.js?v=pwa1','text/javascript'],
  ['/manifest.webmanifest?v=pwa1','application/manifest+json'],
  ['/app-icon-192.png','image/png'],
  ['/app-icon-512.png','image/png'],
  ['/apple-touch-icon-180.png','image/png']
]);

self.addEventListener('install',event=>{
  event.waitUntil((async()=>{
    const cache=await caches.open(CACHE_NAME);
    await Promise.all(SHELL_ASSETS.map(async asset=>{
      try{
        const response=await fetch(asset,{cache:'reload',credentials:'same-origin'});
        const type=(response.headers.get('content-type')||'').toLowerCase();
        if(response.ok&&!response.redirected&&response.type==='basic'&&type.startsWith(SHELL_TYPES.get(asset)))await cache.put(asset,response);
      }catch{}
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    const names=await caches.keys();
    await Promise.all(names.filter(name=>name.startsWith(CACHE_PREFIX)&&name!==CACHE_NAME).map(name=>caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch',event=>{
  const request=event.request;
  if(request.method!=='GET')return;
  const url=new URL(request.url);
  if(url.origin!==self.location.origin||url.pathname.startsWith('/api/'))return;
  const key=url.pathname+url.search;
  if(!SHELL_KEYS.has(key))return;
  event.respondWith(caches.match(request).then(cached=>cached||fetch(request)));
});
