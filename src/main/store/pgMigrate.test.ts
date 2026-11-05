import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql, type Kysely } from 'kysely';
import { createPgPool, postgresKysely } from './postgres.js';
import { ensureVector, migratePostgres, type PgTrack } from './pgMigrate.js';
import { isPg, testPgSchema, type TestPg } from './testStore.js';
import { STATE_PG_BASELINE, STATE_PG_BASELINE_VERSION } from './migrations/statePg.js';
import * as db from '../db.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

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

  it('waits for the advisory lock with bounded retries, so a session holding it cannot stall migration forever', async () => {
    const holder = await t.pool.connect();
    try {
      await holder.query('SELECT pg_advisory_lock(7340211)');
      const started = Date.now();
      await expect(migratePostgres(k, t.schema, TRACK, { lockTimeoutMs: 100, attempts: 3, backoffMs: 20 })).rejects.toThrow(/lock timeout/);
      expect(Date.now() - started).toBeLessThan(5_000);
      setTimeout(() => void holder.query('SELECT pg_advisory_unlock(7340211)'), 300);
      await migratePostgres(k, t.schema, { ...TRACK, steps: [] }, { lockTimeoutMs: 100, attempts: 10, backoffMs: 50 });
      expect(await version()).toBe(3);
    } finally {
      await holder.query('SELECT pg_advisory_unlock_all()');
      holder.release();
    }
  });

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

  it('is not capped by a session statement_timeout', async () => {
    const pool = createPgPool({ connectionString: process.env.PG_TEST_URL, schema: t.schema, max: 1, session: { statementTimeoutMs: 100 } });
    const kk = postgresKysely(pool);
    await migratePostgres(kk, t.schema, { track: 'demo', baselineVersion: 1, baseline: 'SELECT pg_sleep(0.3); CREATE TABLE a (x BIGINT);', steps: [] });
    expect(await version()).toBe(1);
    await expect(sql`SELECT pg_sleep(0.3)`.execute(kk)).rejects.toThrow(/statement timeout/);
    await kk.destroy();
    await pool.end();
  });

  it('refuses a schema that does not exist instead of creating tables elsewhere', async () => {
    const pool = createPgPool({ connectionString: process.env.PG_TEST_URL, schema: 'no_such_schema_x', max: 1 });
    const kk = postgresKysely(pool);
    await expect(migratePostgres(kk, 'no_such_schema_x', TRACK)).rejects.toThrow(/store schema "no_such_schema_x" does not exist/);
    await kk.destroy();
    await pool.end();
  });
});

describe.skipIf(!isPg)('ensureVector', () => {
  it('installs pgvector in public, so two store schemas in one database both migrate', async () => {
    const name = `t_${Math.floor(Date.now() / 1000)}_ext${Math.random().toString(16).slice(2, 8)}`;
    const admin = new pg.Client({ connectionString: process.env.PG_TEST_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    const u = new URL(process.env.PG_TEST_URL as string);
    u.pathname = `/${name}`;
    const setup = new pg.Client({ connectionString: u.toString() });
    await setup.connect();
    await setup.query('CREATE SCHEMA fleet_a; CREATE SCHEMA fleet_b');
    await setup.end();
    try {
      for (const schema of ['fleet_a', 'fleet_b']) {
        const pool = createPgPool({ connectionString: u.toString(), schema, max: 1 });
        const kk = postgresKysely(pool);
        try {
          await ensureVector(kk);
          await migratePostgres(kk, schema, { track: 'state', baselineVersion: STATE_PG_BASELINE_VERSION, baseline: STATE_PG_BASELINE, steps: [] });
        } finally {
          await kk.destroy();
          await pool.end();
        }
      }
    } finally {
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    }
  });
});

describe.skipIf(!isPg)('state openers', () => {
  it('refuse to open one dialect while the other is open', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cf-dialect-'));
    const t = await testPgSchema();
    try {
      db.openDb(dir);
      await expect(db.openDbPostgres(t.pool)).rejects.toThrow(/open on SQLite/);
      await db.closeDb();
      await db.openDbPostgres(t.pool);
      expect(() => db.openDb(dir)).toThrow(/open on Postgres/);
    } finally {
      await db.closeDb();
      await t.drop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
