// Test support: open state.db / inbox on the dialect STORE_TEST_DIALECT names.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import type Database from 'better-sqlite3';
import { CompiledQuery, type Kysely } from 'kysely';
import { createPgPool } from './postgres.js';
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

/** openDb on a fresh tmpdir (SQLite) or openDbPostgres on a fresh schema. */
export async function openTestState(prefix = 'cf-state-'): Promise<TestState> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const t = isPg ? await testPgSchema() : null;
  const open = async () => { if (t) await db.openDbPostgres(t.pool); else db.openDb(dir); };
  await open();
  return {
    dir, pg: t, open,
    async reopen() { await db.closeDb(); await open(); },
    async close() {
      await db.closeDb();
      await t?.drop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const inboxPools = new WeakMap<InboxStore, pg.Pool>();

/** InboxStore.memory() (SQLite) or a fresh-schema store whose close() drops it. */
export async function openTestInbox(): Promise<InboxStore> {
  if (!isPg) return InboxStore.memory();
  const t = await testPgSchema();
  const store = await InboxStore.openPostgres(t.pool);
  inboxPools.set(store, t.pool);
  const close = store.close.bind(store);
  store.close = async () => { await close(); await t.drop(); };
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
