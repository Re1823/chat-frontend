import assert from 'node:assert/strict';
import test from 'node:test';
import {createDwellServer} from '../server.mjs';
import {productionConversationSnapshot} from '../src/runtimes/production-conversation.mjs';

const sessionId='11111111-1111-4111-8111-111111111111';
const records=[
  {type:'user',uuid:'user-1',parentUuid:null,sessionId,userType:'external',timestamp:'2026-09-24T06:22:43.000Z',message:{role:'user',content:[{type:'text',text:'哥哥我到图书馆了'}]}},
  {type:'assistant',uuid:'assistant-1',parentUuid:'user-1',sessionId,timestamp:'2026-09-24T06:22:44.000Z',message:{role:'assistant',content:[{type:'text',text:'去吧，穿厚点'}]}},
  {type:'system',uuid:'stop-1',parentUuid:'assistant-1',sessionId,subtype:'stop_hook_summary',timestamp:'2026-09-24T06:22:45.000Z'},
  {type:'system',uuid:'duration-1',parentUuid:'stop-1',sessionId,subtype:'turn_duration',timestamp:'2026-09-24T06:22:46.000Z'}
];

test('production conversation projection contains only completed visible messages and no transcript identity',()=>{
  const snapshot=productionConversationSnapshot(records);
  assert.deepEqual(snapshot,{available:true,truncated:false,messages:[{role:'user',content:'哥哥我到图书馆了',createdAt:'2026-09-24T06:22:43.000Z'},{role:'assistant',content:'去吧，穿厚点',createdAt:'2026-09-24T06:22:44.000Z'}]});
  assert.doesNotMatch(JSON.stringify(snapshot),/11111111|user-1|assistant-1|stop-1|duration-1/);
});

test('production replay preserves real technical chat text while removing frontend-only image context',()=>{
  const technical=structuredClone(records);technical[0].message.content[0].text='<frontend_image_context>\nImage IDs: private-image-id\n</frontend_image_context>\n\n请检查 /root 的状态';technical[1].message.content[0].text='只读检查完成';
  const snapshot=productionConversationSnapshot(technical);assert.equal(snapshot.available,true);assert.equal(snapshot.messages[0].content,'请检查 /root 的状态');assert.equal(snapshot.messages[1].content,'只读检查完成');assert.doesNotMatch(JSON.stringify(snapshot),/frontend_image_context|private-image-id/);
});

test('production conversation endpoint returns real history only when the connected runtime has it',async()=>{
  const snapshot=productionConversationSnapshot(records),runtime={status:async()=>({state:'connected'}),productionConversation:async()=>snapshot},server=createDwellServer({claudeRuntime:runtime});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  try{
    const response=await fetch(`${base}/api/runtimes/claude-tmux/production-conversation`,{headers:{'sec-fetch-site':'same-origin'}});assert.equal(response.status,200);assert.deepEqual(await response.json(),snapshot);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('cross-origin-resource-policy'),'same-origin');
    assert.equal((await fetch(`${base}/api/runtimes/claude-tmux/production-conversation`,{headers:{'sec-fetch-site':'cross-site'}})).status,403);
  }finally{await new Promise(resolve=>server.close(resolve))}
});

test('production conversation endpoint does not manufacture an empty conversation',async()=>{
  const runtime={status:async()=>({state:'connected'}),productionConversation:async()=>({available:false,messages:[]})},server=createDwellServer({claudeRuntime:runtime});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/runtimes/claude-tmux/production-conversation`,{headers:{'sec-fetch-site':'same-origin'}});assert.equal(response.status,404);assert.deepEqual(await response.json(),{available:false})}finally{await new Promise(resolve=>server.close(resolve))}
});
