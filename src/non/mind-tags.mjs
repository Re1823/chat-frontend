import {KNOWN_V2_MOODS} from './rules.mjs';

const TAG = /<(feel|memory|dream)>([\s\S]*?)<\/\1>/gi;
const ALL_TAG_OPEN = /<(feel|memory|dream)>/gi;
const FIELD = name => new RegExp(`(?:["']?${name}["']?)\\s*:\\s*("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|\\[[^\\]]*\\]|-?\\d+(?:\\.\\d+)?|true|false)`, 'i');

function looseValue(raw) {
  if (raw[0] === '"') { try { return JSON.parse(raw); } catch { return raw.slice(1, -1); } }
  if (raw[0] === "'") return raw.slice(1, -1);
  if (raw[0] === '[') { try { return JSON.parse(raw.replace(/'/g, '"')); } catch { return null; } }
  if (raw === 'true' || raw === 'false') return raw === 'true';
  return Number(raw);
}

// Non tutorial 7/18: JSON first, then regex extraction of named fields.
// A malformed payload that cannot meet validation remains null in its slot.
export function parseMindTagLenient(kind, payload, {allowedMoods = KNOWN_V2_MOODS} = {}) {
  if (!['feel', 'memory', 'dream'].includes(kind)) return null;
  let value;
  try { value = JSON.parse(payload); } catch {
    value = {};
    for (const name of ['body', 'mood', 'moods', 'intensity', 'weight', 'pinned', 'tags', 'title']) {
      const match = FIELD(name).exec(payload);
      if (match) value[name] = looseValue(match[1]);
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.body !== 'string' || !value.body.trim()) return null;
  const body = value.body.trim();
  if (kind === 'dream') {
    if ('mood' in value || 'moods' in value || 'intensity' in value) return null;
    return {kind, body, title: typeof value.title === 'string' ? value.title.trim() : null, weight: 0.5};
  }
  const moods = Array.isArray(value.moods) ? value.moods : value.mood == null ? [] : [value.mood];
  if (!moods.length || moods.some(mood => typeof mood !== 'string' || !allowedMoods.includes(mood))) return null;
  if (kind === 'feel') {
    if (!Number.isInteger(value.intensity) || value.intensity < 1 || value.intensity > 10) return null;
    return {kind, body, moods, mood: moods[0], intensity: value.intensity, weight: 1};
  }
  if ('intensity' in value) return null; // Non tutorial 7/18: memory rejects intensity.
  const weight = value.weight == null ? 1 : value.weight;
  if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0 || weight > 1) return null;
  return {kind, body, moods, mood: moods[0], weight, pinned: value.pinned === true,
    tags: Array.isArray(value.tags) ? value.tags.filter(tag => typeof tag === 'string') : []};
}

// Slots follow every opening tag, including malformed/unclosed tags. This is
// the positional contract from Non tutorial 7/18; no UI wiring is performed.
export function extractMindTagSlots(text, options = {}) {
  const slots = [];
  for (const open of text.matchAll(ALL_TAG_OPEN)) {
    const kind = open[1].toLowerCase();
    const tail = text.slice(open.index);
    const complete = new RegExp(`^<${kind}>([\\s\\S]*?)<\\/${kind}>`, 'i').exec(tail);
    slots.push(complete ? parseMindTagLenient(kind, complete[1], options) : null);
  }
  return slots;
}

export function stripMindTags(text) { return text.replace(TAG, '').replace(/<(?:feel|memory|dream)>[\s\S]*$/i, ''); }

// Non specification §3 / tutorial 7/18: parsing preserves one slot per tag.
// This foundation returns the write candidates; no runtime write is started.
export function applyNonMindTags(text, options = {}) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  return {visibleText: stripMindTags(text), slots: extractMindTagSlots(text, options)};
}

export function isExactDupMind(body, allBodies) {
  if (typeof body !== 'string' || !Array.isArray(allBodies)) throw new TypeError('invalid dedup input');
  return allBodies.includes(body);
}

// QIUQIU IMPLEMENTATION CHOICE, not Non's unpublished near-dedup algorithm.
// NFKC/lowercase/collapsed whitespace; Unicode code-point 6-grams form a
// MULTISET. Dice counts repeated grams with min(leftCount, rightCount).
export const QIUQIU_NEAR_RECENT_N = 20;
export const QIUQIU_NEAR_THRESHOLD = 0.60;
export function normalizeNearBody(body) {
  if (typeof body !== 'string') throw new TypeError('body required');
  return body.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}
function sixGramCounts(body) {
  const chars = [...normalizeNearBody(body)], counts = new Map();
  for (let index = 0; index <= chars.length - 6; index++) {
    const gram = chars.slice(index, index + 6).join('');
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}
export function sixGramDice(left, right) {
  const a = sixGramCounts(left), b = sixGramCounts(right);
  const aCount = [...a.values()].reduce((sum, count) => sum + count, 0);
  const bCount = [...b.values()].reduce((sum, count) => sum + count, 0);
  if (!aCount || !bCount) return 0;
  let shared = 0;
  for (const [gram, count] of a) shared += Math.min(count, b.get(gram) ?? 0);
  return 2 * shared / (aCount + bCount);
}
// recentBodies must be newest first and already restricted to the same kind.
export function isRecentDupMind(body, recentBodies) {
  if (typeof body !== 'string' || !Array.isArray(recentBodies)) throw new TypeError('near-dedup input required');
  return recentBodies.slice(0, QIUQIU_NEAR_RECENT_N)
    .some(other => sixGramDice(body, other) > QIUQIU_NEAR_THRESHOLD);
}
