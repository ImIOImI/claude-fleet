// Brings a Postgres store up and keeps watching it (part 4b D50): the app
// boots without waiting, store-backed services start once it is ready, and a
// later outage shows as `down` until a ping succeeds again.
import { EventEmitter } from 'node:events';
import type { ImportProgress, StoreChoice, StoreStatus } from '../../preload/storeTypes.js';

export interface SupervisorDeps<S> {
  choice: Exclude<StoreChoice, 'sqlite'>;
  /** Start (managed) and open the store; a throw is retried with backoff. `progress` becomes the status detail. */
  open(progress: (message: string) => void): Promise<S>;
  /** The first-switch copy; returns a notice for Settings, or null. A throw closes the stores and retries. */
  prepare(stores: S, onProgress: (p: ImportProgress) => void): Promise<string | null>;
  /** Start the store-backed services. Must be idempotent: a throw (its message
   *  is the status detail) is retried after each good ping until it succeeds. */
  ready(stores: S): Promise<void>;
  /** Throws when the store is unreachable. */
  ping(stores: S): Promise<void>;
  /** Managed: start the container again if Docker stopped it. A throw's message becomes the status detail. */
  repair?(): Promise<void>;
  /** After an outage: catch up (ingest re-reads, renderers refetch). */
  recovered(stores: S): void;
  close(stores: S): Promise<void>;
  log(type: string, message: string): void;
  sleep?(ms: number): Promise<void>;
  pingIntervalMs?: number;
  maxBackoffMs?: number;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class StoreSupervisor<S> extends EventEmitter {
  private st: StoreStatus;
  private stopped = false;
  private stores: S | null = null;
  private servicesFailed: string | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly readyP: Promise<S>;
  private resolveReady!: (s: S) => void;

  constructor(private readonly d: SupervisorDeps<S>) {
    super();
    this.st = { choice: d.choice, phase: 'starting', detail: null, progress: null, notice: null };
    this.readyP = new Promise((r) => { this.resolveReady = r; });
  }

  status(): StoreStatus {
    return this.st;
  }

  /** Resolves once, when the store first becomes ready. */
  whenReady(): Promise<S> {
    return this.readyP;
  }

  /** Runs `fn` between steps: no bring-up attempt, ping or repair is in flight
   *  while it runs. It gets the ready stores, or null before the first ready. */
  exclusive<T>(fn: (stores: S | null) => Promise<T>): Promise<T> {
    const run = this.tail.then(() => fn(this.stores));
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** Runs until stop(); never rejects. */
  async run(): Promise<void> {
    const sleep = this.d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let backoff = 1000;
    while (!this.stopped && !this.stores) {
      const failed = await this.exclusive(() => this.bringUp());
      if (!failed) continue;
      await sleep(backoff);
      backoff = Math.min(backoff * 2, this.d.maxBackoffMs ?? 30_000);
    }
    let down = false;
    while (!this.stopped && this.stores) {
      await sleep(this.d.pingIntervalMs ?? 5000);
      down = await this.exclusive(() => this.watch(down));
    }
  }

  stop(): void {
    this.stopped = true;
  }

  /** Runs `ready` again after some of its services were torn down; a failure
   *  is shown and retried like the first start's. */
  async restartServices(): Promise<void> {
    if (this.stores) this.set({ detail: await this.startServices(this.stores) });
  }

  /** One attempt; true when it failed and the caller should back off. */
  private async bringUp(): Promise<boolean> {
    if (this.stopped) return false;
    let opened: S | null = null;
    try {
      opened = await this.d.open((m) => this.set({ phase: 'starting', detail: m }));
      const notice = await this.d.prepare(opened, (p) => this.set({ phase: 'importing', progress: p, detail: null }));
      if (this.stopped) {
        await this.d.close(opened).catch(() => undefined);
        return false;
      }
      this.stores = opened;
      const failed = await this.startServices(opened);
      this.set({ phase: 'ready', detail: failed, progress: null, notice });
      this.resolveReady(opened);
      return false;
    } catch (e) {
      if (opened) await this.d.close(opened).catch(() => undefined);
      this.d.log('store-open-failed', message(e));
      this.set({ phase: 'down', detail: message(e), progress: null });
      return true;
    }
  }

  /** One ping (and repair); returns whether the store is down. */
  private async watch(down: boolean): Promise<boolean> {
    if (this.stopped || !this.stores) return down;
    try {
      await this.d.ping(this.stores);
      if (down) {
        this.set({ phase: 'ready', detail: this.servicesFailed });
        this.d.recovered(this.stores);
      }
      if (this.servicesFailed !== null) this.set({ detail: await this.startServices(this.stores) });
      return false;
    } catch (e) {
      if (!down) this.d.log('store-unreachable', message(e));
      this.set({ phase: 'down', detail: message(e) });
      await this.d.repair?.().catch((r: unknown) => this.set({ detail: message(r) }));
      return true;
    }
  }

  /** The services' failure, or null once they all started. */
  private async startServices(stores: S): Promise<string | null> {
    try {
      await this.d.ready(stores);
      this.servicesFailed = null;
    } catch (e) {
      if (message(e) !== this.servicesFailed) this.d.log('store-ready-failed', message(e));
      this.servicesFailed = message(e);
    }
    return this.servicesFailed;
  }

  private set(p: Partial<StoreStatus>): void {
    this.st = { ...this.st, ...p };
    this.emit('status', this.st);
  }
}
