import { createHash } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const LOCAL_OFFSET_MINUTES = 480;
export const STATE_VERSION = 1;
export const DEFAULT_STATE_DIR = '/root/.local/state/qiuqiu-time-anchor';
export const INSTANCE_MAX_AGE_SECONDS = 30 * 60;
export const LONG_GAP_SECONDS = 2 * 60 * 60;
export const TEMPORAL_CORTEX = 'Let this time check update your understanding of the moment. If the temporal facts change what this situation means, let that change naturally shape your response.';

const TEMPORAL_WORDS = /今天|昨天|明天|刚才|刚刚|早上|上午|中午|下午|晚上|今晚|凌晨|一会儿|过会儿/;
const FORBIDDEN_OUTPUT = /Asia\/Shanghai|Shanghai|China|\bCST\b|\bUTC\b|\+08:00|offset|timezone|server time|VPS location|(?:^|\W)Z(?:$|\W)/i;
const HASH = /^[a-f0-9]{64}$/;
const LOCAL_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

export const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');
export function sessionHash(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('Time Anchor session unavailable');
  return sha256(sessionId);
}
export function instanceHash(instanceKey) {
  if (typeof instanceKey !== 'string' || instanceKey.length < 32) throw new Error('Time Anchor instance unavailable');
  return sha256(instanceKey);
}

