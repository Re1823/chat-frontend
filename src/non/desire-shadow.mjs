import {openNonStore} from './store.mjs';
import {createDesireCore} from './desire-engine.mjs';
import {QIUQIU_DESIRE_CONFIG} from './drive.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TYPES = new Set(['user_message','assistant_message','turn_completed']);
const SATISFACTION = new Set(Object.keys(QIUQIU_DESIRE_CONFIG.satisfaction));
export const DESIRE_SHADOW_FLAGS = Object.freeze({
  SHADOW_ONLY:true,
  AWARENESS_ENABLED:false,
  PROACTIVE_ENABLED:false,
  WHITELIST_RECALL_ENABLED:false
});

function eligible(event) {
  if (!event || !UUID.test(event.turnId || '') || !TYPES.has(event.eventType) ||
      event.source !== 'authoritative_chat' || event.productionTurn !== true ||
      event.role !== (event.eventType === 'user_message' ? 'user' : 'assistant')) return false;
  if (event.replay || event.recovery || event.proactive || event.tool || event.internal) return false;
  // Frontend tool delivery and streaming deltas cannot certify an assistant
  // message as ordinary authoritative chat output.
  if (event.eventType === 'assistant_message' && event.messageSource !== 'authoritative_chat') return false;
  return true;
}

// This observer receives metadata only. Chat content cannot be classified into
// Thoughts by this path; Phase 4 authoring is a separate, explicit capability.
export function createDesireShadow({path, now = Date.now, random = Math.random,
  log = record => console.info(JSON.stringify(record)), openStore = openNonStore} = {}) {
  let chain = Promise.resolve();
  const report = record => { try { log({component:'non_desire_shadow',...record}); } catch {} };
  async function apply(event) {
    const turnId = typeof event?.turnId === 'string' && UUID.test(event.turnId) ? event.turnId : null;
    const eventType = TYPES.has(event?.eventType) ? event.eventType : null;
    const eventId = turnId && eventType ? `${turnId}:${eventType}` : null;
    if (!eligible(event)) {
      report({status:'skipped',turnId,eventId,eventType,reason:'untrusted_source'});
      return {status:'skipped'};
    }
    if (!path) {
      report({status:'skipped',turnId,eventId,eventType,reason:'store_unconfigured'});
      return {status:'skipped'};
    }
    const at = Number.isFinite(event.at) ? event.at : now();
    const satisfaction = event.action?.origin === 'verified_system_event' &&
      SATISFACTION.has(event.action.name) ? event.action.name : null;
    let store;
    try {
      store = await openStore({path,now,busyTimeoutMs:50});
      const outcome = store.applyDesireShadowEvent({eventId,turnId,eventType,occurredAt:at}, stagingStore => {
        const core = createDesireCore({store:stagingStore,now,random});
        core.advance(at);
        if (satisfaction) core.satisfy(satisfaction,{id:`${eventId}:satisfy`,at});
        if (eventType === 'turn_completed') core.selectIntent(at);
        return {thought:'none',satisfaction:satisfaction ?? 'none'};
      });
      const status = outcome.duplicate ? 'duplicate_ignored' : 'accepted';
      report({status,eventId,turnId,eventType,driveUpdated:!outcome.duplicate && outcome.changed,
        thought:outcome.duplicate?'none':outcome.result.thought,
        satisfaction:outcome.duplicate?'none':outcome.result.satisfaction});
      return {status, eventId};
    } catch (error) {
      // Never log exception messages: database errors can contain private data.
      report({status:'error',eventId,turnId,eventType,errorClass:error?.constructor?.name || 'Error'});
      return {status:'error',eventId};
    } finally { try { store?.close(); } catch {} }
  }
  return Object.freeze({
    observe(event) {
      const job = chain.then(() => apply(event));
      chain = job.then(() => undefined, () => undefined);
      return job;
    }
  });
}
