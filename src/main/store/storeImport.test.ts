import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql, type Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as db from '../db.js';
import { InboxStore, INBOX_SCHEMA_VERSION } from '../inbox/inboxDb.js';
import { FIXTURE, S, WS } from '../state/ingestFixture.js';
import { EMBED_DIM, EMBED_MODEL_ID, encodeVector } from '../vectors.js';
import { INBOX_PG_TRACK } from './migrations/inboxPg.js';
import { STATE_PG_TRACK } from './migrations/statePg.js';
import type { PgTrack } from './pgMigrate.js';
import { migratePostgres } from './pgMigrate.js';
import { postgresKysely, schemaOf } from './postgres.js';
import {
  IMPORT_PG_TRACK, IMPORT_TABLES, importSqlite, ImportError, sourceFingerprint, trackVersion, type ImportProgress,
} from './storeImport.js';
import { isPg, testPgSchema, type TestPg } from './testStore.js';

const tablesOf = (t: PgTrack): string[] =>
  [...[t.baseline, ...t.steps.map((s) => s.postgres)].join('\n').matchAll(/CREATE TABLE (\w+)/g)].map((m) => m[1]).sort();

const sha = (f: string): string => (existsSync(f) ? createHash('sha256').update(readFileSync(f)).digest('hex') : '-');

