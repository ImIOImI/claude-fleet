// Opens state.db's and the inbox's Postgres stores on one shared pool.
import type pg from 'pg';
import { closeDb, openDbPostgres } from '../db.js';
import { InboxStore } from '../inbox/inboxDb.js';
import { INBOX_PG_TRACK } from './migrations/inboxPg.js';
import { STATE_PG_TRACK } from './migrations/statePg.js';
import { ensureVector, migratePostgres, type PgTrack } from './pgMigrate.js';
import { createPgPool, postgresKysely, schemaOf, type PgPoolConfig, type WriteHook } from './postgres.js';
import { iamAuthHint, pgPoolConfig, type PostgresStoreConfig } from './storeConfig.js';

export interface PgStores {
  pool: pg.Pool;
  /** The options `pool` was built from (the MCP caller roles connect the same way). */
  poolConfig: PgPoolConfig;
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
  pool?: Pick<PgPoolConfig, 'session' | 'keepAlive' | 'keepAliveInitialDelayMillis'>;
  /** Replaces the openers' own migrations; runs on the new pool before the stores open. */
  migrate?: (pool: pg.Pool) => Promise<void>;
}

/** The stores' migrations on an unfenced handle (fleet-host runs them before opening the fenced stores). */
export async function migratePgStores(pool: pg.Pool, o: { state: boolean; extraTracks?: readonly PgTrack[] }): Promise<void> {
  const k = postgresKysely(pool);
  const schema = schemaOf(pool);
  try {
    await migratePostgres(k, schema, INBOX_PG_TRACK);
    if (o.state) {
      await ensureVector(k);
      await migratePostgres(k, schema, STATE_PG_TRACK);
    }
    for (const t of o.extraTracks ?? []) await migratePostgres(k, schema, t);
  } finally {
    await k.destroy();
  }
}

export async function openPgStores(cfg: PostgresStoreConfig, o: OpenPgStoresOptions): Promise<PgStores> {
  const poolConfig: PgPoolConfig = { ...pgPoolConfig(cfg, o.env), ...o.pool };
  const pool = createPgPool(poolConfig);
  pool.on('error', o.onPoolError);
  const hook = { afterBeginWrite: o.afterBeginWrite, migrate: o.migrate ? false : undefined };
  try {
    await o.migrate?.(pool);
    const inbox = await InboxStore.openPostgres(pool, hook);
    try {
      if (o.state) await openDbPostgres(pool, hook);
    } catch (e) {
      await inbox.close();
      throw e;
    }
    return { pool, poolConfig, inbox, end: () => pool.end() };
  } catch (e) {
    await closeDb();
    await pool.end();
    const hint = iamAuthHint(cfg, e);
    if (hint) (e as Error).message += ` (${hint})`;
    throw e;
  }
}
