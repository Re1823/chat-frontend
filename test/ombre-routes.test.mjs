import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createDwellServer} from '../server.mjs';

const runtime={configuration:()=>({enabled:false}),initialize:async()=>{},status:async()=>({state:'disabled'})};
async function withServer(service,run){
  const server=createDwellServer({claudeRuntime:runtime,ombreService:service});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try{await run(`http://127.0.0.1:${server.address().port}`)}finally{server.close();await once(server,'close')}
}

test('Ombre browser routes expose stable read-only API shapes',async()=>{
  const calls=[];
  const service={configured:()=>true,status:async()=>({connected:true,status:'ok'}),buckets:async()=>[{id:'1'}],search:async q=>{calls.push(q);return [{id:'2'}]},bucket:async id=>{calls.push(id);return {id,content:'full'}}};
  await withServer(service,async base=>{
    assert.equal((await (await fetch(`${base}/api/ombre-dashboard/status`)).json()).connected,true);
    assert.deepEqual((await (await fetch(`${base}/api/ombre-dashboard/buckets`)).json()).items,[{id:'1'}]);
    assert.deepEqual((await (await fetch(`${base}/api/ombre-dashboard/search?q=%E4%B8%AD%E6%96%87`)).json()).items,[{id:'2'}]);
    assert.equal((await (await fetch(`${base}/api/ombre-dashboard/buckets/a%2Fb`)).json()).id,'a/b');
  });
  assert.deepEqual(calls,['中文','a/b']);
});

test('Ombre routes map failures without leaking upstream details',async()=>{
  const service={configured:()=>true,status:async()=>{const error=new Error('password=cookie=secret');error.code='ombre_unavailable';error.statusCode=503;throw error}};
  await withServer(service,async base=>{
    const response=await fetch(`${base}/api/ombre-dashboard/status`),text=await response.text();
    assert.equal(response.status,503);
    assert.deepEqual(JSON.parse(text),{error:'ombre_unavailable'});
    assert.equal(/password|cookie|secret/.test(text),false);
  });
});

test('readiness route never returns CLAUDE.md content and keeps Claude offline',async()=>{
  const service={configured:()=>false};
  await withServer(service,async base=>{
    const result=await (await fetch(`${base}/api/qiuqiu/readiness`)).json();
    assert.equal(result.claudeCode,'offline');
    assert.equal(result.obDashboardConnected,false);
    assert.deepEqual(Object.keys(result),['workspaceConfigured','workspaceExists','claudeMdExists','obDashboardConnected','claudeCode']);
  });
});
