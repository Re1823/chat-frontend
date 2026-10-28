import { chromium } from 'playwright-core';
import { assertShopUrl, isConfirmationUrl, isLoginUrl, productIdFromUrl } from './browser-policy.mjs';
import { classifyShoppingRequest, clickAndWaitForConfirmation } from './confirmation-policy.mjs';
import { collectTaobaoConfirmationDom, normalizeTaobaoConfirmationDom } from './confirmation-extractor.mjs';
import { normalizeTaobaoSsr, selectedPropertyPath } from './taobao-ssr.mjs';
import { assertOfficialCashierUrl } from './alipay-policy.mjs';

const blockedAction = /(?:提交订单|确认订单|立即支付|确认付款|去支付|转账|充值|红包|提现|礼品卡|储值)/;
const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
export const classifyEmptySearch = diagnostic => diagnostic.verification ? 'verification_required' : diagnostic.login ? 'login_required' : 'empty_search_results';

export async function createEdgeAdapter({ profileDir }) {
  if (!profileDir || /(?:Microsoft[\\/]Edge[\\/]User Data|Edge[\\/]User Data)/i.test(profileDir)) throw new TypeError('dedicated_profile_required');
  const context = await chromium.launchPersistentContext(profileDir, { channel: 'msedge', headless: false, viewport: { width: 1280, height: 900 }, acceptDownloads: false });
  const page = context.pages()[0] || await context.newPage();
  const pageState = async target => {
    const rawUrl = target.url();
    let location;
    try { const url = new URL(rawUrl); location = `${url.protocol}//${url.hostname}${url.pathname}`; } catch { location = 'unknown'; }
    try {
      const state = await target.evaluate(() => {
        const body = document.body?.innerText || '';
        const nav = performance.getEntriesByType('navigation')[0];
        return { title: document.title.slice(0, 100), readyState: document.readyState, bodyLength: body.length, login: /(?:扫码登录|请先登录|密码登录)/.test(body), verification: /(?:滑动验证|安全验证|验证码|设备确认)/.test(body), navigationType: nav?.type || null, redirectCount: nav?.redirectCount ?? null, responseStatus: nav?.responseStatus ?? null };
      });
      return { location, ...state };
    } catch { return { location, state: 'unreadable' }; }
  };
  let phase = 'browsing';
  let purchaseSourceUrl = '';
  const requestLocation = raw => { try { const url = new URL(raw); return { host: url.hostname, path: url.pathname }; } catch { return { host: 'unknown', path: '' }; } };
  await context.route('**/*', async route => {
    const request = route.request();
    let isMainFrame = false;
    try { isMainFrame = request.frame() === page.mainFrame(); } catch { /* Popup or detached frame. */ }
    const verdict = classifyShoppingRequest({ url: request.url(), method: request.method(), isNavigation: request.isNavigationRequest(), resourceType: request.resourceType(), phase, sourceUrl: page.url() === 'about:blank' ? purchaseSourceUrl : page.url(), isMainFrame });
    if (verdict === 'deny') {
      if (phase === 'preparing' || request.isNavigationRequest()) console.info(JSON.stringify({ component: 'shopping_browser', event: 'request_blocked', method: request.method(), ...requestLocation(request.url()) }));
      return route.abort();
    }
    if (verdict === 'draft') console.info(JSON.stringify({ component: 'shopping_browser', event: 'draft_request_allowed', method: request.method(), ...requestLocation(request.url()) }));
    return route.continue();
  });
  page.on('response', response => {
    const request = response.request();
    const location = requestLocation(response.url());
    if (phase === 'preparing' && (request.isNavigationRequest() || location.host === 'h5api.m.taobao.com')) console.info(JSON.stringify({ component: 'shopping_browser', event: 'prepare_response', method: request.method(), status: response.status(), ...location }));
  });
  page.on('requestfailed', request => {
    if (phase === 'preparing') console.info(JSON.stringify({ component: 'shopping_browser', event: 'prepare_request_failed', method: request.method(), failure: String(request.failure()?.errorText || '').slice(0, 60), ...requestLocation(request.url()) }));
  });
  const guardedUrl = () => { const url = page.url(); assertShopUrl(url); for (const frame of page.frames()) if (/alipay\.(?:com|cn)(?:\/|$)/i.test(frame.url())) throw new Error('sensitive_page_rejected'); return url; };
  const currentConfirmation = async () => {
    if (page.isClosed() || !context.pages().includes(page)) throw new Error('page_identity_lost');
    const pageUrl = guardedUrl();
    if (!isConfirmationUrl(pageUrl) || !/确认订单/.test(await page.title())) throw new Error('confirmation_not_verified');
    const state = await page.evaluate(() => ({ readyState: document.readyState, verification: /(?:滑动验证|安全验证|验证码|设备确认)/.test(document.body?.innerText || '') }));
    if (state.verification) throw new Error('verification_required');
    if (state.readyState !== 'complete') throw new Error('confirmation_not_ready');
    if (new URL(pageUrl).pathname !== '/auction/buy_now.jhtml' || new URL(pageUrl).hostname !== 'buy.taobao.com') throw new Error('confirmation_layout_unsupported');
    const fields = normalizeTaobaoConfirmationDom(await page.evaluate(collectTaobaoConfirmationDom));
    if (guardedUrl() !== pageUrl) throw new Error('page_changed');
    return { ...fields, pageUrl, reliable: true };
  };
  const extractSsrProduct = async pageUrl => {
    const expectedItemId = new URL(pageUrl).searchParams.get('id');
    const source = await page.evaluate(() => {
      const res = window.__ICE_APP_CONTEXT__?.loaderData?.home?.data?.res;
      if (!res) return null;
      const info = {};
      for (const [skuId, detail] of Object.entries(res.skuCore?.sku2info || {}).slice(0, 200)) info[skuId] = { priceText: detail?.price?.priceText, quantity: detail?.quantity, saleable: detail?.saleable };
      const selectedNames = [...document.querySelectorAll('[class*="skuValueWrap"]')].slice(0, 8).map(wrap => {
        const selected = [...wrap.querySelectorAll('[class*="valueItem--"]')].filter(node => /(?:^|\s)isSelected--/.test(String(node.className || '')));
        return selected.length === 1 ? selected[0].querySelector('[class*="valueItemText--"]')?.textContent?.trim() || '' : '';
      });
      return { itemId: res.item?.itemId, title: res.item?.title, merchant: res.seller?.shopName || res.seller?.sellerNick || '', props: (res.skuBase?.props || []).slice(0, 8).map(prop => ({ pid: prop.pid, name: prop.name, values: (prop.values || []).slice(0, 80).map(value => ({ vid: value.vid, name: value.name })) })), skus: (res.skuBase?.skus || []).slice(0, 200).map(sku => ({ skuId: sku.skuId, propPath: sku.propPath })), info, selectedNames };
    });
    const selectedPath = selectedPropertyPath(source?.props, source?.selectedNames) || new URL(pageUrl).searchParams.get('sku_properties') || '';
    return normalizeTaobaoSsr(source, expectedItemId, selectedPath);
  };
  const extractProduct = async () => page.evaluate(() => {
    const text = element => (element?.textContent || '').replace(/\s+/g, ' ').trim();
    const first = selectors => { for (const selector of selectors) { const value = text(document.querySelector(selector)); if (value) return value; } return ''; };
    const buttons = [...document.querySelectorAll('button,[role="button"]')].filter(element => element.getClientRects().length).map(text).filter(value => value && value.length <= 50);
    const priceText = first(['[data-price]', '[class*="Price--priceText"]', '[class*="priceText"]', '[class*="price-value"]']);
    const title = first(['[class*="ItemHeader--mainTitle"]', '[class*="title--"]', 'h1']) || document.querySelector('meta[property="og:title"]')?.content || document.title;
    return { title: title.slice(0, 160), merchant: first(['[class*="shopName"]', '[class*="shop-name"]', '[data-shop-name]']).split(/好评率|及时发货率|平均/)[0].slice(0, 80), displayedPrice: priceText.slice(0, 40), skuOptions: [...new Set(buttons.filter(value => !/(?:购买|支付|订单|购物车|收藏|客服|搜索|分享)/.test(value)))].slice(0, 30), offers: [...new Set(buttons.filter(value => /(?:券|优惠)/.test(value)))].slice(0, 10), availability: /(?:已售罄|无货)/.test(document.body.innerText) ? 'unavailable' : 'unknown' };
  });
  const clickExactButton = async value => {
    if (!value || blockedAction.test(value)) throw new Error('action_rejected');
    const target = page.getByRole('button', { name: value, exact: true });
    if (await target.count() !== 1) throw new Error('choice_unavailable');
    await target.click({ timeout: 8000 });
    const selected = await target.evaluate(element => element.getAttribute('aria-pressed') === 'true' || element.getAttribute('aria-selected') === 'true' || element.getAttribute('aria-checked') === 'true' || /(?:selected|active|checked)/i.test(element.className || ''));
    if (!selected) throw new Error('selection_unverified');
  };
  return {
    async url() { return guardedUrl(); },
    async reviewPreparedOrder() { return currentConfirmation(); },
    async approvedOrderStatus() {
      const cashier = context.pages().find(target => { try { assertOfficialCashierUrl(target.url()); return true; } catch { return false; } });
      if (cashier) return { stage: 'cashier', cashierUrl: assertOfficialCashierUrl(cashier.url()) };
      const location = page.url();
      try { return { stage: isConfirmationUrl(location) ? 'confirmation' : 'unknown' }; } catch { return { stage: 'unknown' }; }
    },
    async submitApprovedOrder() {
      await currentConfirmation();
      const buttons = page.getByRole('button', { name: '提交订单', exact: true });
      if (await buttons.count() !== 1 || !await buttons.isVisible() || !await buttons.isEnabled()) throw new Error('order_submit_control_unavailable');
      phase = 'submitting';
      let landed = false;
      try {
        await buttons.click({ timeout: 8000, noWaitAfter: true });
        const deadline = Date.now() + 25_000;
        while (Date.now() < deadline) {
          for (const target of context.pages()) {
            let cashierUrl;
            try { cashierUrl = assertOfficialCashierUrl(target.url()); } catch { continue; }
            await target.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
            const state = await target.evaluate(() => ({ readyState: document.readyState, title: document.title, bodyLength: (document.body?.innerText || '').length })).catch(() => null);
            if (state && ['interactive', 'complete'].includes(state.readyState) && /(?:支付宝|收银台|支付)/.test(state.title) && state.bodyLength > 30) { landed = true; return { cashierUrl }; }
          }
          await page.waitForTimeout(250);
        }
        throw new Error('cashier_not_verified');
      } finally { phase = landed ? 'cashier' : 'browsing'; }
    },
    async inspectCurrentPage() {
      if (page.isClosed() || !context.pages().includes(page)) throw new Error('page_identity_lost');
      const observedUrl = guardedUrl();
      const url = new URL(observedUrl);
      const title = await page.title();
      const summary = await page.evaluate(() => {
        const body = document.body?.innerText || '';
        const lines = body.split(/\n+/).map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
        const sensitive = /(?:地址|收货人|联系人|手机|电话|身份证|邮编|门牌)/;
        const orderLine = /^(?:商家|店铺|商品名称|商品信息|规格|颜色分类|开关类型|数量|商品小计|运费|优惠|实付款|应付|合计|总计)(?:[:：\s]|$)/;
        const globals = ['__ICE_APP_CONTEXT__', '__INITIAL_STATE__', '__PRELOADED_STATE__', '__NEXT_DATA__', '__APOLLO_STATE__'].flatMap(name => {
          const value = window[name];
          return value && typeof value === 'object' ? [{ name, keys: Object.keys(value).slice(0, 30) }] : [];
        });
        const structuredPaths = [];
        const seen = new WeakSet();
        const relevant = /(?:order|trade|item|goods|sku|seller|shop|merchant|title|price|amount|discount|promotion|freight|shipping|postage|total|quantity|num|address)/i;
        const secret = /(?:token|cookie|session|auth|password|secret|access|sign|csrf|encrypt|credential|mobile|phone|receiver|consignee|contact|street|detailAddress)/i;
        const walk = (value, path, depth) => {
          if (structuredPaths.length >= 150 || depth > 7 || value == null) return;
          if (typeof value === 'object') {
            if (seen.has(value)) return;
            seen.add(value);
            const keys = Object.keys(value);
            if (depth <= 3 || relevant.test(path)) structuredPaths.push({ path, type: Array.isArray(value) ? 'array' : 'object', keys: keys.slice(0, 18), length: Array.isArray(value) ? value.length : undefined });
            const ranked = keys.sort((a, b) => Number(relevant.test(b)) - Number(relevant.test(a)));
            for (const key of ranked.slice(0, 35)) {
              if (secret.test(key)) continue;
              try { walk(value[key], `${path}.${key}`, depth + 1); } catch { /* Getter unavailable. */ }
              if (structuredPaths.length >= 150) break;
            }
            return;
          }
          if (!relevant.test(path) || secret.test(path) || /address/i.test(path)) return;
          const text = String(value).trim();
          if (!text || text.length > 120 || /1[3-9]\d{9}|(?:省|市|区|县).{3,}(?:路|街|号|室)/.test(text)) return;
          if (typeof value === 'number' || /(?:item|goods|sku|seller|shop|merchant|title|price|amount|discount|promotion|freight|shipping|postage|total|quantity|num)/i.test(path)) structuredPaths.push({ path, type: typeof value, value: text.slice(0, 100) });
        };
        for (const name of ['__ICE_APP_CONTEXT__', '__INITIAL_STATE__', '__PRELOADED_STATE__', '__NEXT_DATA__']) {
          const value = window[name];
          if (value && typeof value === 'object') walk(value, name, 0);
        }
        const amountLabel = /^(?:实付款|应付金额|应付|合计|总计|商品金额|商品总价|商品小计|小计|运费|邮费|配送费|优惠|店铺优惠|跨店优惠)[:：]?$/;
        const amountRows = [];
        const safeText = value => String(value || '').replace(/1[3-9]\d{9}/g, '[masked-phone]').replace(/(?:收货地址|配送地址|详细地址|收货人)[^\n]*/g, '[masked-address]').slice(0, 220);
        for (const node of document.querySelectorAll('div,span,p,td,th,strong')) {
          if (amountRows.length >= 12) break;
          if (!node.getClientRects().length) continue;
          const own = [...node.childNodes].filter(child => child.nodeType === Node.TEXT_NODE).map(child => child.textContent).join('').trim();
          if (!amountLabel.test(own)) continue;
          const nearby = (node.parentElement?.innerText || '').slice(0, 240);
          const amounts = [...nearby.matchAll(/[￥¥]\s*\d{1,8}(?:\.\d{1,2})?/g)].map(match => match[0]);
          amountRows.push({ label: own, amounts: [...new Set(amounts)].slice(0, 8), parentText: safeText(node.parentElement?.innerText), tag: node.tagName, parentClass: String(node.parentElement?.className || '').slice(0, 90), children: [...(node.parentElement?.children || [])].slice(0, 8).map(child => ({ tag: child.tagName, className: String(child.className || '').slice(0, 65), text: safeText(child.innerText).slice(0, 75) })) });
        }
        const productLinks = [...document.querySelectorAll('a[href*="item.taobao.com/item.htm"],a[href*="detail.tmall.com/item.htm"]')].filter(node => node.getClientRects().length).slice(0, 8).map(node => {
          const target = new URL(node.href);
          return { host: target.hostname, itemId: target.searchParams.get('id'), text: safeText(node.innerText).slice(0, 140), parentText: safeText(node.parentElement?.innerText) };
        });
        const semanticSamples = [...document.querySelectorAll('[class*="shop"],[class*="seller"],[class*="merchant"],[class*="goods"],[class*="sku"],[class*="Sku"],[class*="title"],[class*="Title"]')].filter(node => node.getClientRects().length && node.children.length < 5).slice(0, 55).flatMap(node => {
          const value = (node.innerText || '').trim();
          return value && value.length < 140 && !sensitive.test(value) && !/1[3-9]\d{9}/.test(value) ? [{ tag: node.tagName, className: String(node.className || '').slice(0, 80), text: safeText(value) }] : [];
        }).slice(0, 30);
        const fieldLabel = /^(?:数量|购买数量|运费|邮费|配送费|配送服务|快递|包邮|免运费|收货地址|颜色分类|笔尖规格|品牌)[:：]?$/;
        const fieldRows = [];
        for (const node of document.querySelectorAll('div,span,p,td,th,label')) {
          if (fieldRows.length >= 25) break;
          if (!node.getClientRects().length) continue;
          const own = [...node.childNodes].filter(child => child.nodeType === Node.TEXT_NODE).map(child => child.textContent).join('').trim();
          if (!fieldLabel.test(own)) continue;
          fieldRows.push({ label: own, parentClass: String(node.parentElement?.className || '').slice(0, 90), parentText: /地址/.test(own) ? '[masked-address]' : safeText(node.parentElement?.innerText), childTexts: /地址/.test(own) ? [] : [...(node.parentElement?.children || [])].slice(0, 8).map(child => safeText(child.innerText).slice(0, 80)) });
        }
        const titleNode = document.querySelector('a[class*="itemTitle"]');
        const productRow = [];
        for (let node = titleNode, depth = 0; node && depth < 3; node = node.parentElement, depth++) productRow.push({ depth, className: String(node.className || '').slice(0, 90), text: safeText(node.innerText).slice(0, 180) });
        const addressShapes = [...document.querySelectorAll('[class*="address"],[class*="Address"]')].filter(node => node.getClientRects().length).slice(0, 20).map(node => ({ className: String(node.className || '').slice(0, 90), textLength: (node.innerText || '').length, selected: /(?:selected|active|checked)/i.test(String(node.className || '')), regions: [...new Set((node.innerText || '').match(/[\u4e00-\u9fff]{2,8}(?:省|市|自治区)/g) || [])].slice(0, 2) }));
        const addressCards = [...document.querySelectorAll('[class*="addressContent"]')].filter(node => node.getClientRects().length).slice(0, 5).map((node, index) => {
          const raw = node.innerText || '';
          const phone = raw.match(/1[3-9]\d{9}/);
          const ancestors = [];
          for (let parent = node, depth = 0; parent && depth < 5; parent = parent.parentElement, depth++) ancestors.push({ className: String(parent.className || '').slice(0, 120), ariaChecked: parent.getAttribute('aria-checked'), dataState: parent.getAttribute('data-state') });
          return { index, regions: [...new Set(raw.match(/[\u4e00-\u9fff]{2,8}(?:省|市|自治区)/g) || [])].slice(0, 2), phoneTail: phone ? `****${phone[0].slice(-4)}` : null, ancestors, childClasses: [...node.querySelectorAll('*')].slice(0, 10).map(child => String(child.className || '').slice(0, 80)), checkedInput: Boolean(node.querySelector('input:checked,[aria-checked="true"]')) };
        });
        const quantityShapes = [...document.querySelectorAll('[class*="quantity"],[class*="Quantity"],[class*="count"],[class*="Count"],[class*="num"],[class*="Num"]')].filter(node => node.getClientRects().length && (node.innerText || '').length < 80).slice(0, 25).map(node => ({ className: String(node.className || '').slice(0, 100), text: safeText(node.innerText).slice(0, 75) }));
        const attributeRows = lines.filter(line => /^(?:颜色分类|规格|尺码|型号|数量|笔尖规格|品牌)[:：]/.test(line) && !sensitive.test(line)).slice(0, 15);
        const embeddedJson = [...document.querySelectorAll('script[type="application/json"],script[type="application/ld+json"]')].slice(0, 15).map(node => ({ id: String(node.id || '').slice(0, 60), type: node.type, length: node.textContent?.length || 0 }));
        return {
          readyState: document.readyState,
          bodyLength: body.length,
          confirmationSemantics: /确认订单/.test(document.title) && /(?:提交订单|确认订单)/.test(body),
          loginOrVerification: /(?:扫码登录|请先登录|滑动验证|安全验证|验证码|设备确认)/.test(body),
          paymentStage: /(?:收银台|确认付款|支付成功)/.test(document.title),
          addressPresent: lines.some(line => /(?:收货地址|配送地址)/.test(line)),
          orderLines: lines.filter(line => !sensitive.test(line) && !/1[3-9]\d{9}/.test(line) && orderLine.test(line)).slice(0, 35).map(line => line.slice(0, 140)),
          globals,
          structuredPaths,
          amountRows,
          productLinks,
          semanticSamples,
          fieldRows,
          productRow,
          addressShapes,
          addressCards,
          quantityShapes,
          attributeRows,
          embeddedJson
        };
      });
      return { pageHost: url.hostname, pagePath: url.pathname, queryKeys: [...new Set(url.searchParams.keys())].slice(0, 20), title: title.slice(0, 100), pageCount: context.pages().length, isControlledPage: true, isConfirmationPath: isConfirmationUrl(observedUrl), ...summary };
    },
    async search(query, limit, pageNumber = 1) {
      let current;
      try { current = new URL(page.url()); } catch { current = null; }
      if (current?.hostname !== 's.taobao.com' || current.searchParams.get('q') !== query || Number(current.searchParams.get('page') || 1) !== pageNumber) {
        await page.goto(`https://s.taobao.com/search?q=${encodeURIComponent(query)}&page=${pageNumber}`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      }
      const pageUrl = guardedUrl();
      await page.waitForFunction(() => document.querySelectorAll('a[href*="item.taobao.com/item.htm"],a[href*="detail.tmall.com/item.htm"]').length > 0 || document.querySelectorAll('[class*="item"],[class*="Item"]').length > 20, null, { timeout: 8000 }).catch(() => {});
      for (let step = 0; step < 2; step++) { await page.mouse.wheel(0, 650); await page.waitForTimeout(150); }
      const items = await page.evaluate(max => {
        const out = [];
        for (const link of document.querySelectorAll('a[href]')) {
          const url = link.href;
          if (!/^https:\/\/(?:item\.taobao\.com|detail\.tmall\.com)\/item\.htm\?/.test(url)) continue;
          const card = link.closest('article,li,[class*="Card"],[class*="card"],[class*="item"]') || link;
          const title = (link.getAttribute('title') || link.textContent || '').replace(/\s+/g, ' ').trim();
          const displayedPrice = (card.querySelector('[class*="price"],[data-price]')?.textContent || '').replace(/\s+/g, ' ').trim();
          const merchant = (card.querySelector('[class*="shop"],[class*="seller"]')?.textContent || '').replace(/\s+/g, ' ').trim();
          out.push({ url, title: title.slice(0, 160), displayedPrice: displayedPrice.slice(0, 40), merchant: merchant.slice(0, 80) });
          if (out.length >= max) break;
        }
        return out;
      }, Math.min(30, Math.max(limit * 3, 10)));
      if (items.length === 0) {
        const diagnostic = await page.evaluate(() => {
          const text = document.body?.innerText || '';
          const anchors = [...document.querySelectorAll('a[href]')];
          const counts = {};
          for (const anchor of anchors) {
            try { const host = new URL(anchor.href).hostname; if (host === 'item.taobao.com' || host === 'detail.tmall.com') counts[host] = (counts[host] || 0) + 1; } catch { /* Ignore malformed links. */ }
          }
          const cards = [...document.querySelectorAll('article,[class*="Card"],[class*="card"]')];
          const sampleCards = cards.filter(element => element.getClientRects().length && (element.innerText || '').length > 20).slice(0, 5).map(element => ({ tag: element.tagName, className: String(element.className || '').slice(0, 90), dataKeys: Object.keys(element.dataset || {}).slice(0, 8), linkCount: element.querySelectorAll('a[href]').length, childTags: [...new Set([...element.children].map(child => child.tagName))].slice(0, 6) }));
          const linkShapes = anchors.slice(0, 20).flatMap(anchor => { try { const url = new URL(anchor.href); return [`${url.hostname}${url.pathname}`.slice(0, 90)]; } catch { return []; } }).slice(0, 12);
          const explicitEmpty = /(?:没有找到|暂无相关商品|没有搜索结果)/.test(text);
          const loginLink = Boolean(document.querySelector('a[href*="login.taobao.com"]'));
          return { login: /(?:扫码登录|请先登录|登录后查看|密码登录)/.test(text) || Boolean(document.querySelector('input[type="password"],iframe[src*="login.taobao.com"]')) || (text.length < 200 && loginLink && !explicitEmpty), verification: /(?:滑动验证|请完成验证|安全验证|验证码)/.test(text), anchorCount: anchors.length, productLinkCounts: counts, candidateCards: cards.length, textLength: text.length, loginForm: Boolean(document.querySelector('form[action*="login"],input[type="password"]')), logoutLink: Boolean(document.querySelector('a[href*="logout"]')), sampleCards, linkShapes };
        });
        console.info(JSON.stringify({ component: 'shopping_browser', event: 'empty_search_diagnostic', ...diagnostic }));
        const state = classifyEmptySearch(diagnostic);
        if (state !== 'empty_search_results') throw new Error(state);
      }
      return { pageUrl, items };
    },
    async product(url) {
      let sameItem = false;
      try { sameItem = productIdFromUrl(page.url()) === productIdFromUrl(url); } catch { /* Navigate below. */ }
      if (!sameItem) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      const pageUrl = guardedUrl();
      if (isLoginUrl(pageUrl)) throw new Error('login_required');
      productIdFromUrl(pageUrl);
      await page.waitForFunction(() => document.querySelectorAll('button,[role="button"],[class*="sku"],[class*="Sku"]').length > 5, null, { timeout: 8000 }).catch(() => {});
      const product = new URL(pageUrl).hostname === 'item.taobao.com' ? await extractSsrProduct(pageUrl) : await extractProduct();
      const buy = page.getByRole('button', { name: '立即购买', exact: true });
      await buy.waitFor({ state: 'visible', timeout: 3500 }).catch(() => {});
      product.buyNowAvailable = await buy.count() === 1 && await buy.isVisible() && await buy.isEnabled();
      return { pageUrl, product };
    },
    async select({ skuId, quantity, offerId }) {
      const before = guardedUrl(); productIdFromUrl(before);
      if (new URL(before).hostname === 'item.taobao.com') {
        if (offerId) throw new Error('offer_unavailable');
        const product = await extractSsrProduct(before);
        const chosen = product.skuOptions.find(option => option.skuId === skuId);
        if (!chosen || chosen.stock === 0 || chosen.saleable === false) throw new Error('sku_unavailable');
        const parts = chosen.propPath.split(';');
        for (let index = 0; index < parts.length; index++) {
          const [pid, vid] = parts[index].split(':');
          const dimension = product.dimensions[index];
          const value = dimension?.pid === pid && dimension.values.find(option => option.vid === vid);
          if (!value) throw new Error('sku_unavailable');
          const wrap = page.locator('[class*="skuValueWrap"]').nth(index);
          const option = wrap.locator('[class*="valueItem--"]').filter({ has: page.getByText(value.name, { exact: true }) });
          if (await option.count() !== 1) throw new Error('sku_unavailable');
          const selected = await option.evaluate(element => /(?:^|\s)isSelected--/.test(String(element.className || '')));
          if (!selected) await option.click({ timeout: 8000 });
          await page.waitForFunction(({ dimension, expected }) => {
            const wrap = document.querySelectorAll('[class*="skuValueWrap"]')[dimension];
            const selected = [...(wrap?.querySelectorAll('[class*="valueItem--"]') || [])].filter(node => /(?:^|\s)isSelected--/.test(String(node.className || '')));
            return selected.length === 1 && selected[0].querySelector('[class*="valueItemText--"]')?.textContent?.trim() === expected;
          }, { dimension: index, expected: value.name }, { timeout: 3_000 }).catch(() => { throw new Error('sku_unverified'); });
          guardedUrl();
        }
        const quantityInput = page.locator('[class*="countValueWrapper"] input');
        if (await quantityInput.count() !== 1) throw new Error('quantity_unavailable');
        await quantityInput.fill(String(quantity));
        await quantityInput.dispatchEvent('change');
        if (await quantityInput.inputValue() !== String(quantity)) throw new Error('quantity_unverified');
        const after = guardedUrl();
        if (productIdFromUrl(after) !== productIdFromUrl(before)) throw new Error('page_changed');
        const verified = await extractSsrProduct(after);
        const verifiedSku = verified.skuOptions.find(option => option.skuId === skuId);
        if (verified.selectedSkuId !== skuId || !verifiedSku || verifiedSku.stock === 0 || verifiedSku.saleable === false) throw new Error('sku_unverified');
        if (await quantityInput.inputValue() !== String(quantity)) throw new Error('quantity_unverified');
        const buy = page.getByRole('button', { name: '立即购买', exact: true });
        await buy.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
        await page.waitForFunction(() => {
          const buttons = [...document.querySelectorAll('button,[role="button"]')].filter(node => node.getClientRects().length && node.textContent?.trim() === '立即购买');
          return buttons.length === 1 && !buttons[0].disabled && buttons[0].getAttribute('aria-disabled') !== 'true';
        }, null, { timeout: 5_000 }).catch(() => {});
        if (await buy.count() !== 1 || !await buy.isVisible() || !await buy.isEnabled()) {
          console.info(JSON.stringify({ component: 'shopping_browser', event: 'buy_control_unavailable', count: await buy.count(), visible: await buy.isVisible().catch(() => false), enabled: await buy.isEnabled().catch(() => false) }));
          throw new Error('product_unavailable');
        }
        // Product-page prices are reference data only; the confirmation page sets the trusted total.
        const visiblePrice = await page.evaluate(() => {
          const blocks = [...document.querySelectorAll('[class*="block2--"]')].filter(node => node.getClientRects().length);
          const prices = blocks.flatMap(block => {
            const unit = block.querySelector('[class*="unit--"]');
            const value = block.querySelector('[class*="text--"]');
            const unitText = (unit?.innerText || '').trim();
            const valueText = (value?.innerText || '').trim();
            return /^[￥¥]$/.test(unitText) && /^\d{1,8}(?:\.\d{1,2})?$/.test(valueText) ? [unitText + valueText] : [];
          });
          return prices.length === 1 ? prices[0] : '';
        });
        return { pageUrl: after, selectedSku: skuId, selectedSkuLabel: verifiedSku.label, quantity, displayedPrice: visiblePrice };
      }
      const product = await extractProduct();
      if (!product.skuOptions.includes(skuId)) throw new Error('sku_unavailable');
      await clickExactButton(skuId);
      if (offerId) { if (!product.offers.includes(offerId)) throw new Error('offer_unavailable'); await clickExactButton(offerId); }
      const quantityInput = page.locator('input[name="quantity"],input[type="number"],input[aria-label*="数量"]');
      if (await quantityInput.count() !== 1) throw new Error('quantity_unavailable');
      await quantityInput.fill(String(quantity));
      await quantityInput.dispatchEvent('change');
      const actual = await quantityInput.inputValue();
      if (actual !== String(quantity)) throw new Error('selection_unverified');
      const after = guardedUrl();
      return { pageUrl: after, selectedSku: skuId, quantity, displayedPrice: (await extractProduct()).displayedPrice };
    },
    async prepareOrder() {
      const sourcePage = guardedUrl();
      productIdFromUrl(sourcePage);
      const buy = page.getByRole('button', { name: '立即购买', exact: true });
      if (await buy.count() !== 1) throw new Error('order_needs_manual_review');
      let popupOpened = false;
      const onPage = target => { if (target !== page) popupOpened = true; };
      context.on('page', onPage);
      phase = 'preparing';
      purchaseSourceUrl = sourcePage;
      try {
        await clickAndWaitForConfirmation(page, () => buy.click({ timeout: 8000 }));
        await page.waitForFunction(() => document.readyState === 'complete' && /确认订单/.test(document.title) && (document.body?.innerText?.length || 0) > 100, null, { timeout: 12_000 }).catch(() => {});
        const state = await pageState(page);
        console.info(JSON.stringify({ component: 'shopping_browser', event: 'confirmation_page_state', ...state, popupOpened }));
        if (popupOpened || state.location.startsWith('chrome-error:')) throw new Error('order_needs_manual_review');
        if (state.login) throw new Error('login_required');
        if (state.verification) throw new Error('verification_required');
        if (state.readyState !== 'complete' || !/确认订单/.test(state.title) || state.bodyLength === 0 || /(?:收银台|确认付款|支付成功)/.test(state.title)) throw new Error('order_needs_manual_review');
        let fields, pageUrl;
        for (let attempt = 0; attempt < 2; attempt++) {
          pageUrl = guardedUrl();
          if (isLoginUrl(pageUrl)) throw new Error('login_required');
          if (!isConfirmationUrl(pageUrl)) throw new Error('order_needs_manual_review');
          if (new URL(pageUrl).hostname === 'buy.taobao.com' && new URL(pageUrl).pathname === '/auction/buy_now.jhtml') {
            const observed = await page.evaluate(collectTaobaoConfirmationDom);
            fields = normalizeTaobaoConfirmationDom(observed);
            if (guardedUrl() !== pageUrl) throw new Error('order_needs_manual_review');
            break;
          }
          // Only explicit, unambiguous labels are accepted. Unknown Taobao layouts stop here.
          try { fields = await page.evaluate(() => {
            const source = document.body.innerText.split(/\n+/).map(line => line.trim()).filter(Boolean);
            const field = label => {
              const found = source.filter(line => line.startsWith(label + '：') || line.startsWith(label + ':'));
              return found.length === 1 ? found[0].slice(label.length + 1).trim() : '';
            };
            const href = document.querySelector('a[href*="item.taobao.com/item.htm"],a[href*="detail.tmall.com/item.htm"]')?.href || '';
            return { merchant: field('商家'), goods: field('商品'), sku: field('规格'), quantity: Number(field('数量')), subtotal: field('商品小计'), shipping: field('运费'), discount: field('优惠'), total: field('实付款'), addressLabel: field('收货地址'), category: field('商品类型') === '实物商品' ? 'physical_goods' : 'unknown', resourceUrl: href };
          }); } catch (cause) {
            if (!/Execution context was destroyed|navigation/i.test(String(cause.message || '')) || attempt === 1) throw new Error('order_needs_manual_review');
            await page.waitForLoadState('domcontentloaded', { timeout: 8_000 }).catch(() => {});
            continue;
          }
          if (guardedUrl() !== pageUrl) throw new Error('order_needs_manual_review');
          break;
        }
        return { ...fields, pageUrl, reliable: Boolean(fields.merchant && fields.goods && fields.sku && fields.addressLabel && fields.resourceUrl) };
      } finally {
        phase = 'browsing';
        purchaseSourceUrl = '';
        context.off('page', onPage);
      }
    },
    async close() { await context.close(); }
  };
}
