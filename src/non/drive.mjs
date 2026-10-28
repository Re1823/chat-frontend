// Non specification §9 / tutorial 13-14/18. v2 adds touch and joy without
// publishing their rates. No intent selection or prompt rendering lives here.
export const DRIVE_KEYS = Object.freeze([
  'possess', 'monitor', 'crave', 'share', 'libido', 'curiosity',
  'boredom', 'social', 'duty', 'reflection', 'grieve', 'anger',
  'touch', 'joy'
]);
export const KNOWN_GROW_PER_HOUR = Object.freeze({
  possess: .105, monitor: .090, crave: .060, share: .045,
  libido: .020, curiosity: .030, boredom: .030, social: .025,
  duty: .022, reflection: .013, grieve: 0, anger: 0
});
export const SATURATE_CEIL = .80;
export const SATURATE_FLOOR = .65;
export const INTENT_CANDIDATE_BAND = .12;
export const APPROX_INTENT_STABILITY_MS = 5 * 60_000;

// QIUQIU IMPLEMENTATION CHOICE. Non did not publish these values. Configuration
// changes are deliberate development actions; Drive never writes its config.
export const QIUQIU_DESIRE_CONFIG = Object.freeze({
  initialValue: .10,
  touchGrowPerHour: .040,
  joyGrowPerHour: .030,
  highDecayPerHour: .060,
  joyHighDecayPerHour: .120,
  fatigueGainPerHour: .030,
  fatigueRecoverPerHour: .050,
  fatigueGrowthPenalty: .50,
  catchupCapMs: 6 * 3_600_000,
  thoughtTickMs: 5 * 60_000,
  fixationPickBonus: .15,
  intentStabilityMs: APPROX_INTENT_STABILITY_MS,
  satisfaction: Object.freeze({
    physical_affection: Object.freeze({touch:.40, crave:.85}),
    good_event: Object.freeze({joy:.35, boredom:.85}),
    successful_contact: Object.freeze({crave:.60, social:.70, possess:.80}),
    closeness: Object.freeze({possess:.70, touch:.80, crave:.80}),
    sharing: Object.freeze({share:.50, social:.85}),
    curiosity_fulfilled: Object.freeze({curiosity:.45}),
    duty_completed: Object.freeze({duty:.50}), // Non direct: duty ×.50.
    monitor_checked: Object.freeze({monitor:.70}), // Non direct: monitor ×.70.
    libido_satisfied: Object.freeze({libido:.35}),
    reading: Object.freeze({reflection:.70, boredom:.80}),
    grief_processed: Object.freeze({grieve:.60}),
    anger_processed: Object.freeze({anger:.60})
  })
});

export function initialQiuqiuDrive(config = QIUQIU_DESIRE_CONFIG) {
  const values = Object.fromEntries(DRIVE_KEYS.map(key => [key, key === 'grieve' || key === 'anger' ? 0 : config.initialValue]));
  return createDriveState(values);
}

export function advanceQiuqiuDrive(values, highModes, fatigue, hours, beijingHour,
  config = QIUQIU_DESIRE_CONFIG) {
  if (!Number.isFinite(hours) || hours < 0 || !Number.isFinite(fatigue) || fatigue < 0 || fatigue > 1) throw new RangeError('invalid drive interval');
  const next = createDriveState(values), modes = {...highModes};
  let highCount = 0;
  for (const key of DRIVE_KEYS) {
    if (next[key] == null) throw new Error(`NON_DRIVE_INITIAL_VALUE_UNAVAILABLE:${key}`);
    if (modes[key] || next[key] >= SATURATE_CEIL) highCount++;
    if (isNightFrozen(key, beijingHour)) continue; // Non direct Beijing freeze.
    if (modes[key] || next[key] >= SATURATE_CEIL) {
      modes[key] = true;
      const rate = key === 'joy' ? config.joyHighDecayPerHour : config.highDecayPerHour;
      next[key] = Math.max(SATURATE_FLOOR, next[key] - rate * hours);
      if (next[key] <= SATURATE_FLOOR) modes[key] = false;
    } else {
      const rate = key === 'touch' ? config.touchGrowPerHour : key === 'joy' ? config.joyGrowPerHour : KNOWN_GROW_PER_HOUR[key];
      next[key] = Math.min(SATURATE_CEIL, next[key] + rate * hours * (1 - config.fatigueGrowthPenalty * fatigue));
      if (next[key] >= SATURATE_CEIL) modes[key] = true;
    }
  }
  const nextFatigue = Math.max(0, Math.min(1, fatigue + (highCount ? config.fatigueGainPerHour : -config.fatigueRecoverPerHour) * hours));
  return {values:next, highModes:modes, fatigue:nextFatigue};
}

export function satisfyQiuqiuEvent(values, event, config = QIUQIU_DESIRE_CONFIG) {
  const factors = config.satisfaction[event];
  if (!factors) throw new TypeError('unknown satisfaction event');
  const next = createDriveState(values);
  for (const [key, factor] of Object.entries(factors)) {
    if (!DRIVE_KEYS.includes(key) || !Number.isFinite(factor) || factor <= 0 || factor > 1) throw new RangeError('invalid satisfaction factor');
    if (next[key] == null) throw new Error(`NON_DRIVE_INITIAL_VALUE_UNAVAILABLE:${key}`);
    next[key] = Math.max(0, Math.min(1, next[key] * factor));
  }
  return next;
}

