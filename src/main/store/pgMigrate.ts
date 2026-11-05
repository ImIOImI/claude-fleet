// Postgres migrations: one `schema_migrations` row per track. A fresh schema
// gets the track's baseline (≡ the final SQLite schema), then each later step.
// SQLite keeps its own user_version chain.
import { sql, type Kysely } from 'kysely';

export interface PgMigrationStep { version: number; postgres: string }

export interface PgTrack {
  /** `schema_migrations.track`: 'state' | 'inbox' (fleet-host adds its own). */
  track: string;
  baselineVersion: number;
  baseline: string;
  steps: readonly PgMigrationStep[];
}

// Arbitrary constant: serializes concurrent migrators (two host pods, two tracks).
const MIGRATE_LOCK = 7_340_211;

/** Migrate `t` inside `schema`, which must exist (the store never creates it). */
export async function migratePostgres<DB>(k: Kysely<DB>, schema: string, t: PgTrack): Promise<void> {
  const cur = await sql<{ s: string | null }>`SELECT current_schema() AS s`.execute(k);
  if (cur.rows[0]?.s !== schema) {
    throw new Error(`the store schema "${schema}" does not exist: create it (and grant this role CREATE on it) before first start`);
  }
  await k.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(${MIGRATE_LOCK})`.execute(trx);
    await sql`CREATE TABLE IF NOT EXISTS schema_migrations (track TEXT PRIMARY KEY, version BIGINT NOT NULL)`.execute(trx);
    const row = await sql<{ version: number }>`SELECT version FROM schema_migrations WHERE track = ${t.track}`.execute(trx);
    let v = row.rows[0]?.version ?? 0;
    if (v === 0) {
      await sql.raw(t.baseline).execute(trx);
      v = t.baselineVersion;
      await sql`INSERT INTO schema_migrations (track, version) VALUES (${t.track}, ${v})`.execute(trx);
    }
    for (const s of t.steps) {
      if (s.version <= v) continue;
      await sql.raw(s.postgres).execute(trx);
      v = s.version;
      await sql`UPDATE schema_migrations SET version = ${v} WHERE track = ${t.track}`.execute(trx);
    }
  });
}

/** pgvector ≥ 0.8.0 (iterative index scans) must be installed in the database.
 *  Creates it when this role may; otherwise names the admin step. */
export async function ensureVector<DB>(k: Kysely<DB>): Promise<void> {
  const installed = async () =>
    (await sql<{ v: string }>`SELECT extversion AS v FROM pg_extension WHERE extname = 'vector'`.execute(k)).rows[0]?.v;
  let v = await installed();
  if (!v) {
    try {
      await sql`CREATE EXTENSION IF NOT EXISTS vector`.execute(k);
    } catch (e) {
      throw new Error(`pgvector is not installed and this role cannot create it; an admin must run CREATE EXTENSION vector (${String(e)})`);
    }
    v = await installed();
  }
  const [maj, min] = String(v).split('.').map(Number);
  if (maj === 0 && min < 8) throw new Error(`pgvector ${v} is too old: the store needs 0.8.0 or later`);
}
