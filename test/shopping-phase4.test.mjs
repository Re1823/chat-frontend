import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPurchaseStore } from '../src/shopping/purchases.mjs';
import { createShoppingPaymentExecutor } from '../src/shopping/payment-executor.mjs';
import { createAlipayBotAdapter, parseAlipayBotOutput } from '../src/shopping/alipay-bot-adapter.mjs';
import { classifyShoppingRequest } from '../src/shopping/confirmation-policy.mjs';
import { createBrowserWorker } from '../src/shopping/browser-worker.mjs';
import { createShoppingApprovalApi } from '../src/shopping/approval-api.mjs';
import { createDwellServer } from '../server.mjs';

const ownerId = 'owner@example.com';
const order = { platform:'taobao', merchant:'得力办公文具', goods:'得力中性笔', sku:'红色1支+笔芯2支 / 0.5mm', skuId:'6261131742582', quantity:1, subtotalMinor:480, shippingMinor:0, discountMinor:62, totalMinor:418, addressLabel:'四川省 成都市 · ****8076', resourceUrl:'https://item.taobao.com/item.htm?id=671224654225', confirmationPage:'https://buy.taobao.com/auction/buy_now.jhtml', category:'physical_goods' };
const cashier = 'https://cashier.alipay.com/standard/payment?material=private';

async function approvedFixture({ approve = true } = {}) {
  const path=join(await mkdtemp(join(tmpdir(),'shopping-phase4-')),'purchases.json');
  const settings={path,approvalSecret:'phase4-test-secret-with-at-least-32-characters'};
  const store=createPurchaseStore(settings);await store.load();
  const session=await store.startSession({ownerId,conversationId:'claude-main',workerId:'windows-1',browserContextId:'context-1',profileId:'shopping',pageUrl:order.resourceUrl});
  const pending=await store.create({ownerId,conversationId:'claude-main',sessionId:session.sessionId,workerOrder:order});
  if (approve) await store.decide({ownerId,purchaseId:pending.purchaseId,sessionId:pending.sessionId,fingerprint:pending.fingerprint,nonce:pending.approvalNonce,decision:'approve'});
  return {store,settings,pending};
}

test('approved execution submits one order, keeps cashier secret, reconciles and completes',async()=>{
  const {store,settings,pending}=await approvedFixture();
  let orderSubmits=0,paymentSubmits=0,queries=0;
  const gateway={online:()=>true,call:async(operation,payload)=>{assert.equal(operation,'submit_approved_order');assert.equal(payload.snapshot.totalMinor,418);orderSubmits++;return {sessionId:payload.sessionId,executionId:payload.executionId,cashierUrl:cashier}}};
  const provider={execute:async args=>{paymentSubmits++;assert.equal(args.paymentLink,cashier);assert.match(args.intentSummary,/¥4\.18/);return {status:'pending',queryCredential:{kind:'outShakeNo',value:'12345678908282123456789012345678'}}},query:async()=>{queries++;return {status:queries===1?'processing':'paid'}}};
  const executor=createShoppingPaymentExecutor({purchaseStore:store,gateway,provider,allowRealPayment:true});
  assert.equal((await executor.execute(pending.purchaseId)).state,'pending_alipay');
  assert.equal((await executor.execute(pending.purchaseId)).state,'pending_alipay');
  assert.equal(orderSubmits,1);assert.equal(paymentSubmits,1);
  assert.equal(JSON.stringify(store.listApprovals({ownerId})).includes('material=private'),false);
  const recovered=createPurchaseStore(settings);await recovered.load();
  const afterRestart=createShoppingPaymentExecutor({purchaseStore:recovered,gateway,provider,allowRealPayment:true});
  assert.equal((await afterRestart.execute(pending.purchaseId)).state,'pending_alipay');
  assert.equal(orderSubmits,1);assert.equal(paymentSubmits,1);
  assert.equal((await afterRestart.query(pending.purchaseId)).state,'pending_alipay');
  assert.equal((await afterRestart.query(pending.purchaseId)).state,'completed');
  assert.equal((await afterRestart.query(pending.purchaseId)).state,'completed');
  assert.equal(queries,2);
});

