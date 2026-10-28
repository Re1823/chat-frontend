import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPurchaseStore } from '../src/shopping/purchases.mjs';
import { createApprovalContinuation } from '../src/shopping/approval-continuation.mjs';
import { createShoppingApprovalApi } from '../src/shopping/approval-api.mjs';
import { createDwellServer } from '../server.mjs';
import { shoppingMcpTools } from '../src/shopping/contracts.mjs';
import { createShoppingGateway } from '../src/shopping/gateway.mjs';
import { signWorkerMessage } from '../src/shopping/worker-auth.mjs';

const secret='phase1-continuation-approval-secret-32chars';
const order={platform:'taobao',merchant:'fixture merchant',goods:'fixture pen',sku:'red',skuId:'sku-1',quantity:1,subtotalMinor:480,shippingMinor:0,discountMinor:62,totalMinor:418,addressLabel:'masked',resourceUrl:'https://item.taobao.com/item.htm?id=123456',confirmationPage:'https://buy.taobao.com/auction/buy_now.jhtml',category:'physical_goods'};
async function fixture(){
  const path=join(await mkdtemp(join(tmpdir(),'approval-continuation-')),'purchases.json');
  let clock=Date.now();
  const open=async()=>{const store=createPurchaseStore({path,approvalSecret:secret,now:()=>clock});await store.load();return store};
  const store=await open();
  const create=async()=>{const session=await store.startSession({ownerId:'owner',conversationId:'claude-main',workerId:'windows',browserContextId:'edge-context',profileId:'edge-profile',pageUrl:order.resourceUrl});const purchase=await store.create({ownerId:'owner',conversationId:'claude-main',sessionId:session.sessionId,workerOrder:order});return {session,purchase}};
  const decide=(purchase,session,decision='approve',nonce=purchase.approvalNonce,fingerprint=purchase.fingerprint,sessionId=session.sessionId)=>store.decide({ownerId:'owner',purchaseId:purchase.purchaseId,sessionId,fingerprint,nonce,decision});
  return {path,store,open,create,decide,advance:ms=>{clock+=ms}};
}

test('Approve atomically enqueues only this request; disabled submit gate records a safe block',async()=>{
  const f=await fixture(),{session,purchase}=await f.create();let executes=0;
  const continuation=createApprovalContinuation({purchaseStore:f.store,executor:{execute:async()=>{executes++}},orderSubmitEnabled:false,workerOnline:()=>true});
  const api=createShoppingApprovalApi({purchaseStore:f.store,verifyOwner:async()=> 'owner',onApproved:id=>continuation.attempt(id)});
  const server=createDwellServer({shoppingApprovalApi:api});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const origin=`http://127.0.0.1:${server.address().port}`;
    const body={sessionId:session.sessionId,fingerprint:purchase.fingerprint,nonce:purchase.approvalNonce,decision:'approve'};
    const request=()=>fetch(`${origin}/api/shopping/approvals/${purchase.purchaseId}/decision`,{method:'POST',headers:{'content-type':'application/json',origin,'sec-fetch-site':'same-origin','x-shopping-user-action':'1'},body:JSON.stringify(body)});
    assert.equal((await request()).status,200);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal((await request()).status,409);
    const saved=JSON.parse(await readFile(f.path,'utf8')).records[purchase.purchaseId];
    assert.equal(saved.state,'approved');assert.equal(saved.continuation.version,1);assert.equal(saved.continuation.state,'blocked_by_order_submit_gate');
    assert.equal(saved.execution,undefined);assert.equal(executes,0);
    const id=saved.continuation.id;await continuation.recover();
    assert.equal(f.store.continuation({purchaseId:purchase.purchaseId}).continuation.id,id);
    assert.equal(executes,0);
  }finally{await new Promise(resolve=>server.close(resolve))}
});

test('exact approved request gets one stable claim without Explicit Execute; duplicate delivery does not submit twice',async()=>{
  const f=await fixture(),{session,purchase}=await f.create();await f.decide(purchase,session);
  let executes=0;const continuation=createApprovalContinuation({purchaseStore:f.store,orderSubmitEnabled:true,workerOnline:()=>true,executor:{execute:async id=>{executes++;await f.store.claimExecution({purchaseId:id});return {state:'executing'}}}});
  const id=f.store.continuation({purchaseId:purchase.purchaseId}).continuation.id;
  await Promise.all([continuation.attempt(purchase.purchaseId),continuation.attempt(purchase.purchaseId)]);
  await continuation.recover();
  assert.equal(executes,1);assert.equal(f.store.continuation({purchaseId:purchase.purchaseId}).continuation.id,id);
  assert.equal(f.store.execution({purchaseId:purchase.purchaseId}).state,'executing');
});

