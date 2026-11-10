// Off-main-thread WAL checkpoints for state.db (SPEC §7 *Retention* → *WAL
// checkpoints*). SQLite's auto-checkpoint runs inside whichever commit crosses
// the threshold, so on the main connection its page copy and fsync land
// inside that commit. db.ts owns one per open SQLite store (installed from here
// so fleet-host's import graph stays free of worker code); the leftover-WAL
// drain and retention runs take leases on it.
import { Worker } from 'node:worker_threads';
import type Database from 'better-sqlite3';
import {
  setWalCheckpointerFactory, type CheckpointHost, type CheckpointResult, type CheckpointerOptions, type StoreCheckpointer,
  type WalCheckpointLease, type WalDrainResult,
} from '../db.js';
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
/** A WAL past this many frames means checkpoints aren't keeping up (not applied while a drain runs). */
export const WAL_MAX_FRAMES = 10_000;
/** This many checkpoints in a row that leave frames behind (a reader or the lock) or fail also give up. */
export const WAL_MAX_INCOMPLETE = 5;
/** A checkpoint outstanding this long is hung (e.g. stuck I/O): hand back. */
export const CHECKPOINT_TIMEOUT_MS = 5000;
/** A leftover-WAL checkpoint copies the whole previous run's WAL, so it gets longer while a drain runs. */
export const DRAIN_TIMEOUT_MS = 60_000;
/** The main connection's journal_size_limit while the worker checkpoints: about WAL_REWIND_FRAMES pages. */
export const WAL_HOLD_SIZE_LIMIT = 16 * 1024 * 1024;
/** stop() waits this long for the worker thread (and its connection) to end. */
const EXIT_WAIT_MS = 2000;
const REQUEST_EVERY_MS = 1000;


/** A lock held elsewhere reports busy = 1 or -1 counts: such a checkpoint did nothing it can vouch for. */
export const complete = (r: CheckpointResult): boolean =>
  r.busy === 0 && r.log >= 0 && r.checkpointed >= 0 && r.checkpointed >= r.log;




interface Saved { autocheckpoint: number; sizeLimit: number }

function hold(d: Database.Database): Saved {
  const saved = {
    autocheckpoint: d.pragma('wal_autocheckpoint', { simple: true }) as number,
    sizeLimit: d.pragma('journal_size_limit', { simple: true }) as number,
  };
  d.pragma('wal_autocheckpoint = 0');
  d.pragma(`journal_size_limit = ${WAL_HOLD_SIZE_LIMIT}`);
  return saved;
}

/** One worker generation: spawned, holding the main connection's checkpoints until handed back. */
interface Generation {
  worker: Worker;
  exited: Promise<void>;
  ready: Promise<boolean>;
  saved: Saved | null;
  restored: Promise<void> | null;
  pending: Promise<void> | null;
  settle: (() => void) | null;
  watchdog: ReturnType<typeof setTimeout> | null;
  timer: ReturnType<typeof setInterval> | null;
  last: CheckpointResult | null;
  incomplete: number;
  closed: boolean;
  timeoutMs: number;
}

export class WalCheckpointer implements StoreCheckpointer {
  private gen: Generation | null = null;
  private leases = 0;
  private draining = 0;
  private stopped = false;
  /** Exits of every worker not yet gone, an ended generation's included. */
  private readonly live = new Set<Promise<void>>();

  constructor(private readonly host: CheckpointHost) {}

  /** At openDb, before anything writes: hold checkpoints synchronously and
   *  spawn the worker. The returned lease belongs to the leftover drain. */
  holdAtOpen(conn: Database.Database, opts: CheckpointerOptions = {}): WalCheckpointLease {
    const g = this.spawn(opts);
    g.saved = hold(conn);
    this.draining++;
    return this.lease(g, () => { this.draining--; });
  }

