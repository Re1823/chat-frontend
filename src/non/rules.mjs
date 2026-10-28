// Non technical specification §§2, 5-9; original tutorial 3/18, 5-7/18,
// 10/18, 13-16/18. v2 overrides the original where explicitly stated.

export const KNOWN_V2_MOODS = Object.freeze([
  'warm', 'sweet', 'calm', 'flutter', 'fire', 'hope', 'joy', 'yearn',
  'fresh', 'rain', 'night', 'weary', 'stuffy', 'grit', 'jolt', 'ache',
  'awkward', 'sour', 'anger', 'clarity'
]);
// The v2 record says 21 moods but names only 20 survivors. The missing name
// remains disabled; do not infer it from OB or silently accept arbitrary names.
export const MOOD_VOCABULARY_COMPLETE = false;
export const HOT_MOODS = Object.freeze(['fire', 'ache', 'jolt', 'yearn']);
export const MIND_ACTIVE_WEIGHT = 0.40;
export const MIND_FADE_WEIGHT = 0.10;

// Non specification §2 / tutorial 5/18: visual strata, with pinned separate.
export function mindStratum({weight, pinned = false}) {
  if (!Number.isFinite(weight) || weight < 0 || weight > 1) throw new RangeError('invalid weight');
  if (pinned) return 'pinned';
  return weight >= MIND_ACTIVE_WEIGHT ? 'active' : weight >= MIND_FADE_WEIGHT ? 'fading' : 'sleeping';
}

export function elapsedHours(fromMs, toMs) {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) throw new RangeError('invalid elapsed time');
  return (toMs - fromMs) / 3_600_000;
}

// Non specification §6 / tutorial 10/18: fixed decrement per elapsed hour.
export function decayWeight({kind, weight, intensity = null, pinned = false}, elapsedHours) {
  if (!['feel', 'memory', 'dream'].includes(kind)) throw new TypeError('unknown mind kind');
  if (!Number.isFinite(weight) || weight < 0 || weight > 1) throw new RangeError('invalid weight');
  if (!Number.isFinite(elapsedHours) || elapsedHours < 0) throw new RangeError('invalid elapsed hours');
  if (pinned || elapsedHours === 0) return weight;
  if (kind === 'dream') return Math.max(0.15, weight - elapsedHours / 12);
  if (kind === 'feel' && (!Number.isInteger(intensity) || intensity < 1 || intensity > 10)) throw new RangeError('feel intensity must be 1..10');
  const divisor = kind === 'feel'
    ? 168 * (0.5 + intensity / 10)
    : 504 * (0.5 + 5 / 10); // Non §6: COALESCE(memory.intensity, 5); memories have no intensity.
  return Math.max(0, weight - elapsedHours / divisor);
}

// Non v2 page 1: message length controls the number of surfaced records.
export function breathLimit(hanCount) {
  if (!Number.isInteger(hanCount) || hanCount < 0) throw new RangeError('invalid Han count');
  return hanCount < 15 ? 3 : hanCount < 30 ? 5 : 8;
}

// Non tutorial 16/18: a hot mood in a cold context needs >=3 lexical hits
// or semantic similarity >=0.85. The context classifier is not published.
export function passesHotMoodGate({moods = [], coldContext, lexicalHits = 0, similarity = null}) {
  if (typeof coldContext !== 'boolean') throw new Error('NON_CONTEXT_CLASSIFIER_UNAVAILABLE');
  if (!coldContext || !moods.some(mood => HOT_MOODS.includes(mood))) return true;
  return lexicalHits >= 3 || (Number.isFinite(similarity) && similarity >= 0.85);
}

// Non v2 page 1: importance order 0,N-1,1,N-2,...
export function uShapeReorder(items) {
  const output = Array(items.length);
  items.forEach((item, index) => { output[index % 2 === 0 ? index / 2 : items.length - 1 - (index - 1) / 2] = item; });
  return output;
}

// Non specification §7: base 30m, +30m per five surfaces, capped at 3h;
// dream base 2h and cap 12h. Pinned entries bypass cooldown.
export function cooldownMs({kind, surfaceCount = 0, pinned = false}) {
  if (!['feel', 'memory', 'dream'].includes(kind)) throw new TypeError('unknown mind kind');
  if (pinned) return 0;
  if (!Number.isInteger(surfaceCount) || surfaceCount < 0) throw new RangeError('invalid surface count');
  const base = kind === 'dream' ? 120 : 30;
  const cap = kind === 'dream' ? 720 : 180;
  return Math.min(cap, base + 30 * Math.floor(surfaceCount / 5)) * 60_000;
}

export function reinforceWeight(weight) {
  if (!Number.isFinite(weight) || weight < 0 || weight > 1) throw new RangeError('invalid weight');
  return Math.min(1, weight + 0.05); // Non §7 / tutorial 16/18.
}

export const NON_SEMANTIC_THRESHOLD = 0.75; // Non §7 / tutorial 16/18.
