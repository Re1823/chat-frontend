import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { mkdir, readFile, writeFile, rename, chmod, unlink } from 'node:fs/promises';
import initSqlJs from 'sql.js';

export const ALBUM_ID_PATTERN = /^alb_[A-Za-z0-9_-]{32}$/;
export const PHOTO_ID_PATTERN = /^photo_[A-Za-z0-9_-]{32}$/;
const require = createRequire(import.meta.url);
const token = prefix => `${prefix}_${randomBytes(24).toString('base64url')}`;
const fail = (code, statusCode = 400) => Object.assign(new Error(code), { code, statusCode });
const rows = result => result?.[0] ? result[0].values.map(values => Object.fromEntries(result[0].columns.map((name, index) => [name, values[index]]))) : [];

export async function createPhotosStore({ dbPath, storageDir, imageStore, now = () => Date.now() } = {}) {
  if (!dbPath || !storageDir || !imageStore) throw new Error('Photos storage configuration is required');
  await mkdir(dirname(dbPath), { recursive: true, mode: 0o700 });
  await mkdir(join(storageDir, 'images'), { recursive: true, mode: 0o700 });
  await mkdir(join(storageDir, 'thumbnails'), { recursive: true, mode: 0o700 });
  const wasm = require.resolve('sql.js/dist/sql-wasm.wasm');
  const SQL = await initSqlJs({ locateFile: () => wasm });
  let databaseBytes = null;
  try { databaseBytes = await readFile(dbPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const db = databaseBytes ? new SQL.Database(databaseBytes) : new SQL.Database();
  db.run(`PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS albums (id TEXT PRIMARY KEY, name TEXT NOT NULL, mood TEXT, note TEXT, created_at INTEGER NOT NULL, created_by TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS photos (id TEXT PRIMARY KEY, storage_key TEXT NOT NULL UNIQUE, mime TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, byte_size INTEGER NOT NULL, note TEXT, saved_at INTEGER NOT NULL, source_type TEXT NOT NULL, source_turn_id TEXT, source_message_id TEXT, saved_by TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS album_photos (album_id TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE, photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE, position INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(album_id,photo_id));
    CREATE INDEX IF NOT EXISTS idx_photos_saved_at ON photos(saved_at DESC);
    CREATE INDEX IF NOT EXISTS idx_album_photos_album_position ON album_photos(album_id,position);`);
  let writes = Promise.resolve();
  const persist = async () => {
    const temp = `${dbPath}.tmp`;
    await writeFile(temp, Buffer.from(db.export()), { mode: 0o600 });
    await rename(temp, dbPath); await chmod(dbPath, 0o600);
  };
  if (!databaseBytes) await persist();
  const serialized = operation => { const result = writes.then(operation); writes = result.catch(() => {}); return result; };
  const validateAlbum = id => { if (id != null && !ALBUM_ID_PATTERN.test(String(id))) throw fail('invalid_album_id'); };
  const validatePhoto = id => { if (!PHOTO_ID_PATTERN.test(String(id || ''))) throw fail('invalid_photo_id'); };
  const albumExists = id => rows(db.exec('SELECT id FROM albums WHERE id=$id', { $id: id })).length > 0;
  const photoProjection = `SELECT p.id AS photoId,p.mime,p.width,p.height,p.byte_size AS byteSize,p.note,p.saved_at AS savedAt,p.source_type AS sourceType,p.source_turn_id AS sourceTurnId,p.source_message_id AS sourceMessageId,p.saved_by AS savedBy,ap.album_id AS albumId,a.name AS albumName FROM photos p LEFT JOIN album_photos ap ON ap.photo_id=p.id LEFT JOIN albums a ON a.id=ap.album_id`;
  return {
    dbPath, storageDir,
    createAlbum({ name, mood = null, note = null, createdBy = 'user' }) {
      return serialized(async () => {
        name = String(name || '').trim(); mood = mood == null ? null : String(mood).trim(); note = note == null ? null : String(note).trim();
        if (!name || name.length > 80 || (mood && mood.length > 24) || (note && note.length > 500) || !['user', 'assistant'].includes(createdBy)) throw fail('invalid_album');
        const id = token('alb'), createdAt = now();
        db.run('INSERT INTO albums(id,name,mood,note,created_at,created_by) VALUES(?,?,?,?,?,?)', [id, name, mood, note, createdAt, createdBy]); await persist();
        return { albumId: id, name, mood, note, createdAt, createdBy, photoCount: 0 };
      });
    },
    listAlbums() {
      return rows(db.exec(`SELECT a.id AS albumId,a.name,a.mood,a.note,a.created_at AS createdAt,a.created_by AS createdBy,COUNT(ap.photo_id) AS photoCount FROM albums a LEFT JOIN album_photos ap ON ap.album_id=a.id GROUP BY a.id ORDER BY a.created_at DESC`));
    },
    listPhotos({ albumId = null, limit = 100, offset = 0 } = {}) {
      validateAlbum(albumId); limit = Math.min(100, Math.max(1, Number(limit) || 100)); offset = Math.max(0, Number(offset) || 0);
      const where = albumId ? ' WHERE ap.album_id=$albumId' : '';
      return rows(db.exec(`${photoProjection}${where} ORDER BY p.saved_at DESC LIMIT $limit OFFSET $offset`, { $albumId: albumId, $limit: limit, $offset: offset })).map(photo => ({ ...photo, thumbnailUrl: `/api/photos/${photo.photoId}/thumbnail`, contentUrl: `/api/photos/${photo.photoId}/content` }));
    },
    getPhoto(photoId) { validatePhoto(photoId); const photo = rows(db.exec(`${photoProjection} WHERE p.id=$id`, { $id: photoId }))[0]; return photo ? { ...photo, thumbnailUrl: `/api/photos/${photo.photoId}/thumbnail`, contentUrl: `/api/photos/${photo.photoId}/content` } : null; },
    async readPhoto(photoId, variant = 'content') {
      const photo = this.getPhoto(photoId); if (!photo) throw fail('photo_not_found', 404);
      const suffix = variant === 'thumbnail' ? 'thumbnails' : 'images';
      return { data: await readFile(join(storageDir, suffix, `${photoId}.bin`)), mime: photo.mime, metadata: photo };
    },
    promote({ imageId, albumId = null, note = null, sourceTurnId = null, sourceMessageId = null, savedBy = 'user' }) {
      return serialized(async () => {
        validateAlbum(albumId); if (albumId && !albumExists(albumId)) throw fail('album_not_found', 404);
        note = note == null ? null : String(note).trim(); if ((note && note.length > 1000) || !['user', 'assistant'].includes(savedBy)) throw fail('invalid_photo_metadata');
        const photoId = token('photo'), contentPath = join(storageDir, 'images', `${photoId}.bin`), thumbnailPath = join(storageDir, 'thumbnails', `${photoId}.bin`);
        const meta = await imageStore.copyTo(imageId, contentPath, thumbnailPath);
        try {
          const savedAt = now(); db.run('BEGIN');
          db.run('INSERT INTO photos(id,storage_key,mime,width,height,byte_size,note,saved_at,source_type,source_turn_id,source_message_id,saved_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', [photoId, photoId, meta.mime, meta.width, meta.height, meta.byteSize, note, savedAt, 'chat', sourceTurnId, sourceMessageId, savedBy]);
          if (albumId) db.run('INSERT INTO album_photos(album_id,photo_id,position) VALUES(?,?,COALESCE((SELECT MAX(position)+1 FROM album_photos WHERE album_id=?),0))', [albumId, photoId, albumId]);
          db.run('COMMIT'); await persist();
          return this.getPhoto(photoId);
        } catch (error) { try { db.run('ROLLBACK'); } catch {} await Promise.allSettled([unlink(contentPath), unlink(thumbnailPath)]); throw error; }
      });
    },
    close() { db.close(); }
  };
}
