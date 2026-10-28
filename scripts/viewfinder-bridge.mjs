import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const configPath = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'viewfinder', 'config.json');
const token = JSON.parse(fs.readFileSync(configPath, 'utf8')).token;
if (typeof token !== 'string' || !token) throw new Error('取景框配置中没有口令');
const syncSecretPath = path.join(path.dirname(configPath), 'chat-sync-secret.txt');
const syncSecret = process.env.SCREENPEEK_SYNC_SECRET || (fs.existsSync(syncSecretPath) ? fs.readFileSync(syncSecretPath, 'utf8').trim() : '');
const frontendUrl = `http://127.0.0.1:${Number(process.env.SCREENPEEK_FRONTEND_PORT || 34173)}`;
const httpPort = Number(process.env.VIEWFINDER_HTTP_PORT || 3100);
const wsPort = Number(process.env.VIEWFINDER_WS_PORT || 3200);
const outputDir = path.resolve('data', 'viewfinder-captures');
const pending = new Map();
let uncertainActions = false;
let app = null;
let chatEpoch = null;
let heartbeatInFlight = false;
let lastHeartbeatAt = 0;
const deliveredEvents = new Set();

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}
function json(res, code, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': data.length, 'cache-control': 'no-store' });
  res.end(data);
}
function failPending(socket, error) {
  for (const [id, item] of pending) {
    if (item.socket !== socket) continue;
    if (item.type === 'vf_action') uncertainActions = true;
    clearTimeout(item.timer);
    pending.delete(id);
    item.resolve({ ok: false, error });
  }
}
function sendFrame(socket, opcode, payload = Buffer.alloc(0)) {
  if (socket.destroyed) return false;
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (body.length < 126) header = Buffer.from([0x80 | opcode, body.length]);
  else if (body.length <= 65535) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(body.length, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(body.length), 2); }
  socket.write(Buffer.concat([header, body]));
  return true;
}
function send(socket, message) { return sendFrame(socket, 1, JSON.stringify(message)); }
function appConnected() { return !!app && !app.destroyed; }
function disableChat(notify = true, reason = '') {
  const previous = chatEpoch;
  chatEpoch = null;
  lastHeartbeatAt = 0;
  deliveredEvents.clear();
  if (previous && reason) console.warn('[screenpeek-sync] disabled:', reason);
  if (previous && notify) void postFrontend('/api/internal/viewfinder-chat/disconnected', { epoch: previous }).catch(() => {});
}
function postFrontend(route, body) {
  if (syncSecret.length < 32) return Promise.reject(new Error('sync_secret_missing'));
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request(frontendUrl + route, {
      method: 'POST', timeout: 5000,
      headers: { 'content-type': 'application/json', 'content-length': payload.length, 'x-viewfinder-chat-secret': syncSecret }
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; if (text.length > 65536) req.destroy(new Error('response_too_large')); });
      res.on('end', () => { try { const result = JSON.parse(text); if (res.statusCode !== 200 || result.ok !== true) reject(new Error(result.error || 'frontend_rejected')); else resolve(result); } catch (error) { reject(error); } });
    });
    req.on('timeout', () => req.destroy(new Error('frontend_timeout')));
    req.on('error', reject);
    req.end(payload);
  });
}
async function sendChatToFrontend(socket, content) {
  const epoch = chatEpoch, clientRequestId = crypto.randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!epoch || epoch !== chatEpoch || socket !== app) return;
    try {
      await postFrontend('/api/internal/viewfinder-chat/message', { epoch, clientRequestId, text: content });
      return;
    } catch (error) {
      if (error.message === 'sync_disabled' || error.message === 'invalid_message') break;
    }
  }
  if (socket === app) send(socket, { type: 'error', message: '这条消息的投递状态未能确认，请先在 PWA 查看，避免重复发送。ScreenPeek 聊天同步已关闭。' });
  disableChat(true, 'message_delivery_unconfirmed');
}
function request(type, fields, timeoutMs) {
  if (!app || app.destroyed) return Promise.resolve({ ok: false, error: 'offline' });
  const socket = app;
  const requestId = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (type === 'vf_action') uncertainActions = true;
      pending.delete(requestId);
      resolve({ ok: false, error: 'timeout' });
    }, timeoutMs);
    pending.set(requestId, { socket, timer, resolve, type });
    if (!send(socket, { type, requestId, ...fields })) {
      clearTimeout(timer); pending.delete(requestId);
      resolve({ ok: false, error: 'offline' });
    }
  });
}
function handleMessage(socket, raw) {
  let message;
  try { message = JSON.parse(raw); } catch { return; }
  if (message.type === 'vf_hello') {
    if (app && app !== socket) { disableChat(true, 'app_reconnected'); failPending(app, 'disconnected'); app.end(); }
    app = socket;
    send(socket, { type: 'vf_ready' });
    console.log('取景框已连接');
  } else if ((message.type === 'chat' || message.type === 'file') && socket === app) {
    if (!chatEpoch) return send(socket, { type: 'error', message: 'ScreenPeek 聊天同步尚未开启；请先在 PWA 请秋秋开启。' });
    if (message.type === 'file') return send(socket, { type: 'error', message: 'ScreenPeek 图片消息暂不支持，请在 PWA 发送图片。' });
    if (typeof message.content !== 'string' || !message.content.trim() || message.content.length > 16384) return send(socket, { type: 'error', message: '消息为空或过长，未发送。' });
    void sendChatToFrontend(socket, message.content.trim());
  } else if (message.type === 'vf_shot' && socket === app) {
    const item = pending.get(message.requestId);
    if (!item || item.socket !== socket) return;
    clearTimeout(item.timer); pending.delete(message.requestId);
    item.resolve(message.error ? { ok: false, error: String(message.error) } : { ok: true, data: message.data, desc: message.desc });
  }
}
function acceptSocket(socket, head) {
  let buffer = head || Buffer.alloc(0);
  let chunks = [];
  let chunkBytes = 0;
  function close() { socket.destroy(); }
  socket.on('data', (data) => {
    buffer = Buffer.concat([buffer, data]);
    while (buffer.length >= 2) {
      const first = buffer[0], second = buffer[1], opcode = first & 15;
      const masked = !!(second & 0x80);
      let len = second & 127, offset = 2;
      if (!masked) return close();
      if (len === 126) { if (buffer.length < 4) return; len = buffer.readUInt16BE(2); offset = 4; }
      if (len === 127) {
        if (buffer.length < 10) return;
        const large = buffer.readBigUInt64BE(2);
        if (large > 16n * 1024n * 1024n) return close();
        len = Number(large); offset = 10;
      }
      if (len > 16 * 1024 * 1024 || buffer.length < offset + 4 + len) return len > 16 * 1024 * 1024 ? close() : undefined;
      const mask = buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      buffer = buffer.subarray(offset + 4 + len);
      if (opcode === 8) { sendFrame(socket, 8); return socket.end(); }
      if (opcode === 9) { sendFrame(socket, 10, payload); continue; }
      if (opcode === 10) continue;
      if (opcode === 1) { chunks = [payload]; chunkBytes = payload.length; }
      else if (opcode === 0 && chunks.length) { chunks.push(payload); chunkBytes += payload.length; }
      else return close();
      if (chunkBytes > 16 * 1024 * 1024) return close();
      if (first & 0x80) {
        handleMessage(socket, Buffer.concat(chunks).toString('utf8'));
        chunks = []; chunkBytes = 0;
      }
    }
  });
  socket.on('close', () => {
    failPending(socket, 'disconnected');
    if (app === socket) { disableChat(true, 'app_disconnected'); app = null; console.log('取景框已断开'); }
  });
  socket.on('error', () => {});
  if (buffer.length) socket.emit('data', Buffer.alloc(0));
}

