import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { scanTopK, SearchWorkerClient, SearchWorkerUnavailable, SEARCH_QUEUE_MAX, type ScanJob } from './searchWorker.js';
import { sqliteReadSource } from './sqliteReadSource.js';
import { decodeVector, encodeVector, encodeVectorInt8, topK, EMBED_DIM, EMBED_MODEL_ID } from './vectors.js';

const A = 'wsA';
const B = 'wsB';

function rand(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
}
function unit(r: () => number): Float32Array {
  const v = new Float32Array(EMBED_DIM);
  let n = 0;
  for (let i = 0; i < v.length; i++) { v[i] = r(); n += v[i] * v[i]; }
  n = Math.sqrt(n);
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

const SCHEMA = `
  CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace_id TEXT);
  CREATE TABLE embeddings (
    id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, session_id TEXT NOT NULL, kind TEXT NOT NULL,
    ref_event_id INTEGER, ts INTEGER, text TEXT NOT NULL, model_id TEXT NOT NULL, dim INTEGER NOT NULL,
    vec BLOB NOT NULL, dedup_key TEXT NOT NULL);
  CREATE INDEX idx_emb_workspace ON embeddings(workspace_id);`;

let dir: string;
let path: string;
let w: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cf-searchw-'));
  path = join(dir, 'state.db');
  w = new Database(path);
  w.pragma('journal_mode = WAL');
  w.exec(SCHEMA);
});
afterEach(() => {
  if (w.open) w.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Text rows (int8 and float32), placeholders, another model, another workspace and a deleted session. */
function seed(n = 400): void {
  const r = rand(7);
  w.prepare('INSERT INTO sessions (id, workspace_id) VALUES (?, ?)').run('sa', A);
  w.prepare('INSERT INTO sessions (id, workspace_id) VALUES (?, ?)').run('sb', B);
  const ins = w.prepare(`INSERT INTO embeddings (workspace_id, session_id, kind, ts, text, model_id, dim, vec, dedup_key)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (let i = 0; i < n; i++) {
    const v = unit(r);
    const ws = i % 5 === 0 ? B : A;
    const sid = i % 23 === 0 ? 'gone' : ws === A ? 'sa' : 'sb';
    const kind = i % 7 === 0 ? 'summary' : 'turn';
    if (i % 3 === 0) ins.run(ws, sid, kind, i, '', EMBED_MODEL_ID, EMBED_DIM, Buffer.alloc(0), `p${i}`);
    else ins.run(ws, sid, kind, i, `text ${i}`, i % 11 === 0 ? 'other-model' : EMBED_MODEL_ID, EMBED_DIM,
      i % 4 === 0 ? encodeVector(v) : encodeVectorInt8(v), `k${i}`);
  }
}

/** The scan before #596: read every allowed row, decode, topK over all of them. */
function reference(db: Database.Database, q: Float32Array, job: ScanJob) {
  const where = [`workspace_id IN (${job.allowed.map(() => '?').join(',')})`, 'model_id = ?', `text <> ''`,
    'EXISTS (SELECT 1 FROM sessions s WHERE s.id = embeddings.session_id)'];
  const params: unknown[] = [...job.allowed, job.modelId];
  if (job.kind) { where.push('kind = ?'); params.push(job.kind); }
  const rows = db.prepare(`SELECT session_id AS sessionId, workspace_id AS workspaceId, kind, ts, text, vec FROM embeddings
                           WHERE ${where.join(' AND ')} ORDER BY id`).all(...params) as Array<{ sessionId: string; workspaceId: string; kind: 'turn' | 'summary'; ts: number | null; text: string; vec: Buffer }>;
  return topK(q, rows.map((x) => ({ vec: decodeVector(x.vec) })), job.limit)
    .map(({ index, score }) => { const { vec: _v, ...hit } = rows[index]; return { ...hit, score }; });
}

const job = (o: Partial<ScanJob> = {}): ScanJob => ({ allowed: [A, B], modelId: EMBED_MODEL_ID, limit: 10, dim: EMBED_DIM, ...o });

describe('scanTopK', () => {
  it('returns exactly what the decode + topK scan returned', () => {
    seed();
    const q = unit(rand(99));
    for (const j of [job(), job({ allowed: [A] }), job({ kind: 'summary', limit: 3 }), job({ limit: 50 })]) {
      expect(scanTopK(w, q, j).hits).toEqual(reference(w, q, j));
    }
  });

  it('skips placeholders, other models and deleted sessions', () => {
    seed();
    const r = scanTopK(w, unit(rand(3)), job({ limit: 400 }));
    expect(r.hits.every((h) => h.text !== '' && h.sessionId !== 'gone')).toBe(true);
    expect(r.scanned).toBe(r.hits.length);
  });

  it('breaks score ties by lower id, like the sorted scan', () => {
    w.prepare('INSERT INTO sessions (id, workspace_id) VALUES (?, ?)').run('sa', A);
    const v = unit(rand(5));
    const ins = w.prepare(`INSERT INTO embeddings (workspace_id, session_id, kind, ts, text, model_id, dim, vec, dedup_key)
                           VALUES (?, 'sa', 'turn', ?, ?, ?, ?, ?, ?)`);
    for (let i = 0; i < 12; i++) ins.run(A, i, `same ${i}`, EMBED_MODEL_ID, EMBED_DIM, encodeVector(v), `t${i}`);
    const hits = scanTopK(w, v, job({ allowed: [A], limit: 5 })).hits;
    expect(hits.map((h) => h.text)).toEqual(['same 0', 'same 1', 'same 2', 'same 3', 'same 4']);
    expect(hits).toEqual(reference(w, v, job({ allowed: [A], limit: 5 })));
  });

  it('returns nothing for an empty scope or limit 0', () => {
    seed();
    expect(scanTopK(w, unit(rand(1)), job({ allowed: [] })).hits).toEqual([]);
    expect(scanTopK(w, unit(rand(1)), job({ limit: 0 })).hits).toEqual([]);
  });
});

describe('SearchWorkerClient', () => {
  it('matches the inline scan and keeps the caller scope', async () => {
    seed();
    const c = new SearchWorkerClient(path);
    try {
      const q = unit(rand(42));
      const r = await c.search(q, job({ allowed: [A], limit: 20 }));
      expect(r.hits).toEqual(reference(w, q, job({ allowed: [A], limit: 20 })));
      expect(r.hits.every((h) => h.workspaceId === A)).toBe(true);
    } finally {
      await c.close();
    }
  });

  it('sees rows committed after it started', async () => {
    seed(30);
    const c = new SearchWorkerClient(path);
    try {
      const q = unit(rand(5));
      await c.search(q, job());
      w.prepare(`INSERT INTO embeddings (workspace_id, session_id, kind, ts, text, model_id, dim, vec, dedup_key)
                 VALUES (?, 'sa', 'turn', 1, 'exact', ?, ?, ?, 'x')`).run(A, EMBED_MODEL_ID, EMBED_DIM, encodeVector(q));
      expect((await c.search(q, job({ limit: 1 }))).hits[0].text).toBe('exact');
    } finally {
      await c.close();
    }
  });

  it('times out the running scan only, terminates that worker, and serves the queue from a fresh one', async () => {
    seed(30);
    // The first worker hangs on its first scan; later workers answer.
    const flag = join(dir, 'hung');
    const src = `
      const { parentPort, workerData } = require('node:worker_threads');
      const fs = require('node:fs');
      const first = !fs.existsSync(${JSON.stringify(flag)});
      if (first) fs.writeFileSync(${JSON.stringify(flag)}, String(process.pid));
      parentPort.postMessage({ ready: true });
      parentPort.on('message', (m) => {
        if (m === 'close') return parentPort.close();
        if (first) return;
        parentPort.postMessage({ ok: true, result: { hits: [], scanned: 7, ms: 1 } });
      });`;
    const logs: string[] = [];
    const c = new SearchWorkerClient(path, { timeoutMs: 300, workerSource: src, log: (m) => logs.push(m) });
    try {
      const a = c.search(unit(rand(1)), job());
      const b = c.search(unit(rand(2)), job());
      const d = c.search(unit(rand(3)), job());
      await expect(a).rejects.toThrow(/timed out/);
      expect((await b).scanned).toBe(7);
      expect((await d).scanned).toBe(7);
      expect(logs.some((m) => /timed out/.test(m))).toBe(true);
      expect(c.usable()).toBe(true);
    } finally {
      await c.close();
    }
  });

  it('gives up after repeated timeouts', async () => {
    seed(10);
    const hang = `
      const { parentPort } = require('node:worker_threads');
      parentPort.postMessage({ ready: true });
      parentPort.on('message', (m) => { if (m === 'close') parentPort.close(); });`;
    const c = new SearchWorkerClient(path, { timeoutMs: 100, workerSource: hang });
    for (let i = 0; i < 3; i++) await expect(c.search(unit(rand(1)), job())).rejects.toThrow(/timed out/);
    expect(c.usable()).toBe(false);
    await expect(c.search(unit(rand(1)), job())).rejects.toBeInstanceOf(SearchWorkerUnavailable);
    await c.close();
  });

  it('disables after three crashes', async () => {
    seed(10);
    const crash = `
      const { parentPort } = require('node:worker_threads');
      parentPort.postMessage({ ready: true });
      parentPort.on('message', () => { process.exit(3); });`;
    const c = new SearchWorkerClient(path, { workerSource: crash });
    try {
      const rs = await Promise.allSettled([c.search(unit(rand(1)), job()), c.search(unit(rand(2)), job()), c.search(unit(rand(3)), job()), c.search(unit(rand(4)), job())]);
      const inline = rs.filter((r) => r.status === 'rejected' && r.reason instanceof SearchWorkerUnavailable && r.reason.inline);
      expect(rs.every((r) => r.status === 'rejected')).toBe(true);
      // 3 crashes disable the client, after which the remaining caller may scan inline too.
      expect(inline.length).toBeLessThanOrEqual(4);
      expect(c.usable()).toBe(false);
    } finally {
      await c.close();
    }
  });

  it('marks a single crash inline for one caller only', async () => {
    seed(10);
    const flag = join(dir, 'crashed');
    const src = `
      const { parentPort } = require('node:worker_threads');
      const fs = require('node:fs');
      const first = !fs.existsSync(${JSON.stringify(flag)});
      if (first) fs.writeFileSync(${JSON.stringify(flag)}, '1');
      parentPort.postMessage({ ready: true });
      parentPort.on('message', (m) => {
        if (m === 'close') return parentPort.close();
        if (first) process.exit(3);
        parentPort.postMessage({ ok: true, result: { hits: [], scanned: 1, ms: 1 } });
      });`;
    const c = new SearchWorkerClient(path, { workerSource: src });
    try {
      const rs = await Promise.allSettled([c.search(unit(rand(1)), job()), c.search(unit(rand(2)), job()), c.search(unit(rand(3)), job())]);
      expect(rs[0].status === 'rejected' && rs[0].reason instanceof SearchWorkerUnavailable && rs[0].reason.inline).toBe(true);
      expect(rs[1].status).toBe('fulfilled');
      expect(rs[2].status).toBe('fulfilled');
    } finally {
      await c.close();
    }
  });

  it('reports unavailable when the worker cannot open the DB, and gives up after 3 failures', async () => {
    const logs: string[] = [];
    const c = new SearchWorkerClient(join(dir, 'missing.db'), { log: (m) => logs.push(m) });
    for (let i = 0; i < 3; i++) {
      await expect(c.search(unit(rand(1)), job())).rejects.toBeInstanceOf(SearchWorkerUnavailable);
    }
    expect(c.usable()).toBe(false);
    expect(logs.some((m) => /inline from now on/.test(m))).toBe(true);
    await c.close();
  });

  it('rejects a search in flight at close, and later searches, with a plain error', async () => {
    seed(10);
    const hang = `
      const { parentPort } = require('node:worker_threads');
      parentPort.postMessage({ ready: true });
      parentPort.on('message', (m) => { if (m === 'close') parentPort.close(); });`;
    const c = new SearchWorkerClient(path, { workerSource: hang });
    const p = c.search(unit(rand(1)), job()).catch((x: unknown) => x);
    await new Promise((r) => setTimeout(r, 100));
    await c.close();
    const e = await p;
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(SearchWorkerUnavailable);
    await expect(c.search(unit(rand(1)), job())).rejects.toThrow(/closed/);
  });

  it('serves concurrent searches in order with correct results', async () => {
    seed();
    const c = new SearchWorkerClient(path);
    try {
      const qs = [1, 2, 3, 4, 5].map((i) => unit(rand(200 + i)));
      const rs = await Promise.all(qs.map((q) => c.search(q, job())));
      rs.forEach((r, i) => expect(r.hits).toEqual(reference(w, qs[i], job())));
    } finally {
      await c.close();
    }
  });

  it('caps the queue', async () => {
    seed(10);
    const hang = `
      const { parentPort } = require('node:worker_threads');
      parentPort.postMessage({ ready: true });
      parentPort.on('message', (m) => { if (m === 'close') parentPort.close(); });`;
    const c = new SearchWorkerClient(path, { workerSource: hang, timeoutMs: 60_000 });
    const ps = Array.from({ length: SEARCH_QUEUE_MAX + 2 }, () => c.search(unit(rand(1)), job()).catch((e: Error) => e.message));
    await new Promise((r) => setTimeout(r, 200));
    await c.close();
    const msgs = await Promise.all(ps);
    expect(msgs.filter((m) => /busy/.test(String(m))).length).toBeGreaterThanOrEqual(1);
  });
});

describe('sqliteReadSource search', () => {
  it('scans in the worker and returns the same hits as inline', async () => {
    seed();
    const ro = new Database(path, { readonly: true });
    const rs = sqliteReadSource(ro);
    try {
      const q = unit(rand(8));
      const hits = await rs.searchEmbeddings(q, new Set([A, B]), { limit: 10 });
      expect(hits).toEqual(reference(w, q, job()));
    } finally {
      await rs.close();
    }
  });

  it('falls back to the inline scan when the worker is unavailable', async () => {
    seed();
    const ro = new Database(path, { readonly: true });
    const broken = `require('node:worker_threads').parentPort.postMessage({ ready: false, message: 'no' });`;
    const rs = sqliteReadSource(ro, { searchWorker: { workerSource: broken } });
    try {
      const q = unit(rand(9));
      expect(await rs.searchEmbeddings(q, new Set([A]), { limit: 5, kind: 'turn' }))
        .toEqual(reference(w, q, job({ allowed: [A], limit: 5, kind: 'turn' })));
    } finally {
      await rs.close();
    }
  });

  it('does not scan inline for a search in flight at close', async () => {
    seed(30);
    const ro = new Database(path, { readonly: true });
    const hang = `
      const { parentPort } = require('node:worker_threads');
      parentPort.postMessage({ ready: true });
      parentPort.on('message', (m) => { if (m === 'close') parentPort.close(); });`;
    const rs = sqliteReadSource(ro, { searchWorker: { workerSource: hang } });
    const p = rs.searchEmbeddings(unit(rand(1)), new Set([A]), { limit: 5 }).catch((x: Error) => x);
    await new Promise((r) => setTimeout(r, 100));
    await rs.close();
    expect(String(await p)).toMatch(/closed/);
    await expect(rs.searchEmbeddings(unit(rand(1)), new Set([A]), { limit: 5 })).rejects.toThrow(/closed/);
  });

  it('surfaces a worker timeout instead of rescanning inline', async () => {
    seed(30);
    const ro = new Database(path, { readonly: true });
    const hang = `
      const { parentPort } = require('node:worker_threads');
      parentPort.postMessage({ ready: true });
      parentPort.on('message', () => {});`;
    const rs = sqliteReadSource(ro, { searchWorker: { workerSource: hang, timeoutMs: 150 } });
    try {
      await expect(rs.searchEmbeddings(unit(rand(1)), new Set([A]), { limit: 5 })).rejects.toThrow(/timed out/);
    } finally {
      await rs.close();
    }
  });
});
