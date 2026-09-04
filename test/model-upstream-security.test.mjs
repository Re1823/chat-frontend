import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {once} from 'node:events';
import http from 'node:http';
import {createModelUpstreamPolicy,isBlockedAddress,loadModelUpstreamAllowlist} from '../src/security/model-upstream-policy.mjs';
import {createDwellServer} from '../server.mjs';

const allowlist=loadModelUpstreamAllowlist({MODEL_UPSTREAM_ALLOWLIST:'https://api.deepseek.com,http://127.0.0.1,http://localhost,http://metadata.test'});
const policyFor=address=>createModelUpstreamPolicy({allowlist,resolve:async()=>[{address,family:address.includes(':')?6:4}]});

test('allows an exact trusted model origin resolving only to public addresses',async()=>{
  const result=await policyFor('203.0.113.20')('https://api.deepseek.com/v1/chat/completions');
  assert.equal(result.origin,'https://api.deepseek.com');
});

test('rejects localhost, loopback, RFC1918, link-local and metadata destinations',async()=>{
  for(const url of ['http://localhost/v1','http://127.0.0.1/v1'])await assert.rejects(policyFor('127.0.0.1')(url),/禁止的网络地址/);
  for(const address of ['10.0.0.1','172.16.1.2','192.168.1.2','169.254.1.1','169.254.169.254','::1','fe80::1','fd00::1'])assert.equal(isBlockedAddress(address),true,address);
});

test('rejects hostname DNS resolution to private space and any mixed private answer',async()=>{
  await assert.rejects(policyFor('192.168.0.4')('http://metadata.test/v1'),/禁止的网络地址/);
  const mixed=createModelUpstreamPolicy({allowlist,resolve:async()=>[{address:'203.0.113.20'},{address:'169.254.169.254'}]});
  await assert.rejects(mixed('http://metadata.test/v1'),/禁止的网络地址/);
});

test('rejects untrusted, credentialed and malformed model URLs',async()=>{
  const policy=policyFor('203.0.113.20');
  for(const url of ['https://evil.example/v1','https://user:pass@api.deepseek.com/v1','file:///etc/passwd','not a url'])await assert.rejects(policy(url),error=>error.code==='upstream_not_allowed'&&error.statusCode===400);
});

test('chat route returns a stable policy error without contacting a rejected upstream',async()=>{
  let checked='';
  const app=createDwellServer({validateModelUpstream:async url=>{checked=url;throw Object.assign(new Error('do not expose this detail'),{statusCode:400,code:'upstream_not_allowed'})}});
  app.listen(0,'127.0.0.1');await once(app,'listening');
  try{
    const response=await fetch(`http://127.0.0.1:${app.address().port}/api/chat`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({config:{protocol:'chat',base:'https://evil.example',key:'secret',model:'m'},messages:[]})});
    assert.equal(response.status,400);assert.deepEqual(await response.json(),{error:'upstream_not_allowed'});assert.match(checked,/evil\.example/);
  }finally{app.close();await once(app,'close')}
});

test('upstream error bodies are discarded instead of relayed to the browser',async()=>{
  const upstream=http.createServer((req,res)=>{req.resume();res.writeHead(401,{'content-type':'application/json'});res.end('{"secret":"upstream diagnostic and token"}')});
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  const app=createDwellServer({validateModelUpstream:async()=>true});app.listen(0,'127.0.0.1');await once(app,'listening');
  try{
    const base=`http://127.0.0.1:${upstream.address().port}`;
    const response=await fetch(`http://127.0.0.1:${app.address().port}/api/test`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({config:{protocol:'chat',base,key:'k',model:'m'}})}),text=await response.text();
    assert.equal(response.status,401);assert.doesNotMatch(text,/secret|diagnostic|token/);assert.deepEqual(JSON.parse(text),{error:'模型上游请求失败（401）'});
  }finally{await Promise.all([new Promise(resolve=>app.close(resolve)),new Promise(resolve=>upstream.close(resolve))])}
});

test('deployment nginx blocks internal hooks and preserves streaming proxy settings',async()=>{
  const nginx=await readFile(new URL('../deploy/nginx-qiuqiu.conf',import.meta.url),'utf8');
  assert.match(nginx,/server_name qiuqiu\.reesia\.xyz/);
  assert.match(nginx,/location \^~ \/api\/internal\/\s*\{\s*return 403;/s);
  assert.match(nginx,/proxy_pass http:\/\/qiuqiu_frontend/);
  assert.match(nginx,/proxy_buffering off/);
  assert.match(nginx,/proxy_read_timeout 300s/);
});

test('systemd unit is loopback-service ready and restarts without privileged execution',async()=>{
  const unit=await readFile(new URL('../deploy/chat-frontend.service',import.meta.url),'utf8');
  assert.match(unit,/User=qiuqiu/);
  assert.match(unit,/EnvironmentFile=\/etc\/qiuqiu\/chat-frontend\.env/);
  assert.match(unit,/WorkingDirectory=\/opt\/qiuqiu\/chat-frontend/);
  assert.match(unit,/ExecStart=\/usr\/bin\/node server\.mjs/);
  assert.match(unit,/Restart=on-failure/);
  assert.match(unit,/WantedBy=multi-user\.target/);
});
