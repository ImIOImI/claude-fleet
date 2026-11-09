import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { deflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { queryWorkerStats, runQueryInWorker } from './queryWorker.js';

const WS_A = 'ws-a';
const WS_B = 'ws-b';
let dir: string;
let srcPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'query-worker-'));
  srcPath = join(dir, 'state.db');
  const db = new Database(srcPath);
  db.exec(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, workspace_id TEXT NOT NULL, ts INTEGER,
      type TEXT NOT NULL, subtype TEXT, uuid TEXT, parent_uuid TEXT, model TEXT, input_tokens INTEGER,
      output_tokens INTEGER, cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER,
      service_tier TEXT, tool_name TEXT, tool_use_id TEXT, tool_input TEXT, tool_result_is_error INTEGER,
      raw_jsonl TEXT NOT NULL, dedup_key TEXT NOT NULL);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, last_active_at INTEGER);
    CREATE TABLE broker_sessions (workspace_id TEXT NOT NULL, broker_session_id TEXT NOT NULL);
    CREATE TABLE session_summaries (session_id TEXT, workspace_id TEXT NOT NULL, summary TEXT);
    CREATE TABLE session_tags (workspace_id TEXT NOT NULL, session_id TEXT, tag TEXT);
    CREATE TABLE usage_events (ts INTEGER, workspace_id TEXT NOT NULL, kind TEXT);
  `); // no perf_events / port_exposures: exercises the pre-v11 / pre-v15 fallbacks
  db.prepare(`INSERT INTO sessions VALUES ('sa', ?, 1), ('sb', ?, 2)`).run(WS_A, WS_B);
  const ev = db.prepare(`INSERT INTO events (session_id, workspace_id, ts, type, raw_jsonl, dedup_key) VALUES (?,?,?,?,?,?)`);
  ev.run('sa', WS_A, 1, 'user', '{"a":1}', 'k1');
  ev.run('sb', WS_B, 2, 'user', '{"secret":1}', 'k2');
  db.close();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const job = (sql: string, extra: Partial<{ params: unknown[]; includeRaw: boolean; maxRows: number; maxBytes: number }> = {}) => ({
  srcPath, allowed: [WS_A], includeRaw: false, sql, params: [], maxRows: 200, ...extra
});

// Worker spawns are slow under full-suite parallel load — generous per-test timeout.
describe('runQueryInWorker', { timeout: 30_000 }, () => {
  it('returns only allowed-workspace rows (isolation)', async () => {
    expect(await runQueryInWorker(job('SELECT id FROM sessions ORDER BY id'))).toEqual([{ id: 'sa' }]);
    expect(await runQueryInWorker(job(`SELECT count(*) AS n FROM events WHERE workspace_id = '${WS_B}'`))).toEqual([{ n: 0 }]);
  });

  it('cannot reach the source DB via sqlite_master or the attach alias', async () => {
    const names = (await runQueryInWorker(job("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name"))) as Array<{ name: string }>;
    expect(names.map((r) => r.name)).toEqual(
      ['broker_sessions', 'events', 'perf_events', 'port_exposures', 'session_summaries', 'session_tags', 'sessions', 'usage_events']
    );
    const dbs = (await runQueryInWorker(job('SELECT name FROM pragma_database_list ORDER BY name'))) as Array<{ name: string }>;
    expect(dbs.map((r) => r.name)).toEqual(['main']);
  });

  it('omits raw_jsonl unless include_raw, and then only allowed rows', async () => {
    await expect(runQueryInWorker(job('SELECT raw_jsonl FROM events'))).rejects.toThrow(/no such column/i);
    expect(await runQueryInWorker(job('SELECT raw_jsonl FROM events', { includeRaw: true }))).toEqual([{ raw_jsonl: '{"a":1}' }]);
  });

  it('caps rows via maxRows and binds params', async () => {
    expect(await runQueryInWorker(job('SELECT value FROM json_each(\'[1,2,3]\')', { maxRows: 2 }))).toHaveLength(2);
    expect(await runQueryInWorker(job('SELECT id FROM sessions WHERE id = ?', { params: ['sa'] }))).toEqual([{ id: 'sa' }]);
  });

  it('rejects oversized results, writes, and malformed SQL with clear errors', async () => {
    await expect(runQueryInWorker(job("SELECT printf('%.*c', 2000, 'x') AS s", { maxBytes: 100 }))).rejects.toThrow(/result too large/);
    await expect(runQueryInWorker(job('DROP TABLE events'))).rejects.toThrow(/read-only/i);
    await expect(runQueryInWorker(job('DEFINITELY NOT SQL'))).rejects.toThrow(/syntax error/i);
    await expect(runQueryInWorker(job('SELECT 1; SELECT 2'))).rejects.toThrow();
  });

  it('times out a hung worker, terminates it, and keeps the main loop free', async () => {
    let ticks = 0;
    const iv = setInterval(() => { ticks += 1; }, 10);
    const t0 = Date.now();
    await expect(
      runQueryInWorker(job('SELECT 1'), { timeoutMs: 150, workerSource: 'setInterval(() => {}, 1000);' })
    ).rejects.toThrow(/query timed out after 0s — narrow the query/);
    clearInterval(iv);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(ticks).toBeGreaterThan(3); // main loop kept running while the worker hung
    // terminate() reaps a JS-only hang promptly; the zombie count returns to 0.
    for (let i = 0; i < 100 && queryWorkerStats().zombies > 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(queryWorkerStats()).toEqual({ running: 0, zombies: 0, queued: 0 });
  });

  it('times out a long native SQLite statement without blocking the caller', async () => {
    // A finite but slow recursive CTE: the worker can't be interrupted mid-statement,
    // so the caller must be released at the deadline while the worker finishes.
    const slow = 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 30000000) SELECT count(*) AS n FROM c';
    const t0 = Date.now();
    await expect(runQueryInWorker(job(slow), { timeoutMs: 100 })).rejects.toThrow(/timed out/);
    expect(Date.now() - t0).toBeLessThan(3000); // deadline 100ms; slack for worker spawn under load
    for (let i = 0; i < 1500 && queryWorkerStats().zombies > 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(queryWorkerStats().zombies).toBe(0);
  }, 40_000);

  it('runs at most MAX_CONCURRENT_QUERIES workers at once; extra calls queue', async () => {
    const hang = { timeoutMs: 300, workerSource: 'setInterval(() => {}, 1000);' };
    const calls = [runQueryInWorker(job('SELECT 1'), hang), runQueryInWorker(job('SELECT 1'), hang), runQueryInWorker(job('SELECT 1'), hang)];
    await new Promise((r) => setTimeout(r, 50));
    expect(queryWorkerStats()).toMatchObject({ running: 2, queued: 1 });
    const results = await Promise.allSettled(calls);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    for (let i = 0; i < 100 && queryWorkerStats().zombies > 0; i++) await new Promise((r) => setTimeout(r, 20));
  });
});

describe('compressed rows (state v16)', () => {
  let v16: string;
  const line = JSON.stringify({ type: 'user', message: { content: 'compressed '.repeat(100) } });
  beforeAll(() => {
    v16 = join(dir, 'state16.db');
    const db = new Database(v16);
    db.exec(`
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, workspace_id TEXT NOT NULL, ts INTEGER,
        type TEXT NOT NULL, subtype TEXT, uuid TEXT, parent_uuid TEXT, model TEXT, input_tokens INTEGER,
        output_tokens INTEGER, cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER,
        service_tier TEXT, tool_name TEXT, tool_use_id TEXT, tool_input TEXT, tool_result_is_error INTEGER,
        raw_jsonl TEXT NOT NULL, dedup_key TEXT NOT NULL, raw_z BLOB);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL);
      CREATE TABLE broker_sessions (workspace_id TEXT NOT NULL);
      CREATE TABLE session_summaries (workspace_id TEXT NOT NULL);
      CREATE TABLE session_tags (workspace_id TEXT NOT NULL);
      CREATE TABLE usage_events (workspace_id TEXT NOT NULL);
    `);
    const ev = db.prepare(`INSERT INTO events (session_id, workspace_id, ts, type, raw_jsonl, dedup_key, raw_z) VALUES (?,?,?,?,?,?,?)`);
    ev.run('sa', WS_A, 1, 'user', '', 'k1', deflateSync(Buffer.from(line)));
    ev.run('sa', WS_A, 2, 'user', '{"plain":1}', 'k2', null);
    db.close();
  });
  const job16 = (sql: string, includeRaw: boolean) => ({ ...job(sql, { includeRaw }), srcPath: v16 });

  it('include_raw returns the decompressed line', async () => {
    expect(await runQueryInWorker(job16('SELECT raw_jsonl FROM events ORDER BY id', true)))
      .toEqual([{ raw_jsonl: line }, { raw_jsonl: '{"plain":1}' }]);
  });

  it('json functions work on decompressed text', async () => {
    expect(await runQueryInWorker(job16(`SELECT json_extract(raw_jsonl, '$.type') AS t FROM events WHERE id = 1`, true)))
      .toEqual([{ t: 'user' }]);
  });

  it('fleet_raw returns raw_jsonl for a corrupt raw_z', async () => {
    expect(await runQueryInWorker(job16(`SELECT fleet_raw('fallback', X'00ff') AS r`, false))).toEqual([{ r: 'fallback' }]);
  }, 30_000);

  it('fleet_raw is callable directly, and raw_jsonl stays absent without include_raw', async () => {
    expect(await runQueryInWorker(job16(`SELECT fleet_raw('x', NULL) AS r`, false))).toEqual([{ r: 'x' }]);
    await expect(runQueryInWorker(job16('SELECT raw_jsonl FROM events', false))).rejects.toThrow(/raw_jsonl/);
  }, 30_000);
});

describe('snapshot over a v17 state.db (deduped attachments)', () => {
  let v17: string;
  const payload = JSON.stringify({ type: 'skill_listing', content: 'skill '.repeat(400) });
  const ref = 'f'.repeat(64);
  const rendered = JSON.stringify([{ content: 'rendered '.repeat(50) }]);
  const full = (u: string) => `{"type":"attachment","uuid":"${u}","attachment":${payload},"rendered":${rendered}}`;
  const stored = (u: string) => `{"type":"attachment","uuid":"${u}","attachment":{"fleetRef":"${ref}","part":0},"rendered":{"fleetRef":"${ref}","part":1}}`;
  const body = JSON.stringify([payload, rendered]);
  beforeAll(() => {
    v17 = join(dir, 'state17.db');
    const db = new Database(v17);
    db.exec(`
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, workspace_id TEXT NOT NULL, ts INTEGER,
        type TEXT NOT NULL, subtype TEXT, uuid TEXT, parent_uuid TEXT, model TEXT, input_tokens INTEGER,
        output_tokens INTEGER, cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER,
        service_tier TEXT, tool_name TEXT, tool_use_id TEXT, tool_input TEXT, tool_result_is_error INTEGER,
        raw_jsonl TEXT NOT NULL, dedup_key TEXT NOT NULL, raw_z BLOB, att_ref TEXT);
      CREATE TABLE event_blobs (hash TEXT PRIMARY KEY, body_z BLOB NOT NULL, bytes INTEGER NOT NULL, refs INTEGER NOT NULL);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL);
      CREATE TABLE broker_sessions (workspace_id TEXT NOT NULL);
      CREATE TABLE session_summaries (workspace_id TEXT NOT NULL);
      CREATE TABLE session_tags (workspace_id TEXT NOT NULL);
      CREATE TABLE usage_events (workspace_id TEXT NOT NULL);
    `);
    const ev = db.prepare(`INSERT INTO events (session_id, workspace_id, ts, type, raw_jsonl, dedup_key, raw_z, att_ref) VALUES (?,?,?,?,?,?,?,?)`);
    ev.run('sa', WS_A, 1, 'attachment', stored('a'), 'k1', null, ref);
    ev.run('sa', WS_A, 2, 'attachment', '', 'k2', deflateSync(Buffer.from(stored('b'))), ref);
    ev.run('sb', WS_B, 3, 'attachment', stored('c'), 'k3', null, 'e'.repeat(64));
    db.prepare(`INSERT INTO event_blobs VALUES (?,?,?,?)`).run(ref, deflateSync(Buffer.from(body)), body.length, 2);
    db.prepare(`INSERT INTO event_blobs VALUES (?,?,?,?)`).run('e'.repeat(64), deflateSync(Buffer.from('["{\\"secret\\":1}"]')), 16, 1);
    db.close();
  });
  const job17 = (sql: string, includeRaw: boolean) => ({ ...job(sql, { includeRaw }), srcPath: v17 });

  it('include_raw rebuilds plain and compressed deduped lines', async () => {
    expect(await runQueryInWorker(job17('SELECT raw_jsonl FROM events ORDER BY id', true)))
      .toEqual([{ raw_jsonl: full('a') }, { raw_jsonl: full('b') }]);
  }, 30_000);

  it('copies only the blobs of allowed rows', async () => {
    expect(await runQueryInWorker(job17('SELECT hash FROM event_blobs', true))).toEqual([{ hash: ref }]);
  }, 30_000);

  it('fleet_raw with a missing body returns the stored line', async () => {
    expect(await runQueryInWorker(job17(`SELECT fleet_raw('{"attachment":{"fleetRef":"x","part":0}}', NULL, 'x', NULL) AS r`, false)))
      .toEqual([{ r: '{"attachment":{"fleetRef":"x","part":0}}' }]);
  }, 30_000);
});

