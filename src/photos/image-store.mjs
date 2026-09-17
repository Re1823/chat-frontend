import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink, chmod, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

export const IMAGE_ID_PATTERN = /^img_[A-Za-z0-9_-]{43}$/;
export const IMAGE_LIMITS = Object.freeze({ maxFiles: 4, maxFileBytes: 8 * 1024 * 1024, maxTotalBytes: 20 * 1024 * 1024, maxPixels: 24_000_000, maxDimension: 12_000, displayEdge: 1600, thumbnailEdge: 360, tempTtlMs: 30 * 60 * 1000, completedTtlMs: 5 * 60 * 1000, maxTempImages: 512, maxTempBytes: 256 * 1024 * 1024 });
const TYPES = Object.freeze({ jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' });

const imageId = () => `img_${randomBytes(32).toString('base64url')}`;
const fail = (code, statusCode = 400) => Object.assign(new Error(code), { code, statusCode });
const sniff = data => {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (data.length >= 12 && data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
};
const safeMeta = record => ({ imageId: record.imageId, mime: record.mime, width: record.width, height: record.height, byteSize: record.byteSize, thumbnailUrl: `/api/chat/images/${record.imageId}/thumbnail`, contentUrl: `/api/chat/images/${record.imageId}/content` });

export function createImageStore({ rootDir, now = () => Date.now(), limits = IMAGE_LIMITS } = {}) {
  if (!rootDir) throw new Error('image store rootDir is required');
  const tempDir = join(rootDir, 'temp');
  const records = new Map();
  const requests = new Map();
  let transitions=0;
  const ready = mkdir(tempDir, { recursive: true, mode: 0o700 }).then(() => chmod(tempDir, 0o700));
  const pathFor = (id, variant) => join(tempDir, `${id}.${variant}`);
  const requireId = id => { if (!IMAGE_ID_PATTERN.test(String(id || ''))) throw fail('invalid_image_id'); return String(id); };
  const remove = async record => {
    records.delete(record.imageId);
    await Promise.allSettled([unlink(record.contentPath), unlink(record.thumbnailPath)]);
  };
  const cleanup = async () => {
    const time = now();
    await Promise.all([...records.values()].filter(record => record.expiresAt <= time).map(remove));
  };
  const encode = async (data, declaredMime) => {
    if (!Buffer.isBuffer(data) || data.length === 0) throw fail('invalid_image');
    if (data.length > limits.maxFileBytes) throw fail('image_too_large', 413);
    const actualMime = sniff(data);
    if (!actualMime || !Object.values(TYPES).includes(declaredMime) || actualMime !== declaredMime) throw fail('unsupported_image_type', 415);
    let source, metadata;
    try {
      source = sharp(data, { failOn: 'error', limitInputPixels: limits.maxPixels, sequentialRead: true });
      metadata = await source.metadata();
    } catch { throw fail('invalid_image', 415); }
    if (!TYPES[metadata.format] || TYPES[metadata.format] !== actualMime || !metadata.width || !metadata.height || metadata.width > limits.maxDimension || metadata.height > limits.maxDimension || metadata.width * metadata.height > limits.maxPixels) throw fail('image_dimensions_exceeded', 413);
    const base = sharp(data, { failOn: 'error', limitInputPixels: limits.maxPixels, sequentialRead: true }).rotate().resize({ width: limits.displayEdge, height: limits.displayEdge, fit: 'inside', withoutEnlargement: true });
    const thumb = sharp(data, { failOn: 'error', limitInputPixels: limits.maxPixels, sequentialRead: true }).rotate().resize({ width: limits.thumbnailEdge, height: limits.thumbnailEdge, fit: 'inside', withoutEnlargement: true });
    let content, thumbnail, mime;
    if (actualMime === 'image/png') { content = await base.png({ compressionLevel: 9 }).toBuffer(); thumbnail = await thumb.png({ compressionLevel: 9 }).toBuffer(); mime = actualMime; }
    else if (actualMime === 'image/webp') { content = await base.webp({ quality: 82 }).toBuffer(); thumbnail = await thumb.webp({ quality: 76 }).toBuffer(); mime = actualMime; }
    else { content = await base.jpeg({ quality: 82, mozjpeg: true }).toBuffer(); thumbnail = await thumb.jpeg({ quality: 76, mozjpeg: true }).toBuffer(); mime = 'image/jpeg'; }
    const safe = await sharp(content, { limitInputPixels: limits.maxPixels }).metadata();
    return { content, thumbnail, mime, width: safe.width, height: safe.height };
  };
  return {
    limits,
    async add({ data, mime }) {
      await ready; await cleanup();
      const normalized = await encode(data, mime);
      const currentBytes = [...records.values()].reduce((total, record) => total + record.byteSize, 0);
      if (records.size >= limits.maxTempImages || currentBytes + normalized.content.length > limits.maxTempBytes) throw fail('image_store_quota_exceeded', 507);
      const id = imageId(), contentPath = pathFor(id, 'image'), thumbnailPath = pathFor(id, 'thumb');
      await writeFile(contentPath, normalized.content, { mode: 0o600, flag: 'wx' });
      try { await writeFile(thumbnailPath, normalized.thumbnail, { mode: 0o600, flag: 'wx' }); }
      catch (error) { await unlink(contentPath).catch(() => {}); throw error; }
      const record = { imageId: id, contentPath, thumbnailPath, mime: normalized.mime, width: normalized.width, height: normalized.height, byteSize: normalized.content.length, createdAt: now(), expiresAt: now() + limits.tempTtlMs, state: 'uploaded', boundTurnId: null, clientRequestId: null };
      records.set(id, record); return safeMeta(record);
    },
    async bind(ids, { turnId, clientRequestId }) {
      transitions++;
      try {
      await cleanup();
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > limits.maxFiles || new Set(ids).size !== ids.length) throw fail('invalid_image_ids');
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(turnId || '')) || !/^[A-Za-z0-9_-]{1,128}$/.test(String(clientRequestId || ''))) throw fail('invalid_turn_binding');
      const prior = requests.get(clientRequestId);
      if (prior) throw fail(prior.turnId === turnId ? 'duplicate_image_turn' : 'client_request_reused', 409);
      const selected = ids.map(id => records.get(requireId(id)));
      if (selected.some(record => !record || record.expiresAt <= now())) throw fail('image_not_found', 404);
      if (selected.some(record => record.state !== 'uploaded')) throw fail('image_already_bound', 409);
      for (const record of selected) Object.assign(record, { state: 'bound', boundTurnId: turnId, clientRequestId });
      requests.set(clientRequestId, { turnId, imageIds: [...ids] });
      return selected.map(safeMeta);
      } finally { transitions--; }
    },
    leaseTurn(turnId, leaseMs) { const expiry=now()+Math.max(0,Number(leaseMs)||0);for(const record of records.values())if(record.boundTurnId===turnId)record.expiresAt=Math.max(record.expiresAt,expiry); },
    async readForTurn(id, turnId, variant = 'content') {
      await cleanup(); const record = records.get(requireId(id));
      if (!record || record.expiresAt <= now()) throw fail('image_not_found', 404);
      if (!turnId || record.boundTurnId !== turnId || !['bound', 'consumed'].includes(record.state)) throw fail('image_not_bound_to_active_turn', 403);
      record.state = 'consumed';
      return { data: await readFile(variant === 'thumbnail' ? record.thumbnailPath : record.contentPath), mime: record.mime, metadata: safeMeta(record) };
    },
    async readPublic(id, variant = 'content') {
      await cleanup(); const record = records.get(requireId(id));
      if (!record || record.expiresAt <= now()) throw fail('image_not_found', 404);
      return { data: await readFile(variant === 'thumbnail' ? record.thumbnailPath : record.contentPath), mime: record.mime, metadata: safeMeta(record) };
    },
    get(id) { const record = records.get(String(id)); return record ? { ...record } : null; },
    async finishTurn(turnId, outcome = 'finished') {
      const expiry = now() + limits.completedTtlMs;
      for (const record of records.values()) if (record.boundTurnId === turnId) Object.assign(record, { state: outcome === 'not_delivered' ? 'uploaded' : 'consumed', expiresAt: outcome === 'not_delivered' ? now() + limits.tempTtlMs : Math.min(record.expiresAt, expiry), ...(outcome === 'not_delivered' ? { boundTurnId: null, clientRequestId: null } : {}) });
    },
    async copyTo(id, destinationContent, destinationThumbnail) {
      const record = records.get(requireId(id)); if (!record || record.expiresAt <= now()) throw fail('image_not_found', 404);
      await copyFile(record.contentPath, destinationContent); await chmod(destinationContent, 0o600);
      try { await copyFile(record.thumbnailPath, destinationThumbnail); await chmod(destinationThumbnail, 0o600); }
      catch (error) { await unlink(destinationContent).catch(() => {}); throw error; }
      return safeMeta(record);
    },
    cleanup,
    quiescence(){return {transitionalImageBindingCount:transitions};},
    _records: records
  };
}
