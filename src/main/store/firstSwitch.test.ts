import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as db from '../db.js';
import { InboxStore } from '../inbox/inboxDb.js';
import { firstSwitchCopy, retireSqliteFile, switchBackToSqlite } from './firstSwitch.js';
import { migratePgStores } from './pgStores.js';
import { postgresKysely } from './postgres.js';
import { EXPORTED_FINGERPRINT, IMPORT_PG_TRACK } from './storeImport.js';
import { isPg, testPgSchema, type TestPg } from './testStore.js';

const ME = { kind: 'user', id: 'me' } as const;
const sha = (f: string): string => createHash('sha256').update(readFileSync(f)).digest('hex');

it('retireSqliteFile renames the file with its WAL and shm', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cf-retire-'));
  try {
    for (const f of ['inbox.db', 'inbox.db-wal', 'inbox.db-shm']) writeFileSync(join(dir, f), 'x');
    expect(retireSqliteFile(join(dir, 'inbox.db'), 7)).toBe(join(dir, 'inbox.db.migrated-7'));
    expect(readdirSync(dir).sort()).toEqual(['inbox.db.migrated-7', 'inbox.db.migrated-7-shm', 'inbox.db.migrated-7-wal']);
    expect(retireSqliteFile(join(dir, 'inbox.db'), 8)).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe.skipIf(!isPg)('firstSwitchCopy', () => {
  let dir: string;
  let t: TestPg;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cf-switch-'));
    const inbox = InboxStore.open(dir);
    await inbox.post(ME, { title: 'carry me over' });
    await inbox.close();
    db.openDb(dir);
    await db.closeDb();
    t = await testPgSchema();
    await migratePgStores(t.pool, { state: true, extraTracks: [IMPORT_PG_TRACK] });
  });
  afterEach(async () => {
    await t.drop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('copies the inbox, retires inbox.db, keeps state.db; a second run is a no-op', async () => {
    expect(await firstSwitchCopy({ pool: t.pool, userData: dir, state: true, onProgress: () => undefined, now: () => 42 })).toBeNull();
    expect(existsSync(join(dir, 'inbox.db'))).toBe(false);
    expect(existsSync(join(dir, 'inbox.db.migrated-42'))).toBe(true);
    expect(existsSync(join(dir, 'state.db'))).toBe(true);
    const inbox = await InboxStore.openPostgres(t.pool, { migrate: false });
    expect((await inbox.list({})).map((x) => x.title)).toEqual(['carry me over']);
    await inbox.close();
    expect(await firstSwitchCopy({ pool: t.pool, userData: dir, state: true, onProgress: () => undefined })).toBeNull();
  });

  it('keeps inbox.db in place when the copy fails, and retires it once a retry finishes', async () => {
    const boom = vi.fn(() => { throw new Error('injected'); });
    await expect(firstSwitchCopy({ pool: t.pool, userData: dir, state: false, onProgress: boom, now: () => 1 })).rejects.toThrow('injected');
    expect(existsSync(join(dir, 'inbox.db'))).toBe(true);
    expect(readdirSync(dir).some((f) => f.includes('.migrated-'))).toBe(false);
    expect(await firstSwitchCopy({ pool: t.pool, userData: dir, state: false, onProgress: () => undefined, now: () => 2 })).toBeNull();
    expect(existsSync(join(dir, 'inbox.db'))).toBe(false);
    expect(existsSync(join(dir, 'inbox.db.migrated-2'))).toBe(true);
  });

  it('says so when the store already had inbox data, and leaves inbox.db in place', async () => {
    await t.pool.query(`INSERT INTO ${t.schema}.notify_state (k, v) VALUES ('x', '1')`);
    const note = await firstSwitchCopy({ pool: t.pool, userData: dir, state: false, onProgress: () => undefined });
    expect(note).toMatch(/inbox.db was not copied/);
    expect(existsSync(join(dir, 'inbox.db'))).toBe(true);
  });
});

describe.skipIf(!isPg)('switchBackToSqlite', () => {
  let dir: string;
  let t: TestPg;
  const inboxFile = (): string => join(dir, 'inbox.db');

  async function pgPost(title: string): Promise<void> {
    const inbox = await InboxStore.openPostgres(t.pool, { migrate: false });
    await inbox.post(ME, { title, key: title });
    await inbox.close();
  }
  const runRow = async () => (await t.pool.query(`SELECT fingerprint, finished_at FROM ${t.schema}.store_import_run WHERE source = 'inbox'`)).rows[0];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cf-switchback-'));
    const inbox = InboxStore.open(dir);
    await inbox.post(ME, { title: 'from sqlite', key: 'from-sqlite' });
    await inbox.close();
    db.openDb(dir);
    await db.closeDb();
    t = await testPgSchema();
    await migratePgStores(t.pool, { state: true, extraTracks: [IMPORT_PG_TRACK] });
    await firstSwitchCopy({ pool: t.pool, userData: dir, state: true, onProgress: () => undefined, now: () => 10 });
    await pgPost('made on postgres');
  });
  afterEach(async () => {
    await t.drop();
    rmSync(dir, { recursive: true, force: true });
  });

  const titlesIn = async (status: 'open' | 'all' = 'open'): Promise<string[]> => {
    const inbox = InboxStore.open(dir);
    try {
      return (await inbox.list({ status })).map((x) => x.title).sort();
    } finally {
      await inbox.close();
    }
  };

  it('copies the Postgres inbox into a fresh inbox.db before committing the choice; state.db is untouched', async () => {
    const state = sha(join(dir, 'state.db'));
    const commit = vi.fn(async () => {
      expect(existsSync(inboxFile())).toBe(true);
      expect(await runRow()).toMatchObject({ fingerprint: EXPORTED_FINGERPRINT, finished_at: null });
    });
    const out = await switchBackToSqlite({ pool: t.pool, userData: dir, onProgress: () => undefined, commit });
    expect(out).toMatchObject({ status: 'switched', counts: { todos: 2 } });
    expect(commit).toHaveBeenCalledOnce();
    expect(sha(join(dir, 'state.db'))).toBe(state);
    expect(readdirSync(dir).filter((f) => f.includes('from-postgres'))).toEqual([]);
    expect(await titlesIn()).toEqual(['from sqlite', 'made on postgres']);
  });

  it('stays on Postgres when the copy fails: no inbox.db, no commit; a retry resumes and switches', async () => {
    const commit = vi.fn(async () => undefined);
    let n = 0;
    await expect(switchBackToSqlite({
      pool: t.pool, userData: dir, commit, onProgress: () => { if (++n === 2) throw new Error('injected'); },
    })).rejects.toThrow('injected');
    expect(commit).not.toHaveBeenCalled();
    expect(existsSync(inboxFile())).toBe(false);
    expect((await runRow()).finished_at).not.toBeNull();
    expect(await switchBackToSqlite({ pool: t.pool, userData: dir, commit, onProgress: () => undefined })).toMatchObject({ status: 'switched' });
    expect(commit).toHaveBeenCalledOnce();
  });

  it('stays on Postgres when committing the choice fails: inbox.db is taken back and the import run restored', async () => {
    const before = await runRow();
    await expect(switchBackToSqlite({
      pool: t.pool, userData: dir, onProgress: () => undefined, commit: async () => { throw new Error('config.json unwritable'); },
    })).rejects.toThrow('config.json unwritable');
    expect(existsSync(inboxFile())).toBe(false);
    expect(await runRow()).toEqual(before);
  });

  it('refuses when inbox.db already holds data, and leaves it untouched', async () => {
    const inbox = InboxStore.open(dir);
    await inbox.post(ME, { title: 'someone else' });
    await inbox.close();
    const before = sha(inboxFile());
    const commit = vi.fn(async () => undefined);
    const out = await switchBackToSqlite({ pool: t.pool, userData: dir, onProgress: () => undefined, commit });
    expect(out.status).toBe('skipped-nonempty');
    expect(out.status === 'skipped-nonempty' && out.notice).toMatch(/inbox\.db/);
    expect(commit).not.toHaveBeenCalled();
    expect(sha(inboxFile())).toBe(before);
  });

  it('an inbox.db with no rows is set aside, not overwritten', async () => {
    const empty = InboxStore.open(dir);
    await empty.close();
    const out = await switchBackToSqlite({ pool: t.pool, userData: dir, onProgress: () => undefined, commit: async () => undefined, now: () => 77 });
    expect(out.status).toBe('switched');
    expect(existsSync(join(dir, 'inbox.db.replaced-77'))).toBe(true);
    expect(await titlesIn()).toEqual(['from sqlite', 'made on postgres']);
  });

  it('does not switch while the Postgres inbox keeps changing under the copy', async () => {
    const k = postgresKysely<unknown>(t.pool);
    let i = 0;
    const commit = vi.fn(async () => undefined);
    try {
      await expect(switchBackToSqlite({
        pool: t.pool, userData: dir, commit,
        onProgress: () => { void sql`INSERT INTO notify_state (k, v) VALUES (${`w${++i}`}, '1')`.execute(k); },
      })).rejects.toThrow(/kept changing/);
    } finally {
      await k.destroy();
    }
    expect(commit).not.toHaveBeenCalled();
    expect(existsSync(inboxFile())).toBe(false);
  });

  it('switching to Postgres again copies what changed on SQLite over the stale Postgres inbox', async () => {
    await switchBackToSqlite({ pool: t.pool, userData: dir, onProgress: () => undefined, commit: async () => undefined });
    const inbox = InboxStore.open(dir);
    const dismissed = (await inbox.list({})).find((x) => x.title === 'from sqlite')!;
    await inbox.update(ME, dismissed.id, { status: 'dismissed' });
    await inbox.post(ME, { title: 'back on sqlite', key: 'back' });
    await inbox.close();
    const want = await titlesIn('all');

    expect(await firstSwitchCopy({ pool: t.pool, userData: dir, state: true, onProgress: () => undefined, now: () => 99 })).toBeNull();
    expect(existsSync(join(dir, 'inbox.db.migrated-99'))).toBe(true);
    const pgInbox = await InboxStore.openPostgres(t.pool, { migrate: false });
    try {
      expect((await pgInbox.list({ status: 'all' })).map((x) => x.title).sort()).toEqual(want);
      expect((await pgInbox.list({})).find((x) => x.title === 'from sqlite')).toBeUndefined();
    } finally {
      await pgInbox.close();
    }
    const d = new Database(join(dir, 'inbox.db.migrated-99'), { readonly: true });
    const n = (d.prepare('SELECT count(*) AS n FROM todos').get() as { n: number }).n;
    d.close();
    expect((await t.pool.query(`SELECT count(*)::int AS n FROM ${t.schema}.todos`)).rows[0].n).toBe(n);
  });
});
