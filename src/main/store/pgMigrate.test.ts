import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql, type Kysely } from 'kysely';
import { createPgPool, postgresKysely } from './postgres.js';
import { migratePostgres, type PgTrack } from './pgMigrate.js';
import { isPg, testPgSchema, type TestPg } from './testStore.js';

const TRACK: PgTrack = {
  track: 'demo', baselineVersion: 3, baseline: 'CREATE TABLE a (x BIGINT); CREATE TABLE b (y BIGINT);',
  steps: [{ version: 3, postgres: 'SELECT 1/0' }, { version: 4, postgres: 'ALTER TABLE a ADD COLUMN z TEXT' }],
};

describe.skipIf(!isPg)('migratePostgres', () => {
  let t: TestPg;
  let k: Kysely<unknown>;
  beforeEach(async () => { t = await testPgSchema(); k = postgresKysely(t.pool); });
  afterEach(async () => { await k.destroy(); await t.drop(); });

  const version = async () =>
    (await sql<{ version: number }>`SELECT version FROM schema_migrations WHERE track = 'demo'`.execute(k)).rows[0]?.version;
  const columns = async (table: string) =>
    (await sql<{ c: string }>`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = ${t.schema} AND table_name = ${table} ORDER BY ordinal_position`.execute(k)).rows.map((r) => r.c);

  it('applies the baseline, skips steps at or below it, runs later ones, and is idempotent', async () => {
    await migratePostgres(k, t.schema, TRACK);
    expect(await version()).toBe(4);
    expect(await columns('a')).toEqual(['x', 'z']);
    await migratePostgres(k, t.schema, TRACK);
    expect(await version()).toBe(4);
  });

  it('serializes concurrent migrators: the baseline runs once', async () => {
    const k2 = postgresKysely(t.pool);
    await Promise.all([migratePostgres(k, t.schema, TRACK), migratePostgres(k2, t.schema, TRACK)]);
    expect(await version()).toBe(4);
    await k2.destroy();
  });

  it('a failing step rolls the whole run back', async () => {
    await expect(migratePostgres(k, t.schema, { ...TRACK, steps: [{ version: 4, postgres: 'SELECT 1/0' }] })).rejects.toThrow(/division by zero/);
    expect(await columns('a')).toEqual([]);
  });

  it('refuses a schema that does not exist instead of creating tables elsewhere', async () => {
    const pool = createPgPool({ connectionString: process.env.PG_TEST_URL, schema: 'no_such_schema_x', max: 1 });
    const kk = postgresKysely(pool);
    await expect(migratePostgres(kk, 'no_such_schema_x', TRACK)).rejects.toThrow(/store schema "no_such_schema_x" does not exist/);
    await kk.destroy();
    await pool.end();
  });
});
