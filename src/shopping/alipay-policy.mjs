const fail = code => { throw new Error(code); };

export function assertOfficialCashierUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail('cashier_url_rejected'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !/(?:^|\.)alipay\.com$/.test(host) || !/(?:^|\.)[a-z0-9-]*cashier[a-z0-9-]*\.alipay\.com$/.test(host) || !url.pathname || url.href.length > 8192) fail('cashier_url_rejected');
  return url.href;
}