function upgrade(req, socket, head) {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return socket.destroy(); }
  if (!isLoopback(socket.remoteAddress)) return socket.destroy();
  const key = req.headers['sec-websocket-key'];
  if (req.headers.upgrade?.toLowerCase() !== 'websocket' || typeof key !== 'string') return socket.destroy();
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  const supplied = Buffer.from(url.searchParams.get('token') || '');
  const expected = Buffer.from(token);
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    const code = Buffer.alloc(2); code.writeUInt16BE(4001);
    sendFrame(socket, 8, code);
    return socket.end();
  }
  acceptSocket(socket, head);
}
function validJpeg(data) {
  if (typeof data !== 'string' || data.length > 16 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return false;
  const bytes = Buffer.from(data, 'base64');
  return bytes.length > 100 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
}
async function receiveBody(req) {
  let body = '';
  for await (const part of req) {
    body += part;
    if (body.length > 65536) throw new Error('请求过大');
  }
  return JSON.parse(body || '{}');
}
const api = http.createServer(async (req, res) => {
  if (!isLoopback(req.socket.remoteAddress) || Object.hasOwn(req.headers, 'x-forwarded-for')) return json(res, 403, { ok: false, error: 'forbidden' });
  if (req.method !== 'POST') return json(res, 404, { ok: false, error: 'not_found' });
  try {
    const body = await receiveBody(req);
    if (req.url === '/api/internal/vf-activity') return json(res, 200, { ok: true, connected: appConnected(), pending: pending.size, uncertain: uncertainActions });
    if (req.url === '/api/internal/vf-chat-status') return json(res, 200, { ok: true, connected: appConnected(), enabled: !!chatEpoch });
    if (req.url === '/api/internal/vf-chat-sync') {
      if (typeof body.enabled !== 'boolean' || !/^[0-9a-f-]{36}$/i.test(String(body.epoch || ''))) return json(res, 400, { ok: false, error: 'invalid_sync_request' });
      if (!body.enabled) { if (!chatEpoch || chatEpoch === body.epoch) disableChat(false); return json(res, 200, { ok: true, enabled: false, connected: appConnected() }); }
      if (!appConnected()) return json(res, 200, { ok: false, enabled: false, connected: false, error: 'viewfinder_offline' });
      if (syncSecret.length < 32) return json(res, 200, { ok: false, enabled: false, connected: true, error: 'sync_secret_missing' });
      try { const health = await fetch(frontendUrl + '/api/chat/queue/status', { signal: AbortSignal.timeout(3000) }); if (!health.ok) throw Error('forward_unavailable'); }
      catch { return json(res, 200, { ok: false, enabled: false, connected: true, error: 'forward_unavailable' }); }
      chatEpoch = body.epoch; lastHeartbeatAt = Date.now(); deliveredEvents.clear();
      send(app, { type: 'history', items: [] });
      return json(res, 200, { ok: true, enabled: true, connected: true });
    }
    if (req.url === '/api/internal/vf-chat-event') {
      if (!chatEpoch || body.epoch !== chatEpoch) return json(res, 409, { ok: false, error: 'sync_disabled' });
      if (!appConnected()) { disableChat(true, 'app_offline'); return json(res, 200, { ok: false, error: 'viewfinder_offline' }); }
      if (typeof body.eventId !== 'string' || body.eventId.length > 160 || !['resend', 'delta', 'done', 'error'].includes(body.type)) return json(res, 400, { ok: false, error: 'invalid_event' });
      if (deliveredEvents.has(body.eventId)) return json(res, 200, { ok: true, duplicate: true });
      if (body.type === 'resend' || body.type === 'done') {
        if (typeof body.text !== 'string' || body.text.length > 65536) return json(res, 400, { ok: false, error: 'invalid_event_text' });
      }
      send(app, body.type === 'error' ? { type: 'error', message: String(body.message || '回复未完成').slice(0, 256) } : body.type === 'delta' ? { type: 'delta' } : { type: body.type, text: body.text });
      deliveredEvents.add(body.eventId); if (deliveredEvents.size > 1024) deliveredEvents.delete(deliveredEvents.values().next().value);
      return json(res, 200, { ok: true });
    }
    if (req.url === '/api/internal/vf-capture') {
      if (body.mode !== 'temp' && body.mode !== 'keep') return json(res, 400, { ok: false, error: 'invalid_mode' });
      const result = await request('vf_capture', { mode: body.mode }, 20000);
      if (!result.ok) return json(res, 200, result);
      if (!validJpeg(result.data)) return json(res, 502, { ok: false, error: 'invalid_jpeg' });
      if (body.inline === true) return json(res, 200, { ok: true, data: result.data, mime: 'image/jpeg' });
      fs.mkdirSync(outputDir, { recursive: true });
      const file = path.join(outputDir, `${body.mode === 'temp' ? 'vftemp' : 'vfkeep'}-${Date.now()}-${crypto.randomUUID()}.jpg`);
      fs.writeFileSync(file, Buffer.from(result.data, 'base64'), { flag: 'wx' });
      if (body.mode === 'temp') setTimeout(() => fs.rm(file, { force: true }, () => {}), 600000).unref();
      return json(res, 200, { ok: true, path: file });
    }
    if (req.url === '/api/internal/vf-action') {
      if (!body.action || typeof body.action !== 'object') return json(res, 400, { ok: false, error: 'invalid_action' });
      const result = await request('vf_action', { action: body.action }, 60000);
      if (result.ok && !validJpeg(result.data)) return json(res, 502, { ok: false, error: 'invalid_jpeg' });
      return json(res, 200, result);
    }
    return json(res, 404, { ok: false, error: 'not_found' });
  } catch (error) { return json(res, 400, { ok: false, error: error.message }); }
});
const ws4 = http.createServer();
const ws6 = http.createServer();
for (const server of [ws4, ws6]) {
  server.on('upgrade', upgrade);
  server.on('request', (_req, res) => json(res, 404, { ok: false, error: 'not_found' }));
}
api.listen(httpPort, '127.0.0.1', () => console.log(`HTTP 127.0.0.1:${httpPort} 已监听`));
ws4.listen(wsPort, '127.0.0.1', () => console.log(`WebSocket 127.0.0.1:${wsPort} 已监听`));
ws6.listen(wsPort, '::1', () => console.log(`WebSocket [::1]:${wsPort} 已监听`));
setInterval(async () => {
  const epoch = chatEpoch;
  if (!epoch || heartbeatInFlight) return;
  heartbeatInFlight = true;
  try {
    await postFrontend('/api/internal/viewfinder-chat/heartbeat', { epoch });
    if (chatEpoch === epoch) lastHeartbeatAt = Date.now();
  } catch (error) {
    if (chatEpoch !== epoch) return;
    if (error?.message === 'frontend_timeout' && Date.now() - lastHeartbeatAt < 30000) {
      console.warn('[screenpeek-sync] transient heartbeat timeout');
      return;
    }
    if (appConnected()) send(app, { type: 'error', message: 'ScreenPeek 聊天连接已中断，同步已关闭；需要在 PWA 重新开启。' });
    disableChat(true, `heartbeat_${['frontend_timeout', 'sync_disabled', 'ECONNRESET', 'ECONNREFUSED'].includes(error?.message) ? error.message : error?.code || 'failed'}`);
  } finally {
    heartbeatInFlight = false;
  }
}, 4000).unref();
