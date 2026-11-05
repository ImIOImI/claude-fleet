// MCP `query` isolation on Postgres (SPEC §11): each caller workspace reads
// through its own LOGIN role. Row-level security limits every exposed table to
// the workspaces in `mcp_grants` for session_user, which the caller's SQL can't
// change (SET ROLE / set_config('role') reach only the caller's own roles).
import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { sql, type Kysely } from 'kysely';
import { parse as parseConnectionString } from 'pg-connection-string';
import { pgTypes, writeLock, type PgPoolConfig } from './postgres.js';
import { scramVerifier } from './scram.js';
import { MCP_QUERY_TABLES, SNAPSHOT_EVENT_COLS, type QueryArgs, type QueryCaller, type QueryRunner } from './readSource.js';

/** Role names are `<schema>_mcp_<16 hex>_raw` at most: within Postgres's 63. */
const MAX_SCHEMA_LEN = 32;
const DEFAULT_STATEMENT_TIMEOUT_MS = 10_000;
const DEFAULT_LOCK_TIMEOUT_MS = 2_000;

export class QueryUnavailableError extends Error {}

export interface IsolationRoles { reader: string; raw: string }

export function isolationRoles(schema: string): IsolationRoles {
  return { reader: `${schema}_mcp_reader`, raw: `${schema}_mcp_raw` };
}

/** A caller's LOGIN role. Hashed: workspace ids aren't identifier-safe. */
export function callerRole(schema: string, callerId: string): string {
  return `${schema}_mcp_${createHash('sha256').update(callerId).digest('hex').slice(0, 16)}`;
}

/** pg options to log in as `user` where the store pool connects. A connection
 *  string's own user and password would win over explicit fields, so it is split. */
export function rolePoolConfig(base: PgPoolConfig, user: string, password: string): pg.PoolConfig {
  const { connectionString, schema: _schema, session: _session, user: _u, password: _p, max: _max, ...rest } = base as PgPoolConfig & pg.PoolConfig;
  const cs = connectionString ? parseConnectionString(connectionString) : null;
  return {
    ...rest,
    host: cs?.host ?? rest.host,
    port: cs?.port ? Number(cs.port) : rest.port,
    database: cs?.database ?? rest.database,
    user, password,
    max: 1, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 10_000,
    types: pgTypes,
  };
}

const POLICY = (schema: string, table: string): string =>
  table === 'perf_events'
    ? `workspace_id IS NULL OR workspace_id IN (SELECT unnest(${schema}.mcp_scope()))`
    : `workspace_id IN (SELECT unnest(${schema}.mcp_scope()))`;

