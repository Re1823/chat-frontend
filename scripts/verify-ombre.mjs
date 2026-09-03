import {loadLocalEnv} from '../src/local-env.mjs';
import {createOmbreDashboardService,loadOmbreDashboardConfig} from '../src/ombre-dashboard/service.mjs';

await loadLocalEnv(new URL('../.env.local',import.meta.url));
const config=loadOmbreDashboardConfig();
const service=createOmbreDashboardService({config});
const report={target:new URL(config.url).origin,configured:service.configured()};

const shape=value=>value&&typeof value==='object'?Object.keys(value).sort():[];
try{
  await service.login();
  report.login=true;
  report.sessionCookieCaptured=service.sessionState().authenticated;
  const rawStatus=await service.dashboardRequest('/api/status');
  const rawBuckets=await service.dashboardRequest('/api/buckets');
  const status=await service.status();
  const buckets=await service.buckets();
  report.status={ok:status.connected,version:status.version??null,fields:shape(rawStatus),bucketFields:shape(rawStatus?.buckets),normalized:status};
  report.buckets={ok:true,count:buckets.length,envelope:Array.isArray(rawBuckets)?'array':shape(rawBuckets),itemFields:shape(Array.isArray(rawBuckets)?rawBuckets[0]:Object.values(rawBuckets).find(Array.isArray)?.[0]),normalizedFields:shape(buckets[0])};
  const searchQuery=String(buckets[0]?.name||buckets[0]?.contentPreview||'memory').slice(0,2);
  const search=await service.search(searchQuery);
  report.search={ok:true,count:search.length};
  if(!buckets[0]?.id)throw new Error('No bucket id available for detail verification');
  const rawDetail=await service.dashboardRequest(`/api/bucket/${encodeURIComponent(buckets[0].id)}`);
  const detail=await service.bucket(buckets[0].id);
  report.detail={ok:Boolean(detail.id),fields:shape(rawDetail),metadataFields:shape(rawDetail?.metadata),scoreFields:shape(rawDetail?.score),normalizedFields:shape(detail)};
  try{const breath=await service.dashboardRequest('/api/breath-debug?q=memory');report.breathDebug={supported:true,fields:shape(breath),resultFields:shape(Array.isArray(breath)?breath[0]:breath?.results?.[0]||breath?.items?.[0]||breath?.data)}}catch(error){report.breathDebug=error.code==='ombre_upstream_error'?'not_supported_or_non_2xx':'unverified'}
  let loginCalls=0,corruptNextApi=false;
  const verificationFetch=async(url,init)=>{
    if(String(url).endsWith('/auth/login'))loginCalls++;
    else if(corruptNextApi){corruptNextApi=false;init={...init,headers:{...init.headers,cookie:'dwell_invalid_cookie=1'}}}
    return fetch(url,init);
  };
  const retryService=createOmbreDashboardService({config,fetchImpl:verificationFetch});
  await Promise.all([retryService.ensureLoggedIn(),retryService.ensureLoggedIn(),retryService.ensureLoggedIn()]);
  report.concurrentLoginDeduped=loginCalls===1;
  corruptNextApi=true;
  const retryStatus=await retryService.status();
  report.invalidCookie401Relogin=retryStatus.connected&&loginCalls===2;
  console.log(JSON.stringify(report,null,2));
}catch(error){
  report.ok=false;
  report.error=error?.code||error?.name||'unknown_error';
  console.log(JSON.stringify(report,null,2));
  process.exitCode=1;
}
