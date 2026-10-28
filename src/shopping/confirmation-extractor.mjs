import { moneyMinor } from './browser-policy.mjs';

const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
const amount = value => moneyMinor(clean(value).replace(/\s*([.])\s*/g, '$1'));
const fail = () => { throw new Error('order_needs_manual_review'); };

// Runs only inside the worker's controlled confirmation Page. It returns a
// small projection and masks the address before anything leaves the browser.
export function collectTaobaoConfirmationDom() {
  const visible = node => Boolean(node?.getClientRects().length);
  const text = node => (node?.innerText || '').replace(/\s+/g, ' ').trim();
  const one = selector => {
    const nodes = [...document.querySelectorAll(selector)].filter(visible);
    return nodes.length === 1 ? nodes[0] : null;
  };
  const item = one('a[class*="itemTitle--"][href*="item.taobao.com/item.htm"]');
  let itemId = '';
  try { itemId = new URL(item?.href).searchParams.get('id') || ''; } catch { /* Missing item. */ }
  const attrs = (document.body?.innerText || '').split(/\n+/).map(line => line.trim()).filter(line => /^颜色分类\s*[:：]/.test(line));
  const discountGroups = [...document.querySelectorAll('[class*="PromotionTitle--"]')].filter(visible).slice(0, 16).map(node => text(node)).filter(value => /^(?:店铺优惠|平台优惠)/.test(value));
  const totalRows = [...document.querySelectorAll('[class*="trade-price-container"]')].filter(visible).filter(node => text(node.querySelector('[class*="trade-price-label"]')) === '合计');
  const total = totalRows.length === 1 ? totalRows[0] : null;
  const addressCards = [...document.querySelectorAll('[class*="addressContent--"]')].filter(visible);
  const selectedAddresses = addressCards.filter(node => /(?:^|\s)listItemSelect--/.test(String(node.parentElement?.className || '')));
  const address = selectedAddresses.length === 1 ? selectedAddresses[0] : null;
  const addressText = address?.innerText || '';
  const regions = [...new Set(addressText.match(/[\u4e00-\u9fff]{2,8}(?:省|市|自治区)/g) || [])].slice(0, 2);
  const phone = addressText.match(/1[3-9]\d{9}/);
  return {
    title: document.title,
    itemId,
    goods: text(item).slice(0, 160),
    merchant: text(one('[class*="shopInfo--"]')).slice(0, 80),
    skuTexts: attrs.slice(0, 4).map(line => line.replace(/^颜色分类\s*[:：]\s*/, '').trim().slice(0, 100)),
    quantityText: text(one('[class*="goodNum--"]')).slice(0, 50),
    subtotalText: text(one('[class*="priceLine_total--"] [class*="priceRight--"]')).slice(0, 50),
    shippingText: text(one('[class*="trade-container-orderExtRight"]')).slice(0, 180),
    discountGroups,
    totalParts: total ? {
      label: text(total.querySelector('[class*="trade-price-label"]')),
      symbol: text(total.querySelector('[class*="trade-price-symbol"]')),
      integer: text(total.querySelector('[class*="trade-price-integer"]')),
      point: text(total.querySelector('[class*="trade-price-point"]')),
      decimal: text(total.querySelector('[class*="trade-price-decimal"]'))
    } : null,
    addressCount: selectedAddresses.length,
    maskedAddress: address && regions.length && phone ? `${regions.join(' ')} · ****${phone[0].slice(-4)}` : '',
    cnyOptionPresent: [...document.querySelectorAll('[class*="optionTitle--"]')].some(node => visible(node) && text(node) === '人民币')
  };
}

export function normalizeTaobaoConfirmationDom(observed) {
  if (!observed || !/确认订单/.test(observed.title || '') || !/^[1-9]\d{4,19}$/.test(observed.itemId || '') || !observed.goods || !observed.merchant || !observed.maskedAddress || observed.addressCount !== 1 || !observed.cnyOptionPresent) fail();
  if (!Array.isArray(observed.skuTexts) || observed.skuTexts.length !== 1 || !observed.skuTexts[0]) fail();
  const quantityMatch = /^共\s*(\d{1,2})\s*件商品$/.exec(clean(observed.quantityText));
  if (!quantityMatch) fail();
  const quantity = Number(quantityMatch[1]);
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 20) fail();
  let subtotalMinor, shippingMinor, totalMinor;
  try {
    subtotalMinor = amount(observed.subtotalText);
    const shippingAmounts = clean(observed.shippingText).match(/[￥¥]\s*\d{1,8}(?:\.\d{1,2})?/g) || [];
    if (shippingAmounts.length !== 1 || !/配送服务/.test(observed.shippingText)) fail();
    shippingMinor = amount(shippingAmounts[0]);
    const parts = observed.totalParts;
    if (parts?.label !== '合计' || !/^[￥¥]$/.test(parts.symbol) || !/^\d{1,8}$/.test(parts.integer) || parts.point !== '.' || !/^\d{2}$/.test(parts.decimal)) fail();
    totalMinor = amount(`${parts.symbol}${parts.integer}.${parts.decimal}`);
  } catch { fail(); }
  const discounts = new Map();
  for (const entry of observed.discountGroups || []) {
    const normalized = clean(entry).replace(/\s+/g, '');
    const label = /^(店铺优惠|平台优惠)/.exec(normalized)?.[1];
    const values = normalized.match(/[￥¥]\s*\d{1,8}(?:\.\d{1,2})?/g) || [];
    if (!label || values.length !== 1) fail();
    const minor = amount(values[0]);
    if (discounts.has(label) && discounts.get(label) !== minor) fail();
    discounts.set(label, minor);
  }
  const discountMinor = [...discounts.values()].reduce((sum, value) => sum + value, 0);
  if (totalMinor <= 0 || subtotalMinor + shippingMinor - discountMinor !== totalMinor) fail();
  return {
    merchant: clean(observed.merchant), goods: clean(observed.goods), sku: clean(observed.skuTexts[0]), quantity,
    subtotal: (subtotalMinor / 100).toFixed(2), shipping: (shippingMinor / 100).toFixed(2), discount: (discountMinor / 100).toFixed(2), total: (totalMinor / 100).toFixed(2),
    addressLabel: observed.maskedAddress, category: 'physical_goods', currency: 'CNY', resourceUrl: `https://item.taobao.com/item.htm?id=${observed.itemId}`, reliable: true
  };
}
