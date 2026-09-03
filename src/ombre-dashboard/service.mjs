import {normalizeBreathDebug,normalizeBucket,normalizeBucketList,normalizeStatus} from './normalize.mjs';

export class OmbreDashboardError extends Error{
  constructor(code,statusCode=502){super(code);this.name='OmbreDashboardError';this.code=code;this.statusCode=statusCode}
}

const trimUrl=value=>String(value||'').trim().replace(/\/+$/,'');
const cookieHeader=headers=>{
  const lines=typeof headers.getSetCookie==='function'?headers.getSetCookie():[headers.get('set-cookie')].filter(Boolean);
  return lines.map(line=>String(line).split(';',1)[0]).filter(Boolean).join('; ');
};

export function loadOmbreDashboardConfig(env=process.env){
  return {
    url:trimUrl(env.OMBRE_DASHBOARD_URL),
    password:String(env.OMBRE_DASHBOARD_PASSWORD||''),
    timeoutMs:Math.max(250,Number(env.OMBRE_DASHBOARD_TIMEOUT_MS)||5000),
    cfAccessClientId:String(env.CF_ACCESS_CLIENT_ID||''),
    cfAccessClientSecret:String(env.CF_ACCESS_CLIENT_SECRET||'')
  };
}

export function createOmbreDashboardService({config=loadOmbreDashboardConfig(),fetchImpl=globalThis.fetch}={}){
  let sessionCookie='';
  let loginPromise=null;
  const configured=()=>Boolean(config.url&&config.password);
  const accessHeaders=()=>{
    if(!config.cfAccessClientId&&!config.cfAccessClientSecret)return {};
    if(!config.cfAccessClientId||!config.cfAccessClientSecret)throw new OmbreDashboardError('ombre_not_configured',503);
    return {'CF-Access-Client-Id':config.cfAccessClientId,'CF-Access-Client-Secret':config.cfAccessClientSecret};
  };
  const request=async(path,init={})=>{
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),config.timeoutMs);
    try{return await fetchImpl(`${config.url}${path}`,{...init,headers:{accept:'application/json',...accessHeaders(),...init.headers},signal:controller.signal,redirect:'manual'})}
    catch(error){throw new OmbreDashboardError('ombre_unavailable',503)}finally{clearTimeout(timer)}
  };
  const login=async()=>{
    if(!configured())throw new OmbreDashboardError('ombre_not_configured',503);
    if(loginPromise)return loginPromise;
    loginPromise=(async()=>{
      const response=await request('/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:config.password})});
      const cookie=cookieHeader(response.headers);
      if(!response.ok||!cookie)throw new OmbreDashboardError('ombre_auth_failed',502);
      sessionCookie=cookie;
      return true;
    })().finally(()=>{loginPromise=null});
    return loginPromise;
  };
  const ensureLoggedIn=async()=>{if(!sessionCookie)await login()};
  const dashboardRequest=async(path,{retry=true}={})=>{
    await ensureLoggedIn();
    const response=await request(path,{headers:{cookie:sessionCookie}});
    if(response.status===401&&retry){sessionCookie='';await login();return dashboardRequest(path,{retry:false})}
    if(response.status===401||response.status===403)throw new OmbreDashboardError('ombre_auth_failed',502);
    if(!response.ok)throw new OmbreDashboardError('ombre_upstream_error',502);
    try{return await response.json()}catch{throw new OmbreDashboardError('ombre_upstream_error',502)}
  };
  return {
    configured,login,ensureLoggedIn,dashboardRequest,
    async status(){return normalizeStatus(await dashboardRequest('/api/status'))},
    async buckets(){return normalizeBucketList(await dashboardRequest('/api/buckets'))},
    async search(query){return normalizeBucketList(await dashboardRequest(`/api/search?q=${encodeURIComponent(String(query||''))}`))},
    async bucket(id){return normalizeBucket(await dashboardRequest(`/api/bucket/${encodeURIComponent(String(id))}`))},
    async breathDebug(query){return normalizeBreathDebug(await dashboardRequest(`/api/breath-debug?q=${encodeURIComponent(String(query||''))}`))},
    sessionState(){return {authenticated:Boolean(sessionCookie)}}
  };
}
