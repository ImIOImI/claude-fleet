// Brute-force vector scans (search_transcripts and history:search's local
// half), run in a worker thread with its own read-only connection so they
// don't block main.
//
// scanTopK is serialized into the worker via toString(): it may use only its
// parameters and globals. The inline fallback calls the same function.
//
// No vector cache: every ingest commit changes PRAGMA data_version and
// retention rewrites vectors in place.

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
 *  elements rounded to float32 first); ties keep the lower id. Only the
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
  const stmt = db.prepare(`SELECT id, vec FROM embeddings WHERE ${where.join(' AND ')}`).raw(true);
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
    const last = top[top.length - 1];
    if (top.length < k || s > last.score || (s === last.score && id < last.id)) {
      let j = top.length;
      while (j > 0 && (top[j - 1].score < s || (top[j - 1].score === s && top[j - 1].id > id))) j--;
      top.splice(j, 0, { id, score: s });
      if (top.length > k) top.pop();
    }
  }
  const hits: ScanHit[] = [];
  if (top.length > 0) {
    const rows = db
      .prepare(`SELECT id, session_id AS sessionId, workspace_id AS workspaceId, kind, ts, text FROM embeddings
                WHERE id IN (${top.map(() => '?').join(',')}) AND workspace_id IN (${ids.map(() => '?').join(',')})`)
      .all(...top.map((t) => t.id), ...ids) as Array<{ id: number; sessionId: string; workspaceId: string; kind: 'turn' | 'summary'; ts: number | null; text: string }>;
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

/** The worker couldn't serve the call (didn't start or crashed). `inline` is
 *  true for at most one caller per failure, or for every caller once the client
 *  has given up, so a crash doesn't turn every queued search into a main-thread scan. */
export class SearchWorkerUnavailable extends Error {
  constructor(message: string, readonly inline: boolean) {
    super(message);
  }
}

export const SEARCH_QUEUE_MAX = 16;
const LOG_EVERY_MS = 60_000;

export interface SearchWorkerOptions {
  timeoutMs?: number;
  readyTimeoutMs?: number;
  /** Test seam: replaces the worker body. */
  workerSource?: string;
  /** Rate-limited warnings (start failures, crashes, timeouts, giving up). */
  log?: (message: string) => void;
}

interface Job {
  q: Float32Array;
  job: ScanJob;
  resolve: (r: ScanResult) => void;
  reject: (e: Error) => void;
}

/** One worker per state.db path, one scan in flight. The timeout starts when a
 *  scan is sent; a scan past it is rejected and the worker replaced, and the
 *  queue carries over to the fresh worker. */
export class SearchWorkerClient {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private queue: Job[] = [];
  private running: { j: Job; timer: ReturnType<typeof setTimeout> } | null = null;
  private failures: number[] = [];
  private disabled = false;
  private closed = false;
  private lastLog = 0;

  constructor(private readonly dbPath: string, private readonly opts: SearchWorkerOptions = {}) {}

  /** False once the client gave up (repeated failures) or was closed. */
  usable(): boolean {
    return !this.disabled && !this.closed;
  }

  /** Rejects with SearchWorkerUnavailable when the worker can't serve it, or
   *  with a plain Error (timeout, full queue, closed) that callers surface. */
  search(q: Float32Array, job: ScanJob): Promise<ScanResult> {
    if (this.closed) return Promise.reject(new Error('search worker closed'));
    if (this.disabled) return Promise.reject(new SearchWorkerUnavailable('search worker disabled', true));
    if (this.queue.length >= SEARCH_QUEUE_MAX) return Promise.reject(new Error('transcript search is busy; retry shortly'));
    return new Promise<ScanResult>((resolve, reject) => {
      this.queue.push({ q, job, resolve, reject });
      this.pump();
    });
  }

  /** Lets the worker close its connection (terminated after 1 s); rejects queued searches. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const w = this.worker;
    this.worker = null;
    this.ready = null;
    this.rejectAll(new Error('search worker closed'));
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

  private pump(): void {
    if (this.running || this.queue.length === 0 || this.closed) return;
    if (this.disabled) {
      this.rejectAll(new SearchWorkerUnavailable('search worker disabled', true));
      return;
    }
    this.start().then(() => {
      if (this.worker === null || this.running || this.closed) return;
      const j = this.queue.shift();
      if (!j) return;
      const w = this.worker;
      const timeoutMs = this.opts.timeoutMs ?? SEARCH_TIMEOUT_MS;
      const timer = setTimeout(() => {
        if (this.running?.j !== j) return;
        this.running = null;
        j.reject(new Error(`transcript search timed out after ${Math.round(timeoutMs / 1000)}s`));
        // A scan inside a native statement can't be interrupted: replace the worker.
        this.failed(`search timed out after ${timeoutMs} ms`);
        this.replace(w);
        this.pump();
      }, timeoutMs);
      timer.unref?.();
      this.running = { j, timer };
      w.postMessage({ q: j.q, job: j.job });
    }, () => undefined);
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    const ready = new Promise<void>((resolve, reject) => {
      let settled = false;
      let w: Worker;
      const down = (reason: string) => {
        if (this.worker !== w) return;
        this.worker = null;
        this.ready = null;
        void w.terminate().catch(() => undefined);
        this.failed(reason);
        // The scan in flight (or, before ready, the first queued one) may run inline once.
        const first = this.running?.j ?? this.queue.shift();
        if (this.running) {
          clearTimeout(this.running.timer);
          this.running = null;
        }
        first?.reject(new SearchWorkerUnavailable(reason, true));
        if (this.disabled) this.rejectAll(new SearchWorkerUnavailable(reason, true));
        if (!settled) {
          settled = true;
          clearTimeout(t);
          reject(new SearchWorkerUnavailable(reason, false));
        }
        this.pump();
      };
      try {
        w = new Worker(this.opts.workerSource ?? WORKER_SRC, {
          eval: true,
          workerData: { bs3Path: betterSqlitePath(), dbPath: this.dbPath },
        });
      } catch (e) {
        this.failed(String(e));
        this.ready = null;
        this.queue.shift()?.reject(new SearchWorkerUnavailable(String(e), true));
        if (this.disabled) this.rejectAll(new SearchWorkerUnavailable(String(e), true));
        reject(new SearchWorkerUnavailable(String(e), false));
        queueMicrotask(() => this.pump());
        return;
      }
      w.unref();
      this.worker = w;
      const t = setTimeout(() => down('search worker did not start'), this.opts.readyTimeoutMs ?? READY_TIMEOUT_MS);
      t.unref?.();
      w.on('message', (m: { ready?: boolean; ok?: boolean; result?: ScanResult; message?: string }) => {
        if (m.ready !== undefined) {
          if (!m.ready) down(m.message ?? 'search worker failed to open state.db');
          else if (!settled) {
            settled = true;
            clearTimeout(t);
            resolve();
          }
          return;
        }
        if (this.worker !== w || !this.running) return;
        const { j, timer } = this.running;
        clearTimeout(timer);
        this.running = null;
        if (m.ok && m.result) j.resolve(m.result);
        else j.reject(new Error(m.message ?? 'search failed'));
        this.pump();
      });
      w.on('error', (e) => down(`search worker crashed: ${String(e)}`));
      w.on('exit', (code) => down(`search worker exited (code ${code})`));
    });
    this.ready = ready;
    return ready;
  }

  /** Terminate `w`; queued scans go to the next worker. */
  private replace(w: Worker): void {
    if (this.worker !== w) return;
    this.worker = null;
    this.ready = null;
    void w.terminate().catch(() => undefined);
  }

  private rejectAll(err: Error): void {
    if (this.running) {
      clearTimeout(this.running.timer);
      this.running.j.reject(err);
      this.running = null;
    }
    for (const j of this.queue.splice(0)) j.reject(err);
  }

  private failed(reason: string): void {
    const now = Date.now();
    this.failures = this.failures.filter((t) => now - t < FAILURE_WINDOW_MS);
    this.failures.push(now);
    if (this.failures.length >= MAX_FAILURES && !this.disabled) {
      this.disabled = true;
      this.opts.log?.(`search scans run inline from now on: ${reason}`);
      return;
    }
    if (now - this.lastLog >= LOG_EVERY_MS) {
      this.lastLog = now;
      this.opts.log?.(`search worker: ${reason}`);
    }
  }
}