/** Idempotent; runs as the store role, which owns the tables and has CREATEROLE. */
export async function ensureIsolation<DB>(k: Kysely<DB>, schema: string): Promise<void> {
  const r = isolationRoles(schema);
  await k.transaction().execute(async (trx) => {
    const run = (text: string) => sql.raw(text).execute(trx);
    await run(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${r.reader}') THEN CREATE ROLE ${r.reader} NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${r.raw}') THEN CREATE ROLE ${r.raw} NOLOGIN; END IF;
    END $$`);
    await run(`CREATE TABLE IF NOT EXISTS mcp_grants (
      role_name TEXT COLLATE "C" NOT NULL, workspace_id TEXT COLLATE "C" NOT NULL, PRIMARY KEY (role_name, workspace_id))`);
    await run(`CREATE OR REPLACE FUNCTION mcp_scope() RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER
      SET search_path = pg_catalog
      AS $f$ SELECT coalesce(array_agg(workspace_id), '{}') FROM ${schema}.mcp_grants WHERE role_name = session_user $f$`);
    await run(`REVOKE ALL ON FUNCTION mcp_scope() FROM PUBLIC`);
    await run(`GRANT USAGE ON SCHEMA ${schema} TO ${r.reader}`);
    await run(`GRANT EXECUTE ON FUNCTION mcp_scope() TO ${r.reader}`);
    await run(`GRANT SELECT (${SNAPSHOT_EVENT_COLS}) ON events TO ${r.reader}`);
    await run(`GRANT SELECT (raw_jsonl) ON events TO ${r.raw}`);
    await run(`GRANT SELECT ON ${MCP_QUERY_TABLES.filter((t) => t !== 'events').join(', ')} TO ${r.reader}`);
    for (const t of MCP_QUERY_TABLES) {
      await run(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
      await run(`DROP POLICY IF EXISTS mcp_read ON ${t}`);
      await run(`CREATE POLICY mcp_read ON ${t} FOR SELECT TO ${r.reader} USING (${POLICY(schema, t)})`);
    }
  });
}

/** Why `query` can't be isolated on this server, or null when it can. */
export async function isolationBlocker<DB>(k: Kysely<DB>, schema: string): Promise<string | null> {
  if (schema.length > MAX_SCHEMA_LEN) return `the store schema name is longer than ${MAX_SCHEMA_LEN} characters`;
  const r = await sql<{ v: number; cr: boolean }>`
    SELECT current_setting('server_version_num')::int AS v, rolcreaterole AS cr FROM pg_roles WHERE rolname = current_user`.execute(k);
  const row = r.rows[0];
  if (!row || row.v < 160000) return 'it needs Postgres 16 or later';
  if (!row.cr) return 'the store role needs CREATEROLE (it creates one read-only role per workspace)';
  return null;
}

export interface QueryIsolationOptions { statementTimeoutMs?: number; lockTimeoutMs?: number; onPoolError?: (e: Error) => void }

export class PgQueryIsolation implements QueryRunner {
  private readonly pools = new Map<string, pg.Pool>();
  private readonly locks = new Map<string, () => Promise<() => void>>();
  private readonly ensured = new Map<string, Promise<void>>();

  private constructor(
    private readonly app: Kysely<unknown>,
    private readonly schema: string,
    private readonly base: PgPoolConfig,
    private readonly opts: QueryIsolationOptions,
  ) {}

  /** Provisions the shared roles, grants and policies; throws QueryUnavailableError when the server can't. */
  static async open<DB>(app: Kysely<DB>, schema: string, base: PgPoolConfig, opts: QueryIsolationOptions = {}): Promise<PgQueryIsolation> {
    const blocker = await isolationBlocker(app, schema);
    if (blocker) throw new QueryUnavailableError(`query is unavailable on this Postgres store: ${blocker}`);
    await ensureIsolation(app, schema);
    return new PgQueryIsolation(app as Kysely<unknown>, schema, base, opts);
  }

  async query(caller: QueryCaller, q: QueryArgs): Promise<unknown[]> {
    const role = callerRole(this.schema, caller.callerId);
    let lock = this.locks.get(role);
    if (!lock) { lock = writeLock(); this.locks.set(role, lock); }
    const release = await lock();
    try {
      await this.ensureRole(role);
      await this.writeScope(role, caller.scope);
      return await this.runAs(role, q);
    } finally {
      release();
    }
  }

  async forgetCaller(callerId: string): Promise<void> {
    const role = callerRole(this.schema, callerId);
    await this.pools.get(role)?.end();
    this.pools.delete(role);
    this.ensured.delete(role);
    await this.app.transaction().execute(async (trx) => {
      await sql`DELETE FROM mcp_grants WHERE role_name = ${role}`.execute(trx);
      await sql.raw(`DROP ROLE IF EXISTS ${role}`).execute(trx);
      await sql.raw(`DROP ROLE IF EXISTS ${role}_raw`).execute(trx);
    });
  }

  async end(): Promise<void> {
    await Promise.all([...this.pools.values()].map((p) => p.end()));
    this.pools.clear();
  }

  /** The role exists, with a password minted for this process and never stored. */
  private ensureRole(role: string): Promise<void> {
    let p = this.ensured.get(role);
    if (!p) {
      p = this.provision(role);
      this.ensured.set(role, p);
      p.catch(() => this.ensured.delete(role));
    }
    return p;
  }

  private async provision(role: string): Promise<void> {
    const r = isolationRoles(this.schema);
    const password = randomBytes(32).toString('base64url');
    await this.app.transaction().execute(async (trx) => {
      const run = (text: string) => sql.raw(text).execute(trx);
      await run(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} LOGIN NOINHERIT; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}_raw') THEN CREATE ROLE ${role}_raw NOLOGIN; END IF;
      END $$`);
      await run(`ALTER ROLE ${role} LOGIN NOINHERIT CONNECTION LIMIT 4 PASSWORD '${scramVerifier(password)}'`);
      await run(`GRANT ${r.reader} TO ${role} WITH INHERIT TRUE`);
      await run(`GRANT ${r.reader}, ${r.raw} TO ${role}_raw WITH INHERIT TRUE`);
      await run(`GRANT ${role}_raw TO ${role} WITH INHERIT FALSE, SET TRUE`);
    });
    await this.pools.get(role)?.end();
    const pool = new pg.Pool(rolePoolConfig(this.base, role, password));
    pool.on('error', (e) => this.opts.onPoolError?.(e));
    this.pools.set(role, pool);
  }

  /** Rewritten on every call, so a revoked grant stops applying at once. */
  private async writeScope(role: string, scope: ReadonlySet<string>): Promise<void> {
    await this.app.transaction().execute(async (trx) => {
      await sql`DELETE FROM mcp_grants WHERE role_name = ${role}`.execute(trx);
      const ids = [...scope];
      if (ids.length > 0) {
        await sql`INSERT INTO mcp_grants (role_name, workspace_id) VALUES ${sql.join(ids.map((w) => sql`(${role}, ${w})`))}`.execute(trx);
      }
    });
  }

  private async runAs(role: string, q: QueryArgs): Promise<unknown[]> {
    if (!Number.isSafeInteger(q.maxRows) || q.maxRows < 1) throw new Error('maxRows must be a positive integer');
    const pool = this.pools.get(role);
    if (!pool) throw new Error('caller role pool missing');
    const c = await pool.connect();
    let broken: Error | undefined;
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      try {
        if (q.includeRaw) await c.query(`SET LOCAL ROLE ${role}_raw`);
        await c.query(`SET LOCAL statement_timeout = ${this.opts.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS}`);
        await c.query(`SET LOCAL lock_timeout = ${this.opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS}`);
        await c.query(`SET LOCAL search_path = ${this.schema}, public`);
        // Temp views shadow the tables, so `SELECT * FROM events` works without raw_jsonl.
        await c.query(`CREATE TEMP VIEW events AS SELECT ${SNAPSHOT_EVENT_COLS}${q.includeRaw ? ', raw_jsonl' : ''} FROM ${this.schema}.events`);
        for (const t of MCP_QUERY_TABLES) {
          if (t !== 'events') await c.query(`CREATE TEMP VIEW ${t} AS SELECT * FROM ${this.schema}.${t}`);
        }
        await c.query('SET TRANSACTION READ ONLY');
        // A cursor accepts only SELECT/VALUES/WITH (no data-modifying WITH);
        // the extended protocol refuses a second statement.
        const declare: pg.QueryConfig & { queryMode: 'extended' } = {
          text: `DECLARE mcp_q NO SCROLL CURSOR FOR ${q.sql.replace(/[\s;]+$/, '')}`,
          values: q.params,
          queryMode: 'extended',
        };
        await c.query(declare);
        return (await c.query(`FETCH FORWARD ${q.maxRows} FROM mcp_q`)).rows;
      } finally {
        await c.query('ROLLBACK');
      }
    } finally {
      // Session-level effects outlive a rollback (advisory locks, LISTEN).
      try { await c.query('DISCARD ALL'); } catch (e) { broken = e as Error; }
      c.release(broken);
    }
  }
}
