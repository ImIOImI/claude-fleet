// Host-scale bench for search_transcripts' vector scan (#596): ~62k text turn
// vectors (int8) plus ~286k placeholder rows, the shape measured on the host.
// Reports main-thread blocked ms (max event-loop delay) per search for the
// scan before #596 (read every row with its text, decode, sort), the inline
// scanTopK fallback, and the worker.
//
// Skipped unless SEARCH_SCAN_BENCH=1:
//   SEARCH_SCAN_BENCH=1 npx vitest run src/main/searchScanBench.test.ts
import { describe, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { scanTopK, SearchWorkerClient, type ScanJob } from './searchWorker.js';
import { decodeVector, encodeVectorInt8, topK, EMBED_DIM, EMBED_MODEL_ID } from './vectors.js';

const ON = process.env.SEARCH_SCAN_BENCH === '1';
const TEXT_ROWS = 62_000;
const PLACEHOLDERS = 286_000;
const WORKSPACES = 6;
const ROUNDS = Number(process.env.SEARCH_SCAN_ROUNDS ?? 10);

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

function build(path: string): void {
  const w = new Database(path);
  w.pragma('journal_mode = WAL');
  w.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace_id TEXT);
    CREATE TABLE embeddings (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, session_id TEXT NOT NULL,
      kind TEXT NOT NULL, ref_event_id INTEGER, ts INTEGER, text TEXT NOT NULL, model_id TEXT NOT NULL, dim INTEGER NOT NULL,
      vec BLOB NOT NULL, dedup_key TEXT NOT NULL);
    CREATE INDEX idx_emb_workspace ON embeddings(workspace_id);
    CREATE INDEX idx_emb_session ON embeddings(session_id);`);
  const r = rand(11);
  const sess = w.prepare('INSERT INTO sessions VALUES (?, ?)');
  const ins = w.prepare(`INSERT INTO embeddings (workspace_id, session_id, kind, ts, text, model_id, dim, vec, dedup_key)
                         VALUES (?, ?, 'turn', ?, ?, ?, ?, ?, ?)`);
  const empty = Buffer.alloc(0);
  w.transaction(() => {
    for (let s = 0; s < 1500; s++) sess.run(`s${s}`, `ws${s % WORKSPACES}`);
    const total = TEXT_ROWS + PLACEHOLDERS;
    const every = total / TEXT_ROWS;
    let text = 0;
    for (let i = 0; i < total; i++) {
      const s = i % 1500;
      const isText = text < TEXT_ROWS && i >= Math.round(text * every);
      if (isText) {
        text++;
        ins.run(`ws${s % WORKSPACES}`, `s${s}`, i, `turn ${i} ` + 'x'.repeat(400), EMBED_MODEL_ID, EMBED_DIM, encodeVectorInt8(unit(r)), `k${i}`);
      } else {
        ins.run(`ws${s % WORKSPACES}`, `s${s}`, i, '', EMBED_MODEL_ID, EMBED_DIM, empty, `p${i}`);
      }
    }
  })();
  w.close();
}

function oldScan(db: Database.Database, q: Float32Array, job: ScanJob): void {
  const rows = db.prepare(`SELECT session_id, workspace_id, kind, ts, text, vec FROM embeddings
    WHERE workspace_id IN (${job.allowed.map(() => '?').join(',')}) AND model_id = ? AND text <> ''
    AND EXISTS (SELECT 1 FROM sessions s WHERE s.id = embeddings.session_id)`)
    .all(...job.allowed, job.modelId) as Array<{ vec: Buffer }>;
  topK(q, rows.map((x) => ({ vec: decodeVector(x.vec) })), job.limit);
}

async function blocked(fn: () => Promise<unknown> | unknown): Promise<number> {
  const h = monitorEventLoopDelay({ resolution: 1 });
  h.enable();
  // Let the histogram sample the loop while fn runs (or while it waits on the worker).
  await new Promise((r) => setTimeout(r, 5));
  await fn();
  await new Promise((r) => setTimeout(r, 5));
  h.disable();
  return h.max / 1e6;
}

const stat = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return { p50: s[Math.floor(s.length / 2)].toFixed(1), max: s[s.length - 1].toFixed(1) };
};

describe.skipIf(!ON)('search scan bench (#596)', () => {
  it('main-thread blocked ms per search', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cf-searchbench-'));
    const path = join(dir, 'state.db');
    build(path);
    const ro = new Database(path, { readonly: true });
    const client = new SearchWorkerClient(path);
    const job: ScanJob = { allowed: Array.from({ length: WORKSPACES }, (_, i) => `ws${i}`), modelId: EMBED_MODEL_ID, limit: 10, dim: EMBED_DIM };
    const out: Record<string, number[]> = { before: [], inline: [], worker: [], workerScanMs: [] };
    try {
      await client.search(unit(rand(1)), job); // start the worker
      for (let i = 0; i < ROUNDS; i++) {
        const q = unit(rand(100 + i));
        out.before.push(await blocked(() => oldScan(ro, q, job)));
        out.inline.push(await blocked(() => scanTopK(ro, q, job)));
        let scanMs = 0;
        out.worker.push(await blocked(async () => { scanMs = (await client.search(q, job)).ms; }));
        out.workerScanMs.push(scanMs);
      }
      console.log(`[search-scan] ${TEXT_ROWS} text + ${PLACEHOLDERS} placeholder rows, ${ROUNDS} rounds, limit 10`);
      for (const [k, v] of Object.entries(out)) console.log(`[search-scan] ${k.padEnd(13)} p50 ${stat(v).p50} ms  max ${stat(v).max} ms`);
    } finally {
      await client.close();
      ro.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 600_000);
});
