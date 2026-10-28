import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { assertOfficialCashierUrl } from './alipay-policy.mjs';

export const PURCHASE_STATES = Object.freeze(['pending_approval', 'approved', 'executing', 'pending_alipay', 'reconciling', 'paid', 'completed', 'rejected', 'expired', 'failed']);
const transitions = Object.freeze({ pending_approval: ['approved', 'rejected', 'expired'], approved: ['executing', 'expired', 'failed'], executing: ['pending_alipay', 'reconciling', 'paid', 'failed'], pending_alipay: ['reconciling', 'failed'], reconciling: ['pending_alipay', 'paid', 'failed'], paid: ['completed'], completed: [], rejected: [], expired: [], failed: [] });
const fail = code => { throw new Error(code); };
const sha = value => createHash('sha256').update(value).digest('hex');
const nonempty = (value, max = 300) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const exactHost = (hostname, domain) => hostname === domain || hostname.endsWith(`.${domain}`);

export function makeOrderSnapshot(input) {
  if (!input || typeof input !== 'object') fail('invalid_order');
  const { platform, merchant, goods, sku, skuId, quantity, subtotalMinor, shippingMinor, discountMinor, totalMinor, addressLabel, resourceUrl, confirmationPage = null, merchantOrderId = null, category } = input;
  if (!['taobao', 'tmall'].includes(platform) || category !== 'physical_goods' || ![merchant, goods, sku, skuId, addressLabel].every(value => nonempty(value)) || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 20) fail('unsupported_order');
  if (![subtotalMinor, shippingMinor, discountMinor, totalMinor].every(value => Number.isSafeInteger(value) && value >= 0) || totalMinor <= 0 || subtotalMinor + shippingMinor - discountMinor !== totalMinor) fail('invalid_amount');
  if (merchantOrderId !== null && !nonempty(merchantOrderId, 128)) fail('invalid_order');
  let url;
  try { url = new URL(resourceUrl); } catch { fail('invalid_shop_url'); }
  if (url.protocol !== 'https:' || ![ 'taobao.com', 'tmall.com' ].some(domain => exactHost(url.hostname, domain)) || url.username || url.password) fail('invalid_shop_url');
  if (confirmationPage !== null && !['https://buy.taobao.com/auction/buy_now.jhtml', 'https://buy.taobao.com/auction/order/confirm_order.htm', 'https://buy.tmall.com/order/confirm_order.htm'].includes(confirmationPage)) fail('invalid_confirmation_page');
  const snapshot = { platform, merchant: merchant.trim(), goods: goods.trim(), sku: sku.trim(), skuId: skuId.trim(), quantity, subtotalMinor, shippingMinor, discountMinor, totalMinor, currency: 'CNY', addressLabel: addressLabel.trim(), resourceUrl: url.href, confirmationPage, merchantOrderId, category };
  return Object.freeze(snapshot);
}

export function orderFingerprint(snapshot) {
  return sha(JSON.stringify(snapshot)); // Fixed field order from makeOrderSnapshot.
}

