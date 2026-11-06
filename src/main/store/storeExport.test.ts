import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql, type Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InboxStore } from '../inbox/inboxDb.js';
import { migratePgStores } from './pgStores.js';
import { postgresKysely } from './postgres.js';
import { exportInboxToSqlite, pgInboxFingerprint } from './storeExport.js';
import { IMPORT_PG_TRACK, IMPORT_TABLES, ImportError, type ImportProgress } from './storeImport.js';
import { isPg, testPgSchema, type TestPg } from './testStore.js';

const ME = { kind: 'user', id: 'me' } as const;

describe.skipIf(!isPg)('exportInboxToSqlite (the switch back from Postgres)', () => {
  let dir: string;
  let file: string;
  let t: TestPg;
  let k: Kysely<unknown>;
  let todoIds: string[];

  const count = (d: Database.Database, table: string): number =>
    (d.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number }).n;
  const pgCount = async (table: string): Promise<number> =>
    (await sql<{ n: number }>`SELECT count(*) AS n FROM ${sql.table(table)}`.execute(k)).rows[0].n;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cf-export-'));
    file = join(dir, 'inbox.db.from-postgres');
    t = await testPgSchema();
    await migratePgStores(t.pool, { state: false, extraTracks: [IMPORT_PG_TRACK] });
    const inbox = await InboxStore.openPostgres(t.pool, { migrate: false });
    for (let i = 0; i < 25; i++) await inbox.post(ME, { title: `todo ${i}`, key: `k${i}`, tags: [`tag${i % 3}`] });
    todoIds = (await inbox.list({})).map((x) => x.id).sort();
    await inbox.close();
    k = postgresKysely<unknown>(t.pool);
    await sql`INSERT INTO claim_vectors (claim_id, model_id, vec) VALUES ('c1', 'm', ${Buffer.from([0, 1, 2, 255])})`.execute(k);
    await sql`INSERT INTO claims_fts (claim_id, text, topics) VALUES ('c1', 'full text', 'a b')`.execute(k);
  });
  afterEach(async () => {
    await k.destroy();
    await t.drop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes every inbox table with its ids into a file InboxStore opens; new rows get fresh ids', async () => {
    const out = await exportInboxToSqlite({ k, file, maxRowsPerChunk: 4 });
    for (const table of IMPORT_TABLES.inbox) expect(out.counts[table], table).toBe(await pgCount(table));
    const d = new Database(file, { readonly: true });
    expect((d.prepare(`SELECT vec FROM claim_vectors`).get() as { vec: Buffer }).vec).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(d.prepare(`SELECT claim_id FROM claims_fts WHERE claims_fts MATCH 'full'`).all()).toEqual([{ claim_id: 'c1' }]);
    expect(d.prepare(`SELECT name FROM sqlite_master WHERE name LIKE 'store_export%'`).all()).toEqual([]);
    d.close();
    const maxEvent = (await sql<{ m: number }>`SELECT max(id) AS m FROM todo_events`.execute(k)).rows[0].m;

    const home = mkdtempSync(join(tmpdir(), 'cf-export-home-'));
    try {
      renameSync(file, join(home, 'inbox.db'));
      const inbox = InboxStore.open(home);
      try {
        expect((await inbox.list({})).map((x) => x.id).sort()).toEqual(todoIds);
        const { todo } = await inbox.post(ME, { title: 'after the switch back', key: 'after' });
        const events = await inbox.events(todo.id);
        expect(events.length).toBeGreaterThan(0);
        expect(Math.min(...events.map((e) => e.id))).toBeGreaterThan(maxEvent);
      } finally {
        await inbox.close();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('resumes after a failure and ends equal to a straight copy', async () => {
    let chunks = 0;
    // 25 todos in chunks of 4 is 7 chunks: the failure lands after todos finished.
    await expect(exportInboxToSqlite({ k, file, maxRowsPerChunk: 4, onProgress: () => { if (++chunks === 9) throw new Error('injected'); } }))
      .rejects.toThrow('injected');
    expect(existsSync(file)).toBe(true);
    const seen: ImportProgress[] = [];
    const out = await exportInboxToSqlite({ k, file, maxRowsPerChunk: 4, onProgress: (p) => seen.push(p) });
    expect(seen.some((p) => p.table === 'todos')).toBe(false);
    expect(seen.every((p) => p.source === 'inbox')).toBe(true);
    const d = new Database(file, { readonly: true });
    for (const table of IMPORT_TABLES.inbox) expect(count(d, table), table).toBe(out.counts[table]);
    expect(count(d, 'todos')).toBe(25);
    d.close();
  });

  it('a Postgres inbox changed between attempts restarts the copy from scratch', async () => {
    let chunks = 0;
    await expect(exportInboxToSqlite({ k, file, maxRowsPerChunk: 4, onProgress: () => { if (++chunks === 9) throw new Error('injected'); } }))
      .rejects.toThrow('injected');
    const inbox = await InboxStore.openPostgres(t.pool, { migrate: false });
    await inbox.post(ME, { title: 'posted between attempts', key: 'between' });
    await inbox.close();
    const seen: ImportProgress[] = [];
    await exportInboxToSqlite({ k, file, maxRowsPerChunk: 4, onProgress: (p) => seen.push(p) });
    expect(seen.find((p) => p.table === 'todos')).toMatchObject({ copied: 4, total: 26 });
    const d = new Database(file, { readonly: true });
    expect(count(d, 'todos')).toBe(26);
    expect(d.prepare(`SELECT title FROM todos WHERE dedupe_key = 'between'`).get()).toEqual({ title: 'posted between attempts' });
    d.close();
  });

  it('copies from one snapshot: a write during the copy is not half-copied, and the fingerprint moves', async () => {
    const before = await pgInboxFingerprint(k);
    let wrote = false;
    // One-row chunks: dozens of round trips pass before notify_state is read.
    const out = await exportInboxToSqlite({
      k, file, maxRowsPerChunk: 1,
      onProgress: () => {
        if (wrote) return;
        wrote = true;
        void t.pool.query(`INSERT INTO ${t.schema}.notify_state (k, v) VALUES ('mid-copy', '1')`);
      },
    });
    expect(out.fingerprint).toBe(before);
    expect(out.counts.notify_state).toBe(0);
    await new Promise((r) => setTimeout(r, 50));
    expect(await pgInboxFingerprint(k)).not.toBe(before);
  });

  it('a row written into the file by anything else fails the count check', async () => {
    await expect(exportInboxToSqlite({
      k, file, maxRowsPerChunk: 4,
      onProgress: (p) => {
        if (p.table !== 'tags') return;
        const w = new Database(file);
        w.prepare(`INSERT OR IGNORE INTO tags (entity_kind, entity_id, tag) VALUES ('todo', 'x', 'intruder')`).run();
        w.close();
      },
    })).rejects.toThrow(ImportError);
  });

  it('a file at the partial path that is not its own copy is replaced', async () => {
    writeFileSync(file, 'not a database');
    const out = await exportInboxToSqlite({ k, file });
    expect(out.counts.todos).toBe(25);
  });
});
