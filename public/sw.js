const CACHE_PREFIX='qiuqiu-shell-';
const CACHE_NAME='qiuqiu-shell-pwa23-cold1';
const SHELL_ASSETS=[
  '/style.css?v=pwa23',
  '/app.js?v=pwa23-cold1',
  '/manifest.webmanifest?v=pwa23',
  '/app-icon-192.png',
  '/app-icon-512.png',
  '/apple-touch-icon-180.png'
];
const SHELL_KEYS=new Set(SHELL_ASSETS);
const SHELL_TYPES=new Map([
  ['/style.css?v=pwa23','text/css'],
  ['/app.js?v=pwa23-cold1','text/javascript'],
  ['/manifest.webmanifest?v=pwa23','application/manifest+json'],
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

function safeNotificationTarget(value){
  const raw=String(value||'/');
  try{const url=new URL(raw,self.location.origin);if(url.origin!==self.location.origin||raw.startsWith('//')||!url.pathname.startsWith('/'))return '/';return url.pathname+url.search+url.hash}catch{return '/'}
}
const coldResumeTarget=target=>target==='/'?'/?qiuqiu_resume=notification':target;

self.addEventListener('push',event=>{
  let payload={};try{payload=event.data?.json?.()||{}}catch{}
  const title=String(payload.title||'秋秋').trim().slice(0,80)||'秋秋',body=String(payload.body||'').trim().slice(0,180),tag=String(payload.tag||'').trim().slice(0,64),target=safeNotificationTarget(payload.target),options={body,icon:'/app-icon-192.png',data:{target}};
  if(tag)options.tag=tag;
  event.waitUntil(self.registration.showNotification(title,options));
});

self.addEventListener('notificationclick',event=>{
  event.notification.close();const target=safeNotificationTarget(event.notification.data?.target);
  event.waitUntil((async()=>{
    const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true}),existing=windows.find(client=>{try{return new URL(client.url).origin===self.location.origin}catch{return false}});
    if(existing&&target==='/'){existing.postMessage({type:'qiuqiu-open-chat',target});return existing.focus()}
    if(existing){const navigated=await existing.navigate?.(target);return (navigated||existing).focus()}
    return self.clients.openWindow(coldResumeTarget(target));
  })());
});
