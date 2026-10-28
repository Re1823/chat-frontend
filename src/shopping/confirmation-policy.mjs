import { assertShopUrl, isConfirmationUrl, isLoginUrl, productIdFromUrl } from './browser-policy.mjs';
import { assertOfficialCashierUrl } from './alipay-policy.mjs';

const BUILD_PATH = /^\/h5\/mtop\.trade\.order\.build(?:\.h5)?\/\d+(?:\.\d+)?\/$/i;
const DRAFT_DOCUMENTS = new Set(['/auction/buy_now.jhtml', '/auction/order/confirm_order.htm']);
const SUBMISSION_PATH = /(?:submit|createorder|order\.create|cashier|payment|pay\.htm|alipay)/i;
const CREATE_PATH = /^\/h5\/mtop\.trade\.order\.create(?:\.h5)?\/\d+(?:\.\d+)?\/$/i;
const productSource = url => { try { return Boolean(productIdFromUrl(url)); } catch { return false; } };
const manualAuth = (sourceUrl, target) => {
  try {
    const source = new URL(sourceUrl);
    return /^(?:login|passport)\.(?:taobao|tmall)\.com$/.test(source.hostname) && /^(?:login|passport)\.(?:taobao|tmall)\.com$/.test(target.hostname) && /(?:login|auth|havana|verify|captcha|sms)/i.test(target.pathname);
  } catch { return false; }
};

export function classifyShoppingRequest({ url, method, isNavigation, resourceType, phase, sourceUrl, isMainFrame }) {
  let target;
  try { target = new URL(url); } catch { return 'deny'; }
  if (phase === 'submitting' || phase === 'cashier') {
    try { assertOfficialCashierUrl(url); return method === 'GET' ? 'cashier' : 'deny'; } catch { /* Continue with the shop boundary. */ }
    if (phase === 'submitting' && target.hostname === 'h5api.m.taobao.com' && method === 'POST' && !isNavigation && isMainFrame && ['xhr', 'fetch'].includes(resourceType) && CREATE_PATH.test(target.pathname) && isConfirmationUrl(sourceUrl)) return 'approved_submit';
  }
  if (SUBMISSION_PATH.test(target.pathname) || target.pathname === '/auction/confirm_order.htm') return 'deny';
  if (isNavigation) {
    try { assertShopUrl(url); } catch { return 'deny'; }
    if (method === 'GET') return 'allow';
    if (phase === 'browsing' && method === 'POST' && manualAuth(sourceUrl, target)) return 'manual_auth';
    if (phase !== 'preparing' || method !== 'POST' || !isMainFrame || resourceType !== 'document' || target.hostname !== 'buy.taobao.com' || !DRAFT_DOCUMENTS.has(target.pathname)) return 'deny';
    try {
      const source = new URL(sourceUrl);
      const fromDraft = source.hostname === 'buy.taobao.com' && DRAFT_DOCUMENTS.has(source.pathname);
      return productSource(sourceUrl) || fromDraft ? 'draft' : 'deny';
    } catch { return 'deny'; }
  }
  if (method === 'GET') return 'allow';
  if (phase === 'browsing' && method === 'POST' && manualAuth(sourceUrl, target)) return 'manual_auth';
  if (phase !== 'preparing' || method !== 'POST' || !isMainFrame || !['xhr', 'fetch'].includes(resourceType) || target.hostname !== 'h5api.m.taobao.com' || !BUILD_PATH.test(target.pathname)) return 'deny';
  try {
    const source = new URL(sourceUrl);
    if (productSource(sourceUrl) || (source.hostname === 'buy.taobao.com' && DRAFT_DOCUMENTS.has(source.pathname))) return 'draft';
  } catch { /* Not a product or confirmation page. */ }
  return 'deny';
}

export async function clickAndWaitForConfirmation(page, click, timeout = 25_000) {
  const destination = page.waitForURL(url => {
    try { return isConfirmationUrl(String(url)) || isLoginUrl(String(url)); } catch { return false; }
  }, { waitUntil: 'domcontentloaded', timeout }).then(() => true, () => false);
  await click();
  return destination;
}
