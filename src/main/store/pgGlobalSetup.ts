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
    // testPgAppSchema's roles (<schema>_app, <schema>_mcp_*) are cluster-wide and outlive a crashed run.
    const roles = await c.query<{ r: string }>(`SELECT rolname AS r FROM pg_roles WHERE rolname ~ '^t_[0-9]+_[0-9a-f]+_' ORDER BY length(rolname) DESC`);
    for (const { r } of roles.rows) {
      const schema = /^(t_\d+_[0-9a-f]+)_/.exec(r)?.[1];
      if (!schema || !isStaleTestSchema(schema, now)) continue;
      await c.query(`DROP OWNED BY ${r}`);
      await c.query(`DROP ROLE ${r}`);
    }
  } finally {
    await c.end();
  }
}
