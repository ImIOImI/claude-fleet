// Off-main-thread semantic search scan for the SQLite MCP read path (#596).
//
// search_transcripts scores every allowed embedding against the query vector.
// On the host's corpus (~60k text vectors) that read + score took 400–600 ms,
// synchronously on the main thread. A long-lived worker thread holding its own
// read-only connection now does the scan and returns only the top-k hits.
//
// scanTopK is serialized into the worker via toString(), so it MUST stay
// self-contained: it may use only its parameters and globals — no imports,
// module-level constants or helpers. The inline fallback calls the same
// function, so both modes return identical results.
//
// No vector cache: PRAGMA data_version changes on every ingest commit, and
// retention rewrites vectors in place (float32 → int8), so a cache would be
// invalidated on nearly every query.

import { Worker } from 'node:worker_threads';
import type BetterSqlite3 from 'better-sqlite3';
import { betterSqlitePath } from './queryWorker.js';

export const SEARCH_TIMEOUT_MS = 10_000;
const READY_TIMEOUT_MS = 5_000;
/** Worker failures (start, crash) within FAILURE_WINDOW_MS before the client gives up for the process. */
const MAX_FAILURES = 3;
const FAILURE_WINDOW_MS = 5 * 60_000;

export interface ScanJob {
  /** Allowed workspace ids; the scan reads only these rows. */
  allowed: string[];
  modelId: string;
  kind?: 'turn' | 'summary';
  limit: number;
  /** EMBED_DIM: an int8 row is `[f32 scale][int8 × dim]`. */
  dim: number;
}

export interface ScanHit {
  sessionId: string;
  workspaceId: string;
  kind: 'turn' | 'summary';
  ts: number | null;
  text: string;
  score: number;
}

export interface ScanResult {
  hits: ScanHit[];
  /** Rows scored. */
  scanned: number;
  /** Wall time of the scan where it ran. */
  ms: number;
}

/** Brute-force cosine top-k over `job.allowed`'s current-model, non-placeholder
 *  embeddings of live sessions. Scores match decodeVector + dot exactly (int8
 *  elements rounded to float32 first); ties keep the lower id first. Only the
 *  top-k rows' text is read. SELF-CONTAINED — serialized into the worker. */
export function scanTopK(db: BetterSqlite3.Database, q: Float32Array, job: ScanJob): ScanResult {
  const t0 = performance.now();
  const ids = job.allowed;
  const k = Math.max(0, Math.floor(job.limit));
  if (ids.length === 0 || k === 0) return { hits: [], scanned: 0, ms: 0 };
  const where = [
    `workspace_id IN (${ids.map(() => '?').join(',')})`, 'model_id = ?', `text <> ''`,
    'EXISTS (SELECT 1 FROM sessions s WHERE s.id = embeddings.session_id)',
  ];
  const params: unknown[] = [...ids, job.modelId];
  if (job.kind) {
    where.push('kind = ?');
    params.push(job.kind);
  }
  const top: Array<{ id: number; score: number }> = [];
  let scanned = 0;
  const stmt = db.prepare(`SELECT id, vec FROM embeddings WHERE ${where.join(' AND ')} ORDER BY id`).raw(true);
  for (const row of stmt.iterate(...params) as Iterable<[number, Uint8Array | null]>) {
    const id = row[0];
    const v = row[1];
    let s = 0;
    if (v && v.byteLength === job.dim + 4) {
      const scale = new DataView(v.buffer, v.byteOffset, 4).getFloat32(0, true);
      const e = new Int8Array(v.buffer, v.byteOffset + 4, job.dim);
      const n = Math.min(q.length, job.dim);
      for (let i = 0; i < n; i++) s += q[i] * Math.fround(e[i] * scale);
    } else if (v && v.byteLength > 0) {
      const dv = new DataView(v.buffer, v.byteOffset, v.byteLength);
      const n = Math.min(q.length, Math.floor(v.byteLength / 4));
      for (let i = 0; i < n; i++) s += q[i] * dv.getFloat32(i * 4, true);
    }
    scanned++;
    if (top.length < k || s > top[top.length - 1].score) {
      let j = top.length;
      while (j > 0 && top[j - 1].score < s) j--;
      top.splice(j, 0, { id, score: s });
      if (top.length > k) top.pop();
    }
  }
  const hits: ScanHit[] = [];
  if (top.length > 0) {
    const rows = db
      .prepare(`SELECT id, session_id AS sessionId, workspace_id AS workspaceId, kind, ts, text FROM embeddings
                WHERE id IN (${top.map(() => '?').join(',')})`)
      .all(...top.map((t) => t.id)) as Array<{ id: number; sessionId: string; workspaceId: string; kind: 'turn' | 'summary'; ts: number | null; text: string }>;
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const t of top) {
      const r = byId.get(t.id);
      if (r) hits.push({ sessionId: r.sessionId, workspaceId: r.workspaceId, kind: r.kind, ts: r.ts, text: r.text, score: t.score });
    }
  }
  return { hits, scanned, ms: performance.now() - t0 };
}

const WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
const scan = (${scanTopK.toString()});
let db = null;
try {
  const Database = require(workerData.bs3Path);
  db = new Database(workerData.dbPath, { readonly: true, fileMustExist: true });
  parentPort.postMessage({ ready: true });
} catch (e) {
  parentPort.postMessage({ ready: false, message: e && e.message ? e.message : String(e) });
}
parentPort.on('message', (m) => {
  if (m === 'close') {
    try { if (db) db.close(); } catch {}
    parentPort.close();
    return;
  }
  try {
    parentPort.postMessage({ id: m.id, ok: true, result: scan(db, m.q, m.job) });
  } catch (e) {
    parentPort.postMessage({ id: m.id, ok: false, message: e && e.message ? e.message : String(e) });
  }
});
`;

/** The worker couldn't serve the call (didn't start, crashed, or the client gave up); callers scan inline. */
export class SearchWorkerUnavailable extends Error {}

export interface SearchWorkerOptions {
  timeoutMs?: number;
  readyTimeoutMs?: number;
  /** Test seam: replaces the worker body. */
  workerSource?: string;
  /** Called once when the client stops using the worker for the process. */
  onDisabled?: (reason: string) => void;
}

interface Pending {
  resolve: (r: ScanResult) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** One long-lived worker per state.db path; requests run in order. */
export class SearchWorkerClient {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private failures: number[] = [];
  private disabled = false;
  private closed = false;

  constructor(private readonly dbPath: string, private readonly opts: SearchWorkerOptions = {}) {}

  /** False once the client gave up (repeated failures) or was closed. */
  usable(): boolean {
    return !this.disabled && !this.closed;
  }

  /** Rejects with SearchWorkerUnavailable when the worker can't serve it, or
   *  with a timeout Error (the worker is then replaced; don't rescan inline). */
  async search(q: Float32Array, job: ScanJob): Promise<ScanResult> {
    if (!this.usable()) throw new SearchWorkerUnavailable('search worker disabled');
    await this.start();
    const w = this.worker;
    if (!w) throw new SearchWorkerUnavailable('search worker not running');
    const id = this.nextId++;
    const timeoutMs = this.opts.timeoutMs ?? SEARCH_TIMEOUT_MS;
    return new Promise<ScanResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`transcript search timed out after ${Math.round(timeoutMs / 1000)}s`));
        // A scan inside a native statement can't be interrupted: replace the worker.
        this.drop(new Error('search worker restarted after a timeout'));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      w.postMessage({ id, q, job });
    });
  }

  /** Lets an idle worker close its connection (so it isn't open when the app's
   *  connection closes), then terminates it. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const w = this.worker;
    this.worker = null;
    this.ready = null;
    this.rejectAll(new SearchWorkerUnavailable('search worker closed'));
    if (!w) return;
    // Bounded: a worker that already exited never emits 'exit' again.
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(t);
        resolve();
      };
      const t = setTimeout(() => void w.terminate().catch(() => undefined).finally(done), 1000);
      w.once('exit', done);
      try {
        w.postMessage('close');
      } catch {
        done();
      }
    });
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    const ready = new Promise<void>((resolve, reject) => {
      let settled = false;
      let w: Worker;
      const down = (reason: string) => {
        if (this.worker !== w) return;
        this.failed(reason);
        this.drop(new SearchWorkerUnavailable(reason));
        if (!settled) {
          settled = true;
          clearTimeout(t);
          reject(new SearchWorkerUnavailable(reason));
        }
      };
      try {
        w = new Worker(this.opts.workerSource ?? WORKER_SRC, {
          eval: true,
          workerData: { bs3Path: betterSqlitePath(), dbPath: this.dbPath },
        });
      } catch (e) {
        this.failed(String(e));
        this.ready = null;
        reject(new SearchWorkerUnavailable(String(e)));
        return;
      }
      w.unref();
      this.worker = w;
      const t = setTimeout(() => down('search worker did not start'), this.opts.readyTimeoutMs ?? READY_TIMEOUT_MS);
      t.unref?.();
      w.on('message', (m: { ready?: boolean; id?: number; ok?: boolean; result?: ScanResult; message?: string }) => {
        if (m.ready !== undefined) {
          if (!m.ready) down(m.message ?? 'search worker failed to open state.db');
          else if (!settled) {
            settled = true;
            clearTimeout(t);
            resolve();
          }
          return;
        }
        const p = m.id === undefined ? undefined : this.pending.get(m.id);
        if (!p || m.id === undefined) return;
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.ok && m.result) p.resolve(m.result);
        else p.reject(new Error(m.message ?? 'search failed'));
      });
      w.on('error', (e) => down(`search worker crashed: ${String(e)}`));
      w.on('exit', (code) => down(`search worker exited (code ${code})`));
    });
    this.ready = ready;
    return ready;
  }

  /** Drop the worker and fail everything in flight; the next search starts a fresh one. */
  private drop(err: Error): void {
    const w = this.worker;
    this.worker = null;
    this.ready = null;
    this.rejectAll(err);
    if (w) void w.terminate().catch(() => undefined);
  }

  private rejectAll(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private failed(reason: string): void {
    const now = Date.now();
    this.failures = this.failures.filter((t) => now - t < FAILURE_WINDOW_MS);
    this.failures.push(now);
    if (this.failures.length >= MAX_FAILURES && !this.disabled) {
      this.disabled = true;
      this.opts.onDisabled?.(reason);
    }
  }
}
