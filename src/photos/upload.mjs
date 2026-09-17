import Busboy from 'busboy';

const fail = (code, statusCode = 400) => Object.assign(new Error(code), { code, statusCode });

export function receiveImageUpload(req, limits) {
  return new Promise((resolve, reject) => {
    let parser;
    try { parser = Busboy({ headers: req.headers, limits: { files: limits.maxFiles, fileSize: limits.maxFileBytes, fields: 0, parts: limits.maxFiles } }); }
    catch { return reject(fail('invalid_multipart')); }
    const files = []; let total = 0, settled = false;
    const abort = error => { if (settled) return; settled = true; req.unpipe(parser); reject(error); };
    parser.on('file', (_field, stream, info) => {
      const chunks = []; let bytes = 0, truncated = false;
      stream.on('limit', () => { truncated = true; });
      stream.on('data', chunk => { bytes += chunk.length; total += chunk.length; if (total > limits.maxTotalBytes) abort(fail('images_total_too_large', 413)); else chunks.push(chunk); });
      stream.on('end', () => { if (!settled) { if (truncated || bytes > limits.maxFileBytes) return abort(fail('image_too_large', 413)); files.push({ data: Buffer.concat(chunks), mime: String(info.mimeType || '').toLowerCase() }); } });
    });
    parser.on('filesLimit', () => abort(fail('too_many_images', 413)));
    parser.on('partsLimit', () => abort(fail('too_many_images', 413)));
    parser.on('error', () => abort(fail('invalid_multipart')));
    parser.on('finish', () => { if (settled) return; settled = true; if (!files.length) reject(fail('no_images')); else resolve(files); });
    req.pipe(parser);
  });
}
