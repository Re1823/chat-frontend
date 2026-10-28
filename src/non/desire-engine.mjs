import {randomUUID} from 'node:crypto';
import {
  DRIVE_KEYS, QIUQIU_DESIRE_CONFIG, initialQiuqiuDrive, advanceQiuqiuDrive,
  satisfyQiuqiuEvent, pickIntent, subjectiveVoice
} from './drive.mjs';
import {
  QIUQIU_THOUGHT_CONFIG, addExperienceThought, evolveThoughtsOneTick,
  clearLibidoFixationsOnRelease
} from './thoughts.mjs';

const HOUR = 3_600_000;
function beijingHour(at) { return new Date(at + 8 * HOUR).getUTCHours(); }

// Explicit, inert state core: no timer, Claude session, prompt, OB, network, or
// proactive action. Only callers that open a separate Non store can persist it.
export function createDesireCore({store, now = Date.now, random = Math.random,
  driveConfig = QIUQIU_DESIRE_CONFIG, thoughtConfig = QIUQIU_THOUGHT_CONFIG} = {}) {
  if (!store?.loadDesire || !store?.saveDesire || typeof now !== 'function' || typeof random !== 'function')
    throw new TypeError('independent Non store and clock required');

  function initialize(at = now()) {
    if (!Number.isFinite(at)) throw new TypeError('timestamp required');
    const loaded = store.loadDesire();
    if (loaded.state) return loaded;
    const state = {values:initialQiuqiuDrive(driveConfig),highModes:{},fatigue:0,
      lastUpdatedAt:at,thoughtRemainderMs:0,lastAppliedMs:0,pick:null,satisfactionEvents:[]};
    store.saveDesire(state,loaded.thoughts);
    return {state,thoughts:loaded.thoughts};
  }

  function advance(at = now()) {
    let {state,thoughts} = initialize(at);
    if (!Number.isFinite(at) || at < state.lastUpdatedAt) throw new RangeError('time cannot move backwards');
    const elapsed = at - state.lastUpdatedAt;
    if (!elapsed) return diagnostic(state,thoughts,at);
    // QIUQIU CHOICE: process only the most recent capped interval after downtime.
    // The discarded interval never replays, so restart cannot explode Drive.
    const applied = Math.min(elapsed,driveConfig.catchupCapMs);
    let cursor = at - applied;
    const next = {...state,values:{...state.values},highModes:{...state.highModes}};
    let remainder = state.thoughtRemainderMs;
    while (cursor < at) {
      const step = Math.min(driveConfig.thoughtTickMs - remainder,at - cursor);
      const tickAt = cursor + step;
      const advanced = advanceQiuqiuDrive(next.values,next.highModes,next.fatigue,
        step / HOUR,beijingHour(cursor + step / 2),driveConfig);
      next.values=advanced.values; next.highModes=advanced.highModes; next.fatigue=advanced.fatigue;
      remainder += step;
      if (remainder >= driveConfig.thoughtTickMs) {
        const evolved = evolveThoughtsOneTick(thoughts,tickAt,thoughtConfig);
        thoughts=evolved.thoughts;
        for (const [dimension,delta] of Object.entries(evolved.feedback))
          next.values[dimension]=Math.min(1,next.values[dimension]+delta);
        remainder=0;
      }
      cursor=tickAt;
    }
    next.thoughtRemainderMs=remainder;
    next.lastUpdatedAt=at;
    next.lastAppliedMs=applied;
    store.saveDesire(next,thoughts);
    return diagnostic(next,thoughts,at);
  }

  function experience({text,dimension,source,id = randomUUID(),at = now()}) {
    advance(at);
    const {state,thoughts}=store.loadDesire();
    const next=addExperienceThought(thoughts,{text,dimension,source,id,at},thoughtConfig);
    store.saveDesire(state,next);
    return diagnostic(state,next,at);
  }

  function satisfy(event,{id,at = now()} = {}) {
    if (typeof id !== 'string' || !id) throw new TypeError('satisfaction event id required');
    advance(at);
    const {state,thoughts}=store.loadDesire();
    if (state.satisfactionEvents.some(item => item.id === id)) return diagnostic(state,thoughts,at);
    const next={...state,values:satisfyQiuqiuEvent(state.values,event,driveConfig),
      satisfactionEvents:[...state.satisfactionEvents,{id,event,at}].slice(-32)};
    const remaining=event === 'libido_satisfied' ? clearLibidoFixationsOnRelease(thoughts) : thoughts;
    // A satisfied high dimension leaves its decay mode when below the floor.
    next.highModes={...state.highModes};
    for (const key of DRIVE_KEYS) if (next.values[key] <= .65) next.highModes[key]=false;
    store.saveDesire(next,remaining);
    return diagnostic(next,remaining,at);
  }

  function selectIntent(at = now()) {
    advance(at);
    const {state,thoughts}=store.loadDesire();
    const pick=pickIntent(state.values,{fixations:thoughts,random,
      isNight:beijingHour(at) >= 1 && beijingHour(at) < 8,
      previous:state.pick,at,config:driveConfig});
    if (pick !== state.pick) store.saveDesire({...state,pick},thoughts);
    return pick ? {winner:pick.winner,pickedAt:pick.pickedAt,until:pick.until} : null;
  }

  function snapshot(at = now()) {
    const {state,thoughts}=store.loadDesire();
    return state ? diagnostic(state,thoughts,at) : null;
  }

  return Object.freeze({initialize,advance,experience,satisfy,selectIntent,snapshot,
    subjectiveVoice});
}

function diagnostic(state,thoughts,timestamp) {
  // Background diagnostic only; never render into Claude context. No thought text.
  return {timestamp,values:{...state.values},winner:state.pick?.winner ?? null,
    activeFixations:thoughts.filter(item => item.stage === 'fixation').length,
    thoughtPoolSize:thoughts.length,lastUpdatedAt:state.lastUpdatedAt,
    appliedElapsedMs:state.lastAppliedMs,satisfactionEvents:[...state.satisfactionEvents]};
}