test('restart recovers only new marked approvals and preserves the original claim identity',async()=>{
  const f=await fixture(),{session,purchase}=await f.create();await f.decide(purchase,session);
  const id=f.store.continuation({purchaseId:purchase.purchaseId}).continuation.id;
  await f.store.setContinuationState({purchaseId:purchase.purchaseId,nextState:'claimed'});
  const restored=await f.open();let executes=0;
  const continuation=createApprovalContinuation({purchaseStore:restored,orderSubmitEnabled:true,workerOnline:()=>true,executor:{execute:async purchaseId=>{executes++;await restored.claimExecution({purchaseId});return {state:'executing'}}}});
  await continuation.recover();await continuation.recover();
  assert.equal(executes,1);assert.equal(restored.continuation({purchaseId:purchase.purchaseId}).continuation.id,id);
});

test('historical approved without a Phase 1 marker is never recovered',async()=>{
  const f=await fixture(),{session,purchase}=await f.create();await f.decide(purchase,session);
  const disk=JSON.parse(await readFile(f.path,'utf8'));delete disk.records[purchase.purchaseId].continuation;await writeFile(f.path,JSON.stringify(disk));
  const restored=await f.open();let executes=0;
  const continuation=createApprovalContinuation({purchaseStore:restored,orderSubmitEnabled:true,workerOnline:()=>true,executor:{execute:async()=>{executes++}}});
  assert.deepEqual(await continuation.recover(),[]);assert.equal(executes,0);assert.equal(restored.execution({purchaseId:purchase.purchaseId}).state,'approved');
});

test('worker reconnect wakes only marked continuation recovery, without a polling loop',async()=>{
  const f=await fixture(),{session,purchase}=await f.create();await f.decide(purchase,session);
  let executes=0;const gateway=createShoppingGateway({secret,workerId:'windows',replayPath:join(await mkdtemp(join(tmpdir(),'approval-gateway-')),'replay.json'),purchaseStore:f.store});
  const continuation=createApprovalContinuation({purchaseStore:f.store,orderSubmitEnabled:true,workerOnline:()=>gateway.online(),executor:{execute:async id=>{executes++;await f.store.claimExecution({purchaseId:id})}}});
  assert.equal((await continuation.attempt(purchase.purchaseId)).status,'waiting_for_worker');
  let woke;const recovered=new Promise(resolve=>{woke=resolve});
  gateway.onWorkerOnline(()=>{void continuation.recover().then(woke)});
  gateway.accept(signWorkerMessage({secret,role:'worker',workerId:'windows',operation:'poll',payload:{}}));
  await recovered;
  assert.equal(executes,1);
  gateway.accept(signWorkerMessage({secret,role:'worker',workerId:'windows',operation:'poll',payload:{}}));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(executes,1);
});

test('invalid approval binding, rejected and expired requests never create continuation',async()=>{
  const f=await fixture(),{session,purchase}=await f.create();
  for(const [nonce,fingerprint,sessionId] of [['wrong',purchase.fingerprint,session.sessionId],[purchase.approvalNonce,'wrong',session.sessionId],[purchase.approvalNonce,purchase.fingerprint,'wrong']])await assert.rejects(f.decide(purchase,session,'approve',nonce,fingerprint,sessionId));
  assert.equal(f.store.continuation({purchaseId:purchase.purchaseId}),null);
  await f.decide(purchase,session,'reject');assert.equal(f.store.continuation({purchaseId:purchase.purchaseId}),null);
  const next=await f.create();f.advance(11*60_000);await assert.rejects(f.decide(next.purchase,next.session),/approval_expired/);
  assert.equal(f.store.continuation({purchaseId:next.purchase.purchaseId}),null);
  assert.ok(!shoppingMcpTools.some(tool=>/execute|submit|payment/.test(tool.name)));
});
