// Fenced singleton lease (remote-workspaces §3). Standby until acquired; the
// holder renews every 10 s with a 30 s TTL. Losing it is fatal: the caller
// exits so a stale holder never keeps serving.
import { EventEmitter } from 'node:events';

export const LEASE_RENEW_MS = 10_000;
export const LEASE_TTL_MS = 30_000;

export interface LeaseStore {
  /** Take the lease if free or expired; returns the new epoch, or null if another holder has it. */
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
      if (row.holder !== null && row.expiresAt > now) return null;
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

export interface LeaseOptions {
  holder: string;
  store: LeaseStore;
  now?: () => number;
  renewMs?: number;
  ttlMs?: number;
  onError?: (err: Error) => void;
}

/** Events: 'acquired' (epoch), 'lost' (). */
export class LeaseManager extends EventEmitter {
  private _state: LeaseState = 'standby';
  private _epoch = 0;
  private validUntil = 0;
  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<void> | null = null;
  private stopped = false;
  private readonly now: () => number;
  private readonly renewMs: number;
  private readonly ttlMs: number;

  constructor(private readonly opts: LeaseOptions) {
    super();
    this.now = opts.now ?? Date.now;
    this.renewMs = opts.renewMs ?? LEASE_RENEW_MS;
    this.ttlMs = opts.ttlMs ?? LEASE_TTL_MS;
  }

  get state(): LeaseState {
    return this._state;
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
    try {
      if (this._state === 'standby') {
        const epoch = await store.tryAcquire(holder, t, this.ttlMs);
        if (epoch !== null && !this.stopped) {
          this._state = 'holder';
          this._epoch = epoch;
          this.validUntil = t + this.ttlMs;
          this.emit('acquired', epoch);
        }
        return;
      }
      if (await store.renew(holder, this._epoch, t, this.ttlMs)) {
        this.validUntil = t + this.ttlMs;
        return;
      }
      this.lose();
    } catch (err) {
      this.opts.onError?.(err as Error);
      if (this._state === 'holder' && this.now() >= this.validUntil) this.lose();
    }
  }

  private lose(): void {
    this._state = 'standby';
    this.halt();
    this.emit('lost');
  }

  private halt(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Stop renewing and release the lease if held (SIGTERM path). */
  async stop(): Promise<void> {
    await this.ticking;
    const wasHolder = this._state === 'holder';
    this.halt();
    this._state = 'standby';
    if (wasHolder) await this.opts.store.release(this.opts.holder, this._epoch);
  }
}
