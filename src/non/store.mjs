import {randomUUID} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import Database from 'better-sqlite3';
import {isExactDupMind, isRecentDupMind, QIUQIU_NEAR_RECENT_N} from './mind-tags.mjs';
import {NON_EMBEDDING_MODEL, NON_EMBEDDING_DIM, validateNonEmbedding} from './embedding.mjs';
import {decayWeight, elapsedHours, reinforceWeight, KNOWN_V2_MOODS} from './rules.mjs';
import {likePattern, trigramMatch} from './breath.mjs';
import {createThought} from './thoughts.mjs';

// Non specification §§1-3, 5-7 / tutorial 3-7/18. Explicit path only:
// importing this module does not create a database or connect to production.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS feels (
  id TEXT PRIMARY KEY, author TEXT NOT NULL, body TEXT NOT NULL,
  mood TEXT NOT NULL, moods_json TEXT NOT NULL, intensity INTEGER NOT NULL CHECK(intensity BETWEEN 1 AND 10),
  weight REAL NOT NULL DEFAULT 1 CHECK(weight BETWEEN 0 AND 1), pinned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, surface_count INTEGER NOT NULL DEFAULT 0, last_surfaced_at INTEGER,
  embedding TEXT, embedding_model TEXT, embedding_dim INTEGER, source TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY, author TEXT NOT NULL, body TEXT NOT NULL,
  mood TEXT NOT NULL, moods_json TEXT NOT NULL, tags_json TEXT NOT NULL DEFAULT '[]',
  weight REAL NOT NULL DEFAULT 1 CHECK(weight BETWEEN 0 AND 1), pinned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, surface_count INTEGER NOT NULL DEFAULT 0, last_surfaced_at INTEGER,
  embedding TEXT, embedding_model TEXT, embedding_dim INTEGER, source TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dreams (
  id TEXT PRIMARY KEY, author TEXT NOT NULL, body TEXT NOT NULL, title TEXT,
  consumed_feel_ids_json TEXT NOT NULL DEFAULT '[]', consumed_memory_ids_json TEXT NOT NULL DEFAULT '[]',
  weight REAL NOT NULL DEFAULT 0.5 CHECK(weight BETWEEN 0 AND 1), pinned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, surface_count INTEGER NOT NULL DEFAULT 0, last_surfaced_at INTEGER,
  embedding TEXT, embedding_model TEXT, embedding_dim INTEGER, source TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
-- Shadow identities contain metadata only; no chat or thought text.
CREATE TABLE IF NOT EXISTS desire_shadow_events (
  event_id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, event_type TEXT NOT NULL,
  occurred_at INTEGER NOT NULL, recorded_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS noun_whitelist (
  normalized TEXT PRIMARY KEY, term TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS thoughts (
  id TEXT PRIMARY KEY, text TEXT NOT NULL, dimension TEXT NOT NULL,
  strength REAL NOT NULL, stage TEXT NOT NULL, fed_count INTEGER NOT NULL,
  source TEXT NOT NULL, embedding TEXT, born_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  age_ticks INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_feels_created ON feels(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dreams_created ON dreams(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_thoughts_dimension ON thoughts(dimension, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_desire_shadow_turn ON desire_shadow_events(turn_id);
`;

// Non §7: three-character trigram FTS5 is a lexical channel. Independent
// FTS tables avoid relying on an undocumented Non D1 rowid arrangement.
function createFts(db, table) {
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${table}_trigram USING fts5(id UNINDEXED, body, tokenize='trigram');
    CREATE TRIGGER IF NOT EXISTS ${table}_fts_insert AFTER INSERT ON ${table} BEGIN
      INSERT INTO ${table}_trigram(id, body) VALUES(new.id, new.body);
    END;
    CREATE TRIGGER IF NOT EXISTS ${table}_fts_delete AFTER DELETE ON ${table} BEGIN
      DELETE FROM ${table}_trigram WHERE id=old.id;
    END;
    CREATE TRIGGER IF NOT EXISTS ${table}_fts_update AFTER UPDATE OF body ON ${table} BEGIN
      DELETE FROM ${table}_trigram WHERE id=old.id;
      INSERT INTO ${table}_trigram(id, body) VALUES(new.id, new.body);
    END;`);
}

const TABLE = Object.freeze({feel: 'feels', memory: 'memories', dream: 'dreams'});
function checkedTable(kind) { const table = TABLE[kind]; if (!table) throw new TypeError('unknown mind kind'); return table; }
function validMoods(entry) {
  return Array.isArray(entry.moods) && entry.moods.length > 0 &&
    entry.mood === entry.moods[0] && entry.moods.every(mood => KNOWN_V2_MOODS.includes(mood));
}
function rowValue(db, sql, values = []) { return db.prepare(sql).get(...values) ?? null; }
function rows(db, sql, values = []) { return db.prepare(sql).all(...values); }

export async function openNonStore({path, now = () => Date.now(), readOnly = false, busyTimeoutMs = null} = {}) {
  if (typeof path !== 'string' || !path || path === ':memory:') throw new TypeError('independent Non database path required');
  if (!readOnly) await mkdir(dirname(path), {recursive: true, mode: 0o700});
  const db = new Database(path,{readonly:readOnly,fileMustExist:readOnly});
  try {
    if (busyTimeoutMs !== null) {
      if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 5000) throw new RangeError('invalid busy timeout');
      db.pragma(`busy_timeout = ${busyTimeoutMs}`);
    }
    if (!readOnly) { db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;'); db.exec(SCHEMA); }
    // Additive migration only within this independent Non database.
    if (!readOnly && !db.prepare('PRAGMA table_info(thoughts)').all().some(column => column.name === 'age_ticks'))
      db.exec('ALTER TABLE thoughts ADD COLUMN age_ticks INTEGER NOT NULL DEFAULT 0');
    if (!readOnly) for (const table of Object.values(TABLE)) createFts(db, table);
  }
  catch (error) { db.close(); throw error; }
  const transact = fn => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  const allBodies = () => Object.values(TABLE).flatMap(table => rows(db, `SELECT body FROM ${table}`).map(row => row.body));
  const recentBodies = table => rows(db, `SELECT body FROM ${table} ORDER BY created_at DESC, rowid DESC LIMIT ?`, [QIUQIU_NEAR_RECENT_N]).map(row => row.body);
  const getSetting = key => { const row = rowValue(db, 'SELECT value_json FROM settings WHERE key=?', [key]); return row ? JSON.parse(row.value_json) : null; };
  const setSetting = (key, value) => { db.prepare('INSERT INTO settings(key,value_json) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json').run(key, JSON.stringify(value)); };
  const readDesire = () => ({state:getSetting('desire_state'), thoughts:rows(db,
    'SELECT id,text,dimension,strength,stage,fed_count,source,born_at,updated_at,age_ticks FROM thoughts ORDER BY born_at,id')
    .map(row => ({id:row.id,text:row.text,dimension:row.dimension,strength:row.strength,
      stage:row.stage,fedCount:row.fed_count,source:row.source,bornAt:row.born_at,
      updatedAt:row.updated_at,ageTicks:row.age_ticks}))});
  const writeDesire = (state, thoughts) => {
    setSetting('desire_state',state);
    db.prepare('DELETE FROM thoughts').run();
    const insert = db.prepare('INSERT INTO thoughts(id,text,dimension,strength,stage,fed_count,source,born_at,updated_at,age_ticks) VALUES(?,?,?,?,?,?,?,?,?,?)');
    for (const thought of thoughts) {
      createThought(thought);
      insert.run(thought.id,thought.text,thought.dimension,thought.strength,thought.stage,
        thought.fedCount,thought.source,thought.bornAt,thought.updatedAt,thought.ageTicks ?? 0);
    }
  };
  return {
    path,
    close() { db.close(); },
    schemaTables() { return rows(db, "SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name").map(row => row.name); },
    getSetting, setSetting,
    // Admin-owned vocabulary only. A unique normalized key makes concurrent
    // additions idempotent; every write is one SQLite statement/transaction.
    listWhitelistTerms() { return rowValue(db,"SELECT name FROM sqlite_master WHERE type='table' AND name='noun_whitelist'") ? rows(db, 'SELECT term FROM noun_whitelist ORDER BY created_at, rowid').map(row => row.term) : []; },
    addWhitelistTerm(term) {
      const clean = normalizeWhitelistTerm(term);
      return transact(() => {
        const result = db.prepare('INSERT OR IGNORE INTO noun_whitelist(normalized,term,created_at) VALUES(?,?,?)').run(clean.toLowerCase(),clean,now());
        return {added:result.changes > 0,terms:rows(db,'SELECT term FROM noun_whitelist ORDER BY created_at, rowid').map(row => row.term)};
      });
    },
    removeWhitelistTerm(term) {
      const clean = normalizeWhitelistTerm(term);
      return transact(() => {
        const result = db.prepare('DELETE FROM noun_whitelist WHERE normalized=?').run(clean.toLowerCase());
        return {removed:result.changes > 0,terms:rows(db,'SELECT term FROM noun_whitelist ORDER BY created_at, rowid').map(row => row.term)};
      });
    },
    getWatermarks() { return {mind_summary_watermark: getSetting('mind_summary_watermark'), last_session_summary_at: getSetting('last_session_summary_at')}; },
    setWatermark(key, value) { if (!['mind_summary_watermark','last_session_summary_at'].includes(key)) throw new TypeError('unknown summary watermark'); setSetting(key, value); },
    insertMind(entry, {author, source, dedupMode} = {}) {
      if (!['exact-only', 'qiuqiu-near'].includes(dedupMode)) throw new Error('NON_DEDUP_MODE_REQUIRED');
      const table = checkedTable(entry?.kind);
      if (!entry || typeof entry.body !== 'string' || !entry.body.trim() || typeof author !== 'string' || !author || typeof source !== 'string' || !source) throw new TypeError('invalid mind record');
      // Non tutorial 7/18: exact body dedup scans all three tables. Near dedup
      // remains unavailable; callers must explicitly choose this reduced mode.
      if (isExactDupMind(entry.body, allBodies())) return null;
      if (dedupMode === 'qiuqiu-near' && isRecentDupMind(entry.body, recentBodies(table))) return null;
      const id = randomUUID(), createdAt = now();
      transact(() => {
        if (table === 'feels') {
          if (!validMoods(entry) || !Number.isInteger(entry.intensity) || entry.intensity < 1 || entry.intensity > 10) throw new TypeError('invalid feel');
          db.prepare('INSERT INTO feels(id,author,body,mood,moods_json,intensity,weight,pinned,created_at,source) VALUES(?,?,?,?,?,?,?,?,?,?)')
            .run(id, author, entry.body, entry.mood, JSON.stringify(entry.moods), entry.intensity, entry.weight ?? 1, entry.pinned ? 1 : 0, createdAt, source);
        } else if (table === 'memories') {
          if (!validMoods(entry) || 'intensity' in entry) throw new TypeError('invalid memory');
          db.prepare('INSERT INTO memories(id,author,body,mood,moods_json,tags_json,weight,pinned,created_at,source) VALUES(?,?,?,?,?,?,?,?,?,?)')
            .run(id, author, entry.body, entry.mood, JSON.stringify(entry.moods), JSON.stringify(entry.tags ?? []), entry.weight ?? 1, entry.pinned ? 1 : 0, createdAt, source);
        } else {
          if ('mood' in entry || 'moods' in entry || 'intensity' in entry) throw new TypeError('invalid dream');
          db.prepare('INSERT INTO dreams(id,author,body,title,weight,pinned,created_at,source) VALUES(?,?,?,?,?,?,?,?)')
            .run(id, author, entry.body, entry.title ?? null, entry.weight ?? 0.5, entry.pinned ? 1 : 0, createdAt, source);
        }
      });
      return {id, kind: entry.kind};
    },
    getMind(kind, id) { return rowValue(db, `SELECT * FROM ${checkedTable(kind)} WHERE id=?`, [id]); },
    listMind(kind) { return rows(db, `SELECT * FROM ${checkedTable(kind)} ORDER BY created_at DESC`); },
    // Non's own vectors only. Identity is recorded on every row and globally;
    // an old/mixed model fails closed rather than being migrated or searched.
    setMindEmbedding(kind, id, vector, {model = NON_EMBEDDING_MODEL, dimension = NON_EMBEDDING_DIM} = {}) {
      const table = checkedTable(kind);
      if (model !== NON_EMBEDDING_MODEL || dimension !== NON_EMBEDDING_DIM) throw new Error('NON_EMBEDDING_IDENTITY_MISMATCH');
      validateNonEmbedding(vector);
      return transact(() => {
        const identity = getSetting('embedding_identity');
        if (identity && (identity.model !== model || identity.dimension !== dimension)) throw new Error('NON_EMBEDDING_IDENTITY_MISMATCH');
        const row = rowValue(db, `SELECT id,embedding_model,embedding_dim FROM ${table} WHERE id=?`, [id]);
        if (!row) return false;
        if ((row.embedding_model && row.embedding_model !== model) || (row.embedding_dim && row.embedding_dim !== dimension)) throw new Error('NON_EMBEDDING_IDENTITY_MISMATCH');
        db.prepare(`UPDATE ${table} SET embedding=?,embedding_model=?,embedding_dim=? WHERE id=?`).run(JSON.stringify(vector), model, dimension, id);
        if (!identity) setSetting('embedding_identity', {model, dimension});
        return true;
      });
    },
    getMindEmbedding(kind, id) {
      const table = checkedTable(kind), identity = getSetting('embedding_identity');
      if (identity && (identity.model !== NON_EMBEDDING_MODEL || identity.dimension !== NON_EMBEDDING_DIM)) throw new Error('NON_EMBEDDING_IDENTITY_MISMATCH');
      const row = rowValue(db, `SELECT embedding,embedding_model,embedding_dim FROM ${table} WHERE id=?`, [id]);
      if (!row?.embedding) return null;
      if (row.embedding_model !== NON_EMBEDDING_MODEL || row.embedding_dim !== NON_EMBEDDING_DIM || !identity) throw new Error('NON_EMBEDDING_IDENTITY_MISMATCH');
      let vector;
      try { vector = JSON.parse(row.embedding); } catch { throw new Error('NON_EMBEDDING_INVALID_VECTOR'); }
      return validateNonEmbedding(vector);
    },
    lexicalLike(kind, term) {
      return rows(db, `SELECT * FROM ${checkedTable(kind)} WHERE body LIKE ? ESCAPE '\\'`, [likePattern(term)]);
    },
    lexicalTrigram(kind, term) {
      const table = checkedTable(kind), query = trigramMatch(term);
      return rows(db, `SELECT m.* FROM ${table} m JOIN ${table}_trigram f ON f.id=m.id WHERE ${table}_trigram MATCH ?`, [query]);
    },
    // Non §6 / tutorial 10/18: persisted last_mind_decay supplies real elapsed
    // time. A missing baseline must be set explicitly; no timer is started.
    applyDecayAt(at = now()) {
      const previous = getSetting('last_mind_decay');
      if (previous == null) throw new Error('NON_DECAY_BASELINE_UNAVAILABLE');
      const hours = elapsedHours(previous, at);
      return transact(() => {
        const counts = {};
        for (const [kind, table] of Object.entries(TABLE)) {
          let changed = 0;
          for (const row of rows(db, `SELECT id,weight,pinned${kind === 'feel' ? ',intensity' : ''} FROM ${table}`)) {
            const weight = decayWeight({kind, weight: row.weight, pinned: !!row.pinned, intensity: row.intensity ?? null}, hours);
            if (weight !== row.weight) { db.prepare(`UPDATE ${table} SET weight=? WHERE id=?`).run(weight, row.id); changed++; }
          }
          counts[kind] = changed;
        }
        setSetting('last_mind_decay', at);
        return counts;
      });
    },
    markSurfaced(kind, id, at = now()) {
      const table = checkedTable(kind);
      return transact(() => {
        const row = rowValue(db, `SELECT weight,surface_count FROM ${table} WHERE id=?`, [id]);
        if (!row) return false;
        db.prepare(`UPDATE ${table} SET weight=?,surface_count=surface_count+1,last_surfaced_at=? WHERE id=?`).run(reinforceWeight(row.weight), at, id);
        return true;
      });
    },
    // Thought text is persisted internally, but numeric reads never expose it.
    insertThought(input) {
      const thought = createThought(input);
      const id=randomUUID(), stamp=now();
      db.prepare('INSERT INTO thoughts(id,text,dimension,strength,stage,fed_count,source,born_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(id,thought.text,thought.dimension,thought.strength,thought.stage,thought.fedCount,thought.source,thought.bornAt,stamp);
      return id;
    },
    thoughtNumbers() { return rows(db, 'SELECT id,dimension,strength,stage,fed_count,source,born_at,updated_at FROM thoughts'); },
    // Internal desire-only read includes text; diagnostics below never call it.
    loadDesire() {
      return readDesire();
    },
    saveDesire(state, thoughts) {
      if (!state || typeof state !== 'object' || !Array.isArray(thoughts)) throw new TypeError('desire state required');
      return transact(() => writeDesire(state,thoughts));
    },
    // One SQLite transaction covers durable dedup and the entire Desire update.
    // The callback sees only an in-memory staging store, never a prompt path.
    applyDesireShadowEvent({eventId,turnId,eventType,occurredAt}, apply) {
      if (typeof eventId !== 'string' || !eventId || typeof turnId !== 'string' || !turnId ||
        !['user_message','assistant_message','turn_completed','thought_authored'].includes(eventType) ||
        !Number.isFinite(occurredAt) || typeof apply !== 'function') throw new TypeError('invalid shadow event');
      return transact(() => {
        if (rowValue(db,'SELECT event_id FROM desire_shadow_events WHERE event_id=?',[eventId]))
          return {duplicate:true};
        let staged = readDesire(), changed = false;
        const stagingStore = {
          loadDesire: () => staged,
          saveDesire: (state,thoughts) => { staged={state,thoughts};changed=true; }
        };
        const result = apply(stagingStore);
        if (changed) writeDesire(staged.state,staged.thoughts);
        db.prepare('INSERT INTO desire_shadow_events(event_id,turn_id,event_type,occurred_at,recorded_at) VALUES(?,?,?,?,?)')
          .run(eventId,turnId,eventType,occurredAt,now());
        return {duplicate:false,changed,result};
      });
    }
  };
}

export function normalizeWhitelistTerm(term) {
  if (typeof term !== 'string') throw new TypeError('whitelist term required');
  const clean = term.normalize('NFKC').trim().replace(/\s+/gu,' ');
  if (!clean || [...clean].length > 40 || /[\p{Cc}\p{Cf}]/u.test(clean)) throw new RangeError('invalid whitelist term');
  return clean;
}
