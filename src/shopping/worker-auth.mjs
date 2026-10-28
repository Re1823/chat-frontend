import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { SHOPPING_TRANSPORT, WORKER_OPERATIONS } from './contracts.mjs';

const OPERATIONS = [...WORKER_OPERATIONS, 'poll', 'idle', 'result', 'execute_approved_purchase', 'reconcile_worker_request'];
const validDirection = message => message.role === 'worker'
  ? (message.operation === 'poll' && message.responseTo === null) || (message.operation === 'result' && /^[0-9a-f-]{36}$/.test(message.responseTo || ''))
  : (message.operation === 'idle' || message.operation === 'execute_approved_purchase' || message.operation === 'reconcile_worker_request' || WORKER_OPERATIONS.includes(message.operation)) && message.responseTo === null;
const canonical = message => JSON.stringify([message.version, message.role, message.workerId, message.requestId, message.responseTo || null, message.timestamp, message.nonce, message.operation, message.payload]);
const mac = (secret, message) => createHmac('sha256', secret).update(canonical(message)).digest('hex');
const validSecret = secret => typeof secret === 'string' && Buffer.byteLength(secret) >= 32;

export function signWorkerMessage({ secret, role, workerId, operation, responseTo = null, payload, now = Date.now() }) {
  if (!validSecret(secret) || !['vps', 'worker'].includes(role) || !/^[A-Za-z0-9_-]{1,80}$/.test(workerId) || !OPERATIONS.includes(operation) || !validDirection({ role, operation, responseTo })) throw new TypeError('invalid_worker_message');
  const message = { version: SHOPPING_TRANSPORT.version, role, workerId, requestId: randomUUID(), responseTo, timestamp: now, nonce: randomUUID(), operation, payload };
  if (Buffer.byteLength(canonical(message)) > SHOPPING_TRANSPORT.maxBodyBytes) throw new RangeError('worker_message_too_large');
  return { ...message, signature: mac(secret, message) };
}

export function createWorkerVerifier({ secret, workerId, expectedRole, now = Date.now, seen }) {
  if (!validSecret(secret)) throw new TypeError('worker_secret_required');
  if (!['vps', 'worker'].includes(expectedRole)) throw new TypeError('worker_role_required');
  if (!seen || typeof seen.has !== 'function' || typeof seen.set !== 'function' || typeof seen.delete !== 'function' || typeof seen[Symbol.iterator] !== 'function') throw new TypeError('replay_store_required');
  return message => {
    if (!message || message.version !== SHOPPING_TRANSPORT.version || message.role !== expectedRole || message.workerId !== workerId || !OPERATIONS.includes(message.operation) || !validDirection(message) || !/^[0-9a-f-]{36}$/.test(message.requestId || '') || !/^[0-9a-f-]{36}$/.test(message.nonce || '') || !Number.isSafeInteger(message.timestamp) || Math.abs(now() - message.timestamp) > SHOPPING_TRANSPORT.maxSkewMs) throw new Error('worker_message_rejected');
    if (Buffer.byteLength(canonical(message)) > SHOPPING_TRANSPORT.maxBodyBytes || !/^[0-9a-f]{64}$/.test(message.signature || '')) throw new Error('worker_message_rejected');
    const expected = Buffer.from(mac(secret, message), 'hex');
    if (!timingSafeEqual(expected, Buffer.from(message.signature, 'hex'))) throw new Error('worker_message_rejected');
    for (const [nonce, expires] of seen) if (expires <= now()) seen.delete(nonce);
    if (seen.has(message.nonce)) throw new Error('worker_message_replayed');
    seen.set(message.nonce, now() + SHOPPING_TRANSPORT.maxSkewMs);
    return { requestId: message.requestId, responseTo: message.responseTo, operation: message.operation, payload: message.payload };
  };
}
