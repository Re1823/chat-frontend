import test from 'node:test';
import assert from 'node:assert/strict';
import {createOmbreDashboardService,loadOmbreDashboardConfig} from '../src/ombre-dashboard/service.mjs';
import {normalizeBreathDebug,normalizeBucket,normalizeBucketList,normalizeStatus} from '../src/ombre-dashboard/normalize.mjs';

const response=(body,status=200,headers={})=>new Response(JSON.stringify(body),{status,headers});
const config={url:'http://127.0.0.1:9999',password:'never-log-this',timeoutMs:1000,cfAccessClientId:'',cfAccessClientSecret:''};

test('dashboard login captures cookie and subsequent status is normalized',async()=>{
  const calls=[];
  const service=createOmbreDashboardService({config,fetchImpl:async(url,init)=>{
    calls.push({url,init});
    if(url.endsWith('/auth/login'))return response({ok:true},200,{'set-cookie':'session=abc; HttpOnly; Path=/'});
    return response({state:'healthy',app_version:'1.2.3',bucket_count:7});
  }});
  assert.deepEqual(await service.status(),{connected:true,status:'healthy',version:'1.2.3',memoryCount:7,dynamicCount:null,permanentCount:null,archivedCount:null,pinnedCount:null});
  assert.equal(calls[1].init.headers.cookie,'session=abc');
  assert.equal(service.sessionState().authenticated,true);
});

test('concurrent requests deduplicate dashboard login',async()=>{
  let logins=0;
  const service=createOmbreDashboardService({config,fetchImpl:async(url)=>{
    if(url.endsWith('/auth/login')){logins++;await new Promise(resolve=>setTimeout(resolve,10));return response({},200,{'set-cookie':'session=one'})}
    return response({buckets:[]});
  }});
  await Promise.all([service.buckets(),service.buckets(),service.buckets()]);
  assert.equal(logins,1);
});

test('401 clears the cookie, logs in again, and retries once',async()=>{
  let logins=0,statusCalls=0;
  const service=createOmbreDashboardService({config,fetchImpl:async(url)=>{
    if(url.endsWith('/auth/login'))return response({},200,{'set-cookie':`session=${++logins}`});
    statusCalls++;
    return statusCalls===1?response({},401):response({status:'ok'});
  }});
  assert.equal((await service.status()).connected,true);
  assert.equal(logins,2);
  assert.equal(statusCalls,2);
});

test('bucket adapter accepts known OB field variants and does not return raw fields',()=>{
  const normalized=normalizeBucket({bucket_id:'b1',title:'Memory',text:'Full',content_preview:'Short',meta:{type:'dynamic',domain:'work',tags:['one'],activation_count:3},importance:'0.8',is_pinned:true,created_at:'2026-01-01',secret:'hidden'});
  assert.deepEqual(normalized,{id:'b1',name:'Memory',content:'Full',contentPreview:'Short',type:'dynamic',domains:['work'],tags:['one'],importance:.8,valence:null,arousal:null,pinned:true,resolved:null,digested:null,activationCount:3,createdAt:'2026-01-01',lastActiveAt:null});
  assert.equal('secret' in normalized,false);
});

test('list, search and detail use stable normalized shapes and encoded paths',async()=>{
  const paths=[];
  const service=createOmbreDashboardService({config,fetchImpl:async(url)=>{
    paths.push(new URL(url).pathname+new URL(url).search);
    if(url.endsWith('/auth/login'))return response({},200,{'set-cookie':'s=x'});
    if(url.includes('/api/bucket/'))return response({id:'a/b',content:'detail'});
    return response({results:[{id:'1',name:'found'}]});
  }});
  assert.equal((await service.buckets())[0].id,'1');
  assert.equal((await service.search('中文 & x'))[0].name,'found');
  assert.equal((await service.bucket('a/b')).content,'detail');
  assert.ok(paths.includes('/api/search?q=%E4%B8%AD%E6%96%87%20%26%20x'));
  assert.ok(paths.includes('/api/bucket/a%2Fb'));
});

test('localhost and cloudflared configs use the same service and optional Access headers',async()=>{
  const local=loadOmbreDashboardConfig({OMBRE_DASHBOARD_URL:'http://localhost:8000/',OMBRE_DASHBOARD_PASSWORD:'p'});
  assert.equal(local.url,'http://localhost:8000');
  let headers;
  const cloud=createOmbreDashboardService({config:{...config,url:'https://ob.example.test',cfAccessClientId:'id',cfAccessClientSecret:'secret'},fetchImpl:async(url,init)=>{
    headers=init.headers;return response({},200,{'set-cookie':'s=x'});
  }});
  await cloud.login();
  assert.equal(headers['CF-Access-Client-Id'],'id');
  assert.equal(headers['CF-Access-Client-Secret'],'secret');
});

test('errors expose only stable codes and never configured secrets',async()=>{
  const service=createOmbreDashboardService({config,fetchImpl:async()=>response({password:config.password},500)});
  await assert.rejects(service.login(),error=>error.code==='ombre_auth_failed'&&!error.message.includes(config.password));
});

test('status and list wrappers tolerate nested and alternate payloads',()=>{
  assert.equal(normalizeStatus({data:{stats:{total:4,dynamic:2}}}).memoryCount,4);
  assert.equal(normalizeBucketList({memories:[{name:'stable'}]})[0].id,'stable');
});

test('OB 2.11 detail metadata and status bucket counters normalize without losing fields',()=>{
  const bucket=normalizeBucket({id:'x',content:'full',metadata:{name:'actual',type:'permanent',domain:'life',tags:['tag'],importance:.9,valence:.2,arousal:.3,pinned:true,activation_count:4,created:'now',last_active:'later'}});
  assert.equal(bucket.name,'actual');assert.equal(bucket.type,'permanent');assert.deepEqual(bucket.domains,['life']);assert.equal(bucket.activationCount,4);
  assert.deepEqual(normalizeStatus({version:'2.11.0',buckets:{total:300,dynamic:100,permanent:200,archive:11,pinned:3}}),{connected:true,status:'online',version:'2.11.0',memoryCount:311,dynamicCount:100,permanentCount:200,archivedCount:11,pinnedCount:3});
});

test('OB 2.11 breath debug is reduced to stable scoring fields',()=>{
  assert.deepEqual(normalizeBreathDebug({query:'q',valence:.1,arousal:.2,threshold:.5,passed_count:1,total_candidates:2,weights:{private:'discarded'},results:[{id:'x',name:'n',raw_total:.7,passed_threshold:true,scores:{semantic:.8,bad:'x'},secret:'discarded'}]}),{query:'q',valence:.1,arousal:.2,threshold:.5,passedCount:1,totalCandidates:2,results:[{id:'x',name:'n',type:null,domain:null,finalScore:.7,passed:true,scores:{semantic:.8}}]});
});
