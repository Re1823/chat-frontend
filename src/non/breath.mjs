// Non specification §7 / tutorial 16/18. These only construct lexical queries.
// The lexical primitives below have no production chat or provider connection.
import {sixGramDice, QIUQIU_NEAR_THRESHOLD} from './mind-tags.mjs';

// QIUQIU IMPLEMENTATION CHOICE: only examples explicitly named in Non tutorial
// 16/18. This is not claimed to be the author's complete stopword collection.
export const QIUQIU_STOP_FRAGMENTS = Object.freeze(['什么', '时候', '早上', '记得']);
export const QIUQIU_NOUN_WHITELIST = Object.freeze([]);
const normalized = text => text.normalize('NFKC').toLowerCase();

export function englishBigrams(text) {
  if (typeof text !== 'string') throw new TypeError('message required');
  // QIUQIU IMPLEMENTATION CHOICE: punctuation separates segments; no bigram
  // crosses punctuation or a sentence boundary. Whitespace separates tokens.
  const segments = normalized(text).match(/[a-z0-9]+(?:\s+[a-z0-9]+)*/g) ?? [];
  return segments.flatMap(segment => {
    const tokens = segment.trim().split(/\s+/);
    return tokens.slice(0, -1).map((token, index) => `${token} ${tokens[index + 1]}`);
  });
}

export function prepareBreathQuery(message, {nounWhitelist = QIUQIU_NOUN_WHITELIST,
  stopFragments = QIUQIU_STOP_FRAGMENTS} = {}) {
  if (typeof message !== 'string' || !Array.isArray(nounWhitelist) || !Array.isArray(stopFragments)) throw new TypeError('Breath query input required');
  const text = normalized(message);
  const hanCount = [...text.matchAll(/\p{Script=Han}/gu)].length;
  const whitelistHits = nounWhitelist.map(normalized).filter(term => term && text.includes(term));
  if (hanCount < 2 && !whitelistHits.length) return {eligible:false, hanCount, whitelistHits:[], terms:[]};
  let reduced = text;
  for (const fragment of stopFragments.map(normalized)) {
    if (fragment) reduced = reduced.replaceAll(fragment, ' ');
  }
  const han = (reduced.match(/\p{Script=Han}+/gu) ?? []).flatMap(chunk => {
    const chars = [...chunk], terms = [];
    for (let size = 2; size <= 3; size++) for (let index = 0; index <= chars.length - size; index++) terms.push(chars.slice(index, index + size).join(''));
    return terms;
  });
  const terms = [...new Set([...whitelistHits, ...han, ...englishBigrams(reduced)])];
  return {eligible:terms.length > 0, hanCount, whitelistHits, terms};
}

export function requireBreathContextGate(contextGate = 'none') {
  if (contextGate === 'none') return;
  if (contextGate === 'writing' || contextGate === 'relationship-history') {
    // Non tutorial 16/18: these gates outrank pinned/weight. No classifier is frozen.
    throw new Error('NON_CONTEXT_GATE_BLOCKED');
  }
  throw new TypeError('unknown Breath context gate');
}

// QIUQIU IMPLEMENTATION CHOICE: input arrays are already in deterministic
// candidate order. LIKE, then FTS, then calibrated semantic; merge by kind/id.
export function mergeBreathCandidates({like = [], fts = [], semantic = [], limit,
  calibrationApproved = false, contextGate = 'none'} = {}) {
  requireBreathContextGate(contextGate);
  if (!Number.isInteger(limit) || limit < 0) throw new RangeError('Breath limit required');
  if (!Array.isArray(like) || !Array.isArray(fts) || !Array.isArray(semantic)) throw new TypeError('candidate arrays required');
  if (semantic.length && calibrationApproved !== true) throw new Error('NON_SEMANTIC_UNCALIBRATED');
  const result = [], seen = new Map();
  const add = (candidate, channel) => {
    if (!candidate || !['feel','memory','dream'].includes(candidate.kind) || typeof candidate.id !== 'string' || !candidate.id) throw new TypeError('invalid Breath candidate');
    const key = `${candidate.kind}\u0000${candidate.id}`;
    if (seen.has(key)) { seen.get(key).channels.push(channel); return; }
    if (result.length >= limit) return;
    const merged = {...candidate, channels:[channel]};
    seen.set(key, merged);
    result.push(merged);
  };
  for (const candidate of like) add(candidate, 'like');
  for (const candidate of fts) add(candidate, 'fts');
  // Semantic is fill-only; no semantic result can displace a lexical candidate.
  for (const candidate of semantic) add(candidate, 'semantic');
  return result;
}

// QIUQIU IMPLEMENTATION CHOICE: same-kind, same UTC hour, 6-gram multiset Dice
// >.60; preserve the FIRST INPUT CANDIDATE, never sort by created_at.
export function keepFirstSameHourSimilar(candidates) {
  if (!Array.isArray(candidates)) throw new TypeError('candidate array required');
  const kept = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate.body !== 'string' || !Number.isFinite(candidate.created_at)) throw new TypeError('candidate body/time required');
    const hour = Math.floor(candidate.created_at / 3_600_000);
    if (!kept.some(first => first.kind === candidate.kind && Math.floor(first.created_at / 3_600_000) === hour &&
      sixGramDice(first.body, candidate.body) > QIUQIU_NEAR_THRESHOLD)) kept.push(candidate);
  }
  return kept;
}
export function likePattern(term) {
  if (typeof term !== 'string' || [...term].length < 2) throw new TypeError('LIKE term needs at least two characters');
  return `%${term.replace(/[\\%_]/g, char => `\\${char}`)}%`;
}

export function trigramMatch(term) {
  if (typeof term !== 'string' || [...term].length < 3) throw new TypeError('FTS term needs at least three characters');
  return `"${term.replace(/"/g, '""')}"`;
}

export function semanticBreath() {
  throw new Error('NON_SEMANTIC_BREATH_UNAVAILABLE');
}
