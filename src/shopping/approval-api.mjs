import { createPublicKey, verify } from 'node:crypto';

const fail = code => Object.assign(new Error(code), { code });
const reply = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value)); };
const decode = value => JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));

export function createAccessOwnerVerifier({ teamDomain, audience, ownerEmail, fetchImpl = fetch, now = Date.now }) {
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(teamDomain || '') || !/^[A-Za-z0-9_-]{20,}$/.test(audience || '') || !/^[^\s@]+@[^\s@]+$/.test(ownerEmail || '')) throw new TypeError('shopping_access_configuration_required');
  const issuer = `https://${teamDomain}`;
  let keys = new Map(), loadedAt = 0;
  const refresh = async () => {
    const response = await fetchImpl(`${issuer}/cdn-cgi/access/certs`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw fail('access_keys_unavailable');
    const body = await response.json();
    if (!Array.isArray(body.keys) || body.keys.length > 8) throw fail('access_keys_invalid');
    keys = new Map(body.keys.filter(key => key.kid && key.kty === 'RSA').map(key => [key.kid, createPublicKey({ key, format: 'jwk' })]));
    loadedAt = now();
  };
  return async req => {
    const token = req.headers['cf-access-jwt-assertion'];
    if (typeof token !== 'string' || token.length > 8192) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    try {
      const header = decode(parts[0]), claims = decode(parts[1]);
      if (header.alg !== 'RS256' || typeof header.kid !== 'string') return null;
      if (now() - loadedAt > 3_600_000 || !keys.has(header.kid)) await refresh();
      const key = keys.get(header.kid);
      if (!key || !verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'))) return null;
      const seconds = Math.floor(now() / 1000);
      if (claims.iss !== issuer || !Array.isArray(claims.aud) || !claims.aud.includes(audience) || claims.type !== 'app' || claims.email?.toLowerCase() !== ownerEmail.toLowerCase() || !Number.isSafeInteger(claims.exp) || claims.exp <= seconds || !Number.isSafeInteger(claims.nbf) || claims.nbf > seconds || !Number.isSafeInteger(claims.iat) || claims.iat > seconds) return null;
      return ownerEmail.toLowerCase();
    } catch { return null; }
  };
}

export function createShoppingApprovalApi({ purchaseStore, verifyOwner, onApproved = null }) {
  if (!purchaseStore || typeof verifyOwner !== 'function') throw new TypeError('approval_api_configuration_required');
  return async (req, res, origin) => {
    const path = new URL(req.url, 'http://local').pathname;
    const decision = path.match(/^\/api\/shopping\/approvals\/([0-9a-f-]{36})\/decision$/i);
    if (path !== '/api/shopping/approvals' && !decision) return false;
    if ((path === '/api/shopping/approvals' && req.method !== 'GET') || (decision && req.method !== 'POST')) { reply(res, 405, { error: 'method_not_allowed' }); return true; }
    const ownerId = await verifyOwner(req);
    if (!ownerId) { reply(res, 403, { error: 'owner_required' }); return true; }
    if (path === '/api/shopping/approvals') {
      await purchaseStore.expirePending();
      reply(res, 200, { purchases: purchaseStore.listApprovals({ ownerId }) });
      return true;
    }
    if (req.headers.origin !== origin || req.headers['sec-fetch-site'] !== 'same-origin' || req.headers['x-shopping-user-action'] !== '1' || !String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) { reply(res, 403, { error: 'user_action_required' }); return true; }
    let text = '';
    for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 4096) { reply(res, 413, { error: 'request_too_large' }); return true; } }
    let body; try { body = JSON.parse(text); } catch { reply(res, 400, { error: 'invalid_json' }); return true; }
    if (!body || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'decision,fingerprint,nonce,sessionId') { reply(res, 400, { error: 'invalid_decision' }); return true; }
    try {
      const record = await purchaseStore.decide({ ownerId, purchaseId: decision[1], sessionId: body.sessionId, fingerprint: body.fingerprint, nonce: body.nonce, decision: body.decision });
      reply(res, 200, { purchase: record });
      if (body.decision === 'approve' && onApproved) setImmediate(() => { void Promise.resolve().then(() => onApproved(record.purchaseId)).catch(() => {}); });
    } catch (error) { reply(res, 409, { error: error.message || 'approval_rejected' }); }
    return true;
  };
}
