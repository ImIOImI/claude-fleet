// `fleet-host migrate`: exactly the startup migrations (host track, then the stores'), run ahead of a rollout.
import { sql } from 'kysely';
import type { PgTrack } from '../main/store/pgMigrate.js';
import { migratePgStores } from '../main/store/pgStores.js';
import type { PostgresStoreConfig } from '../main/store/storeConfig.js';
import { openHostDb } from './hostDb.js';
import type { Logger } from './log.js';

export async function migrateHostStore(
  cfg: PostgresStoreConfig,
  o: { env?: NodeJS.ProcessEnv; log: Logger; extraTracks?: readonly PgTrack[] }
): Promise<Record<string, number>> {
  const h = await openHostDb(cfg, o);
  try {
    await migratePgStores(h.pool, { state: true, extraTracks: o.extraTracks });
    const r = await sql<{ track: string; version: number }>`SELECT track, version FROM schema_migrations ORDER BY track`.execute(h.k);
    return Object.fromEntries(r.rows.map((x) => [x.track, Number(x.version)]));
  } finally {
    await h.end();
  }
}
