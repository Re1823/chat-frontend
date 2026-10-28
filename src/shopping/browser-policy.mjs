const SHOP_DOMAINS = ['taobao.com', 'tmall.com'];
const PRODUCT_ID = /^(tb|tm):([1-9][0-9]{4,19})$/;
const MONEY = /^(?:¥|￥)?\s*([0-9]{1,8})(?:\.([0-9]{1,2}))?$/;
const forbiddenAction = /(?:提交订单|确认订单|立即支付|确认付款|去支付|转账|充值|红包|提现|礼品卡|储值)/;

export const shopHost = host => SHOP_DOMAINS.some(domain => host === domain || host.endsWith(`.${domain}`));
export function assertShopUrl(value) {
  let url; try { url = new URL(value); } catch { throw new Error('shop_url_rejected'); }
  if (url.protocol !== 'https:' || !shopHost(url.hostname) || url.username || url.password || /(?:cashier|payment|pay(?:ment)?\.htm)/i.test(url.pathname)) throw new Error('shop_url_rejected');
  return url;
}
export function isLoginUrl(value) { const url = assertShopUrl(value); return /(?:login|passport)/i.test(url.hostname + url.pathname); }
export function isConfirmationUrl(value) {
  const url = assertShopUrl(value);
  return (url.hostname === 'buy.taobao.com' && ['/auction/order/confirm_order.htm', '/auction/buy_now.jhtml'].includes(url.pathname)) || (url.hostname === 'buy.tmall.com' && url.pathname === '/order/confirm_order.htm');
}
export function productUrl(productId) {
  const match = PRODUCT_ID.exec(productId || ''); if (!match) throw new Error('invalid_product_id');
  return match[1] === 'tb' ? `https://item.taobao.com/item.htm?id=${match[2]}` : `https://detail.tmall.com/item.htm?id=${match[2]}`;
}
export function productIdFromUrl(value) {
  const url = assertShopUrl(value);
  if (!['item.taobao.com', 'detail.tmall.com'].includes(url.hostname) || url.pathname !== '/item.htm' || !/^[1-9][0-9]{4,19}$/.test(url.searchParams.get('id') || '')) throw new Error('invalid_product_url');
  return `${url.hostname === 'item.taobao.com' ? 'tb' : 'tm'}:${url.searchParams.get('id')}`;
}
export function moneyMinor(value) {
  const match = MONEY.exec(String(value || '').trim());
  if (!match) throw new Error('amount_unreliable');
  const amount = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
  if (!Number.isSafeInteger(amount)) throw new Error('amount_unreliable');
  return amount;
}
export function assertOrdinaryChoice(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 128 || forbiddenAction.test(value)) throw new Error('choice_rejected');
  return value;
}
export function compactResults(items, limit = 10) {
  if (!Array.isArray(items)) throw new Error('invalid_search_results');
  return items.slice(0, Math.min(limit, 10)).flatMap(item => {
    try {
      const productId = productIdFromUrl(item.url);
      const title = String(item.title || '').trim().slice(0, 160);
      if (!title) return [];
      return [{ productId, title, platform: productId.startsWith('tb:') ? 'taobao' : 'tmall', displayedPrice: String(item.displayedPrice || '').slice(0, 40), merchant: String(item.merchant || '').slice(0, 80) }];
    } catch { return []; }
  });
}
export function normalizeObservedOrder(raw, { productId, selectedSku, skuId, quantity, existingUnpaidOrder = null }) {
  let observedProductId;
  try { observedProductId = productIdFromUrl(raw?.resourceUrl); } catch { throw new Error('order_needs_manual_review'); }
  const observedSku = String(raw?.sku || '').replace(/\s+/g, ' ').trim();
  const selectedTerms = String(selectedSku || '').replace(/\s+/g, ' ').trim();
  const selectedFirstDimension = selectedTerms.split(' / ')[0];
  const validPage = raw && (existingUnpaidOrder ? !isConfirmationUrl(raw.pageUrl) && raw.merchantOrderId === existingUnpaidOrder && raw.orderStatus === '等待买家付款' : isConfirmationUrl(raw.pageUrl));
  const fullTerms = raw?.skuTermsComplete === true;
  if (!raw || raw.reliable !== true || raw.category !== 'physical_goods' || !validPage || observedProductId !== productId || (!skuId && !fullTerms) || (skuId && /^(?:ui:|properties:)/.test(skuId)) || !selectedTerms || observedSku !== (fullTerms ? selectedTerms : selectedFirstDimension) || raw.quantity !== quantity || (raw.currency && raw.currency !== 'CNY') || !raw.addressLabel || !raw.merchant || raw.merchant === 'unknown' || !raw.goods || /(?:礼品卡|储值|充值|点卡|卡密|红包|虚拟商品)/.test(raw.goods)) throw new Error('order_needs_manual_review');
  const values = ['subtotal', 'shipping', 'discount', 'total'].map(key => moneyMinor(raw[key]));
  const [subtotalMinor, shippingMinor, discountMinor, totalMinor] = values;
  if (totalMinor <= 0 || subtotalMinor + shippingMinor - discountMinor !== totalMinor) throw new Error('order_needs_manual_review');
  const addressLabel = String(raw.addressLabel).trim().replace(/(1[3-9][0-9])([0-9]{4})([0-9]{4})/g, '$1****$3').slice(0, 80);
  const confirmationUrl = new URL(raw.pageUrl);
  return { platform: productId.startsWith('tb:') ? 'taobao' : 'tmall', merchant: String(raw.merchant).trim(), goods: String(raw.goods).trim(), sku: fullTerms ? observedSku : selectedSku, ...(skuId ? {skuId} : {}), quantity, subtotalMinor, shippingMinor, discountMinor, totalMinor, addressLabel, resourceUrl: productUrl(productId), confirmationPage: existingUnpaidOrder ? null : `${confirmationUrl.origin}${confirmationUrl.pathname}`, category: 'physical_goods' };
}
