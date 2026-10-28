import { randomUUID } from 'node:crypto';
import {parseThoughtTaggedMessage,stripThoughtTagFromHistory} from '../non/thought-tag.mjs';

export function validateFrontendText(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== 1 || typeof value.text !== 'string' ||
      !value.text.trim() || value.text.length > 16384) {
    throw Object.assign(new Error('Expected only a nonempty text string (max 16384 characters)'), { statusCode: 400 });
  }
  return value.text;
}

// Bind before reading the request body. A delayed request can never jump to a newer turn.
export function createFrontendDelivery({ turnStore, runtimeId, recordThought = null, stickerStore = null,
  onThoughtDiagnostic = () => {} }) {
  const seen = new Map();
  return {
    bindSticker() {
      const turn=turnStore.get();
      if(!turn||turn.runtimeId!==runtimeId||turn.state!=='running'||turn.closed)throw Object.assign(new Error('No active frontend turn'),{statusCode:409});
      return (body,requestId)=>{
        if(!stickerStore)throw Object.assign(new Error('Sticker library unavailable'),{statusCode:503});
        if(!body||Object.keys(body).sort().join(',')!=='stickerId'||typeof body.stickerId!=='string')throw Object.assign(new Error('Expected stickerId'),{statusCode:400});
        if(typeof requestId!=='string'||!/^[A-Za-z0-9_-]{16,128}$/.test(requestId))throw Object.assign(new Error('Invalid delivery request identity'),{statusCode:400});
        if(turnStore.get()!==turn||turn.state!=='running'||turn.closed)throw Object.assign(new Error('Frontend turn has ended'),{statusCode:409});
        const sticker=stickerStore.get(body.stickerId,'assistant');
        const previous=seen.get(requestId);
        if(previous){if(previous.turn!==turn||previous.stickerId!==sticker.id)throw Object.assign(new Error('Stale delivery identity'),{statusCode:409});return {...previous.receipt,duplicate:true}}
        if((turn.frontendDeliveries||0)>=256)throw Object.assign(new Error('Turn delivery limit reached'),{statusCode:429});
        const messageId=randomUUID();turn.frontendDeliveries=(turn.frontendDeliveries||0)+1;
        turnStore.emit(runtimeId,turn.turnId,{type:'assistant_sticker',turnId:turn.turnId,messageId,sticker,source:'tool'});
        const receipt={ok:true,messageId};seen.set(requestId,{turn,stickerId:sticker.id,receipt});if(seen.size>2048)seen.delete(seen.keys().next().value);return receipt;
      };
    },
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
          return previous.receipt instanceof Promise
            ? previous.receipt.then(receipt => ({...receipt,duplicate:true}))
            : {...previous.receipt,duplicate:true};
        }
        if ((turn.frontendDeliveries || 0) >= 256) throw Object.assign(new Error('Turn delivery limit reached'), { statusCode: 429 });
        // QIUQIU ADAPTER: the tool payload is complete before any journal event.
        // Claude tmux does not emit tool text as segment_delta.
        let parsed;
        try { parsed=parseThoughtTaggedMessage(text); }
        catch {
          const visibleText=stripThoughtTagFromHistory(text);
          if (!visibleText.trim()) throw Object.assign(new Error('Hidden tag has no visible reply'),{statusCode:400});
          parsed={visibleText,thought:null,tagged:true,rejected:true};
          try { onThoughtDiagnostic({status:'rejected',turnId:turn.turnId}); } catch {}
        }
        // With no writer wired, a tagged reply stays user-visible after
        // redaction; it never creates a Thought or breaks ordinary chat.
        const messageId = randomUUID();
        const emitVisible = () => {
          if (turnStore.get() !== turn || turn.state !== 'running' || turn.closed) {
            throw Object.assign(new Error('Frontend turn has ended or is stopping'), { statusCode: 409 });
          }
          turn.frontendDeliveries = (turn.frontendDeliveries || 0) + 1;
          turnStore.emit(runtimeId, turn.turnId, { type: 'assistant_message', turnId: turn.turnId,
            messageId, text:parsed.visibleText, source: 'tool' });
          return { ok: true, messageId };
        };
        const receipt = parsed.thought && typeof recordThought === 'function'
          ? Promise.resolve().then(() => recordThought({turnId:turn.turnId,messageId,
              thought:parsed.thought})).catch(error => {
                try { onThoughtDiagnostic({status:'write_failed',turnId:turn.turnId,
                  errorClass:error?.constructor?.name || 'Error'}); } catch {}
              }).then(emitVisible)
          : emitVisible();
        seen.set(requestId, { turn, text, messageId, receipt });
        if (seen.size > 2048) seen.delete(seen.keys().next().value);
        return receipt;
      };
    }
  };
}
