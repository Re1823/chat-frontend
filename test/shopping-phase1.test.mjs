import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shoppingMcpTools, WORKER_OPERATIONS, assertPaymentExecutor } from '../src/shopping/contracts.mjs';
import { createWorkerVerifier, signWorkerMessage } from '../src/shopping/worker-auth.mjs';
import { createPurchaseStore, makeOrderSnapshot, orderFingerprint } from '../src/shopping/purchases.mjs';

const order = { platform: 'taobao', merchant: '店铺', goods: '实物商品', sku: '蓝色', skuId: '1001', quantity: 2, subtotalMinor: 1000, shippingMinor: 100, discountMinor: 50, totalMinor: 1050, addressLabel: '家 · 上海', resourceUrl: 'https://item.taobao.com/item.htm?id=1', confirmationPage: 'https://buy.taobao.com/auction/buy_now.jhtml', category: 'physical_goods' };

test('Shopping MCP exposes only narrow non-payment tools', () => {
  assert.deepEqual(shoppingMcpTools.map(tool => tool.name), ['shopping_search', 'shopping_product', 'shopping_select', 'shopping_prepare_purchase', 'shopping_purchase_status']);
  assert.equal(shoppingMcpTools.every(tool => tool.inputSchema.additionalProperties === false), true);
  assert.equal(WORKER_OPERATIONS.includes('submit_payment'), false);
  assert.throws(() => assertPaymentExecutor({ execute() {} }), /payment_executor_required/);
});

test('worker messages authenticate exact payload, age, and single use', () => {
  let clock = 100_000;
  const secret = 'a'.repeat(32), workerId = 'windows-1';
  const verify = createWorkerVerifier({ secret, workerId, expectedRole: 'vps', now: () => clock, seen: new Map() });
  const signed = signWorkerMessage({ secret, role: 'vps', workerId, operation: 'search', payload: { query: '台灯' }, now: clock });
  assert.equal(verify(signed).payload.query, '台灯');
  assert.throws(() => verify(signed), /replayed/);
  assert.throws(() => verify({ ...signed, nonce: '0'.repeat(36) }), /rejected/);
  clock += 60_001;
  assert.throws(() => verify(signWorkerMessage({ secret, role: 'vps', workerId, operation: 'product', payload: {}, now: 100_000 })), /rejected/);
  const reply = signWorkerMessage({ secret, role: 'worker', workerId, operation: 'result', responseTo: signed.requestId, payload: { ok: true }, now: clock });
  assert.equal(createWorkerVerifier({ secret, workerId, expectedRole: 'worker', now: () => clock, seen: new Map() })(reply).responseTo, signed.requestId);
  assert.throws(() => verify(reply), /rejected/);
});

test('snapshot rejects non-physical goods, price mismatch, and lookalike hosts', () => {
  const snapshot = makeOrderSnapshot(order);
  assert.equal(orderFingerprint(snapshot).length, 64);
  assert.throws(() => makeOrderSnapshot({ ...order, category: 'gift_card' }), /unsupported_order/);
  assert.throws(() => makeOrderSnapshot({ ...order, totalMinor: 1 }), /invalid_amount/);
  assert.throws(() => makeOrderSnapshot({ ...order, resourceUrl: 'https://taobao.com.evil.example/' }), /invalid_shop_url/);
});

test('approval binds owner, session, fingerprint, nonce, expiry and survives reload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shopping-phase1-'));
  let clock = 1000;
  const path = join(dir, 'purchases.json');
  const store = createPurchaseStore({ path, now: () => clock, approvalTtlMs: 5000 });
  await store.load();
  const session = await store.startSession({ ownerId: 'owner', conversationId: 'chat', workerId: 'windows-1', browserContextId: 'edge-1', profileId: 'shopping', pageUrl: order.resourceUrl });
  const created = await store.create({ ownerId: 'owner', conversationId: 'chat', sessionId: session.sessionId, workerOrder: order });
  assert.equal(created.snapshot.skuId, order.skuId);
  assert.equal(created.snapshot.confirmationPage, order.confirmationPage);
  assert.equal(created.fingerprint, orderFingerprint(created.snapshot));
  const recovered = createPurchaseStore({ path, now: () => clock, approvalTtlMs: 5000 });
  await recovered.load();
  assert.equal(recovered.get({ ownerId: 'owner', purchaseId: created.purchaseId }).snapshot.skuId, order.skuId);
  assert.equal(recovered.get({ ownerId: 'owner', purchaseId: created.purchaseId }).snapshot.confirmationPage, order.confirmationPage);
  assert.equal(recovered.list({ ownerId: 'owner', conversationId: 'chat' })[0].purchaseId, created.purchaseId);
  assert.equal(recovered.list({ ownerId: 'other', conversationId: 'chat' }).length, 0);
  const args = { ownerId: 'owner', purchaseId: created.purchaseId, sessionId: session.sessionId, fingerprint: created.fingerprint, nonce: created.approvalNonce, decision: 'approve' };
  await assert.rejects(recovered.decide({ ...args, ownerId: 'other' }), /purchase_not_found/);
  await assert.rejects(recovered.decide({ ...args, fingerprint: 'wrong' }), /approval_mismatch/);
  assert.equal((await recovered.decide(args)).state, 'approved');
  await assert.rejects(recovered.decide(args), /approval_not_pending/);
  assert.equal((await recovered.transition({ purchaseId: created.purchaseId, expectedState: 'approved', nextState: 'executing' })).state, 'executing');
  await assert.rejects(recovered.transition({ purchaseId: created.purchaseId, expectedState: 'executing', nextState: 'approved' }), /invalid_purchase_transition/);
  const secondSession = await recovered.startSession({ ownerId: 'owner', conversationId: 'chat', workerId: 'windows-1', browserContextId: 'edge-1', profileId: 'shopping', pageUrl: order.resourceUrl });
  const late = await recovered.create({ ownerId: 'owner', conversationId: 'chat', sessionId: secondSession.sessionId, workerOrder: order });
  clock += 5000;
  await assert.rejects(recovered.decide({ ...args, purchaseId: late.purchaseId, sessionId: secondSession.sessionId, nonce: late.approvalNonce }), /approval_expired/);
  assert.equal(await recovered.expirePending(), 1);
  assert.equal(recovered.get({ ownerId: 'owner', purchaseId: late.purchaseId }).state, 'expired');
});
