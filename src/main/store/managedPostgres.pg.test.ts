// The bootstrap SQL against a real server (as the superuser, like the
// container's local socket), under per-test names: the store then opens as
// the bootstrapped role, and MCP isolation can provision.
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as db from '../db.js';
import { bootstrapSql } from './managedPostgres.js';
import { isolationBlocker, rolePoolConfig } from './pgQueryIsolation.js';
import { createPgPool } from './postgres.js';
import { scramVerifier } from './scram.js';
import { isPg, testPgSchema } from './testStore.js';

describe.skipIf(!isPg)('bootstrapSql on Postgres', () => {
  it('runs twice cleanly; the role owns the schema, has CREATEROLE, and the store opens as it', async () => {
    const t = await testPgSchema();
    const schema = `${t.schema}_m`;
    const user = `${t.schema}_app`;
    const password = randomBytes(24).toString('base64url');
    const sqlText = bootstrapSql({ user, schema, verifier: scramVerifier(password) });
    try {
      await t.pool.query(sqlText);
      await t.pool.query(sqlText);
      const { types: _t, max: _m, idleTimeoutMillis: _i, ...conn } = rolePoolConfig({ connectionString: process.env.PG_TEST_URL, schema }, user, password);
      const pool = createPgPool({ ...conn, schema, max: 2 });
      try {
        await db.openDbPostgres(pool);
        const k = db.stateKysely();
        expect(await isolationBlocker(k, schema)).toBeNull();
        const owner = await pool.query<{ o: string }>('SELECT nspowner::regrole::text AS o FROM pg_namespace WHERE nspname = $1', [schema]);
        expect(owner.rows[0].o).toBe(user);
      } finally {
        await db.closeDb();
        await pool.end();
      }
    } finally {
      await t.pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await t.pool.query(`DROP OWNED BY ${user}`).catch(() => undefined);
      await t.pool.query(`DROP ROLE IF EXISTS ${user}`);
      await t.drop();
    }
  });
});
