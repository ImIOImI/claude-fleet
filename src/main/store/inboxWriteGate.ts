// Refuses a store's writes while the switch back to SQLite copies it (part 4b
// D53): a write the copy can't carry over must fail loudly, not land in the
// store being left behind. One gate guards the inbox, another history.
import { sql, type Kysely } from 'kysely';
import type { WriteHook } from './postgres.js';

export class InboxWriteRefused extends Error {}

export class InboxWriteGate {
  private refusal: string | null = null;

  /** The store's afterBeginWrite: runs first in every write, under its write lock. */
  readonly hook: WriteHook = async () => {
    if (this.refusal !== null) throw new InboxWriteRefused(this.refusal);
  };

  get closed(): boolean {
    return this.refusal !== null;
  }

  close(reason: string): void {
    this.refusal = reason;
  }

  open(): void {
    this.refusal = null;
  }

  /** Resolves once every write that passed the gate before close() has
   *  finished. A raw statement counts as a write, so it queues behind them on
   *  the store's write lock; the gate then refuses it. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async drain(k: Kysely<any>): Promise<void> {
    if (this.refusal === null) throw new Error('drain() needs a closed gate');
    await sql`SELECT 1`.execute(k).catch(() => undefined);
  }
}
