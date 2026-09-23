export const CLIENT_IMAGE_LIMITS = Object.freeze({
  maxFiles: 4,
  serverFileBytes: 8 * 1024 * 1024,
  serverBatchBytes: 20 * 1024 * 1024,
  safeFileBytes: 6 * 1024 * 1024,
  safeBatchBytes: 16 * 1024 * 1024
});

export const SINGLE_IMAGE_STEPS = Object.freeze([
  Object.freeze({ maxEdge: 1080, quality: 0.70 }),
  Object.freeze({ maxEdge: 960, quality: 0.64 }),
  Object.freeze({ maxEdge: 800, quality: 0.58 }),
  Object.freeze({ maxEdge: 640, quality: 0.52 })
]);

export const MULTI_IMAGE_STEPS = Object.freeze([
  Object.freeze({ maxEdge: 1600, quality: 0.88 }),
  Object.freeze({ maxEdge: 1440, quality: 0.82 }),
  Object.freeze({ maxEdge: 1280, quality: 0.76 }),
  Object.freeze({ maxEdge: 1080, quality: 0.70 }),
  Object.freeze({ maxEdge: 960, quality: 0.64 }),
  Object.freeze({ maxEdge: 800, quality: 0.58 }),
  Object.freeze({ maxEdge: 640, quality: 0.52 })
]);

export function imageBudgetForBatch(count) {
  const safeCount = Math.max(1, Math.min(CLIENT_IMAGE_LIMITS.maxFiles, Number(count) || 1));
  return Math.min(CLIENT_IMAGE_LIMITS.safeFileBytes, Math.floor(CLIENT_IMAGE_LIMITS.safeBatchBytes / safeCount));
}

export function compressionSteps(count) {
  return Number(count) === 1 ? SINGLE_IMAGE_STEPS : MULTI_IMAGE_STEPS;
}

export function scaledSize(width, height, maxEdge) {
  width = Math.max(1, Number(width) || 1); height = Math.max(1, Number(height) || 1);
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

const exifDate = value => {
  const match = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(value || '');
  if (!match) return null;
  const parts = match.slice(1).map(Number), timestamp = new Date(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]).getTime();
  return Number.isFinite(timestamp) && parts[0] >= 1990 && timestamp <= Date.now() + 86400000 ? timestamp : null;
};

export async function extractJpegCapturedAt(file) {
  if (!/jpe?g/i.test(`${file?.type || ''} ${file?.name || ''}`) || typeof file?.slice !== 'function') return null;
  try {
    const bytes = new Uint8Array(await file.slice(0, 512 * 1024).arrayBuffer()), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
    let offset = 2;
    while (offset + 10 < bytes.length) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1], length = view.getUint16(offset + 2, false);
      if (marker === 0xe1 && length >= 10 && String.fromCharCode(...bytes.slice(offset + 4, offset + 10)) === 'Exif\0\0') {
        const tiff = offset + 10, little = view.getUint16(tiff, false) === 0x4949;
        if (!little && view.getUint16(tiff, false) !== 0x4d4d) return null;
        const u16 = at => view.getUint16(at, little), u32 = at => view.getUint32(at, little);
        const readIfd = ifdOffset => { const at = tiff + ifdOffset; if (at < tiff || at + 2 > bytes.length) return []; const count = u16(at), entries=[]; for(let index=0;index<count;index++){const entry=at+2+index*12;if(entry+12>bytes.length)break;entries.push({tag:u16(entry),type:u16(entry+2),count:u32(entry+4),value:u32(entry+8),entry})}return entries };
        const first = readIfd(u32(tiff + 4)), exifPointer = first.find(entry => entry.tag === 0x8769)?.value;
        for (const entry of exifPointer ? readIfd(exifPointer) : first) {
          if (![0x9003, 0x9004].includes(entry.tag) || entry.type !== 2 || entry.count < 19 || entry.count > 64) continue;
          const start = entry.count <= 4 ? entry.entry + 8 : tiff + entry.value;
          if (start < tiff || start + entry.count > bytes.length) continue;
          const timestamp = exifDate(new TextDecoder('ascii').decode(bytes.slice(start, start + entry.count)).replace(/\0.*$/, ''));
          if (timestamp) return timestamp;
        }
        return null;
      }
      if (length < 2) break; offset += 2 + length;
    }
  } catch {}
  return null;
}

async function decodeImage(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close?.() };
    } catch {}
  }
  if (typeof document === 'undefined' || typeof Image === 'undefined') throw new Error('此浏览器无法解码这张图片');
  const url = URL.createObjectURL(file), image = new Image();
  try {
    image.decoding = 'async'; image.src = url; await image.decode();
    return { source: image, width: image.naturalWidth, height: image.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    throw new Error(/heic|heif/i.test(`${file.type} ${file.name}`) ? '这台浏览器无法解码这张 HEIC/HEIF 照片，请在系统中转换为 JPEG 后重试' : '这张图片无法读取，请换一张重试');
  }
}

function jpegBlob(canvas, quality) {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('图片压缩失败')), 'image/jpeg', quality));
}

export async function compressImageForUpload(file, { count = 1, maxBytes = imageBudgetForBatch(count) } = {}) {
  const decoded = await decodeImage(file);
  try {
    if (!decoded.width || !decoded.height) throw new Error('图片尺寸无效');
    let lastBlob = null;
    for (const step of compressionSteps(count)) {
      const size = scaledSize(decoded.width, decoded.height, step.maxEdge);
      const canvas = document.createElement('canvas'); canvas.width = size.width; canvas.height = size.height;
      const context = canvas.getContext('2d', { alpha: false }); if (!context) throw new Error('图片压缩不可用');
      context.fillStyle = '#f8f6f2'; context.fillRect(0, 0, size.width, size.height);
      context.drawImage(decoded.source, 0, 0, size.width, size.height);
      lastBlob = await jpegBlob(canvas, step.quality);
      canvas.width = 1; canvas.height = 1;
      if (lastBlob.size <= maxBytes) {
        const name = String(file.name || 'photo').replace(/\.[^.]+$/, '') + '.jpg';
        return typeof File === 'function' ? new File([lastBlob], name, { type: 'image/jpeg', lastModified: Date.now() }) : lastBlob;
      }
    }
    throw new Error(`压缩后仍超过 ${Math.floor(maxBytes / 1024 / 1024)}MB，请换一张图片`);
  } finally { decoded.close(); }
}
