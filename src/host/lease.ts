// Fenced singleton lease (remote-workspaces §3). Standby until acquired; the
// holder renews every 10 s with a 30 s TTL. Losing it is fatal: the caller
// exits so a stale holder never keeps serving.
import { EventEmitter } from 'node:events';

export const LEASE_RENEW_MS = 10_000;
export const LEASE_TTL_MS = 30_000;

/**
 * `now` is the caller's wall clock. A store shared between pods must judge
 * expiry on its own clock (e.g. the DB's `now()`), never the caller's.
 * `holder` must be unique per process: `tryAcquire` by the current holder
 * re-grants with a new epoch, so a caller whose acquire timed out after the
 * store granted it recovers the lease on its next tick.
 */
export interface LeaseStore {
  /** Take the lease if free, expired or already ours; returns the new epoch, or null if another holder has it. */
  tryAcquire(holder: string, now: number, ttlMs: number): Promise<number | null>;
  /** Extend the lease; false when `holder`/`epoch` no longer own it. */
  renew(holder: string, epoch: number, now: number, ttlMs: number): Promise<boolean>;
  /** Clear the holder if `holder`/`epoch` still own it. */
  release(holder: string, epoch: number): Promise<void>;
}

/** Process-local lease: correct only for a single replica. */
export function memoryLeaseStore(): LeaseStore {
  let row = { holder: null as string | null, epoch: 0, expiresAt: 0 };
  return {
    async tryAcquire(holder, now, ttlMs) {
      if (row.holder !== null && row.holder !== holder && row.expiresAt > now) return null;
      row = { holder, epoch: row.epoch + 1, expiresAt: now + ttlMs };
      return row.epoch;
    },
    async renew(holder, epoch, now, ttlMs) {
      if (row.holder !== holder || row.epoch !== epoch) return false;
      row = { ...row, expiresAt: now + ttlMs };
      return true;
    },
    async release(holder, epoch) {
      if (row.holder === holder && row.epoch === epoch) row = { ...row, holder: null, expiresAt: 0 };
    }
  };
}

export type LeaseState = 'standby' | 'holder';
/** superseded: the row names another holder or epoch. unreachable: the store didn't confirm in time. */
export type LostReason = 'superseded' | 'unreachable';

export interface LeaseOptions {
  holder: string;
  store: LeaseStore;
  now?: () => number;
  /** Local deadline clock; must not jump with wall time. */
  monotonic?: () => number;
  renewMs?: number;
  ttlMs?: number;
  /** Bound on how long stop() waits for an in-flight step and for release. */
  stopWaitMs?: number;
  onError?: (err: Error) => void;
}

class StoreTimeout extends Error {
  constructor() {
    super('lease store call timed out');
  }
}

function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StoreTimeout()), Math.max(0, ms));
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** Events: 'acquired' (epoch), 'lost' (LostReason). */
export class LeaseManager extends EventEmitter {
  private _state: LeaseState = 'standby';
  private _epoch = 0;
  /** Monotonic time at which the holder gives up: one renew interval short of the TTL. */
  private deadline = 0;
  private deadlineTimer: NodeJS.Timeout | null = null;
  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<void> | null = null;
  private stopped = false;
  private readonly now: () => number;
  private readonly mono: () => number;
  private readonly renewMs: number;
  private readonly ttlMs: number;
  private readonly stopWaitMs: number;

  constructor(private readonly opts: LeaseOptions) {
    super();
    this.now = opts.now ?? Date.now;
    this.mono = opts.monotonic ?? (() => performance.now());
    this.renewMs = opts.renewMs ?? LEASE_RENEW_MS;
    this.ttlMs = opts.ttlMs ?? LEASE_TTL_MS;
    this.stopWaitMs = opts.stopWaitMs ?? 2_000;
    if (!(this.renewMs < this.ttlMs)) throw new RangeError('lease renewMs must be less than ttlMs');
  }

  get state(): LeaseState {
    return this._state === 'holder' && this.mono() >= this.deadline ? 'standby' : this._state;
  }

  get epoch(): number {
    return this._epoch;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => void this.tick(), this.renewMs);
    void this.tick();
  }

  /** One acquire-or-renew step. Concurrent calls share one in-flight step. */
  tick(): Promise<void> {
    this.ticking ??= this.step().finally(() => (this.ticking = null));
    return this.ticking;
  }

  private async step(): Promise<void> {
    if (this.stopped) return;
    const { store, holder } = this.opts;
    const t = this.now();
    const m = this.mono();
    try {
      if (this._state === 'standby') {
        const epoch = await within(store.tryAcquire(holder, t, this.ttlMs), this.ttlMs - this.renewMs);
        if (epoch === null) return;
        if (this.stopped) {
          await within(store.release(holder, epoch), this.stopWaitMs).catch(() => undefined);
          return;
        }
        this._state = 'holder';
        this._epoch = epoch;
        this.extend(m);
        this.emit('acquired', epoch);
        return;
      }
      if (m >= this.deadline) return this.lose('unreachable');
      if (await within(store.renew(holder, this._epoch, t, this.ttlMs), this.deadline - m)) {
        if (this._state === 'holder' && !this.stopped) this.extend(m);
        return;
      }
      this.lose('superseded');
    } catch (err) {
      this.opts.onError?.(err as Error);
      // A timeout was sized to the remaining validity; timers may fire just short of it.
      if (this._state === 'holder' && (err instanceof StoreTimeout || this.mono() >= this.deadline)) this.lose('unreachable');
    }
  }

  private extend(from: number): void {
    this.deadline = from + this.ttlMs - this.renewMs;
    this.armDeadline();
  }

  private armDeadline(): void {
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = setTimeout(() => {
      this.deadlineTimer = null;
      if (this._state !== 'holder' || this.stopped) return;
      if (this.mono() >= this.deadline) this.lose('unreachable');
      else this.armDeadline();
    }, Math.max(0, this.deadline - this.mono()));
    this.deadlineTimer.unref();
  }

  /** A fenced write found the lease row moved on: give up now, as a failed renew would. */
  markLost(reason: LostReason = 'superseded'): void {
    this.lose(reason);
  }

  private lose(reason: LostReason): void {
    if (this._state !== 'holder') return;
    this._state = 'standby';
    this.halt();
    this.emit('lost', reason);
  }

  private halt(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = null;
  }

  /** Stop renewing and release the lease if held (SIGTERM path). */
  async stop(): Promise<void> {
    this.halt();
    if (this.ticking) await within(this.ticking, this.stopWaitMs).catch(() => undefined);
    const wasHolder = this._state === 'holder';
    this._state = 'standby';
    if (wasHolder) await within(this.opts.store.release(this.opts.holder, this._epoch), this.stopWaitMs).catch(() => undefined);
  }
}