test('production stop gate reaches cashier without invoking payment CLI',async()=>{
  const {store,pending}=await approvedFixture();
  let invoked=0;
  const gateway={online:()=>true,call:async(_operation,payload)=>({sessionId:payload.sessionId,executionId:payload.executionId,cashierUrl:cashier})};
  const executor=createShoppingPaymentExecutor({purchaseStore:store,gateway,provider:{execute:async()=>{invoked++},query:async()=>{}},allowRealPayment:false});
  const result=await executor.execute(pending.purchaseId);
  assert.deepEqual(result,{state:'pending_alipay',paymentStage:'awaiting_payment'});
  assert.equal(invoked,0);
  assert.equal(store.get({ownerId,purchaseId:pending.purchaseId}).state,'pending_alipay');
});

test('offline worker leaves approved order untouched; uncertain submission never retries',async()=>{
  const {store,pending}=await approvedFixture();
  const offline=createShoppingPaymentExecutor({purchaseStore:store,gateway:{online:()=>false,call:async()=>{} }});
  await assert.rejects(offline.execute(pending.purchaseId),/worker_offline/);
  assert.equal(store.get({ownerId,purchaseId:pending.purchaseId}).state,'approved');
  let calls=0;
  const gateway={online:()=>true,call:async()=>{calls++;throw new Error('worker_result_uncertain')}};
  const executor=createShoppingPaymentExecutor({purchaseStore:store,gateway});
  await assert.rejects(executor.execute(pending.purchaseId),/worker_result_uncertain/);
  assert.equal((await executor.execute(pending.purchaseId)).paymentStage,'order_submit_uncertain');
  assert.equal(calls,1);
});

test('official CLI adapter uses fixed commands and recognizes only provider-confirmed success',async()=>{
  const seen=[];
  const bot=createAlipayBotAdapter({run:async args=>{seen.push(args);return seen.length===1?'✓ 支付待确认 https://u.alipay.com/short':'✓ 支付已完成'}});
  const payment=await bot.execute({sessionId:'12345678-1234-1234-1234-123456789012',paymentLink:cashier,intentSummary:'服务内容：得力中性笔，支付金额：¥4.18，支付对象：得力办公文具'});
  assert.equal(payment.status,'pending');
  assert.deepEqual(seen[0].slice(0,2),['submit-payment','--session-id']);
  assert.equal((await bot.query({credential:payment.queryCredential})).status,'paid');
  assert.deepEqual(seen[1].slice(0,2),['query-payment-status','-p']);
  assert.throws(()=>parseAlipayBotOutput('query','⏳ 支付处理中'),/payment_query_uncertain/);
});

test('order-create and cashier requests are confined to approved submission phase',()=>{
  const request={url:'https://h5api.m.taobao.com/h5/mtop.trade.order.create/5.0/',method:'POST',isNavigation:false,resourceType:'fetch',isMainFrame:true,sourceUrl:'https://buy.taobao.com/auction/buy_now.jhtml'};
  assert.equal(classifyShoppingRequest({...request,phase:'preparing'}),'deny');
  assert.equal(classifyShoppingRequest({...request,phase:'submitting'}),'approved_submit');
  assert.equal(classifyShoppingRequest({...request,phase:'submitting',sourceUrl:order.resourceUrl}),'deny');
  assert.equal(classifyShoppingRequest({url:cashier,method:'GET',isNavigation:true,resourceType:'document',phase:'submitting',sourceUrl:request.sourceUrl,isMainFrame:true}),'cashier');
  assert.equal(classifyShoppingRequest({url:cashier,method:'POST',isNavigation:true,resourceType:'document',phase:'submitting',sourceUrl:request.sourceUrl,isMainFrame:true}),'deny');
  assert.equal(classifyShoppingRequest({url:'https://fakecashier.alipay.com.evil.example/pay',method:'GET',isNavigation:true,resourceType:'document',phase:'submitting',sourceUrl:request.sourceUrl,isMainFrame:true}),'deny');
});

