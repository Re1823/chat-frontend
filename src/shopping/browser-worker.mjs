import { assertOrdinaryChoice, assertShopUrl, compactResults, isConfirmationUrl, isLoginUrl, normalizeObservedOrder, productIdFromUrl, productUrl } from './browser-policy.mjs';
import { makeOrderSnapshot, orderFingerprint } from './purchases.mjs';

const fail = code => { throw new Error(code); };
const safePage = url => { const parsed = assertShopUrl(url); if (isLoginUrl(url)) fail('login_required'); return parsed; };

// The adapter owns all Playwright actions. No caller-supplied selector, JS, or URL is accepted.
export function createBrowserWorker({ adapter, profileId, browserContextId, devInspectionEnabled = false }) {
  if (!adapter || !profileId || !browserContextId) throw new TypeError('browser_worker_config_required');
  const sessions = new Map();
  let currentProductId = null;
  return async (operation, payload = {}) => {
    if (operation === 'inspect_current_page') {
      if (!devInspectionEnabled || typeof payload.sessionId !== 'string' || Object.keys(payload).length !== 1) fail('operation_rejected');
      const bound = sessions.get(payload.sessionId);
      if (!bound || bound.browserContextId !== browserContextId || bound.profileId !== profileId) fail('session_mismatch');
      const inspection = await adapter.inspectCurrentPage();
      return { ...inspection, sessionId: payload.sessionId, browserContextId, profileId, sessionBound: true, sourceProductId: bound.productId };
    }
    if (operation === 'search') {
      const query = String(payload.query || '').trim();
      if (!query || query.length > 120) fail('invalid_query');
      const page = payload.page || 1;
      if (!Number.isInteger(page) || page < 1 || page > 5) fail('invalid_page');
      const observed = await adapter.search(query, Math.min(payload.limit || 10, 10), page);
      safePage(observed.pageUrl);
      currentProductId = null;
      return { page, products: compactResults(observed.items, payload.limit || 10) };
    }
    if (operation === 'product') {
      const url = productUrl(payload.productId);
      const observed = await adapter.product(url);
      safePage(observed.pageUrl);
      if (productIdFromUrl(observed.pageUrl) !== payload.productId) fail('page_changed');
      currentProductId = payload.productId;
      return { productId: currentProductId, pageUrl: observed.pageUrl, browserContextId, profileId, product: observed.product };
    }
    if (operation === 'select') {
      const { sessionId, productId, skuId, quantity, offerId, pageUrl, expectedContextId, expectedProfileId } = payload;
      if (!sessionId || currentProductId !== productId || expectedContextId !== browserContextId || expectedProfileId !== profileId || !Number.isInteger(quantity) || quantity < 1 || quantity > 20) fail('session_mismatch');
      if (productIdFromUrl(await adapter.url()) !== productId || productIdFromUrl(pageUrl) !== productId) fail('page_changed');
      assertOrdinaryChoice(skuId); if (offerId !== undefined) assertOrdinaryChoice(offerId);
      const observed = await adapter.select({ skuId, quantity, offerId });
      safePage(observed.pageUrl);
      if (productIdFromUrl(observed.pageUrl) !== productId || observed.selectedSku !== skuId || observed.quantity !== quantity) fail('selection_unverified');
      sessions.set(sessionId, { productId, skuId, skuLabel: observed.selectedSkuLabel || skuId, quantity, pageUrl, browserContextId, profileId });
      return { sessionId, productId, selectedSku: skuId, quantity, displayedPrice: String(observed.displayedPrice || '').slice(0, 40) };
    }
    if (operation === 'prepare_order') {
      const bound = sessions.get(payload.sessionId);
      if (!bound || payload.expectedContextId !== browserContextId || payload.expectedProfileId !== profileId) fail('session_mismatch');
      if (bound.prepared) return { sessionId: payload.sessionId, order: bound.prepared };
      const before = await adapter.url(); safePage(before);
      if (productIdFromUrl(before) !== bound.productId) fail('page_changed');
      let raw;
      try { raw = await adapter.prepareOrder(); }
      catch (cause) { if (['order_needs_manual_review', 'choice_unavailable'].includes(cause.message)) return { sessionId: payload.sessionId, status: 'manual_review_required', reason: cause.message }; throw cause; }
      safePage(raw.pageUrl);
      if (!isConfirmationUrl(raw.pageUrl)) return { sessionId: payload.sessionId, status: 'manual_review_required', reason: 'confirmation_not_verified' };
      let order;
      try { order = normalizeObservedOrder(raw, { productId: bound.productId, selectedSku: bound.skuLabel, skuId: bound.skuId, quantity: bound.quantity }); }
      catch (cause) { if (['order_needs_manual_review', 'amount_unreliable'].includes(cause.message)) return { sessionId: payload.sessionId, status: 'manual_review_required', reason: cause.message }; throw cause; }
      bound.prepared = order;
      return { sessionId: payload.sessionId, order };
    }
    if (operation === 'session_status') {
      const bound = sessions.get(payload.sessionId);
      if (!bound) fail('session_mismatch');
      safePage(await adapter.url());
      return { sessionId: payload.sessionId, prepared: Boolean(bound.prepared), browserContextId, profileId };
    }
    if (operation === 'submit_approved_order') {
      const bound = sessions.get(payload.sessionId);
      if (!bound || !bound.prepared || bound.submissionAttempted || payload.expectedContextId !== browserContextId || payload.expectedProfileId !== profileId || !payload.executionId || !payload.purchaseId) fail('approved_session_mismatch');
      const expected = makeOrderSnapshot(payload.snapshot);
      if (orderFingerprint(expected) !== payload.fingerprint || orderFingerprint(makeOrderSnapshot(bound.prepared)) !== payload.fingerprint) fail('approved_snapshot_mismatch');
      const raw = await adapter.reviewPreparedOrder();
      const observed = normalizeObservedOrder(raw, { productId: bound.productId, selectedSku: bound.skuLabel, skuId: bound.skuId, quantity: bound.quantity });
      if (orderFingerprint(makeOrderSnapshot(observed)) !== payload.fingerprint) fail('confirmation_changed');
      bound.submissionAttempted = true;
      const submitted = await adapter.submitApprovedOrder();
      bound.cashierUrl = submitted.cashierUrl;
      return { sessionId: payload.sessionId, executionId: payload.executionId, cashierUrl: submitted.cashierUrl };
    }
    if (operation === 'approved_order_status') {
      const bound = sessions.get(payload.sessionId);
      if (!bound || !bound.submissionAttempted || payload.expectedContextId !== browserContextId || payload.expectedProfileId !== profileId) fail('approved_session_mismatch');
      const observed = await adapter.approvedOrderStatus();
      return { sessionId: payload.sessionId, stage: observed.stage, ...(observed.stage === 'cashier' ? { cashierUrl: observed.cashierUrl } : {}) };
    }
    fail('operation_rejected');
  };
}