function localParts(utcMs) {
  const shifted = new Date(utcMs + LOCAL_OFFSET_MINUTES * 60_000);
  const pad = value => String(value).padStart(2, '0');
  const date = `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
  return { localDate: date, localDateTime: `${date} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}` };
}
export const formatElapsed = seconds => {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  let left = Math.floor(seconds), text = [];
  const days = Math.floor(left / 86400); left %= 86400;
  const hours = Math.floor(left / 3600); left %= 3600;
  const minutes = Math.floor(left / 60); const secs = left % 60;
  if (days) text.push(`${days}d`);
  if (hours) text.push(`${hours}h`);
  if (minutes) text.push(`${minutes}m`);
  if (secs || !text.length) text.push(`${secs}s`);
  return text.join(' ');
};
export const containsTemporalWording = prompt => typeof prompt === 'string' && TEMPORAL_WORDS.test(prompt);

export function buildConversationState({ sessionId, previousState = null, now = new Date(), ambientSampled = false, explicitTemporal = false }) {
  const currentMs = now.getTime();
  if (!Number.isFinite(currentMs)) throw new Error('Time Anchor clock unavailable');
  const hash = sessionHash(sessionId), currentUtc = new Date(currentMs).toISOString();
  const local = localParts(currentMs);
  const previousUtc = previousState?.currentPromptUtc ?? null;
  const previousMs = previousUtc === null ? null : Date.parse(previousUtc);
  if (previousUtc !== null && !Number.isFinite(previousMs)) throw new Error('Invalid Time Anchor state');
  const elapsedSeconds = previousMs === null ? null : Math.max(0, Math.round((currentMs - previousMs) / 1000));
  const dateChanged = previousState ? previousState.localDate !== local.localDate : null;
  const significant = dateChanged === true || (elapsedSeconds !== null && elapsedSeconds >= LONG_GAP_SECONDS);
  return {
    version: STATE_VERSION,
    sessionHash: hash,
    firstPromptUtc: previousState?.firstPromptUtc ?? currentUtc,
    previousPromptUtc: previousUtc,
    currentPromptUtc: currentUtc,
    elapsedSeconds,
    elapsedHuman: elapsedSeconds === null ? null : formatElapsed(elapsedSeconds),
    localOffsetMinutes: LOCAL_OFFSET_MINUTES,
    localDate: local.localDate,
    localDateTime: local.localDateTime,
    previousLocalDateTime: previousState?.localDateTime ?? null,
    localDateChanged: dateChanged,
    anchorDecision: { explicitTemporal: !!explicitTemporal, significant, ambientSampled: !!ambientSampled }
  };
}

export function formatTemporalContext(state, mode) {
  let output = '';
  if (mode === 'attention') output = '[Time Anchor] The user used temporal wording. Consider whether the real local time or elapsed interval changes the meaning of this turn.';
  if (mode === 'ambient') {
    const facts = [`Local time: ${state.localDateTime}.`];
    if (state.elapsedHuman) facts.push(`About ${state.elapsedHuman} have passed since the previous user turn.`);
    if (state.localDateChanged) facts.push('The local calendar date has changed since the previous user turn.');
    output = `[Time Anchor] ${facts.join(' ')} Let these facts shape the response naturally only when relevant; do not mechanically report them.`;
  }
  if (!output || FORBIDDEN_OUTPUT.test(output)) throw new Error('Time Anchor output privacy check failed');
  return output;
}

export function readerPayload(state, now = new Date()) {
  const promptMs = Date.parse(state.currentPromptUtc), nowMs = now.getTime();
  if (!Number.isFinite(promptMs) || !Number.isFinite(nowMs)) throw new Error('Invalid Time Anchor state');
  const payload = {
    localDateTime: localParts(nowMs).localDateTime,
    userPromptLocal: state.localDateTime,
    previousUserPromptLocal: state.previousLocalDateTime,
    elapsedSincePreviousTurn: state.elapsedHuman,
    snapshotAge: formatElapsed(Math.max(0, Math.floor((nowMs - promptMs) / 1000))),
    localDateChanged: state.localDateChanged,
    temporalCortex: TEMPORAL_CORTEX
  };
  const encoded = JSON.stringify(payload);
  if (FORBIDDEN_OUTPUT.test(encoded)) throw new Error('Time Anchor output privacy check failed');
  return payload;
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value), 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  await chmod(temporary, 0o600);
  try { await rename(temporary, path); } finally { await unlink(temporary).catch(() => undefined); }
}
async function readJson(path) { return JSON.parse(await readFile(path, 'utf8')); }
const conversationPath = (baseDir, hash) => join(baseDir, 'conversations', `${hash}.json`);
const instancePath = (baseDir, hash) => join(baseDir, 'instances', `${hash}.json`);

export async function recordPrompt({ sessionId, prompt, instanceKey, baseDir = DEFAULT_STATE_DIR, now = new Date(), randomQuarter = false }) {
  const hash = sessionHash(sessionId), path = conversationPath(baseDir, hash);
  let previous = null;
  try { previous = await readJson(path); } catch (error) { if (error.code !== 'ENOENT') throw new Error('Invalid Time Anchor state'); }
  if (previous && (!validConversationState(previous) || previous.sessionHash !== hash)) throw new Error('Invalid Time Anchor state');
  const explicitTemporal = containsTemporalWording(prompt);
  const state = buildConversationState({ sessionId, previousState: previous, now, ambientSampled: randomQuarter, explicitTemporal });
  const pointer = { version: STATE_VERSION, sessionHash: hash, currentPromptUtc: state.currentPromptUtc, updatedAtUtc: state.currentPromptUtc };
  await atomicJson(path, state);
  await atomicJson(instancePath(baseDir, instanceHash(instanceKey)), pointer);
  const mode = state.previousPromptUtc === null ? null : (state.anchorDecision.significant || randomQuarter ? 'ambient' : (explicitTemporal ? 'attention' : null));
  return { state, additionalContext: mode ? formatTemporalContext(state, mode) : null };
}

export async function readTimeAnchor({ instanceKey, baseDir = DEFAULT_STATE_DIR, now = new Date(), maxPointerAgeSeconds = INSTANCE_MAX_AGE_SECONDS }) {
  let pointer;
  try { pointer = await readJson(instancePath(baseDir, instanceHash(instanceKey))); }
  catch { throw new Error('Time Anchor unavailable'); }
  if (pointer?.version !== STATE_VERSION || !HASH.test(pointer.sessionHash) || typeof pointer.currentPromptUtc !== 'string' || typeof pointer.updatedAtUtc !== 'string') throw new Error('Time Anchor unavailable');
  const pointerMs = Date.parse(pointer.updatedAtUtc), age = (now.getTime() - pointerMs) / 1000;
  if (!Number.isFinite(age) || age < 0 || age > maxPointerAgeSeconds) throw new Error('Time Anchor unavailable');
  let state;
  try { state = await readJson(conversationPath(baseDir, pointer.sessionHash)); } catch { throw new Error('Time Anchor unavailable'); }
  if (!validConversationState(state) || state.sessionHash !== pointer.sessionHash || state.currentPromptUtc !== pointer.currentPromptUtc) throw new Error('Time Anchor unavailable');
  return readerPayload(state, now);
}

function validConversationState(state) {
  return !!state && state.version === STATE_VERSION && HASH.test(state.sessionHash) &&
    typeof state.firstPromptUtc === 'string' && Number.isFinite(Date.parse(state.firstPromptUtc)) &&
    typeof state.currentPromptUtc === 'string' && Number.isFinite(Date.parse(state.currentPromptUtc)) &&
    (state.previousPromptUtc === null || (typeof state.previousPromptUtc === 'string' && Number.isFinite(Date.parse(state.previousPromptUtc)))) &&
    state.localOffsetMinutes === LOCAL_OFFSET_MINUTES && typeof state.localDate === 'string' &&
    LOCAL_DATETIME.test(state.localDateTime) && (state.previousLocalDateTime === null || LOCAL_DATETIME.test(state.previousLocalDateTime)) &&
    (state.elapsedSeconds === null || (Number.isFinite(state.elapsedSeconds) && state.elapsedSeconds >= 0)) &&
    (state.elapsedHuman === null || typeof state.elapsedHuman === 'string') &&
    (state.localDateChanged === null || typeof state.localDateChanged === 'boolean') &&
    !!state.anchorDecision && typeof state.anchorDecision.explicitTemporal === 'boolean' && typeof state.anchorDecision.significant === 'boolean' && typeof state.anchorDecision.ambientSampled === 'boolean';
}
