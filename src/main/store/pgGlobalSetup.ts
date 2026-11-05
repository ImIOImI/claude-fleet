// vitest globalSetup for the Postgres store suite: one-time database prep, so
// parallel test files never race CREATE EXTENSION.
import pg from 'pg';

export default async function setup(): Promise<void> {
  const url = process.env.PG_TEST_URL;
  if (!url) throw new Error('the Postgres store suite needs PG_TEST_URL (scripts/pg-test-server.sh start, or CI)');
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('CREATE EXTENSION IF NOT EXISTS vector');
    const stale = await c.query<{ s: string }>(`SELECT nspname AS s FROM pg_namespace WHERE nspname LIKE 't\\_%'`);
    for (const { s } of stale.rows) await c.query(`DROP SCHEMA ${s} CASCADE`);
  } finally {
    await c.end();
  }
}
