// What only the lease holder runs: the stores, fenced by the lease epoch.
import { closeDb } from '../main/db.js';
import type { PgTrack } from '../main/store/pgMigrate.js';
import { migratePgStores, openPgStores, type PgStores } from '../main/store/pgStores.js';
import type { PostgresStoreConfig } from '../main/store/storeConfig.js';
import { HOST_PG_POOL } from './hostDb.js';
import type { Logger } from './log.js';
import { leaseFence, LeaseLostError } from './pgLease.js';

export interface HolderOptions {
  db: PostgresStoreConfig;
  env: NodeJS.ProcessEnv;
  workspaceId: string;
  holder: string;
  epoch(): number | null;
  onLost(): void;
  log: Logger;
  /** Tests: more store migrations, run like the real ones. */
  extraTracks?: readonly PgTrack[];
}

export interface Holder {
  stores: PgStores;
  stop(): Promise<void>;
}

export async function startHolder(o: HolderOptions): Promise<Holder> {
  const fence = leaseFence({
    workspaceId: o.workspaceId,
    holder: o.holder,
    epoch: o.epoch,
    onLost: (err) => {
      o.log.log('error', 'write fenced off; giving up the lease', { error: err.message });
      o.onLost();
    }
  });
  const held = (when: string): void => {
    if (o.epoch() === null) throw new LeaseLostError(`not the holder ${when} store migrations`);
  };
  const stores = await openPgStores(o.db, {
    state: true,
    env: o.env,
    afterBeginWrite: fence,
    onPoolError: (e) => o.log.log('warn', 'store pool error', { error: e.message }),
    pool: HOST_PG_POOL,
    // Unfenced: a fenced migration would hold FOR SHARE on host_lease and block renew past TTL − renew.
    // The advisory lock still serializes migrators.
    migrate: async (pool) => {
      held('before');
      await migratePgStores(pool, { state: true, extraTracks: o.extraTracks });
      held('after');
    }
  });
  let stopping: Promise<void> | null = null;
  return {
    stores,
    stop() {
      stopping ??= (async () => {
        await stores.inbox.close();
        await closeDb();
        await stores.end();
      })();
      return stopping;
    }
  };
}