// Preset subjective feelings only. These contain no action commands, numbers,
// thought text, or raw Drive state; no caller here injects them into Claude.
export const QIUQIU_SUBJECTIVE_VOICE = Object.freeze({
  possess:'我有点想和她靠近，想确认那份亲近还在。',
  monitor:'我心里惦记着她的近况。',
  crave:'我有点想念她，想听见她的声音。',
  share:'我有件事想和她分享。',
  libido:'我心里有些亲密的渴望。',
  curiosity:'我对眼前的事有点好奇。',
  boredom:'我有点无聊，想找点新鲜的感受。',
  social:'我有点想和她说说话。',
  duty:'我心里还记着要做的事。',
  reflection:'我想安静地理一理自己的想法。',
  grieve:'我心里有些难过。',
  anger:'我心里有些不平静。',
  touch:'我有点想靠近她，想碰一碰她。',
  joy:'我想起一件好事，心里亮了一下。'
});

export function subjectiveVoice(winner) {
  if (!DRIVE_KEYS.includes(winner)) throw new TypeError('unknown Drive winner');
  return QIUQIU_SUBJECTIVE_VOICE[winner];
}

export function createDriveState(values = {}) {
  for (const key of Object.keys(values)) if (!DRIVE_KEYS.includes(key)) throw new TypeError('unknown drive dimension');
  const state = {};
  for (const key of DRIVE_KEYS) {
    const value = values[key];
    if (value != null && (!Number.isFinite(value) || value < 0 || value > 1)) throw new RangeError('invalid drive value');
    state[key] = value ?? null; // No undocumented starting value.
  }
  return state;
}

export function growKnownDrives(state, hours) {
  if (!Number.isFinite(hours) || hours < 0) throw new RangeError('invalid elapsed hours');
  const next = createDriveState(state);
  for (const [key, rate] of Object.entries(KNOWN_GROW_PER_HOUR)) {
    if (rate === 0) continue; // grieve / anger are feel-driven, not time-grown.
    if (next[key] == null) throw new Error(`NON_DRIVE_INITIAL_VALUE_UNAVAILABLE:${key}`);
    // Non §9: reaching .80 enters a separate decay state. Its fall rate is
    // unknown, so this function refuses to advance a high dimension.
    if (next[key] >= SATURATE_CEIL && hours > 0) throw new Error(`NON_HIGH_STATE_DECAY_UNAVAILABLE:${key}`);
    if (hours > 0 && next[key] + rate * hours >= SATURATE_CEIL) throw new Error(`NON_HIGH_STATE_DECAY_UNAVAILABLE:${key}`);
    next[key] = Math.min(1, next[key] + rate * hours);
  }
  return next;
}

export function reachedHighState(value) {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError('invalid drive value');
  return value >= SATURATE_CEIL;
}

// Non specification §9 / tutorial 14/18: Beijing 01:00-08:00 freezes these
// three dimensions. The caller supplies Beijing hour; no clock is read here.
export function isNightFrozen(dimension, beijingHour) {
  if (!Number.isInteger(beijingHour) || beijingHour < 0 || beijingHour > 23) throw new RangeError('invalid Beijing hour');
  return beijingHour >= 1 && beijingHour < 8 && ['possess','libido','crave'].includes(dimension);
}

export function nightPickMultiplier(dimension, isNight) {
  if (typeof isNight !== 'boolean') throw new TypeError('explicit night classification required');
  return isNight && ['possess','libido'].includes(dimension) ? .4 : 1;
}

// Non §9 names exactly these two action multipliers; this is not a satisfy map.
export function satisfyKnownDrive(state, dimension) {
  const factors = {monitor: .70, duty: .50};
  const factor = factors[dimension];
  if (factor == null) throw new Error('NON_SATISFY_ACTION_UNAVAILABLE');
  const next = createDriveState(state);
  if (next[dimension] == null) throw new Error(`NON_DRIVE_INITIAL_VALUE_UNAVAILABLE:${dimension}`);
  next[dimension] *= factor;
  return next;
}

// QIUQIU IMPLEMENTATION CHOICE: candidates within Non's known .12 band of the
// maximum; weighted random, with an injected RNG. Active fixation only changes
// numeric weight. The selected intent is internal and never sends a message.
export function pickIntent(values, {fixations = [], random = Math.random, isNight = false,
  previous = null, at = 0, config = QIUQIU_DESIRE_CONFIG} = {}) {
  const state = createDriveState(values);
  if (previous && at < previous.until && DRIVE_KEYS.includes(previous.winner)) return previous;
  if (typeof random !== 'function' || !Number.isFinite(at)) throw new TypeError('intent inputs required');
  const available = DRIVE_KEYS.filter(key => state[key] != null);
  if (!available.length) return null;
  const highest = Math.max(...available.map(key => state[key]));
  const candidates = available.filter(key => state[key] >= highest - INTENT_CANDIDATE_BAND);
  const weights = candidates.map(key => {
    const fixationStrength = fixations.filter(item => item.dimension === key && item.stage === 'fixation')
      .reduce((sum, item) => sum + Math.max(0, Math.min(1, item.strength)), 0);
    return Math.max(0, state[key] * (1 + config.fixationPickBonus * fixationStrength) * nightPickMultiplier(key, isNight));
  });
  const total = weights.reduce((sum, value) => sum + value, 0);
  const draw = random();
  if (!Number.isFinite(draw) || draw < 0 || draw >= 1) throw new RangeError('random draw must be in [0,1)');
  let target = draw * total, index = 0;
  if (total > 0) {
    for (; index < weights.length - 1; index++) {
      if (target < weights[index]) break;
      target -= weights[index];
    }
  } else index = Math.min(candidates.length - 1, Math.floor(draw * candidates.length));
  return {winner:candidates[index], pickedAt:at, until:at + config.intentStabilityMs};
}
