// vitest globalSetup for the Postgres store suite: one-time database prep, so
// parallel test files never race CREATE EXTENSION.
import pg from 'pg';

const STALE_SEC = 3600;

/** testPgSchema() names are t_<epochSec>_<hex>; only an hour-old one is
 *  abandoned. Younger ones may belong to a concurrent run. */
export function isStaleTestSchema(name: string, nowSec: number): boolean {
  const m = /^t_(\d+)_[0-9a-f]+$/.exec(name);
  return m !== null && nowSec - Number(m[1]) > STALE_SEC;
}

export default async function setup(): Promise<void> {
  const url = process.env.PG_TEST_URL;
  if (!url) throw new Error('the Postgres store suite needs PG_TEST_URL (scripts/pg-test-server.sh start, or CI)');
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('CREATE EXTENSION IF NOT EXISTS vector SCHEMA public');
    const all = await c.query<{ s: string }>(`SELECT nspname AS s FROM pg_namespace WHERE nspname LIKE 't\\_%'`);
    const now = Math.floor(Date.now() / 1000);
    for (const { s } of all.rows) if (isStaleTestSchema(s, now)) await c.query(`DROP SCHEMA ${s} CASCADE`);
  } finally {
    await c.end();
  }
}