test('worker requires an unchanged prepared snapshot before the only submit click',async()=>{
  let submits=0;
  const adapter={
    product:async()=>({pageUrl:order.resourceUrl,product:{title:order.goods}}),
    url:async()=>order.resourceUrl,
    select:async()=>({pageUrl:order.resourceUrl,selectedSku:order.skuId,selectedSkuLabel:order.sku,quantity:1}),
    prepareOrder:async()=>({pageUrl:order.confirmationPage,reliable:true,category:'physical_goods',merchant:order.merchant,goods:order.goods,sku:'红色1支+笔芯2支',quantity:1,subtotal:'4.80',shipping:'0.00',discount:'0.62',total:'4.18',addressLabel:order.addressLabel,resourceUrl:order.resourceUrl}),
    reviewPreparedOrder:async()=>({pageUrl:order.confirmationPage,reliable:true,category:'physical_goods',merchant:order.merchant,goods:order.goods,sku:'红色1支+笔芯2支',quantity:1,subtotal:'4.80',shipping:'0.00',discount:'0.62',total:'4.18',addressLabel:order.addressLabel,resourceUrl:order.resourceUrl}),
    submitApprovedOrder:async()=>{submits++;return {cashierUrl:cashier}}
  };
  const worker=createBrowserWorker({adapter,profileId:'shopping',browserContextId:'context-1'});
  await worker('product',{productId:'tb:671224654225'});
  await worker('select',{sessionId:'session-1',productId:'tb:671224654225',skuId:order.skuId,quantity:1,pageUrl:order.resourceUrl,expectedContextId:'context-1',expectedProfileId:'shopping'});
  const prepared=await worker('prepare_order',{sessionId:'session-1',expectedContextId:'context-1',expectedProfileId:'shopping'});
  const snapshot=(await import('../src/shopping/purchases.mjs')).makeOrderSnapshot(prepared.order);
  const fingerprint=(await import('../src/shopping/purchases.mjs')).orderFingerprint(snapshot);
  const payload={purchaseId:'purchase-1',executionId:'execution-1',sessionId:'session-1',expectedContextId:'context-1',expectedProfileId:'shopping',snapshot,fingerprint};
  await assert.rejects(worker('submit_approved_order',{...payload,fingerprint:'wrong'}),/approved_snapshot_mismatch/);
  assert.equal(submits,0);
  assert.equal((await worker('submit_approved_order',payload)).cashierUrl,cashier);
  await assert.rejects(worker('submit_approved_order',payload),/approved_session_mismatch/);
  assert.equal(submits,1);
});

test('authenticated PWA Approve schedules only its approved purchase once',async()=>{
  const {store,pending}=await approvedFixture({approve:false});
  let scheduled=0;
  const api=createShoppingApprovalApi({purchaseStore:store,verifyOwner:async req=>req.headers['x-test-owner']===ownerId?ownerId:null,onApproved:async purchaseId=>{assert.equal(purchaseId,pending.purchaseId);scheduled++}});
  const server=createDwellServer({shoppingApprovalApi:api});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  try {
    const url=`${origin}/api/shopping/approvals/${pending.purchaseId}/decision`;
    const body=JSON.stringify({sessionId:pending.sessionId,fingerprint:pending.fingerprint,nonce:pending.approvalNonce,decision:'approve'});
    const headers={'x-test-owner':ownerId,'content-type':'application/json',origin,'sec-fetch-site':'same-origin','x-shopping-user-action':'1'};
    assert.equal((await fetch(url,{method:'POST',headers:{...headers,'x-test-owner':'other@example.com'},body})).status,403);
    assert.equal(scheduled,0);
    assert.equal((await fetch(url,{method:'POST',headers,body})).status,200);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(scheduled,1);
    assert.equal((await fetch(url,{method:'POST',headers,body})).status,409);
    assert.equal(scheduled,1);
  } finally { server.close(); }
});
