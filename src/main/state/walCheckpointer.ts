// Off-main-thread WAL checkpoints for state.db while retention runs, and for a
// WAL left by the previous run (SPEC §7 *Retention*). SQLite's auto-checkpoint
// runs inside whichever commit crosses the threshold, so on the main
// connection it lands, with its page copy and fsync, inside that commit.
import { Worker } from 'node:worker_threads';
import { holdWalCheckpoints, takeLeftoverWal, trackStateWorker } from '../db.js';
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
/** closeDb waits this long for a stopped worker's connection to close. */
const EXIT_WAIT_MS = 2000;
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
  /** Release its hold on the main connection and end the worker. Never waits on a checkpoint. */
  close(): Promise<void>;
}

export interface WalCheckpointerOptions {
  workerSource?: string;
  /** How often to request a checkpoint between slices (0 = only on request()). */
  requestEveryMs?: number;
  /** Default CHECKPOINT_TIMEOUT_MS. */
  checkpointTimeoutMs?: number;
  /** Default WAL_MAX_FRAMES. */
  maxFrames?: number;
  /** A hold on the main connection's checkpoints already taken; released like its own. */
  hold?: () => Promise<void>;
}

/** Hold the main connection's checkpoints (holdWalCheckpoints) and checkpoint
 *  from a worker instead. Null (main connection untouched, `opts.hold` not
 *  released) when the worker or the hold fails. */
export async function startWalCheckpointer(dbPath: string, opts: WalCheckpointerOptions = {}): Promise<WalCheckpointer | null> {
  let worker: Worker;
  try {
    worker = new Worker(opts.workerSource ?? WORKER_SRC, { eval: true, workerData: { bs3Path: betterSqlitePath(), dbPath } });
  } catch (e) {
    logError({ source: 'main', level: 'warn', type: 'wal-checkpointer', message: `worker failed to start: ${String(e)}` });
    return null;
  }
  worker.unref();
  const exited = new Promise<void>((resolve) => worker.once('exit', () => resolve()));
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
  const release = opts.hold ?? await holdWalCheckpoints().catch(() => null);
  if (!release) {
    void worker.terminate();
    return null;
  }

  const hungAfter = opts.checkpointTimeoutMs ?? CHECKPOINT_TIMEOUT_MS;
  const maxFrames = opts.maxFrames ?? WAL_MAX_FRAMES;
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

  /** Hand checkpoints back to the main connection and end the worker. */
  let released: Promise<void> = Promise.resolve();
  /** Resolves once the hold is released, also when called again. */
  const shutdown = (reason: string | null): Promise<void> => {
    if (closed) return released;
    closed = true;
    if (timer) clearInterval(timer);
    const hung = pending !== null;
    // Release waiters now: terminate() can't interrupt native I/O, so the
    // worker's exit may come much later or never.
    settle?.();
    if (reason) logError({ source: 'main', level: 'warn', type: 'wal-checkpointer', message: reason, extra: { ...last, incomplete } });
    worker.postMessage('close');
    if (hung) void worker.terminate();
    released = release();
    return released;
  };

  const untrack = trackStateWorker(async () => {
    await shutdown(null);
    await Promise.race([exited, new Promise<void>((r) => setTimeout(r, EXIT_WAIT_MS).unref?.())]);
  });
  if (!untrack) {
    closed = true;
    if (timer) clearInterval(timer);
    worker.postMessage('close');
    if (!opts.hold) await release();
    return null;
  }
  void exited.then(untrack);

  worker.on('message', (m: { ok?: boolean; busy?: number; log?: number; checkpointed?: number; error?: string }) => {
    if (m.ok) {
      last = { busy: m.busy ?? 0, log: m.log ?? 0, checkpointed: m.checkpointed ?? 0 };
      incomplete = last.checkpointed < last.log ? incomplete + 1 : 0;
      if (last.log > maxFrames) void shutdown(`WAL at ${last.log} frames; auto-checkpoint restored for this run`);
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

/** A leftover-WAL checkpoint copies the whole previous run's WAL: it gets longer than a retention one. */
export const DRAIN_TIMEOUT_MS = 60_000;
/** The drain ends after a complete checkpoint that found at most this many frames written since the one before. */
export const DRAIN_SETTLED_FRAMES = 256;
const DRAIN_MAX_ROUNDS = 20;
const DRAIN_RETRY_MS = 100;

export interface WalDrainResult {
  startedAt: number;
  ms: number;
  ok: boolean;
  rounds: number;
  busy?: number;
  log?: number;
  checkpointed?: number;
  error?: string;
}

/** When openDb held checkpoints for a leftover WAL (takeLeftoverWal), drain it
 *  from a checkpointer worker: complete checkpoints until one finds almost
 *  nothing new, so frames main wrote meanwhile are copied too. Then the hold
 *  is released, also on failure, timeout or closeDb. Null when there was
 *  nothing to drain. */
export async function drainLeftoverWal(dbPath: string, opts: { workerSource?: string; timeoutMs?: number } = {}): Promise<WalDrainResult | null> {
  const release = takeLeftoverWal();
  if (!release) return null;
  const startedAt = Date.now();
  const t0 = performance.now();
  const done = (r: Omit<WalDrainResult, 'startedAt' | 'ms'>): WalDrainResult => ({ startedAt, ms: performance.now() - t0, ...r });
  const c = await startWalCheckpointer(dbPath, {
    workerSource: opts.workerSource, requestEveryMs: 0, checkpointTimeoutMs: opts.timeoutMs ?? DRAIN_TIMEOUT_MS, maxFrames: Infinity, hold: release,
  });
  if (!c) {
    await release();
    return done({ ok: false, rounds: 0, error: 'checkpoint worker did not start' });
  }
  let rounds = 0;
  let prevLog = 0;
  let ok = false;
  while (c.active() && rounds < DRAIN_MAX_ROUNDS) {
    c.request();
    await c.idle();
    rounds++;
    const l = c.last();
    if (!c.active() || !l) break;
    if (l.checkpointed < l.log) {
      await new Promise((r) => setTimeout(r, DRAIN_RETRY_MS));
      continue;
    }
    // A rewind restarts the frame count, so a smaller log is all new frames.
    const fresh = l.log >= prevLog ? l.log - prevLog : l.log;
    prevLog = l.log;
    if (rounds > 1 && fresh <= DRAIN_SETTLED_FRAMES) {
      ok = true;
      break;
    }
  }
  const l = c.last();
  const error = ok ? undefined : c.active() ? `not settled after ${rounds} checkpoints` : 'checkpointer handed back';
  await c.close();
  if (error) logError({ source: 'main', level: 'warn', type: 'wal-checkpointer', message: `leftover WAL drain: ${error}`, extra: { ...l, rounds } });
  return done({ ok, rounds, busy: l?.busy, log: l?.log, checkpointed: l?.checkpointed, error });
}