  /** A lease on the running worker, starting it when none runs. Null when the
   *  worker can't open the database or the store closes first. */
  async acquire(opts: CheckpointerOptions = {}): Promise<WalCheckpointLease | null> {
    if (this.stopped) return null;
    let g = this.gen;
    if (!g || g.closed) {
      if (this.leases > 0 && g?.closed) return null; // handed back for the current users
      g = this.spawn(opts);
    }
    this.leases++;
    const counted = g;
    const fail = (): null => {
      if (--this.leases === 0) void this.end(counted, null);
      return null;
    };
    if (!(await g.ready) || g.closed) return fail();
    if (!g.saved) {
      await this.host.withMain((d) => { if (!g!.closed && !g!.saved) g!.saved = hold(d); });
      if (!g.saved) return fail();
    }
    this.leases--; // lease() counts it
    return this.lease(g, () => undefined);
  }

  hasWorkers(): boolean {
    return this.live.size > 0;
  }

  /** closeDb: hand back, end the worker and wait (bounded) for its thread to exit,
   *  so main's connection closes last. Later acquires return null. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.gen) await this.end(this.gen, null);
    await Promise.race([Promise.all(this.live), new Promise<void>((r) => setTimeout(r, EXIT_WAIT_MS).unref?.())]);
  }

  private spawn(opts: CheckpointerOptions): Generation {
    const worker = new Worker(opts.workerSource ?? WORKER_SRC, {
      eval: true, workerData: { bs3Path: betterSqlitePath(), dbPath: opts.dbPath ?? this.host.dbPath },
    });
    worker.unref();
    const g: Generation = {
      worker, exited: new Promise<void>((r) => worker.once('exit', () => r())), ready: Promise.resolve(false),
      saved: null, restored: null, pending: null, settle: null, watchdog: null, timer: null,
      last: null, incomplete: 0, closed: false, timeoutMs: opts.checkpointTimeoutMs ?? 0,
    };
    this.gen = g;
    this.live.add(g.exited);
    void g.exited.then(() => this.live.delete(g.exited));
    g.ready = new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), READY_TIMEOUT_MS);
      worker.once('message', (m: { ready?: boolean }) => { clearTimeout(t); resolve(m.ready === true); });
      worker.once('error', () => { clearTimeout(t); resolve(false); });
      worker.once('exit', () => { clearTimeout(t); resolve(false); });
    }).then((ok) => {
      if (!ok && !g.closed) void this.end(g, 'worker did not open state.db; auto-checkpoint stays on');
      return ok;
    });
    const every = opts.requestEveryMs ?? REQUEST_EVERY_MS;
    if (every > 0) {
      g.timer = setInterval(() => this.request(g), every);
      g.timer.unref?.();
    }
    worker.on('message', (m: { ready?: boolean; ok?: boolean; busy?: number; log?: number; checkpointed?: number; error?: string }) => {
      if (m.ready) return;
      if (m.ok) {
        g.last = { busy: m.busy ?? 0, log: m.log ?? 0, checkpointed: m.checkpointed ?? 0 };
        g.incomplete = complete(g.last) ? 0 : g.incomplete + 1;
      } else {
        // A failed checkpoint leaves `last` stale; it counts as incomplete.
        g.incomplete++;
        this.host.warn(m.error ?? 'checkpoint failed');
      }
      // Settled first: the answered checkpoint is no longer in flight when end() looks.
      g.settle?.();
      if (m.ok && this.draining === 0 && g.last!.log > WAL_MAX_FRAMES) void this.end(g, `WAL at ${g.last!.log} frames; auto-checkpoint restored for this run`);
      else if (g.incomplete >= WAL_MAX_INCOMPLETE) void this.end(g, `${g.incomplete} checkpoints in a row failed or left frames behind; auto-checkpoint restored for this run`);
    });
    // A worker that dies, with or without an `error` event, hands checkpoints back.
    worker.on('error', (e) => { void this.end(g, `worker failed: ${String(e)}`); });
    worker.on('exit', () => {
      g.settle?.();
      void this.end(g, g.closed ? null : 'worker exited');
    });
    return g;
  }

  private request(g: Generation): void {
    if (g.pending || g.closed || !g.saved) return;
    const timeoutMs = g.timeoutMs || (this.draining > 0 ? DRAIN_TIMEOUT_MS : CHECKPOINT_TIMEOUT_MS);
    g.pending = new Promise<void>((resolve) => {
      g.watchdog = setTimeout(() => { void this.end(g, `checkpoint hung for ${timeoutMs} ms; auto-checkpoint restored for this run`); }, timeoutMs);
      g.watchdog.unref?.();
      g.settle = () => {
        if (g.watchdog) clearTimeout(g.watchdog);
        g.watchdog = null;
        g.settle = null;
        g.pending = null;
        resolve();
      };
      g.worker.postMessage(0);
    });
  }

  /** Hand checkpoints back to the main connection and end the worker. Resolves once restored. */
  private end(g: Generation, reason: string | null): Promise<void> {
    if (g.closed) return g.restored ?? Promise.resolve();
    g.closed = true;
    if (g.timer) clearInterval(g.timer);
    const hung = g.pending !== null;
    // Release waiters now: terminate() can't interrupt native I/O, so the
    // worker's exit may come much later or never.
    g.settle?.();
    if (reason) this.host.warn(reason, { ...g.last, incomplete: g.incomplete });
    g.worker.postMessage('close');
    if (hung) void g.worker.terminate();
    const saved = g.saved;
    g.restored = saved
      ? this.host.withMain((d) => {
        d.pragma(`wal_autocheckpoint = ${saved.autocheckpoint}`);
        d.pragma(`journal_size_limit = ${saved.sizeLimit}`);
      })
      : Promise.resolve();
    return g.restored;
  }

