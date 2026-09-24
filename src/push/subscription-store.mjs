import {mkdir,open,readFile,rename,rm,chmod} from 'node:fs/promises';
import {dirname} from 'node:path';

const INSTALLATION_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64URL=/^[A-Za-z0-9_-]+$/;
const clone=value=>JSON.parse(JSON.stringify(value));

export function validatePushSubscription(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw Object.assign(new Error('invalid_push_subscription'),{statusCode:400});
  const allowed=['endpoint','expirationTime','keys'];
  if(Object.keys(input).some(key=>!allowed.includes(key)))throw Object.assign(new Error('invalid_push_subscription'),{statusCode:400});
  let endpoint;
  try{endpoint=new URL(String(input.endpoint||''))}catch{throw Object.assign(new Error('invalid_push_subscription'),{statusCode:400})}
  if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.href.length>2048)throw Object.assign(new Error('invalid_push_subscription'),{statusCode:400});
  const expirationTime=input.expirationTime==null?null:Number(input.expirationTime),p256dh=String(input.keys?.p256dh||''),auth=String(input.keys?.auth||'');
  if(expirationTime!==null&&(!Number.isSafeInteger(expirationTime)||expirationTime<=0))throw Object.assign(new Error('invalid_push_subscription'),{statusCode:400});
  if(!BASE64URL.test(p256dh)||p256dh.length<40||p256dh.length>256||!BASE64URL.test(auth)||auth.length<8||auth.length>128)throw Object.assign(new Error('invalid_push_subscription'),{statusCode:400});
  return {endpoint:endpoint.href,expirationTime,keys:{p256dh,auth}};
}

export function validateInstallationId(value){
  const id=String(value||'');
  if(!INSTALLATION_ID.test(id))throw Object.assign(new Error('invalid_installation_id'),{statusCode:400});
  return id;
}

export function createPushSubscriptionStore({path,now=()=>Date.now(),maxRecords=32}={}){
  if(!path)throw new Error('push subscription store requires path');
  let records=[],persistChain=Promise.resolve();
  const live=record=>record.subscription.expirationTime===null||record.subscription.expirationTime>now();
  const safe=()=>records.filter(live).map(clone);
  const writeState=async()=>{
    await mkdir(dirname(path),{recursive:true,mode:0o700});
    const temp=`${path}.${process.pid}-${Date.now()}.tmp`,handle=await open(temp,'wx',0o600);
    try{await handle.writeFile(JSON.stringify({version:1,records:safe()},null,2)+'\n');await handle.sync();await handle.close();await rename(temp,path);await chmod(path,0o600);if(process.platform!=='win32'){const directory=await open(dirname(path),'r');await directory.sync();await directory.close()}}catch(error){await handle.close().catch(()=>{});await rm(temp,{force:true}).catch(()=>{});throw error}
  };
  const persist=()=>{persistChain=persistChain.then(writeState,writeState);return persistChain};
  const purgeExpired=async()=>{const before=records.length;records=records.filter(live);if(records.length!==before)await persist();return before-records.length};
  return {
    path,
    async initialize(){let missing=false;try{const data=JSON.parse(await readFile(path,'utf8'));records=Array.isArray(data?.records)?data.records.map(record=>({installationId:validateInstallationId(record.installationId),subscription:validatePushSubscription(record.subscription),createdAt:String(record.createdAt||''),updatedAt:String(record.updatedAt||'')})):[]}catch(error){if(error.code!=='ENOENT')throw error;records=[];missing=true}await purgeExpired();if(missing)await persist();return this.snapshot()},
    async upsert({installationId,subscription}){await purgeExpired();const id=validateInstallationId(installationId),value=validatePushSubscription(subscription),timestamp=new Date(now()).toISOString();let record=records.find(item=>item.installationId===id);if(record){record.subscription=value;record.updatedAt=timestamp}else{if(records.length>=maxRecords)throw Object.assign(new Error('push_subscription_limit'),{statusCode:429});record={installationId:id,subscription:value,createdAt:timestamp,updatedAt:timestamp};records.push(record)}await persist();return {installationId:id,createdAt:record.createdAt,updatedAt:record.updatedAt}},
    async remove({installationId,endpoint}){const id=validateInstallationId(installationId);let normalized;try{normalized=new URL(String(endpoint||'')).href}catch{return false}const before=records.length;records=records.filter(item=>!(item.installationId===id&&item.subscription.endpoint===normalized));if(records.length!==before)await persist();return records.length!==before},
    async removeEndpoint(endpoint){const before=records.length;records=records.filter(item=>item.subscription.endpoint!==endpoint);if(records.length!==before)await persist();return records.length!==before},
    async list(){await purgeExpired();return safe()},
    snapshot(){return {count:records.filter(live).length}}
  };
}
