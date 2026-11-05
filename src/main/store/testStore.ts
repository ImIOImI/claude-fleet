// Test support: run store tests on the dialect STORE_TEST_DIALECT names.
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { createPgPool } from './postgres.js';

export const isPg = process.env.STORE_TEST_DIALECT === 'postgres';
const POOL_MAX = Number(process.env.PG_TEST_POOL_MAX ?? 4);
/** Tests that need concurrent connections skip on a single-connection server. */
export const pgMultiConnection = isPg && POOL_MAX > 1;

export interface TestPg { pool: pg.Pool; schema: string; drop(): Promise<void> }

/** A fresh schema on PG_TEST_URL; drop() removes it and ends the pool. */
export async function testPgSchema(): Promise<TestPg> {
  const url = process.env.PG_TEST_URL;
  if (!url) throw new Error('STORE_TEST_DIALECT=postgres needs PG_TEST_URL');
  const schema = `t_${randomBytes(6).toString('hex')}`;
  const pool = createPgPool({ connectionString: url, schema, max: POOL_MAX });
  await pool.query(`CREATE SCHEMA ${schema}`);
  return {
    pool, schema,
    async drop() {
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await pool.end();
    },
  };
}