export function createPurchaseStore({ path, now = Date.now, approvalTtlMs = 10 * 60_000, approvalSecret = '' } = {}) {
  if (!path) throw new TypeError('purchase_store_path_required');
  let records = {}, sessions = {}, writes = Promise.resolve();
  const save = async () => { await mkdir(dirname(path), { recursive: true, mode: 0o700 }); const temporary = `${path}.${randomUUID()}.tmp`; await writeFile(temporary, JSON.stringify({ records, sessions }), { mode: 0o600 }); await rename(temporary, path); };
  const mutate = operation => { const result = writes.then(async () => { const value = await operation(); await save(); return value; }); writes = result.catch(() => {}); return result; };
  const publicRecord = record => record && ({ purchaseId: record.purchaseId, sessionId: record.sessionId, conversationId: record.conversationId, fingerprint: record.fingerprint, snapshot: record.snapshot, state: record.state, paymentStage: record.execution?.publicStage || null, expiresAt: record.expiresAt, createdAt: record.createdAt });
  const approvalNonce = record => approvalSecret && record.nonceDerivation === 1
    ? createHmac('sha256', approvalSecret).update(JSON.stringify([record.purchaseId, record.ownerId, record.sessionId, record.fingerprint, record.expiresAt])).digest('base64url')
    : null;
  const owned = (record, ownerId) => { if (!record || !nonempty(ownerId, 128) || record.ownerId !== ownerId) fail('purchase_not_found'); return record; };
  const move = (record, next) => { if (!transitions[record.state]?.includes(next)) fail('invalid_purchase_transition'); record.state = next; record.updatedAt = now(); };
  return {
    async load() { try { const parsed = JSON.parse(await readFile(path, 'utf8')); if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object' || !parsed.records || !parsed.sessions) fail('invalid_purchase_store'); records = parsed.records; sessions = parsed.sessions; await this.expirePending(); } catch (error) { if (error.code !== 'ENOENT') throw error; } },
    async startSession({ ownerId, conversationId, workerId, browserContextId, profileId, pageUrl, ttlMs = 30 * 60_000 }) { return mutate(() => {
      if (![ownerId, conversationId, workerId, browserContextId, profileId].every(value => nonempty(value, 128)) || !Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 3_600_000) fail('invalid_session');
      let url; try { url = new URL(pageUrl); } catch { fail('invalid_shop_url'); }
      if (url.protocol !== 'https:' || !['taobao.com', 'tmall.com'].some(domain => exactHost(url.hostname, domain))) fail('invalid_shop_url');
      const sessionId = randomUUID();
      sessions[sessionId] = { sessionId, ownerId, conversationId, workerId, browserContextId, profileId, pageUrl: url.href, state: 'active', expiresAt: now() + ttlMs };
      return Object.freeze({ ...sessions[sessionId] });
    }); },
    async create({ ownerId, conversationId, sessionId, workerOrder }) { return mutate(() => {
      if (![ownerId, conversationId, sessionId].every(value => nonempty(value, 128))) fail('invalid_session');
      const session = sessions[sessionId];
      if (!session || session.ownerId !== ownerId || session.conversationId !== conversationId || session.state !== 'active' || session.expiresAt <= now()) fail('session_not_active');
      if (Object.values(records).some(record => record.sessionId === sessionId)) fail('session_already_bound');
      const snapshot = makeOrderSnapshot(workerOrder);
      const shopHost = new URL(session.pageUrl).hostname;
      if (!exactHost(new URL(snapshot.resourceUrl).hostname, snapshot.platform === 'taobao' ? 'taobao.com' : 'tmall.com') || !exactHost(shopHost, snapshot.platform === 'taobao' ? 'taobao.com' : 'tmall.com')) fail('session_order_mismatch');
      const record = { purchaseId: randomUUID(), ownerId, conversationId, sessionId, snapshot, fingerprint: orderFingerprint(snapshot), nonceHash: null, nonceDerivation: approvalSecret ? 1 : 0, state: 'pending_approval', createdAt: now(), updatedAt: now(), expiresAt: now() + approvalTtlMs };
      const nonce = approvalNonce(record) || randomBytes(32).toString('base64url');
      record.nonceHash = sha(nonce);
      records[record.purchaseId] = record;
      session.state = 'locked';
      return { ...publicRecord(record), approvalNonce: nonce };
    }); },
    list({ ownerId, conversationId }) { if (!nonempty(ownerId, 128) || !nonempty(conversationId, 128)) fail('invalid_owner'); return Object.values(records).filter(record => record.ownerId === ownerId && record.conversationId === conversationId && !['completed', 'rejected', 'expired', 'failed'].includes(record.state)).map(publicRecord); },
    listApprovals({ ownerId }) { if (!nonempty(ownerId, 128) || !approvalSecret) fail('approval_unavailable'); return Object.values(records).filter(record => record.ownerId === ownerId && orderFingerprint(record.snapshot) === record.fingerprint).map(record => ({ ...publicRecord(record), ...(record.state === 'pending_approval' && approvalNonce(record) ? { approvalNonce: approvalNonce(record) } : {}) })); },
    getSession({ ownerId, sessionId }) { const session = sessions[sessionId]; if (!session || session.ownerId !== ownerId) fail('session_not_found'); return Object.freeze({ ...session }); },
    getBySession({ ownerId, sessionId }) { const record = Object.values(records).find(item => item.sessionId === sessionId && item.ownerId === ownerId); return publicRecord(record) || null; },
    get({ ownerId, purchaseId }) { return publicRecord(owned(records[purchaseId], ownerId)); },
    async decide({ ownerId, purchaseId, sessionId, fingerprint, nonce, decision }) { return mutate(() => {
      const record = owned(records[purchaseId], ownerId);
      if (record.state !== 'pending_approval') fail('approval_not_pending');
      if (now() >= record.expiresAt) fail('approval_expired');
      if (record.sessionId !== sessionId || record.fingerprint !== fingerprint || orderFingerprint(record.snapshot) !== record.fingerprint || !['approve', 'reject'].includes(decision) || !nonempty(nonce, 128)) fail('approval_mismatch');
      const expected = Buffer.from(record.nonceHash, 'hex');
      const actual = Buffer.from(sha(nonce), 'hex');
      if (!timingSafeEqual(expected, actual)) fail('approval_mismatch');
      move(record, decision === 'approve' ? 'approved' : 'rejected');
      record.nonceHash = null;
      // The marker is committed with the approval. Records approved by older
      // deployments have no marker and are never picked up by recovery.
      if (decision === 'approve') record.continuation = { version: 1, id: randomUUID(), state: 'queued', createdAt: now() };
      return publicRecord(record);
    }); },
    async transition({ purchaseId, expectedState, nextState }) { return mutate(() => {
      const record = records[purchaseId]; if (!record || record.state !== expectedState) fail('purchase_state_changed');
      move(record, nextState); return publicRecord(record);
    }); },
    approvedForExecution() { return Object.values(records).filter(record => record.state === 'approved' && orderFingerprint(record.snapshot) === record.fingerprint).map(publicRecord); },
    continuation({ purchaseId }) {
      const record = records[purchaseId], session = record && sessions[record.sessionId];
      if (!record?.continuation || record.continuation.version !== 1) return null;
      return structuredClone({ purchaseId, state: record.state, continuation: record.continuation, sessionState: session?.state || null, sessionExpiresAt: session?.expiresAt || null, fingerprintValid: orderFingerprint(record.snapshot) === record.fingerprint });
    },
    recoverableContinuations() { return Object.values(records).filter(record => record.state === 'approved' && record.continuation?.version === 1 && ['queued', 'blocked_by_order_submit_gate', 'claimed'].includes(record.continuation.state)).map(record => record.purchaseId); },
    async setContinuationState({ purchaseId, nextState }) { return mutate(() => {
      const record = records[purchaseId], session = record && sessions[record.sessionId];
      if (!record || record.state !== 'approved' || !record.continuation || record.continuation.version !== 1 || !session || session.state !== 'locked' || session.expiresAt <= now() || orderFingerprint(record.snapshot) !== record.fingerprint) fail('continuation_binding_mismatch');
      const previous = record.continuation.state;
      if (nextState === 'blocked_by_order_submit_gate' && !['queued', 'blocked_by_order_submit_gate', 'claimed'].includes(previous)) fail('continuation_state_changed');
      if (nextState === 'claimed' && !['queued', 'blocked_by_order_submit_gate', 'claimed'].includes(previous)) fail('continuation_state_changed');
      if (!['claimed', 'blocked_by_order_submit_gate'].includes(nextState)) fail('continuation_state_changed');
      record.continuation.state = nextState;
      record.continuation.updatedAt = now();
      return structuredClone(record.continuation);
    }); },
    execution({ purchaseId }) { const record = records[purchaseId]; if (!record) fail('purchase_not_found'); return structuredClone({ ...record, session: sessions[record.sessionId] || null }); },
    paymentBinding({ purchaseId }) {
      const r = records[purchaseId], session = r && sessions[r.sessionId];
      if (!r || !session || session.state !== 'locked' || session.expiresAt <= now() || !['executing','pending_alipay','reconciling'].includes(r.state) || !r.execution?.id || orderFingerprint(r.snapshot) !== r.fingerprint || !approvalNonce(r)) fail('payment_binding_rejected');
      return structuredClone({ purchaseId, sessionId:r.sessionId, executionId:r.execution.id, approvalNonce:approvalNonce(r), fingerprint:r.fingerprint, snapshot:r.snapshot, expectedContextId:session.browserContextId, expectedProfileId:session.profileId, state:r.state });
    },
    explicitExecutionBinding({purchaseId}) {
      const r=records[purchaseId],session=r&&sessions[r.sessionId];
      if(!r||r.state!=='approved'||r.execution||!session||session.state!=='locked'||session.expiresAt<=now()||orderFingerprint(r.snapshot)!==r.fingerprint)fail('execution_binding_mismatch');
      const nonce=approvalNonce(r);if(!nonce)fail('execution_binding_mismatch');
      return {purchaseId:r.purchaseId,approvalId:r.purchaseId,sessionId:r.sessionId,fingerprint:r.fingerprint,approvalNonce:nonce,ownerId:r.ownerId};
    },
    async claimExecution({ purchaseId }) { return mutate(() => {
      const record = records[purchaseId];
      if (!record) fail('purchase_not_found');
      if (record.state !== 'approved') return { claimed: false, purchase: publicRecord(record) };
      const session = sessions[record.sessionId];
      if (!session || session.state !== 'locked' || session.expiresAt <= now() || orderFingerprint(record.snapshot) !== record.fingerprint || !record.snapshot.confirmationPage) fail('execution_binding_mismatch');
      record.execution = { id: randomUUID(), stage: 'submit_intent_persisted', publicStage: 'submitting_order', cashierUrl: null, queryCredential: null, updatedAt: now() };
      move(record, 'executing');
      return { claimed: true, purchase: publicRecord(record), executionId: record.execution.id };
    }); },
    async recordCashier({ purchaseId, executionId, cashierUrl }) { return mutate(() => {
      const record = records[purchaseId];
      if (!record || record.state !== 'executing' || record.execution?.id !== executionId || record.execution.stage !== 'submit_intent_persisted') fail('execution_state_changed');
      record.execution.cashierUrl = assertOfficialCashierUrl(cashierUrl);
      record.execution.stage = 'cashier_ready';
      record.execution.publicStage = 'awaiting_payment';
      record.execution.updatedAt = now();
      move(record, 'pending_alipay');
      return publicRecord(record);
    }); },
    async claimPaymentSubmission({ purchaseId, executionId }) { return mutate(() => {
      const record = records[purchaseId];
      if (!record || record.execution?.id !== executionId || record.state !== 'pending_alipay') fail('execution_state_changed');
      if (record.execution.stage !== 'cashier_ready') return { claimed: false, purchase: publicRecord(record) };
      record.execution.stage = 'bot_submit_intent_persisted';
      record.execution.updatedAt = now();
      return { claimed: true, cashierUrl: record.execution.cashierUrl, purchase: publicRecord(record) };
    }); },
    async beginReconcile({ purchaseId, executionId }) { return mutate(() => {
      const record = records[purchaseId];
      if (!record || record.execution?.id !== executionId || record.state !== 'pending_alipay' || !record.execution.queryCredential) fail('payment_query_unavailable');
      move(record, 'reconciling');
      return structuredClone(record.execution.queryCredential);
    }); },
    async executionAttention({ purchaseId, executionId, stage }) { return mutate(() => {
      const record = records[purchaseId];
      if (!record || record.execution?.id !== executionId || !['executing', 'pending_alipay', 'reconciling'].includes(record.state) || !['order_submit_uncertain', 'payment_result_uncertain'].includes(stage)) fail('execution_state_changed');
      record.execution.publicStage = stage;
      record.execution.updatedAt = now();
      return publicRecord(record);
    }); },
    async recordPaymentResult({ purchaseId, executionId, result, queryCredential = null }) { return mutate(() => {
      const record = records[purchaseId];
      if (!record || record.execution?.id !== executionId || !['pending_alipay', 'reconciling'].includes(record.state)) fail('execution_state_changed');
      if (!['pending', 'processing', 'paid', 'failed'].includes(result)) fail('invalid_payment_result');
      if (queryCredential !== null) {
        if (!queryCredential || !['outShakeNo', 'shortUrl'].includes(queryCredential.kind) || !nonempty(queryCredential.value, 8192)) fail('invalid_payment_credential');
        record.execution.queryCredential = queryCredential;
      }
      record.execution.stage = result === 'paid' ? 'provider_paid' : result === 'failed' ? 'provider_failed' : 'provider_pending';
      record.execution.publicStage = result === 'paid' ? 'paid' : result === 'failed' ? 'payment_failed' : 'awaiting_payment';
      record.execution.updatedAt = now();
      if (result === 'paid') { if (record.state === 'pending_alipay') move(record, 'reconciling'); move(record, 'paid'); move(record, 'completed'); }
      else if (result === 'failed') move(record, 'failed');
      else if (record.state === 'reconciling') move(record, 'pending_alipay');
      return publicRecord(record);
    }); },
    async expirePending() { return mutate(() => {
      let count = 0;
      for (const record of Object.values(records)) if (record.state === 'pending_approval' && now() >= record.expiresAt) { move(record, 'expired'); count++; }
      return count;
    }); }
  };
}