  private lease(g: Generation, onClose: () => void): WalCheckpointLease {
    this.leases++;
    let closed = false;
    const hungAfter = () => g.timeoutMs || (this.draining > 0 ? DRAIN_TIMEOUT_MS : CHECKPOINT_TIMEOUT_MS);
    const api: WalCheckpointLease = {
      request: () => { if (!closed) this.request(g); },
      idle: () => g.pending ?? Promise.resolve(),
      async drain() {
        if (!api.active() || (g.last?.log ?? 0) <= WAL_REWIND_FRAMES) return;
        // Each wait is bounded by the watchdog, which hands back and settles; the race is a second bound.
        const bounded = (p: Promise<void> | null) => p && Promise.race([p, new Promise<void>((r) => setTimeout(r, hungAfter() + 100).unref?.())]);
        await bounded(g.pending);
        if (!api.active()) return;
        api.request();
        await bounded(g.pending);
      },
      last: () => g.last,
      active: () => !closed && !g.closed,
      close: async () => {
        if (closed) return;
        closed = true;
        onClose();
        if (--this.leases === 0) {
          await this.end(g, null);
          if (this.gen === g) this.gen = null;
        } else {
          await (g.closed ? g.restored : null);
        }
      },
    };
    return api;
  }
}

/** The drain ends after a complete checkpoint that found at most this many frames written since the drain's previous one. */
export const DRAIN_SETTLED_FRAMES = 256;
const DRAIN_MAX_ROUNDS = 20;
const DRAIN_RETRY_MS = 100;


/** Checkpoint a leftover WAL through `lease` until caught up: frames main wrote
 *  meanwhile are copied too. Then the lease is closed. */
export async function drainLeftover(lease: WalCheckpointLease, warn: CheckpointHost['warn']): Promise<WalDrainResult> {
  const startedAt = Date.now();
  const t0 = performance.now();
  let rounds = 0;
  let prevLog = 0;
  let ok = false;
  while (lease.active() && rounds < DRAIN_MAX_ROUNDS) {
    await lease.idle();
    lease.request();
    await lease.idle();
    rounds++;
    const l = lease.last();
    if (!lease.active() || !l) break;
    if (!complete(l)) {
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
  const l = lease.last();
  const error = ok ? undefined : lease.active() ? `not settled after ${rounds} checkpoints` : 'checkpointer handed back';
  await lease.close();
  if (error) warn(`leftover WAL drain: ${error}`, { ...l, rounds });
  return { startedAt, ms: performance.now() - t0, ok, rounds, busy: l?.busy, log: l?.log, checkpointed: l?.checkpointed, error };
}

export type { CheckpointResult, CheckpointerOptions, WalCheckpointLease, WalDrainResult };

/** Let openDb create the store's checkpointer. The desktop calls this at boot. */
export function installWalCheckpointer(): void {
  setWalCheckpointerFactory({ create: (host) => new WalCheckpointer(host), drain: drainLeftover });
}
