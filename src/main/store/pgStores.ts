// Opens state.db's and the inbox's Postgres stores on one shared pool.
import type pg from 'pg';
import { closeDb, openDbPostgres } from '../db.js';
import { InboxStore } from '../inbox/inboxDb.js';
import { createPgPool, type WriteHook } from './postgres.js';
import { iamAuthHint, pgPoolConfig, type PostgresStoreConfig } from './storeConfig.js';

export interface PgStores {
  pool: pg.Pool;
  inbox: InboxStore;
  /** Ends the pool; close the inbox and state.db (closeDb) first. */
  end(): Promise<void>;
}

export interface OpenPgStoresOptions {
  /** Open state.db too (false in mock mode, as for SQLite). */
  state: boolean;
  env?: NodeJS.ProcessEnv;
  afterBeginWrite?: WriteHook;
  /** An idle pooled client's error; without a listener pg would crash the process. */
  onPoolError: (e: Error) => void;
}

export async function openPgStores(cfg: PostgresStoreConfig, o: OpenPgStoresOptions): Promise<PgStores> {
  const pool = createPgPool(pgPoolConfig(cfg, o.env));
  pool.on('error', o.onPoolError);
  const hook = { afterBeginWrite: o.afterBeginWrite };
  try {
    const inbox = await InboxStore.openPostgres(pool, hook);
    try {
      if (o.state) await openDbPostgres(pool, hook);
    } catch (e) {
      await inbox.close();
      throw e;
    }
    return { pool, inbox, end: () => pool.end() };
  } catch (e) {
    await closeDb();
    await pool.end();
    const hint = iamAuthHint(cfg, e);
    if (hint) (e as Error).message += ` (${hint})`;
    throw e;
  }
}
