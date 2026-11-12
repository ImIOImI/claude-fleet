import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { closeDb, onStateOpenStats, openDb, recordError, withRawSqlite, type StateOpenStats } from './db.js';
import { isPg } from './store/testStore.js';

/** better-sqlite3's SQLITE_DEFAULT_CACHE_SIZE (KiB when negative). */
const BUILD_DEFAULT_CACHE = -16000;

const dirs: string[] = [];
afterEach(async () => {
  await closeDb();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'cf-pragmas-'));
  dirs.push(d);
  return d;
}

describe.skipIf(isPg)('state.db connection pragmas', () => {
  it('main connection keeps the build-default cache and no mmap, and reports both at open', async () => {
    const dir = tempDir();
    openDb(dir);
    const stats = new Promise<StateOpenStats>((r) => onStateOpenStats(r, 600_000));
    expect(await withRawSqlite((d) => d.pragma('cache_size', { simple: true }))).toBe(BUILD_DEFAULT_CACHE);
    expect(await withRawSqlite((d) => d.pragma('mmap_size', { simple: true }))).toBe(0);
    await recordError({ ts: Date.now(), source: 'main', level: 'info', type: 'test', message: 'first write' });
    const s = await stats;
    expect(s.cacheKib).toBe(-BUILD_DEFAULT_CACHE);
    expect(s.mmapBytes).toBe(0);
  });

  it('a read-only connection, as the MCP server opens it, has the same defaults', () => {
    const dir = tempDir();
    openDb(dir);
    const ro = new Database(join(dir, 'state.db'), { readonly: true, fileMustExist: true });
    try {
      expect(ro.pragma('cache_size', { simple: true })).toBe(BUILD_DEFAULT_CACHE);
      expect(ro.pragma('mmap_size', { simple: true })).toBe(0);
    } finally {
      ro.close();
    }
  });
});
