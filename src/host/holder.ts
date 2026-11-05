// What only the lease holder runs: the stores, fenced by the lease epoch.
import { closeDb } from '../main/db.js';
import { openPgStores, type PgStores } from '../main/store/pgStores.js';
import type { PostgresStoreConfig } from '../main/store/storeConfig.js';
import type { Logger } from './log.js';
import { leaseFence } from './pgLease.js';

export interface HolderOptions {
  db: PostgresStoreConfig;
  env: NodeJS.ProcessEnv;
  workspaceId: string;
  holder: string;
  epoch(): number | null;
  onLost(): void;
  log: Logger;
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
  const stores = await openPgStores(o.db, {
    state: true,
    env: o.env,
    afterBeginWrite: fence,
    onPoolError: (e) => o.log.log('warn', 'store pool error', { error: e.message })
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
