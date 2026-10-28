import {openNonStore} from './store.mjs';
import {createDesireCore} from './desire-engine.mjs';
import {DRIVE_KEYS} from './drive.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Internal only. No HTTP route, scheduler, second model, or prompt consumer.
// One transaction and one identity per authoritative turn. The caller must
// first validate the hidden tag from the complete frontend tool payload.
export function createThoughtAuthoring({path,now=Date.now,openStore=openNonStore}={}) {
  return async function recordThought({turnId,thought}) {
    if (!UUID.test(turnId) || !thought || !DRIVE_KEYS.includes(thought.dimension) ||
        typeof thought.text !== 'string' || !thought.text.trim() ||
        [...thought.text].length > 120) throw new TypeError('invalid authored Thought');
    if (!path) throw new Error('Non Desire store unavailable');
    const at=now();
    let store;
    try {
      store=await openStore({path,now,busyTimeoutMs:50});
      const outcome=store.applyDesireShadowEvent({eventId:`${turnId}:thought_authored`,turnId,
        eventType:'thought_authored',occurredAt:at},stagingStore=>{
        const existing=stagingStore.loadDesire().state;
        const effectiveAt=Math.max(at,existing?.lastUpdatedAt ?? at);
        createDesireCore({store:stagingStore,now}).experience({text:thought.text,
          dimension:thought.dimension,source:'claude_authored',id:`${turnId}:thought`,at:effectiveAt});
        return {written:true};
      });
      return {written:!outcome.duplicate,duplicate:outcome.duplicate};
    } finally {store?.close();}
  };
}
