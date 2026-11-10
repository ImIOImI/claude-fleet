// Off-main-thread WAL checkpoints for state.db while retention runs, and for a
// WAL left by the previous run (SPEC §7 *Retention*). SQLite's auto-checkpoint runs inside whichever commit crosses
// the threshold, so on the main connection it lands, with its page copy and
// fsync, inside a retention slice.
import { Worker } from 'node:worker_threads';
import { takeLeftoverWal, withRawSqlite } from '../db.js';
import { logError } from '../errorLog.js';
import { betterSqlitePath } from '../queryWorker.js';

const WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
const Database = require(workerData.bs3Path);
const d = new Database(workerData.dbPath, { fileMustExist: true });
parentPort.on('message', (m) => {
  if (m === 'close') {
    d.close();
    parentPort.close();
    return;
  }
  try {
    const [r] = d.pragma('wal_checkpoint(PASSIVE)');
    parentPort.postMessage({ ok: true, busy: r.busy, log: r.log, checkpointed: r.checkpointed });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: String(e) });
  }
});
parentPort.postMessage({ ready: true });
`;

const READY_TIMEOUT_MS = 5000;
/** Past this many frames, the next slice waits for a complete checkpoint so
 *  its write rewinds the WAL (each rewind costs a header sync, so not every slice). */
export const WAL_REWIND_FRAMES = 4000;
/** A WAL past this many frames means checkpoints aren't keeping up. */
export const WAL_MAX_FRAMES = 10_000;
/** This many checkpoints in a row that leave frames behind (a reader pins them) or fail also give up. */
export const WAL_MAX_INCOMPLETE = 5;
/** A checkpoint outstanding this long is hung (e.g. stuck I/O): hand back. */
export const CHECKPOINT_TIMEOUT_MS = 5000;
/** The main connection truncates the WAL file to this after a rewind: about WAL_REWIND_FRAMES pages. */
const JOURNAL_SIZE_LIMIT = 16 * 1024 * 1024;
const REQUEST_EVERY_MS = 1000;

export interface CheckpointResult { busy: number; log: number; checkpointed: number }

export interface WalCheckpointer {
  /** Start a PASSIVE checkpoint in the worker unless one is already running. */
  request(): void;
  /** Resolves when no checkpoint is running. */
  idle(): Promise<void>;
  /** Once the WAL has passed WAL_REWIND_FRAMES: run a checkpoint and wait for it,
   *  so the caller's next write rewinds the WAL. Otherwise resolves at once. */
  drain(): Promise<void>;
  last(): CheckpointResult | null;
  /** False once it has handed checkpoints back to the main connection. */
  active(): boolean;
  /** Restore the main connection's settings and end the worker. Never waits on a checkpoint. */
  close(): Promise<void>;
}

export interface WalCheckpointerOptions {
  workerSource?: string;
  /** How often to request a checkpoint between slices (0 = only on request()). */
  requestEveryMs?: number;
  /** Default CHECKPOINT_TIMEOUT_MS. */
  checkpointTimeoutMs?: number;
}

/** A leftover-WAL drain gets longer than a retention checkpoint: it copies the whole previous run's WAL. */
export const DRAIN_TIMEOUT_MS = 60_000;

export interface WalDrainResult {
  startedAt: number;
  ms: number;
  ok: boolean;
  busy?: number;
  log?: number;
  checkpointed?: number;
  error?: string;
}

let draining: Promise<unknown> | null = null;

/** When openDb deferred a leftover WAL (takeLeftoverWal), checkpoint it from a
 *  worker, then restore the main connection's auto-checkpoint, also on failure
 *  or timeout. Null when there was nothing to drain. */
export function drainLeftoverWal(dbPath: string, opts: { workerSource?: string; timeoutMs?: number } = {}): Promise<WalDrainResult | null> {
  const restore = takeLeftoverWal();
  if (!restore) return Promise.resolve(null);
  const startedAt = Date.now();
  const t0 = performance.now();
  const p = checkpointOnce(dbPath, opts.workerSource ?? WORKER_SRC, opts.timeoutMs ?? DRAIN_TIMEOUT_MS)
    .then(async (r) => {
      await restore();
      if (!r.ok) logError({ source: 'main', level: 'warn', type: 'wal-checkpointer', message: `leftover WAL drain failed: ${r.error ?? 'unknown'}` });
      return { startedAt, ms: performance.now() - t0, ...r };
    });
  const tracked = p.finally(() => { if (draining === tracked) draining = null; });
  draining = tracked;
  return p;
}

type OnceResult = Omit<WalDrainResult, 'startedAt' | 'ms'>;

function checkpointOnce(dbPath: string, source: string, timeoutMs: number): Promise<OnceResult> {
  let worker: Worker;
  try {
    worker = new Worker(source, { eval: true, workerData: { bs3Path: betterSqlitePath(), dbPath } });
  } catch (e) {
    return Promise.resolve({ ok: false, error: `worker failed to start: ${String(e)}` });
  }
  worker.unref();
  return new Promise<OnceResult>((resolve) => {
    let done = false;
    const finish = (r: OnceResult, terminate: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      worker.postMessage('close');
      // A checkpoint still in native I/O can't be interrupted; never wait on it.
      if (terminate) void worker.terminate();
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, error: `no result in ${timeoutMs} ms` }, true), timeoutMs);
    timer.unref?.();
    worker.on('message', (m: { ready?: boolean; ok?: boolean; busy?: number; log?: number; checkpointed?: number; error?: string }) => {
      if (m.ready) { worker.postMessage(0); return; }
      if (m.ok) finish({ ok: true, busy: m.busy, log: m.log, checkpointed: m.checkpointed }, false);
      else finish({ ok: false, error: m.error ?? 'checkpoint failed' }, true);
    });
    worker.once('error', (e) => finish({ ok: false, error: `worker failed: ${String(e)}` }, true));
    worker.once('exit', () => finish({ ok: false, error: 'worker exited' }, false));
  });
}

/** Turn the main connection's auto-checkpoint off and checkpoint from a worker
 *  instead. Null (main connection untouched) when the worker or the pragmas fail. */
export async function startWalCheckpointer(dbPath: string, opts: WalCheckpointerOptions = {}): Promise<WalCheckpointer | null> {
  // A drain in flight holds auto-checkpoint at 0; reading it now would make this run restore 0.
  await draining;
  let worker: Worker;
  try {
    worker = new Worker(opts.workerSource ?? WORKER_SRC, { eval: true, workerData: { bs3Path: betterSqlitePath(), dbPath } });
  } catch (e) {
    logError({ source: 'main', level: 'warn', type: 'wal-checkpointer', message: `worker failed to start: ${String(e)}` });
    return null;
  }
  worker.unref();
  const ready = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), READY_TIMEOUT_MS);
    worker.once('message', (m: { ready?: boolean }) => { clearTimeout(timer); resolve(m.ready === true); });
    worker.once('error', () => { clearTimeout(timer); resolve(false); });
    worker.once('exit', () => { clearTimeout(timer); resolve(false); });
  });
  if (!ready) {
    logError({ source: 'main', level: 'warn', type: 'wal-checkpointer', message: 'worker did not open state.db; auto-checkpoint stays on' });
    void worker.terminate();
    return null;
  }

  // The store can be closed or switched under us; then leave it alone.
  let prior: { autocheckpoint: number; sizeLimit: number } | null = null;
  try {
    prior = await withRawSqlite((d) => {
      const p = {
        autocheckpoint: d.pragma('wal_autocheckpoint', { simple: true }) as number,
        sizeLimit: d.pragma('journal_size_limit', { simple: true }) as number,
      };
      d.pragma('wal_autocheckpoint = 0');
      d.pragma(`journal_size_limit = ${JOURNAL_SIZE_LIMIT}`);
      return p;
    });
  } catch {
    prior = null;
  }
  if (!prior) {
    void worker.terminate();
    return null;
  }
  const saved = prior;

  const hungAfter = opts.checkpointTimeoutMs ?? CHECKPOINT_TIMEOUT_MS;
  let pending: Promise<void> | null = null;
  let settle: (() => void) | null = null;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let last: CheckpointResult | null = null;
  let incomplete = 0;
  let closed = false;
  const timer = (opts.requestEveryMs ?? REQUEST_EVERY_MS) > 0
    ? setInterval(() => api.request(), opts.requestEveryMs ?? REQUEST_EVERY_MS)
    : null;
  timer?.unref?.();

  const restore = async (): Promise<void> => {
    try {
      await withRawSqlite((d) => {
        d.pragma(`wal_autocheckpoint = ${saved.autocheckpoint}`);
        d.pragma(`journal_size_limit = ${saved.sizeLimit}`);
      });
    } catch {
      // Closed or switched store: nothing to restore on.
    }
  };
  /** Hand checkpoints back to the main connection and end the worker. */
  const shutdown = async (reason: string | null): Promise<void> => {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    // Release waiters now: terminate() can't interrupt native I/O, so the
    // worker's exit may come much later or never.
    settle?.();
    if (reason) logError({ source: 'main', level: 'warn', type: 'wal-checkpointer', message: reason, extra: { ...last, incomplete } });
    await restore();
    // A checkpoint in flight can't be interrupted; terminate() is not awaited
    // so a hung one can't hold up the caller.
    worker.postMessage('close');
    void worker.terminate();
  };

  worker.on('message', (m: { ok?: boolean; busy?: number; log?: number; checkpointed?: number; error?: string }) => {
    if (m.ok) {
      last = { busy: m.busy ?? 0, log: m.log ?? 0, checkpointed: m.checkpointed ?? 0 };
      incomplete = last.checkpointed < last.log ? incomplete + 1 : 0;
      if (last.log > WAL_MAX_FRAMES) void shutdown(`WAL at ${last.log} frames; auto-checkpoint restored for this run`);
      else if (incomplete >= WAL_MAX_INCOMPLETE) void shutdown(`${incomplete} checkpoints in a row left frames behind; auto-checkpoint restored for this run`);
    } else {
      // A failed checkpoint leaves `last` stale; it counts as incomplete.
      incomplete++;
      logError({ source: 'main', level: 'warn', type: 'wal-checkpointer', message: m.error ?? 'checkpoint failed' });
      if (incomplete >= WAL_MAX_INCOMPLETE) void shutdown(`${incomplete} checkpoints in a row failed or left frames behind; auto-checkpoint restored for this run`);
    }
    settle?.();
  });
  // A worker that dies, with or without an `error` event, hands checkpoints back.
  worker.on('error', (e) => { void shutdown(`worker failed: ${String(e)}`); });
  worker.on('exit', () => {
    settle?.();
    void shutdown(closed ? null : 'worker exited');
  });

  const api: WalCheckpointer = {
    request() {
      if (pending || closed) return;
      pending = new Promise<void>((resolve) => {
        watchdog = setTimeout(() => { void shutdown(`checkpoint hung for ${hungAfter} ms; auto-checkpoint restored for this run`); }, hungAfter);
        watchdog.unref?.();
        settle = () => {
          if (watchdog) clearTimeout(watchdog);
          watchdog = null;
          settle = null;
          pending = null;
          resolve();
        };
        worker.postMessage(0);
      });
    },
    idle: () => pending ?? Promise.resolve(),
    async drain() {
      if (closed || (last?.log ?? 0) <= WAL_REWIND_FRAMES) return;
      // Each wait is bounded by the watchdog, which hands back and settles; the race is a second bound.
      const bounded = (p: Promise<void> | null) => p && Promise.race([p, new Promise<void>((r) => setTimeout(r, hungAfter + 100).unref?.())]);
      await bounded(pending);
      if (closed) return;
      api.request();
      await bounded(pending);
    },
    last: () => last,
    active: () => !closed,
    close: () => shutdown(null),
  };
  return api;
}
