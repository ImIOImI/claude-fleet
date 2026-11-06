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
  /** Expand/contract: the previous release may still be running (fleet-host migrate is a PreSync Job); no drops or renames it uses, no long table rewrites. */
  steps: readonly PgMigrationStep[];
}

// Arbitrary constant: serializes concurrent migrators (two host pods, two tracks).
const MIGRATE_LOCK = 7_340_211;

export interface MigrateLockOptions { lockTimeoutMs?: number; attempts?: number; backoffMs?: number }

const LOCK_NOT_AVAILABLE = '55P03';

/** Migrate `t` inside `schema`, which must exist (the store never creates it).
 *  The lock wait is bounded and retried: any session may take MIGRATE_LOCK
 *  (pg_advisory_lock is PUBLIC and only a superuser can revoke it). */
export async function migratePostgres<DB>(k: Kysely<DB>, schema: string, t: PgTrack, o: MigrateLockOptions = {}): Promise<void> {
  const cur = await sql<{ s: string | null }>`SELECT current_schema() AS s`.execute(k);
  if (cur.rows[0]?.s !== schema) {
    throw new Error(`the store schema "${schema}" does not exist: create it (and grant this role CREATE on it) before first start`);
  }
  const attempts = o.attempts ?? 12;
  for (let i = 1; ; i++) {
    try {
      await migrateOnce(k, t, o.lockTimeoutMs ?? 5_000);
      return;
    } catch (e) {
      if ((e as { code?: string }).code !== LOCK_NOT_AVAILABLE || i >= attempts) throw e;
      await new Promise((r) => setTimeout(r, Math.min(5_000, (o.backoffMs ?? 250) * 2 ** (i - 1))));
    }
  }
}

async function migrateOnce<DB>(k: Kysely<DB>, t: PgTrack, lockTimeoutMs: number): Promise<void> {
  await k.transaction().execute(async (trx) => {
    // A session statement_timeout (fleet-host) must not cut a migration short.
    await sql`SET LOCAL statement_timeout = 0`.execute(trx);
    await sql.raw(`SET LOCAL lock_timeout = ${Math.floor(lockTimeoutMs)}`).execute(trx);
    await sql`SELECT pg_advisory_xact_lock(${MIGRATE_LOCK})`.execute(trx);
    await sql`SET LOCAL lock_timeout = 0`.execute(trx);
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

/** pgvector ≥ 0.8.0 must be installed in the database. Creates it in `public`
 *  (on every store schema's search_path) when this role may; otherwise names
 *  the admin step. */
export async function ensureVector<DB>(k: Kysely<DB>): Promise<void> {
  const installed = async () =>
    (await sql<{ v: string }>`SELECT extversion AS v FROM pg_extension WHERE extname = 'vector'`.execute(k)).rows[0]?.v;
  let v = await installed();
  if (!v) {
    try {
      await sql`CREATE EXTENSION IF NOT EXISTS vector SCHEMA public`.execute(k);
    } catch (e) {
      throw new Error(`pgvector is not installed and this role cannot create it; an admin must run CREATE EXTENSION vector (${String(e)})`);
    }
    v = await installed();
  }
  const [maj, min] = String(v).split('.').map(Number);
  if (maj === 0 && min < 8) throw new Error(`pgvector ${v} is too old: the store needs 0.8.0 or later`);
}
