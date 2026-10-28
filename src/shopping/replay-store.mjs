import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

// Small synchronous ledger: verification never acknowledges a nonce before it is durable.
export function createReplayStore(path) {
  if (!path) throw new TypeError('replay_path_required');
  let entries = new Map();
  if (existsSync(path)) entries = new Map(JSON.parse(readFileSync(path, 'utf8')));
  const persist = () => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify([...entries]), { mode: 0o600 });
    renameSync(temporary, path);
  };
  return {
    has: key => entries.has(key),
    set(key, value) { entries.set(key, value); persist(); return this; },
    delete(key) { const removed = entries.delete(key); if (removed) persist(); return removed; },
    [Symbol.iterator]: () => entries[Symbol.iterator]()
  };
}
