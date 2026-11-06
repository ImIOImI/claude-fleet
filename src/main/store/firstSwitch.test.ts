import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as db from '../db.js';
import { InboxStore } from '../inbox/inboxDb.js';
import { firstSwitchCopy, switchBackPlan, switchBackToSqlite, verifyPlacedInbox } from './firstSwitch.js';
import { migratePgStores } from './pgStores.js';
import { createPgPool, postgresKysely } from './postgres.js';
import { EXPORTED_PREFIX, IMPORT_PG_TRACK, IMPORT_TABLES } from './storeImport.js';
import { inboxOnPostgresNotice } from './storeSwitch.js';
import { isPg, testPgSchema, type TestPg } from './testStore.js';

const ME = { kind: 'user', id: 'me' } as const;
const sha = (f: string): string => createHash('sha256').update(readFileSync(f)).digest('hex');

it('verifyPlacedInbox names a table whose count differs from the copy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cf-verify-'));
  try {
    const inbox = InboxStore.open(dir);
    await inbox.post(ME, { title: 'one' });
    await inbox.close();
    const f = join(dir, 'inbox.db');
    const counts = Object.fromEntries(IMPORT_TABLES.inbox.map((t) => [t, 0]));
    expect(verifyPlacedInbox(f, { ...counts, todos: 1, todo_events: 1 })).toBeNull();
    expect(verifyPlacedInbox(f, { ...counts, todos: 2, todo_events: 1 })).toMatch(/todos: 1 rows, the copy had 2/);
    writeFileSync(join(dir, 'junk.db'), 'not a database');
    expect(verifyPlacedInbox(join(dir, 'junk.db'), counts)).toMatch(/unreadable/);
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

  it('a crash while inbox.db is retired leaves the inbox on Postgres, not an empty SQLite inbox', async () => {
    // A non-empty destination fails the retire's last rename, after inbox.db has moved out.
    mkdirSync(join(dir, 'inbox.db.migrated-9'));
    writeFileSync(join(dir, 'inbox.db.migrated-9', 'x'), '');
    await expect(firstSwitchCopy({ pool: t.pool, userData: dir, state: false, onProgress: () => undefined, now: () => 9 })).rejects.toThrow();
    expect(existsSync(join(dir, 'inbox.db'))).toBe(false);
    rmSync(join(dir, 'inbox.db.migrated-9'), { recursive: true });
    expect(inboxOnPostgresNotice(dir)).not.toBeNull();
    expect(switchBackPlan(dir, 10)).toEqual({ kind: 'copy' });
  });

  it('a crash before inbox.db is retired leaves inbox.db the inbox', async () => {
    writeFileSync(join(dir, 'inbox.db.on-postgres'), JSON.stringify({ status: 'pending', at: 1 }));
    expect(inboxOnPostgresNotice(dir)).toBeNull();
    expect(switchBackPlan(dir, 10)).toEqual({ kind: 'keep-inbox-db', notice: null });
  });

  it('says so when the store already had inbox data, and leaves inbox.db in place', async () => {
    await t.pool.query(`INSERT INTO ${t.schema}.notify_state (k, v) VALUES ('x', '1')`);
    const note = await firstSwitchCopy({ pool: t.pool, userData: dir, state: false, onProgress: () => undefined });
    expect(note).toMatch(/inbox.db was not copied/);
    expect(existsSync(join(dir, 'inbox.db'))).toBe(true);
  });
  it('a hot rollback journal stops the copy with a notice, and switching back keeps inbox.db as is', async () => {
    writeFileSync(join(dir, 'inbox.db-journal'), 'unfinished');
    const before = sha(join(dir, 'inbox.db'));
    await expect(firstSwitchCopy({ pool: t.pool, userData: dir, state: false, onProgress: () => undefined })).rejects.toThrow(/switch back to SQLite/i);
    expect(switchBackPlan(dir, 1)).toMatchObject({ kind: 'keep-inbox-db', notice: expect.stringMatching(/unfinished transaction/) });
    const commit = vi.fn(async () => undefined);
    expect(await switchBackToSqlite({ pool: t.pool, userData: dir, onProgress: () => undefined, commit })).toMatchObject({ status: 'switched', kept: true });
    expect(commit).toHaveBeenCalledOnce();
    expect(sha(join(dir, 'inbox.db'))).toBe(before);
    expect(readFileSync(join(dir, 'inbox.db-journal'), 'utf8')).toBe('unfinished');
  });

  it('switching back while the copy is stuck is a plain commit, with no Postgres needed', async () => {
    let n = 0;
    await expect(firstSwitchCopy({ pool: t.pool, userData: dir, state: false, onProgress: () => { if (++n === 1) throw new Error('stuck'); } }))
      .rejects.toThrow('stuck');
    const before = sha(join(dir, 'inbox.db'));
    const dead = createPgPool({ connectionString: 'postgres://nobody@127.0.0.1:1/none', schema: 'none', connectionTimeoutMillis: 500 });
    dead.on('error', () => undefined);
    try {
      const commit = vi.fn(async () => undefined);
      expect(await switchBackToSqlite({ pool: dead, userData: dir, onProgress: () => undefined, commit })).toMatchObject({ status: 'switched', kept: true });
      expect(commit).toHaveBeenCalledOnce();
    } finally {
      await dead.end();
    }
    expect(sha(join(dir, 'inbox.db'))).toBe(before);
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
      expect(await runRow()).toMatchObject({ fingerprint: expect.stringMatching(new RegExp(`^${EXPORTED_PREFIX}[0-9a-f]{64}$`)), finished_at: null });
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
    // A Postgres start beside it keeps both copies and marks the conflict.
    await firstSwitchCopy({ pool: t.pool, userData: dir, state: false, onProgress: () => undefined });
    const before = sha(inboxFile());
    const commit = vi.fn(async () => undefined);
    const out = await switchBackToSqlite({ pool: t.pool, userData: dir, onProgress: () => undefined, commit });
    expect(out.status).toBe('skipped-nonempty');
    expect(out.status === 'skipped-nonempty' && out.notice).toMatch(/move .*inbox\.db.* out of/i);
    expect(commit).not.toHaveBeenCalled();
    expect(sha(inboxFile())).toBe(before);
  });

  it('an inbox.db with no rows is set aside, not overwritten', async () => {
    const empty = InboxStore.open(dir);
    await empty.close();
    await firstSwitchCopy({ pool: t.pool, userData: dir, state: false, onProgress: () => undefined });
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
    const d = new Database(join(dir, 'inbox.db.migrated-99', 'inbox.db'), { readonly: true });
    const n = (d.prepare('SELECT count(*) AS n FROM todos').get() as { n: number }).n;
    d.close();
    expect((await t.pool.query(`SELECT count(*)::int AS n FROM ${t.schema}.todos`)).rows[0].n).toBe(n);
  });

  it('a Postgres write after the export is not erased by the next switch to Postgres', async () => {
    await switchBackToSqlite({ pool: t.pool, userData: dir, onProgress: () => undefined, commit: async () => { await pgPost('posted after the export'); } });
    const before = sha(inboxFile());
    const note = await firstSwitchCopy({ pool: t.pool, userData: dir, state: true, onProgress: () => undefined });
    expect(note).toMatch(/inbox\.db was not copied: .*both changed.*move .*inbox\.db.* out of/i);
    expect((await t.pool.query(`SELECT title FROM ${t.schema}.todos WHERE dedupe_key = 'posted after the export'`)).rows).toHaveLength(1);
    expect(sha(inboxFile())).toBe(before);
    expect(switchBackPlan(dir, 1)).toMatchObject({ kind: 'refuse' });
  });

  it('a foreign WAL left at inbox.db-wal cannot change the switched-back inbox', async () => {
    const o = join(dir, 'other.db');
    const x = new Database(o);
    x.pragma('journal_mode = WAL');
    x.pragma('wal_autocheckpoint = 0');
    x.exec('CREATE TABLE z (a)');
    for (let i = 0; i < 200; i++) x.prepare('INSERT INTO z VALUES (?)').run('x'.repeat(500));
    copyFileSync(`${o}-wal`, `${inboxFile()}-wal`);
    x.close();
    const out = await switchBackToSqlite({ pool: t.pool, userData: dir, onProgress: () => undefined, commit: async () => undefined });
    expect(out.status).toBe('switched');
    expect(await titlesIn()).toEqual(['from sqlite', 'made on postgres']);
    expect(await firstSwitchCopy({ pool: t.pool, userData: dir, state: true, onProgress: () => undefined })).toBeNull();
    expect((await t.pool.query(`SELECT count(*)::int AS n FROM ${t.schema}.todos`)).rows[0].n).toBe(2);
  });

  it('a row lost from the copy after its table was verified is caught before anything is committed', async () => {
    const commit = vi.fn(async () => undefined);
    let hit = false;
    await expect(switchBackToSqlite({
      pool: t.pool, userData: dir, commit,
      onProgress: (p) => {
        if (hit || p.table !== 'todo_events') return;
        hit = true;
        const w = new Database(join(dir, 'inbox.db.from-postgres'));
        w.prepare('DELETE FROM todos WHERE rowid = (SELECT min(rowid) FROM todos)').run();
        w.close();
      },
    })).rejects.toThrow(/todos: 1 rows, the copy had 2/);
    expect(commit).not.toHaveBeenCalled();
    expect(existsSync(inboxFile())).toBe(false);
    expect((await runRow()).finished_at).not.toBeNull();
  });

  it('a new inbox.db beside a finished copy (config.json edited back to SQLite by hand) is kept, not retired', async () => {
    // The hand edit: the app opens inbox.db on SQLite, and the stale marker goes with it.
    const inbox = InboxStore.open(dir);
    await inbox.post(ME, { title: 'made on sqlite after the hand edit', key: 'hand' });
    await inbox.close();
    expect(existsSync(join(dir, 'inbox.db.on-postgres'))).toBe(false);
    expect(switchBackPlan(dir, 1)).toMatchObject({ kind: 'keep-inbox-db' });
    const before = sha(inboxFile());
    const note = await firstSwitchCopy({ pool: t.pool, userData: dir, state: true, onProgress: () => undefined });
    expect(note).toMatch(/inbox\.db was not copied/);
    expect(sha(inboxFile())).toBe(before);
    expect(switchBackPlan(dir, 1)).toMatchObject({ kind: 'refuse' });
    expect(await titlesIn()).toContain('made on sqlite after the hand edit');
  });
});
