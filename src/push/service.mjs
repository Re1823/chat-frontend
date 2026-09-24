import webpush from 'web-push';

const text=(value,max)=>String(value||'').trim().slice(0,max);
export function safePushTarget(value){
  const raw=String(value||'/');
  try{const url=new URL(raw,'https://qiuqiu.invalid');if(url.origin!=='https://qiuqiu.invalid'||!url.pathname.startsWith('/')||raw.startsWith('//'))return '/';return url.pathname+url.search+url.hash}catch{return '/'}
}
export function sanitizePushPayload(value={}){
  return {title:text(value.title,80)||'秋秋',body:text(value.body,180),target:safePushTarget(value.target),tag:text(value.tag,64)};
}
export function createPushService({store,vapid={},transport=webpush}={}){
  if(!store)throw new Error('push service requires store');
  const publicKey=String(vapid.publicKey||''),privateKey=String(vapid.privateKey||''),subject=String(vapid.subject||'');
  const ready=Boolean(publicKey&&privateKey&&/^(mailto:|https:)/.test(subject));
  if(ready)transport.setVapidDetails(subject,publicKey,privateKey);
  return {
    ready,
    publicConfig(){return ready?{supported:true,publicKey}:{supported:false,publicKey:null}},
    async sendPush(payload,{installationId=null}={}){
      if(!ready)throw Object.assign(new Error('push_not_configured'),{statusCode:503});
      const records=(await store.list()).filter(record=>!installationId||record.installationId===installationId),data=JSON.stringify(sanitizePushPayload(payload));
      let sent=0,removed=0,failed=0;
      for(const record of records)try{await transport.sendNotification(record.subscription,data,{TTL:300,urgency:'normal'});sent++}catch(error){if([404,410].includes(Number(error?.statusCode))){await store.removeEndpoint(record.subscription.endpoint);removed++}else failed++}
      return {sent,removed,failed};
    }
  };
}
