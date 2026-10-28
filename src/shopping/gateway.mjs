import {createRequestJournal,resultDigest} from './request-journal.mjs';
import http from 'node:http';
import { createWorkerVerifier, signWorkerMessage } from './worker-auth.mjs';
import { createReplayStore } from './replay-store.mjs';
import { SHOPPING_TRANSPORT, shoppingMcpTools } from './contracts.mjs';

const error = code => Object.assign(new Error(code), { code });
const send = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
const readJson = async req => { let text = ''; for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > SHOPPING_TRANSPORT.maxBodyBytes) throw error('message_too_large'); } try { return JSON.parse(text); } catch { throw error('invalid_json'); } };

export function createShoppingGateway({ secret, workerId, replayPath, purchaseStore, now = Date.now, onlineMs = 10_000, timeoutMs = SHOPPING_TRANSPORT.responseTimeoutMs }) {
  if (!purchaseStore) throw new TypeError('purchase_store_required');
  const verifyWorker = createWorkerVerifier({ secret, workerId, expectedRole: 'worker', now, seen: createReplayStore(replayPath) });
  const journal=createRequestJournal({path:replayPath+'.requests',secret,scope:'gateway-requests'});
  const verifyReconcile=createWorkerVerifier({secret,workerId,expectedRole:'vps',now,seen:createReplayStore(replayPath+'.reconcile')});
  let lastPoll = 0;
  let onWorkerOnline = null;
  const queued = [];
  const pending = new Map();
  const signed = (operation, payload = {}) => signWorkerMessage({ secret, role: 'vps', workerId, operation, payload, now: now() });
  const online = () => lastPoll > 0 && now() - lastPoll <= onlineMs;
  const call = (operation, payload, { timeoutMs: callTimeoutMs = timeoutMs } = {}) => {
    if (!online()) return Promise.reject(error('worker_offline'));
    const message = signed(operation, payload);
    journal.put(message.requestId,{state:'queued',operation,createdAt:now()});
    return new Promise((resolve, reject) => {
      const timer=setTimeout(()=>{pending.delete(message.requestId);const index=queued.findIndex(item=>item.requestId===message.requestId);const row=journal.get(message.requestId);let recovery='uncertain';if(index>=0){queued.splice(index,1);journal.put(message.requestId,{...row,state:'not_executed'});recovery='safe_to_retry';}reject(Object.assign(error(recovery==='safe_to_retry'?'worker_not_executed':'worker_result_uncertain'),{requestId:message.requestId,recovery}));},callTimeoutMs);
      pending.set(message.requestId, { resolve, reject, timer });
      queued.push(message);
    });
  };
  const accept = message => {
    const verified = verifyWorker(message);
    if(verified.operation==='poll'){const wasOnline=online();lastPoll=now();if(!wasOnline&&onWorkerOnline)setImmediate(()=>{try{onWorkerOnline()}catch{}});const request=queued.shift();if(!request)return signed('idle',{});const row=journal.get(request.requestId);journal.put(request.requestId,{...row,state:'dispatched',dispatchedAt:now()});return request;}
    if (verified.operation !== 'result') throw error('operation_rejected');
    const row=journal.get(verified.responseTo);
    if(!row||row.state==='not_executed'||row.state==='queued')throw error('unknown_result');
    if(!verified.payload||typeof verified.payload.ok!=='boolean')throw error('invalid_result');
    if(row.state==='completed') {if(resultDigest(row.outcome)!==resultDigest(verified.payload))throw error('result_identity_mismatch');return signed('idle',{ok:true,duplicate:true,responseTo:verified.responseTo,resultDigest:resultDigest(row.outcome)});}
    journal.put(verified.responseTo,{...row,state:'completed',outcome:verified.payload,completedAt:now()});
    const entry=pending.get(verified.responseTo);
    if(entry){pending.delete(verified.responseTo);clearTimeout(entry.timer);if(verified.payload.ok)entry.resolve(verified.payload.data);else entry.reject(error(String(verified.payload.code||'worker_failed')));}
    return signed('idle',{ok:true,responseTo:verified.responseTo,resultDigest:resultDigest(verified.payload)});
  };
  const reconcile=message=>{
    const request=verifyReconcile(message),p=request.payload;
    if(request.operation!=='reconcile_worker_request'||!p||Object.keys(p).join(',')!=='requestId'||!/^[0-9a-f-]{36}$/.test(p.requestId))throw error('reconcile_rejected');
    const row=journal.get(p.requestId);
    // Unknown legacy identity is never proof of non-execution.
    return signed('idle',{requestId:p.requestId,state:row?.state||'unknown',...(row?.state==='completed'?{outcome:row.outcome}:{}),safeToRetry:row?.state==='not_executed'});
  };
  const invokeTool = async ({ name, arguments: args = {}, ownerId, conversationId }) => {
    const tool = shoppingMcpTools.find(item => item.name === name);
    if (!tool) throw error('unknown_shopping_tool');
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !(key in tool.inputSchema.properties)) || tool.inputSchema.required.some(key => !(key in args))) throw error('invalid_shopping_arguments');
    for (const [key, value] of Object.entries(args)) {
      const rule = tool.inputSchema.properties[key];
      if (rule.type === 'string' && (typeof value !== 'string' || value.length < (rule.minLength || 0) || value.length > rule.maxLength)) throw error('invalid_shopping_arguments');
      if (rule.type === 'integer' && (!Number.isInteger(value) || value < rule.minimum || value > rule.maximum)) throw error('invalid_shopping_arguments');
    }
    if (!ownerId || !conversationId) throw error('owner_context_required');
    if (name === 'shopping_search') return call('search', { query: args.query, page: args.page || 1, limit: args.limit || 10 });
    if (name === 'shopping_product') {
      const data = await call('product', { productId: args.productId });
      const session = await purchaseStore.startSession({ ownerId, conversationId, workerId, browserContextId: data.browserContextId, profileId: data.profileId, pageUrl: data.pageUrl });
      return { ...data, sessionId: session.sessionId };
    }
    if (name === 'shopping_select') {
      const session = purchaseStore.getSession({ ownerId, sessionId: args.sessionId });
      if (session.conversationId !== conversationId || session.workerId !== workerId || session.state !== 'active' || session.expiresAt <= now()) throw error('session_mismatch');
      return call('select', { ...args, sessionExpiresAt:session.expiresAt, pageUrl: session.pageUrl, expectedContextId: session.browserContextId, expectedProfileId: session.profileId }, { timeoutMs: 60_000 });
    }
    if (name === 'shopping_prepare_purchase') {
      const session = purchaseStore.getSession({ ownerId, sessionId: args.sessionId });
      if (session.conversationId !== conversationId || session.workerId !== workerId) throw error('session_mismatch');
      const existing = purchaseStore.getBySession({ ownerId, sessionId: args.sessionId });
      if (existing) return existing;
      if (session.state !== 'active' || session.expiresAt <= now()) throw error('session_mismatch');
      const data = await call('prepare_order', { sessionId: args.sessionId, expectedContextId: session.browserContextId, expectedProfileId: session.profileId });
      if (data.sessionId !== args.sessionId) throw error('session_mismatch');
      if (data.status === 'manual_review_required') return data;
      const { approvalNonce: _approvalNonce, ...record } = await purchaseStore.create({ ownerId, conversationId, sessionId: args.sessionId, workerOrder: data.order });
      return record;
    }
    return purchaseStore.get({ ownerId, purchaseId: args.purchaseId });
  };
  const handler = async (req, res) => {
    try {
      if (req.method !== 'POST' || !['/worker/poll', '/worker/result'].includes(req.url)) return send(res, 404, { error: 'not_found' });
      const message = await readJson(req);
      if (req.url.endsWith('/poll') !== (message.operation === 'poll')) throw error('operation_rejected');
      const response = accept(message);
      return send(res, 200, response);
    } catch (cause) { return send(res, 400, { error: cause.code || cause.message || 'worker_request_rejected' }); }
  };
  return { call, invokeTool, handler, accept, online, reconcile, onWorkerOnline(listener){onWorkerOnline=listener;} };
}

export function createShoppingWorkerHttpServer(gateway) { return http.createServer(gateway.handler); }
