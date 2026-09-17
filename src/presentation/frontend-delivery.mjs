import { randomUUID } from 'node:crypto';

export function validateFrontendText(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== 1 || typeof value.text !== 'string' ||
      !value.text.trim() || value.text.length > 16384) {
    throw Object.assign(new Error('Expected only a nonempty text string (max 16384 characters)'), { statusCode: 400 });
  }
  return value.text;
}

// Bind before reading the request body. A delayed request can never jump to a newer turn.
export function createFrontendDelivery({ turnStore, runtimeId }) {
  const seen = new Map();
  return {
    bind() {
      const turn = turnStore.get();
      if (!turn || turn.runtimeId !== runtimeId || turn.state !== 'running' || turn.closed) {
        throw Object.assign(new Error('No active frontend turn'), { statusCode: 409 });
      }
      return (body, requestId) => {
        const text = validateFrontendText(body);
        if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(requestId)) {
          throw Object.assign(new Error('Invalid delivery request identity'), { statusCode: 400 });
        }
        if (turnStore.get() !== turn || turn.state !== 'running' || turn.closed) {
          throw Object.assign(new Error('Frontend turn has ended or is stopping'), { statusCode: 409 });
        }
        const previous = seen.get(requestId);
        if (previous) {
          if (previous.turn !== turn || previous.text !== text) throw Object.assign(new Error('Stale delivery identity'), { statusCode: 409 });
          return { ok: true, messageId: previous.messageId, duplicate: true };
        }
        if ((turn.frontendDeliveries || 0) >= 256) throw Object.assign(new Error('Turn delivery limit reached'), { statusCode: 429 });
        const messageId = randomUUID();
        seen.set(requestId, { turn, text, messageId });
        if (seen.size > 2048) seen.delete(seen.keys().next().value);
        turn.frontendDeliveries = (turn.frontendDeliveries || 0) + 1;
        turnStore.emit(runtimeId, turn.turnId, { type: 'assistant_message', turnId: turn.turnId, messageId, text, source: 'tool' });
        return { ok: true, messageId };
      };
    }
  };
}
