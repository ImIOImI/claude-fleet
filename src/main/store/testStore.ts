// Test support: open state.db / inbox on the dialect STORE_TEST_DIALECT names.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { onTestFinished } from 'vitest';
import type pg from 'pg';
import type Database from 'better-sqlite3';
import { CompiledQuery, type Kysely } from 'kysely';
import { createPgPool, type PgPoolConfig } from './postgres.js';
import { rolePoolConfig } from './pgQueryIsolation.js';
import { scramVerifier } from './scram.js';
import * as db from '../db.js';
import { InboxStore } from '../inbox/inboxDb.js';

export const isPg = process.env.STORE_TEST_DIALECT === 'postgres';
const POOL_MAX = Number(process.env.PG_TEST_POOL_MAX ?? 4);
/** Tests that need concurrent connections skip on a single-connection server. */
export const pgMultiConnection = isPg && POOL_MAX > 1;

export interface TestPg { pool: pg.Pool; schema: string; drop(): Promise<void> }

/** A fresh schema on PG_TEST_URL; drop() removes it and ends the pool. */
export async function testPgSchema(): Promise<TestPg> {
  const url = process.env.PG_TEST_URL;
  if (!url) throw new Error('STORE_TEST_DIALECT=postgres needs PG_TEST_URL');
  const schema = `t_${Math.floor(Date.now() / 1000)}_${randomBytes(6).toString('hex')}`;
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

export interface TestState {
  dir: string;
  pg: TestPg | null;
  /** Open the same database again (after, or racing, a closeDb). */
  open(): Promise<void>;
  /** closeDb, then open(). */
  reopen(): Promise<void>;
  close(): Promise<void>;
}

/** openDb on a fresh tmpdir (SQLite) or openDbPostgres on a fresh schema. Registers
 *  its own onTestFinished cleanup, so a test that forgets (or re-creates mid-test
 *  without closing the previous one) never leaks a schema/pool; close() is
 *  idempotent so an explicit afterEach close doesn't double up. */
export async function openTestState(prefix = 'cf-state-'): Promise<TestState> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const t = isPg ? await testPgSchema() : null;
  const open = async () => { if (t) await db.openDbPostgres(t.pool); else db.openDb(dir); };
  await open();
  let closed = false;
  const state: TestState = {
    dir, pg: t, open,
    async reopen() { await db.closeDb(); await open(); },
    async close() {
      if (closed) return;
      closed = true;
      await db.closeDb();
      await t?.drop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  onTestFinished(() => state.close());
  return state;
}

const inboxPools = new WeakMap<InboxStore, pg.Pool>();

/** InboxStore.memory() (SQLite) or a fresh-schema store whose close() drops it.
 *  Registers its own onTestFinished cleanup (see openTestState); close() is
 *  idempotent. */
export async function openTestInbox(): Promise<InboxStore> {
  if (!isPg) {
    const store = InboxStore.memory();
    onTestFinished(() => store.close());
    return store;
  }
  const t = await testPgSchema();
  const store = await InboxStore.openPostgres(t.pool);
  inboxPools.set(store, t.pool);
  const close = store.close.bind(store);
  let closed = false;
  store.close = async () => {
    if (closed) return;
    closed = true;
    await close();
    await t.drop();
  };
  onTestFinished(() => store.close());
  return store;
}

/** Raw SQL with `?` placeholders on either dialect (state.db by default). */
export async function queryRows<T = Record<string, unknown>>(
  text: string, params: readonly unknown[] = [], k: Kysely<unknown> = db.stateKysely() as Kysely<unknown>,
): Promise<T[]> {
  let n = 0;
  const q = isPg ? text.replace(/\?/g, () => `$${++n}`) : text;
  return (await k.executeQuery<T>(CompiledQuery.raw(q, [...params]))).rows;
}

/** Counts the statements an inbox store sends from now on (SQLite: prepares on
 *  its connection; Postgres: client queries), to pin "constant round trips, not N+1". */
export function countQueries(s: InboxStore): { count(): number } {
  let n = 0;
  const pool = inboxPools.get(s);
  if (!pool) {
    const raw = (s as unknown as { raw: Database.Database }).raw;
    const orig = raw.prepare.bind(raw);
    raw.prepare = ((text: string) => { n++; return orig(text); }) as typeof raw.prepare;
    return { count: () => n };
  }
  const seen = new WeakSet<pg.PoolClient>();
  const connect = pool.connect.bind(pool) as (cb?: unknown) => Promise<pg.PoolClient>;
  // pool.query() passes a callback; only the promise form is Kysely's.
  pool.connect = ((cb?: unknown) => (cb ? connect(cb) : counted())) as typeof pool.connect;
  const counted = async (): Promise<pg.PoolClient> => {
    const c = await connect();
    if (!seen.has(c)) {
      seen.add(c);
      const q = c.query.bind(c) as (...a: unknown[]) => unknown;
      (c as { query: unknown }).query = (...a: unknown[]) => {
        if (!/^SET search_path/.test(String(a[0]))) n++;
        return q(...a);
      };
    }
    return c;
  };
  return { count: () => n };
}

const turn = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

/** Let timer-started store work finish: three macrotask turns (SQLite does no
 *  I/O), then on Postgres until every pooled client is idle for two checks. */
export async function settle(s: InboxStore): Promise<void> {
  for (let i = 0; i < 3; i++) await turn();
  const pool = inboxPools.get(s);
  if (!pool) return;
  for (let quiet = 0; quiet < 2;) {
    await new Promise<void>((r) => setTimeout(r, 5));
    quiet = pool.waitingCount === 0 && pool.idleCount === pool.totalCount ? quiet + 1 : 0;
    await turn();
  }
}

export interface TestPgApp extends TestPg {
  /** The store role: owns the schema, has CREATEROLE, is not a superuser. */
  appRole: string;
  /** Pool options for appRole (what the store's own pool would use). */
  appConfig: PgPoolConfig;
  appPool: pg.Pool;
}

/** A fresh schema owned by a non-superuser store role, as on a real server:
 *  RLS doesn't apply to superusers, so isolation is only testable this way.
 *  drop() also removes every role named after the schema. */
export async function testPgAppSchema(): Promise<TestPgApp> {
  const t = await testPgSchema();
  const appRole = `${t.schema}_app`;
  const password = randomBytes(24).toString('base64url');
  await t.pool.query(`CREATE ROLE ${appRole} LOGIN CREATEROLE PASSWORD '${scramVerifier(password)}'`);
  await t.pool.query(`ALTER SCHEMA ${t.schema} OWNER TO ${appRole}`);
  const { types: _types, max: _max, idleTimeoutMillis: _idle, ...conn } = rolePoolConfig(
    { connectionString: process.env.PG_TEST_URL, schema: t.schema }, appRole, password,
  );
  const appConfig: PgPoolConfig = { ...conn, schema: t.schema, max: POOL_MAX };
  const appPool = createPgPool(appConfig);
  return {
    ...t, appRole, appConfig, appPool,
    async drop() {
      await appPool.end();
      await t.pool.query(`DROP SCHEMA ${t.schema} CASCADE`);
      const roles = await t.pool.query<{ r: string }>(`SELECT rolname AS r FROM pg_roles WHERE rolname LIKE $1 ORDER BY length(rolname) DESC`, [`${t.schema}\\_%`]);
      for (const { r } of roles.rows) {
        await t.pool.query(`DROP OWNED BY ${r}`);
        await t.pool.query(`DROP ROLE ${r}`);
      }
      await t.pool.end();
    },
  };
}
