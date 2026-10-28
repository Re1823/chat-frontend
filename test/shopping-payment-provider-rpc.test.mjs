import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWindowsPaymentProvider, sealPaymentRequest, validatePaymentRequest } from '../src/shopping/payment-provider-rpc.mjs';
import { makeOrderSnapshot, orderFingerprint } from '../src/shopping/purchases.mjs';
import { signWorkerMessage, createWorkerVerifier } from '../src/shopping/worker-auth.mjs';
import { createShoppingPaymentExecutor } from '../src/shopping/payment-executor.mjs';

const secret='fixture-only-payment-secret-32-characters';
const snapshot=makeOrderSnapshot({platform:'taobao',merchant:'fixture',goods:'pen',sku:'red',skuId:'sku-1',quantity:1,subtotalMinor:1,shippingMinor:0,discountMinor:0,totalMinor:1,addressLabel:'fixture',resourceUrl:'https://item.taobao.com/item.htm?id=123456789',confirmationPage:'https://buy.taobao.com/auction/buy_now.jhtml',category:'physical_goods'});
const base={purchaseId:'11111111-1111-4111-8111-111111111111',sessionId:'22222222-2222-4222-8222-222222222222',executionId:'33333333-3333-4333-8333-333333333333',approvalNonce:'fixture-only-approval-nonce-32-characters',fingerprint:orderFingerprint(snapshot),snapshot,expectedContextId:'fixture-context',expectedProfileId:'fixture-profile',state:'pending_alipay',paymentLink:'https://cashier.alipay.com/fixture',intentSummary:'服务内容：pen red ×1，支付金额：¥0.01，支付对象：fixture'};

test('payment RPC transport rejects unauthorized, expired, and replayed messages',()=>{
  const verify=createWorkerVerifier({secret,workerId:'fixture-worker',expectedRole:'vps',now:()=>1000,seen:new Map()});
  const message=signWorkerMessage({secret,role:'vps',workerId:'fixture-worker',operation:'payment_execute',payload:{},now:1000});
  assert.throws(()=>verify({...message,signature:'0'.repeat(64)}),/worker_message_rejected/);
  assert.throws(()=>verify(signWorkerMessage({secret,role:'vps',workerId:'fixture-worker',operation:'payment_execute',payload:{},now:-100000})),/worker_message_rejected/);
  verify(message);assert.throws(()=>verify(message),/worker_message_replayed/);
});

test('narrow material contract rejects arbitrary arguments, forged proof, stale receipt, and fingerprint drift',()=>{
  const p=sealPaymentRequest(secret,base,1000);
  validatePaymentRequest(secret,p,'payment_execute',1000);
  for(const extra of [{args:['--help']},{command:'cmd.exe'},{executable:'other.exe'},{shell:true}]) assert.throws(()=>validatePaymentRequest(secret,{...p,...extra},'payment_execute',1000),/payment_binding_rejected/);
  assert.throws(()=>validatePaymentRequest(secret,{...p,proof:'0'.repeat(64)},'payment_execute',1000),/payment_proof_rejected/);
  assert.throws(()=>validatePaymentRequest(secret,p,'payment_execute',31000),/payment_request_expired/);
  assert.throws(()=>validatePaymentRequest(secret,sealPaymentRequest(secret,{...base,fingerprint:'0'.repeat(64)},1000),'payment_execute',1000),/payment_binding_rejected/);
});

test('Windows provider fixes executable, persists idempotency, binds browser purchase, bounds and redacts result',async()=>{
  const ledgerPath=join(await mkdtemp(join(tmpdir(),'payment-rpc-')),'ledger.json');
  let calls=0;
  const options={secret,ledgerPath,allowRealPayment:true,validateBrowserBinding:async p=>{if(p.purchaseId!==base.purchaseId||p.expectedContextId!==base.expectedContextId)throw Error('payment_browser_binding_rejected');},run:async args=>{calls++;assert.equal(args[0],'submit-payment');return '✓ 支付待确认 https://u.alipay.com/fixture\nprivate diagnostic omitted';}};
  const provider=createWindowsPaymentProvider(options),p=sealPaymentRequest(secret,base);
  const result=await provider.handle('payment_execute',p);
  assert.deepEqual(result,{status:'pending',queryCredential:{kind:'shortUrl',value:'https://u.alipay.com/fixture'}});
  assert.deepEqual(await provider.handle('payment_execute',sealPaymentRequest(secret,base)),result);assert.equal(calls,1);
  const restarted=createWindowsPaymentProvider(options);assert.deepEqual(await restarted.handle('payment_execute',sealPaymentRequest(secret,base)),result);assert.equal(calls,1);
  assert.equal((await readFile(ledgerPath,'utf8')).includes(base.paymentLink),false);
  await assert.rejects(provider.handle('payment_execute',sealPaymentRequest(secret,{...base,purchaseId:'44444444-4444-4444-8444-444444444444'})),/payment_browser_binding_rejected/);
  const bad=createWindowsPaymentProvider({...options,ledgerPath:ledgerPath+'-bad',run:async()=> 'x'.repeat(65537)});
  await assert.rejects(bad.handle('payment_execute',p),/payment_output_unrecognized/);
  await assert.rejects(bad.handle('payment_execute',p),/payment_execution_uncertain/);
});

test('production verification gates stop both order and payment execution',async()=>{
  const provider=createWindowsPaymentProvider({secret,ledgerPath:'unused',validateBrowserBinding:async()=>assert.fail('browser invoked'),allowRealPayment:false});
  await assert.rejects(provider.handle('payment_execute',sealPaymentRequest(secret,base)),/real_payment_disabled/);
  const executor=createShoppingPaymentExecutor({purchaseStore:{execution:()=>({state:'approved'})},gateway:{call:()=>assert.fail('gateway invoked')},allowOrderSubmission:false});
  await assert.rejects(executor.execute(base.purchaseId),/order_submission_disabled/);
});
