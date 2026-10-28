import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyShoppingRequest, clickAndWaitForConfirmation } from '../src/shopping/confirmation-policy.mjs';
import { isConfirmationUrl } from '../src/shopping/browser-policy.mjs';

const sourceUrl = 'https://item.taobao.com/item.htm?id=741386452411';
const request = overrides => ({ url: 'https://buy.taobao.com/auction/order/confirm_order.htm', method: 'POST', isNavigation: true, resourceType: 'document', phase: 'preparing', sourceUrl, isMainFrame: true, ...overrides });

test('only identified in-site draft requests pass during prepare', () => {
  assert.equal(classifyShoppingRequest(request()), 'draft');
  assert.equal(classifyShoppingRequest(request({ url: 'https://buy.taobao.com/auction/buy_now.jhtml' })), 'draft');
  assert.equal(classifyShoppingRequest(request({ url: 'https://h5api.m.taobao.com/h5/mtop.trade.order.build.h5/4.0/', isNavigation: false, resourceType: 'fetch' })), 'draft');
  assert.equal(classifyShoppingRequest(request({ url: 'https://h5api.m.taobao.com/h5/mtop.trade.order.create/4.0/', isNavigation: false, resourceType: 'fetch' })), 'deny');
  assert.equal(classifyShoppingRequest(request({ url: 'https://buy.taobao.com/order/multiTerminalSubmitOrderAction' })), 'deny');
  assert.equal(classifyShoppingRequest(request({ url: 'https://buy.taobao.com/auction/confirm_order.htm' })), 'deny');
  assert.equal(classifyShoppingRequest(request({ url: 'https://cashier.alipay.com/payment' })), 'deny');
  assert.equal(classifyShoppingRequest(request({ url: 'https://buy.taobao.com/auction/order/confirm_order.htm', isMainFrame: false })), 'deny');
  assert.equal(classifyShoppingRequest(request({ phase: 'browsing' })), 'deny');
  assert.equal(classifyShoppingRequest(request({ sourceUrl: 'https://evil.example/' })), 'deny');
  assert.equal(isConfirmationUrl('https://buy.taobao.com/auction/order/confirm_order.htm'), true);
  assert.equal(isConfirmationUrl('https://buy.taobao.com/auction/buy_now.jhtml?itemId=741386452411'), true);
  assert.throws(() => isConfirmationUrl('http://buy.taobao.com/auction/buy_now.jhtml'), /shop_url_rejected/);
  assert.throws(() => isConfirmationUrl('https://buy.taobao.com.evil.example/auction/buy_now.jhtml'), /shop_url_rejected/);
  assert.equal(isConfirmationUrl('https://buy.taobao.com/auction/buy_now.jhtml/extra'), false);
  assert.equal(isConfirmationUrl('https://buy.taobao.com/auction/confirm_order.htm'), false);
});

test('manual login remains possible without opening shopping writes', () => {
  const login = request({ url: 'https://login.taobao.com/member/login.jhtml', sourceUrl: 'https://login.taobao.com/member/login.jhtml', phase: 'browsing' });
  assert.equal(classifyShoppingRequest(login), 'manual_auth');
  assert.equal(classifyShoppingRequest(request({ url: 'https://buy.taobao.com/order/submit', method: 'GET' })), 'deny');
  assert.equal(classifyShoppingRequest(request({ url: 'https://item.taobao.com/item.htm?id=741386452411', method: 'GET' })), 'allow');
});

test('browsing denies page-owned POST data and order submission', () => {
  const background = request({ url: 'https://h5api.m.taobao.com/h5/mtop.taobao.detail.getdetail/6.0/', phase: 'browsing', isNavigation: false, resourceType: 'fetch' });
  assert.equal(classifyShoppingRequest(background), 'deny');
  assert.equal(classifyShoppingRequest({ ...background, resourceType: 'xhr' }), 'deny');
  assert.equal(classifyShoppingRequest({ ...background, isNavigation: true, resourceType: 'document' }), 'deny');
  assert.equal(classifyShoppingRequest({ ...background, url: 'https://h5api.m.taobao.com/h5/mtop.trade.order.create/5.0/' }), 'deny');
});

test('prepare waits for the confirmation URL after the buy click', async () => {
  let finishNavigation, pending = true, clicked = false;
  const page = { waitForURL(predicate, options) {
    assert.equal(options.waitUntil, 'domcontentloaded');
    assert.equal(predicate(new URL('https://item.taobao.com/item.htm?id=123456')), false);
    assert.equal(predicate(new URL('https://buy.taobao.com/auction/order/confirm_order.htm')), true);
    return new Promise(resolve => { finishNavigation = resolve; });
  } };
  const result = clickAndWaitForConfirmation(page, async () => { clicked = true; });
  result.then(() => { pending = false; });
  await Promise.resolve();
  assert.equal(clicked, true);
  assert.equal(pending, true);
  finishNavigation();
  assert.equal(await result, true);
});