it('a read-only open does not change the fingerprint; a write does', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cf-fp-'));
  try {
    const f = join(dir, 'x.db');
    const w = new Database(f);
    w.pragma('journal_mode = WAL');
    w.exec('CREATE TABLE t (a)');
    w.close();
    const before = sourceFingerprint(f);
    const r = new Database(f, { readonly: true, fileMustExist: true });
    r.prepare('SELECT * FROM t').all();
    r.close();
    expect(sourceFingerprint(f)).toBe(before);
    const w2 = new Database(f);
    w2.prepare('INSERT INTO t VALUES (1)').run();
    expect(sourceFingerprint(f)).not.toBe(before);
    w2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('copies every table of both stores, migration steps included', () => {
  expect([...IMPORT_TABLES.state].sort()).toEqual(tablesOf(STATE_PG_TRACK));
  expect([...IMPORT_TABLES.inbox].sort()).toEqual(tablesOf(INBOX_PG_TRACK));
  expect(trackVersion(INBOX_PG_TRACK)).toBe(INBOX_SCHEMA_VERSION);
});

const vec = (i: number): Float32Array => { const v = new Float32Array(EMBED_DIM); v[i % EMBED_DIM] = 1; return v; };
const ME = { kind: 'user', id: 'me' } as const;

describe.skipIf(!isPg)('importSqlite into Postgres', () => {
  let dir: string;
  let t: TestPg;
  let k: Kysely<unknown>;
  let before: Awaited<ReturnType<typeof db.listSessions>>;
  let todoIds: string[];

  /** SQLite state.db + inbox.db in `dir`, the way a SQLite user leaves them. */
  async function seedSqlite(): Promise<void> {
    db.openDb(dir);
    await db.ingestBatch(WS, S, FIXTURE);
    await db.insertEmbeddings(Array.from({ length: 30 }, (_, i) => ({
      workspaceId: WS, sessionId: S, kind: 'turn' as const, refEventId: i + 1, ts: i, text: `t${i}`,
      modelId: EMBED_MODEL_ID, dim: EMBED_DIM, vec: encodeVector(vec(i)), dedupKey: `d${i}`,
    })));
    await db.renameSession(S, 'renamed by the user');
    before = await db.listSessions();
    await db.closeDb();
    const inbox = InboxStore.open(dir);
    for (let i = 0; i < 25; i++) await inbox.post(ME, { title: `todo ${i}`, key: `k${i}` });
    todoIds = (await inbox.list({})).map((x) => x.id).sort();
    await inbox.close();
  }

  const opts = (source: 'state' | 'inbox', extra: Partial<Parameters<typeof importSqlite>[0]> = {}) => ({
    k, source,
    file: join(dir, source === 'state' ? 'state.db' : 'inbox.db'),
    expectedVersion: trackVersion(source === 'state' ? STATE_PG_TRACK : INBOX_PG_TRACK),
    maxParamsPerChunk: 140,
    ...extra,
  });

  const pgCount = async (table: string): Promise<number> =>
    (await sql<{ n: number }>`SELECT count(*) AS n FROM ${sql.table(table)}`.execute(k)).rows[0].n;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cf-import-'));
    await seedSqlite();
    t = await testPgSchema();
    await db.openDbPostgres(t.pool);
    await InboxStore.openPostgres(t.pool).then((s) => s.close());
    k = postgresKysely<unknown>(t.pool);
    await migratePostgres(k, schemaOf(t.pool), IMPORT_PG_TRACK);
  });
  afterEach(async () => {
    await k.destroy();
    await db.closeDb();
    await t.drop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('copies both stores with their ids; reads match SQLite; new rows get fresh ids; the files are only read', async () => {
    const files = ['inbox.db', 'state.db'].map((f) => join(dir, f));
    const hashes = files.map(sha);
    const inboxOut = await importSqlite(opts('inbox'));
    const stateOut = await importSqlite(opts('state'));
    expect(files.map(sha)).toEqual(hashes);
    expect(inboxOut.status).toBe('copied');
    expect(stateOut).toMatchObject({ status: 'copied', counts: { embeddings: 30 } });
    // db.ts opened before the copy: reopen, as the supervisor opens it after.
    await db.closeDb();
    await db.openDbPostgres(t.pool, { migrate: false });
    expect(await db.listSessions()).toEqual(before);
    expect((await db.ingestBatch(WS, S, FIXTURE)).filter((r) => r.inserted)).toEqual([]);
    expect(await db.listSessions()).toEqual(before);
    expect((await db.searchEmbeddings(vec(3), [WS], { limit: 1 })).map((h) => h.text)).toEqual(['t3']);
    await db.insertEmbeddings([{ workspaceId: WS, sessionId: S, kind: 'turn', refEventId: 99, ts: 1, text: 'new', modelId: EMBED_MODEL_ID, dim: EMBED_DIM, vec: encodeVector(vec(5)), dedupKey: 'new' }]);
    const inbox = await InboxStore.openPostgres(t.pool, { migrate: false });
    try {
      expect((await inbox.list({})).map((x) => x.id).sort()).toEqual(todoIds);
      const { todo } = await inbox.post(ME, { title: 'after the copy', key: 'after' });
      expect((await inbox.events(todo.id)).length).toBeGreaterThan(0);
    } finally {
      await inbox.close();
    }
  });

  it('leaves every identity sequence at or past its column max', async () => {
    await importSqlite(opts('inbox'));
    await importSqlite(opts('state'));
    const ids = (await sql<{ t: string; c: string }>`
      SELECT table_name AS t, column_name AS c FROM information_schema.columns
      WHERE table_schema = current_schema() AND is_identity = 'YES'`.execute(k)).rows;
    expect(ids.length).toBeGreaterThan(5);
    for (const { t: table, c } of ids) {
      const max = (await sql<{ m: number | null }>`SELECT max(${sql.ref(c)}) AS m FROM ${sql.table(table)}`.execute(k)).rows[0].m;
      if (max === null) continue;
      const next = (await sql<{ n: number }>`SELECT nextval(pg_get_serial_sequence(${table}, ${c})) AS n`.execute(k)).rows[0].n;
      expect(next, `${table}.${c}`).toBeGreaterThan(max);
    }
  });

  it('copies text holding NUL as U+FFFD, and the counts still verify', async () => {
    const w = new Database(join(dir, 'inbox.db'));
    w.prepare(`UPDATE todos SET body = ? WHERE id = ?`).run('a\u0000b', todoIds[0]);
    w.close();
    const s = new Database(join(dir, 'state.db'));
    s.prepare(`UPDATE sessions SET user_set_name = ? WHERE id = ?`).run('n\u0000ul', S);
    s.close();
    expect((await importSqlite(opts('inbox'))).status).toBe('copied');
    expect((await importSqlite(opts('state'))).status).toBe('copied');
    expect((await sql<{ b: string }>`SELECT body AS b FROM todos WHERE id = ${todoIds[0]}`.execute(k)).rows[0].b).toBe('a�b');
    expect((await sql<{ n: string }>`SELECT user_set_name AS n FROM sessions WHERE id = ${S}`.execute(k)).rows[0].n).toBe('n�ul');
  });

  it('resumes after a failure and ends equal to a straight copy', async () => {
    let chunks = 0;
    const failing = opts('state', { onProgress: () => { if (++chunks === 3) throw new Error('injected'); } });
    await expect(importSqlite(failing)).rejects.toThrow('injected');
    const seen: ImportProgress[] = [];
    const out = await importSqlite(opts('state', { onProgress: (p) => seen.push(p) }));
    expect(out.status).toBe('copied');
    const src = new Database(join(dir, 'state.db'), { readonly: true });
    expect(await pgCount('events')).toBe((src.prepare('SELECT count(*) AS n FROM events').get() as { n: number }).n);
    src.close();
    // Resumed, not restarted: the table finished before the failure isn't copied again.
    expect(seen.some((p) => p.table === 'sessions')).toBe(false);
    expect(seen.at(-1)).toMatchObject({ source: 'state' });
    expect(await importSqlite(opts('state'))).toMatchObject({ status: 'already' });
  });

  it('reports each chunk as source, table, copied so far and the table total', async () => {
    const seen: ImportProgress[] = [];
    await importSqlite(opts('inbox', { onProgress: (p) => seen.push(p) }));
    const todos = seen.filter((p) => p.table === 'todos');
    expect(todos.length).toBeGreaterThan(1);
    expect(todos.every((p) => p.source === 'inbox' && p.total === 25)).toBe(true);
    expect(todos.map((p) => p.copied)).toEqual([...todos.map((p) => p.copied)].sort((a, b) => a - b));
    expect(todos.at(-1)?.copied).toBe(25);
  });

  it('a source changed between attempts restarts the copy from scratch', async () => {
    let chunks = 0;
    await expect(importSqlite(opts('state', { onProgress: () => { if (++chunks === 2) throw new Error('injected'); } }))).rejects.toThrow('injected');
    const w = new Database(join(dir, 'state.db'));
    w.prepare('UPDATE sessions SET user_set_name = ? WHERE id = ?').run('renamed again', S);
    w.close();
    await importSqlite(opts('state'));
    const row = (await sql<{ n: string }>`SELECT user_set_name AS n FROM sessions WHERE id = ${S}`.execute(k)).rows[0];
    expect(row.n).toBe('renamed again');
  });

  it('a row written by anything else during the copy fails it', async () => {
    const racing = opts('state', {
      onProgress: (p) => {
        // Raw SQL takes the store's write lock, so this lands before the count check.
        if (p.table === 'sessions') void sql`INSERT INTO sessions (id, workspace_id) VALUES ('intruder', 'W')`.execute(k);
      },
    });
    await expect(importSqlite(racing)).rejects.toThrow(/copying sessions: Postgres has 2 rows/);
  });

  it('leaves a store that already holds data untouched', async () => {
    await sql`INSERT INTO notify_state (k, v) VALUES ('pre-existing', '1')`.execute(k);
    expect(await importSqlite(opts('inbox'))).toMatchObject({ status: 'skipped-nonempty' });
    expect(await pgCount('todos')).toBe(0);
    expect((await sql<{ v: string }>`SELECT v FROM notify_state WHERE k = 'pre-existing'`.execute(k)).rows).toEqual([{ v: '1' }]);
  });

  it('reports a missing file and refuses another schema version', async () => {
    expect(await importSqlite({ ...opts('inbox'), file: join(dir, 'nope.db') })).toMatchObject({ status: 'absent' });
    await expect(importSqlite({ ...opts('inbox'), expectedVersion: INBOX_SCHEMA_VERSION + 1 })).rejects.toThrow(ImportError);
  });
});
