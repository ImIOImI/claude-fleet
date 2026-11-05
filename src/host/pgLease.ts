// host_lease on the host DB, and the fence every store write passes through.
// Expiry is judged on the DB's clock_timestamp(), never the pod's clock.
import { sql, type Kysely, type Transaction } from 'kysely';
import type { WriteHook } from '../main/store/postgres.js';
import type { HostDb } from './hostSchema.js';
import type { LeaseStore } from './lease.js';

const ms = (n: number) => sql`${n} * interval '1 millisecond'`;

/**
 * `k` must be unfenced. clock_timestamp(), not now(): a statement that waited on the row lock judges expiry at grant time.
 * `lockTimeoutMs` must be under the LeaseManager's store-call timeouts, so a held row lock fails the call instead of hanging it.
 */
export function postgresLeaseStore(k: Kysely<HostDb>, workspaceId: string, o: { lockTimeoutMs?: number } = {}): LeaseStore {
  const lockMs = String(o.lockTimeoutMs ?? 10_000);
  const inTx = <R>(f: (trx: Transaction<HostDb>) => Promise<R>): Promise<R> =>
    k.transaction().execute(async (trx) => {
      await sql`SELECT set_config('lock_timeout', ${lockMs}, true)`.execute(trx);
      return f(trx);
    });
  return {
    tryAcquire: (holder, _now, ttlMs) => inTx(async (trx) => {
      const r = await sql<{ epoch: number }>`
        INSERT INTO host_lease AS l (workspace_id, holder, epoch, expires_at)
          VALUES (${workspaceId}, ${holder}, 1, clock_timestamp() + ${ms(ttlMs)})
        ON CONFLICT (workspace_id) DO UPDATE
          SET holder = EXCLUDED.holder, epoch = l.epoch + 1, expires_at = clock_timestamp() + ${ms(ttlMs)}
          WHERE l.holder IS NULL OR l.holder = EXCLUDED.holder OR l.expires_at <= clock_timestamp()
        RETURNING epoch`.execute(trx);
      return r.rows[0]?.epoch ?? null;
    }),
    renew: (holder, epoch, _now, ttlMs) => inTx(async (trx) => {
      const r = await sql`
        UPDATE host_lease SET expires_at = clock_timestamp() + ${ms(ttlMs)}
         WHERE workspace_id = ${workspaceId} AND holder = ${holder} AND epoch = ${epoch}`.execute(trx);
      return r.numAffectedRows === 1n;
    }),
    release: (holder, epoch) => inTx(async (trx) => {
      await sql`
        UPDATE host_lease SET holder = NULL, expires_at = clock_timestamp()
         WHERE workspace_id = ${workspaceId} AND holder = ${holder} AND epoch = ${epoch}`.execute(trx);
    })
  };
}

export class LeaseLostError extends Error {
  constructor(detail: string) {
    super(`lease lost: ${detail}`);
    this.name = 'LeaseLostError';
  }
}

export interface FenceTarget {
  workspaceId: string;
  holder: string;
  /** The epoch this process holds, or null when it holds none. */
  epoch(): number | null;
  onLost(err: LeaseLostError): void;
}

/** part 3's afterBeginWrite. FOR SHARE makes a takeover wait for in-flight fenced writes, and every write after it see the new epoch. */
export function leaseFence(t: FenceTarget): WriteHook {
  let reported = false;
  // onLost once: later refusals (closeDb's `select 1` on the way out) only throw.
  const lost = (detail: string): never => {
    const err = new LeaseLostError(detail);
    if (!reported) {
      reported = true;
      t.onLost(err);
    }
    throw err;
  };
  return async (exec) => {
    const mine = t.epoch();
    if (mine === null) return lost('not the holder');
    const rows = (await exec(
      'SELECT holder, epoch, expires_at > clock_timestamp() AS live FROM host_lease WHERE workspace_id = $1 FOR SHARE',
      [t.workspaceId]
    )) as { holder: string | null; epoch: number; live: boolean }[];
    const row = rows[0];
    if (!row) return lost('no lease row');
    if (row.holder !== t.holder || Number(row.epoch) !== mine || !row.live) {
      lost(`epoch ${row.epoch}, held by ${row.holder === t.holder ? 'this process' : 'another'}${row.live ? '' : ', expired'}`);
    }
  };
}
