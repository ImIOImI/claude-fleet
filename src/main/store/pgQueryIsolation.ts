// MCP `query` isolation on Postgres (SPEC §11): each caller workspace reads
// through its own LOGIN role, or all through one bootstrap-provisioned login
// (`preprovisioned`, D71). Row-level security limits every exposed table to
// the workspaces in `mcp_grants` for session_user, which the caller's SQL can't
// change (SET ROLE / set_config('role') reach only the caller's own roles).
import { createHash, randomBytes } from 'node:crypto';
import { connect as netConnect } from 'node:net';
import pg from 'pg';
import { sql, type Kysely } from 'kysely';
import { parse as parseConnectionString } from 'pg-connection-string';
import type { PasswordProvider } from './passwordProvider.js';
import { pgClientFor } from './pgScramOnly.js';
import { pgTypes, writeLock, type PgPoolConfig } from './postgres.js';
import { scramVerifier } from './scram.js';
import { QUERY_USER } from './storeConfig.js';
import { MAX_QUERY_BYTES, MCP_QUERY_TABLES, SNAPSHOT_EVENT_COLS, type QueryArgs, type QueryCaller, type QueryRunner } from './readSource.js';

/** Role names are `<schema>_mcp_<16 hex>_raw` at most: within Postgres's 63. */
export const MAX_SCHEMA_LEN = 32;
const DEFAULT_STATEMENT_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const DEFAULT_SETUP_LOCK_TIMEOUT_MS = 3_000;
const SETUP_STATEMENT_TIMEOUT_MS = 30_000;
/** How long past the call deadline the server-side timeouts still allow, as a backstop for a lost cancel. */
const CANCEL_GRACE_MS = 1_000;
const CANCEL_TIMEOUT_MS = 1_000;
const LOCK_NOT_AVAILABLE = '55P03';
// set_config can raise work_mem per statement, so concurrency is the memory bound.
const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_MAX_QUEUED = 8;
// pg-protocol throws outside any promise when it decodes a string past V8's limit.
const DEFAULT_MAX_MESSAGE_BYTES = 1 << 20;
const MAX_ERROR_CHARS = 2_048;
const FETCH_BATCH = 50;
const INVALID_PASSWORD = '28P01';
const BUSY = 'query is busy: too many queries are running; retry shortly';

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
export function rolePoolConfig(base: PgPoolConfig, user: string, password: string | PasswordProvider): pg.PoolConfig {
  const { connectionString, schema: _schema, session: _session, user: _u, password: _p, max: _max, ...rest } = base as PgPoolConfig & pg.PoolConfig;
  const cs = connectionString ? parseConnectionString(connectionString) : null;
  return {
    ...pgClientFor(rest.ssl),
    ...rest,
    host: cs?.host ?? rest.host,
    port: cs?.port ? Number(cs.port) : rest.port,
    database: cs?.database ?? rest.database,
    user, password,
    max: 1, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 10_000,
    types: pgTypes,
  };
}

// Policies target the reader role only: any other non-owner role sees no rows.
const POLICY = (schema: string, table: string): string =>
  table === 'perf_events'
    ? `workspace_id IS NULL OR workspace_id IN (SELECT unnest(${schema}.mcp_scope()))`
    : `workspace_id IN (SELECT unnest(${schema}.mcp_scope()))`;

/** The isolation DDL, in order; it also versions the stored fingerprint. */
function isolationDdl(schema: string): string[] {
  const r = isolationRoles(schema);
  return [
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${r.reader}') THEN CREATE ROLE ${r.reader} NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${r.raw}') THEN CREATE ROLE ${r.raw} NOLOGIN; END IF;
    END $$`,
    `CREATE TABLE IF NOT EXISTS mcp_grants (
      role_name TEXT COLLATE "C" NOT NULL, workspace_id TEXT COLLATE "C" NOT NULL, PRIMARY KEY (role_name, workspace_id))`,
    `CREATE OR REPLACE FUNCTION mcp_scope() RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER
      SET search_path = pg_catalog
      AS $f$ SELECT coalesce(array_agg(workspace_id), '{}') FROM ${schema}.mcp_grants WHERE role_name = session_user $f$`,
    `REVOKE ALL ON FUNCTION mcp_scope() FROM PUBLIC`,
    `CREATE OR REPLACE FUNCTION mcp_row_too_large(n bigint, cap bigint) RETURNS text LANGUAGE plpgsql VOLATILE
      SET search_path = pg_catalog
      AS $f$ BEGIN RAISE EXCEPTION 'result too large: a row is % bytes (max %); select fewer or narrower columns', n, cap
        USING ERRCODE = 'program_limit_exceeded'; END $f$`,
    `REVOKE ALL ON FUNCTION mcp_row_too_large(bigint, bigint) FROM PUBLIC`,
    `REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM ${r.reader}, ${r.raw}`,
    `GRANT USAGE ON SCHEMA ${schema} TO ${r.reader}`,
    `GRANT EXECUTE ON FUNCTION mcp_scope(), mcp_row_too_large(bigint, bigint) TO ${r.reader}`,
    `GRANT SELECT (${SNAPSHOT_EVENT_COLS}) ON events TO ${r.reader}`,
    `GRANT SELECT (raw_jsonl) ON events TO ${r.raw}`,
    `GRANT SELECT ON ${MCP_QUERY_TABLES.filter((t) => t !== 'events').join(', ')} TO ${r.reader}`,
    ...MCP_QUERY_TABLES.flatMap((t) => [
      `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`,
      `DROP POLICY IF EXISTS mcp_read ON ${t}`,
      `CREATE POLICY mcp_read ON ${t} FOR SELECT TO ${r.reader} USING (${POLICY(schema, t)})`,
    ]),
  ];
}

/** The DDL's version plus a digest of the catalog state it produces: RLS flags,
 *  table and column ACLs, policies, the two functions and the shared roles. */
async function isolationFingerprint<DB>(k: Kysely<DB>, schema: string, ddl: string[]): Promise<string> {
  const r = isolationRoles(schema);
  const state = await sql<{ d: string | null }>`
    SELECT md5(string_agg(x, E'\n' ORDER BY x)) AS d FROM (
      SELECT 'rel:' || c.relname || ':' || c.relkind::text || ':' || c.relrowsecurity || ':' || c.relforcerowsecurity || ':' || coalesce(c.relacl::text, '')
        FROM pg_class c WHERE c.relnamespace = ${schema}::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      UNION ALL
      SELECT 'col:' || c.relname || '.' || a.attname || ':' || a.attacl::text
        FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
        WHERE c.relnamespace = ${schema}::regnamespace AND a.attacl IS NOT NULL
      UNION ALL
      SELECT 'pol:' || tablename || ':' || policyname || ':' || permissive || ':' || roles::text || ':' || cmd || ':' || coalesce(qual, '') || ':' || coalesce(with_check, '')
        FROM pg_policies WHERE schemaname = ${schema}
      UNION ALL
      SELECT 'fn:' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || '):' || md5(p.prosrc) || ':' || p.prosecdef || ':'
          || p.provolatile::text || ':' || coalesce(array_to_string(p.proconfig, ','), '') || ':' || coalesce(p.proacl::text, '')
        FROM pg_proc p WHERE p.pronamespace = ${schema}::regnamespace
      UNION ALL
      SELECT 'ns:' || coalesce(n.nspacl::text, '') FROM pg_namespace n WHERE n.nspname = ${schema}
      UNION ALL
      SELECT 'role:' || rolname || ':' || rolcanlogin FROM pg_roles WHERE rolname IN (${r.reader}, ${r.raw})
    ) s(x)`.execute(k);
  const version = createHash('sha256').update(ddl.join('\n;\n')).digest('hex').slice(0, 16);
  return `${version}:${state.rows[0]?.d ?? ''}`;
}

/** Idempotent; runs as the store role, which owns the tables. It needs
 *  CREATEROLE only when the reader/raw roles don't exist yet. When the catalog already matches the stored fingerprint it runs no DDL, so a
 *  normal start takes no ACCESS EXCLUSIVE lock. A lock wait past `lockTimeoutMs`
 *  throws QueryUnavailableError. */
export async function ensureIsolation<DB>(k: Kysely<DB>, schema: string, lockTimeoutMs = DEFAULT_SETUP_LOCK_TIMEOUT_MS): Promise<void> {
  const ddl = isolationDdl(schema);
  const stored = await sql<{ c: string | null }>`
    SELECT obj_description(to_regclass(${schema + '.mcp_grants'}), 'pg_class') AS c`.execute(k);
  if (stored.rows[0]?.c && stored.rows[0].c === await isolationFingerprint(k, schema, ddl)) return;
  try {
    await k.transaction().execute(async (trx) => {
      const run = (text: string) => sql.raw(text).execute(trx);
      await run(`SET LOCAL lock_timeout = ${lockTimeoutMs}`);
      await run(`SET LOCAL statement_timeout = ${SETUP_STATEMENT_TIMEOUT_MS}`);
      for (const stmt of ddl) await run(stmt);
      await run(`COMMENT ON TABLE mcp_grants IS '${await isolationFingerprint(trx, schema, ddl)}'`);
    });
  } catch (e) {
    if ((e as { code?: string }).code !== LOCK_NOT_AVAILABLE) throw e;
    throw new QueryUnavailableError(
      `query is unavailable on this Postgres store: another session held a lock on the store tables for over ${lockTimeoutMs} ms while row-level security was being set up; restart the app to retry`,
    );
  }
}

/** Why `query` can't be isolated on this server, or null when it can. */
export async function isolationBlocker<DB>(k: Kysely<DB>, schema: string, needsCreateRole = true): Promise<string | null> {
  if (schema.length > MAX_SCHEMA_LEN) return `the store schema name is longer than ${MAX_SCHEMA_LEN} characters`;
  const r = await sql<{ v: number; cr: boolean }>`
    SELECT current_setting('server_version_num')::int AS v, rolcreaterole AS cr FROM pg_roles WHERE rolname = current_user`.execute(k);
  const row = r.rows[0];
  if (!row || row.v < 160000) return 'it needs Postgres 16 or later';
  if (needsCreateRole && !row.cr) return 'the store role needs CREATEROLE (it creates one read-only role per workspace)';
  return null;
}

/** A login `fleet-host bootstrap` made (D71): every caller reads as it, and nothing is created or altered at run time. */
export interface PreprovisionedLogin { role: string; password: PasswordProvider }

export interface QueryIsolationOptions {
  preprovisioned?: PreprovisionedLogin;
  /** Pre-provisioned only: why `query` isn't ready at open (each call retries). */
  onUnavailable?: (message: string) => void;
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
  /** Whole-call deadline; past it the backend is cancelled and the connection destroyed. */
  callTimeoutMs?: number;
  /** lock_timeout for the isolation DDL at open. */
  setupLockTimeoutMs?: number;
  maxConcurrent?: number;
  maxQueued?: number;
  maxMessageBytes?: number;
  onPoolError?: (e: Error) => void;
}

/** Destroys `stream` when a backend message header announces more than `max`
 *  bytes, before pg-protocol buffers and decodes it. */
export function guardMessageSize(stream: NodeJS.ReadableStream & { destroy(e?: Error): void }, max: number): void {
  let body = 0;
  let head: Buffer = Buffer.alloc(0);
  stream.prependListener('data', (chunk: Buffer) => {
    let off = 0;
    while (off < chunk.length) {
      if (body > 0) {
        const n = Math.min(body, chunk.length - off);
        body -= n;
        off += n;
        continue;
      }
      const take = chunk.subarray(off, off + 5 - head.length);
      head = Buffer.concat([head, take]);
      off += take.length;
      if (head.length < 5) return;
      const len = head.readUInt32BE(1) - 4;
      head = Buffer.alloc(0);
      if (len > max) {
        stream.destroy(new Error(`a Postgres message of ${len} bytes exceeds ${max}`));
        return;
      }
      body = len;
    }
  });
}

/** A driver error whose message (which can echo a value) is cut to MAX_ERROR_CHARS; `code` is kept. */
function clipError(e: unknown): unknown {
  if (!(e instanceof Error) || e.message.length <= MAX_ERROR_CHARS) return e;
  const short = new Error(`${e.message.slice(0, MAX_ERROR_CHARS)}… [truncated]`) as Error & { code?: string };
  const code = (e as { code?: unknown }).code;
  if (typeof code === 'string') short.code = code;
  return short;
}

/** Trailing whitespace and semicolons, in linear time: the caller's SQL sits inside a subquery. */
function trimTail(text: string): string {
  let end = text.length;
  while (end > 0 && /[\s;]/.test(text[end - 1])) end--;
  return text.slice(0, end);
}

export class PgQueryIsolation implements QueryRunner {
  private readonly pools = new Map<string, pg.Pool>();
  private readonly locks = new Map<string, () => Promise<() => void>>();
  private readonly ensured = new Map<string, Promise<void>>();
  /** Bumped by forgetCaller; a call that began under an older value is refused. */
  private readonly generations = new Map<string, number>();
  /** Calls per role holding or waiting for its lock. */
  private readonly pending = new Map<string, number>();
  private readonly guarded = new WeakSet<pg.PoolClient>();
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private prepared: Promise<void> | null = null;

  private constructor(
    private readonly app: Kysely<unknown>,
    private readonly schema: string,
    private readonly base: PgPoolConfig,
    private readonly opts: QueryIsolationOptions,
  ) {}

  /** Provisions the shared roles, grants and policies (pre-provisioned: only the grants and policies, once the roles
   *  exist); throws QueryUnavailableError when the server can't. */
  static async open<DB>(app: Kysely<DB>, schema: string, base: PgPoolConfig, opts: QueryIsolationOptions = {}): Promise<PgQueryIsolation> {
    const blocker = await isolationBlocker(app, schema, !opts.preprovisioned);
    if (blocker) throw new QueryUnavailableError(`query is unavailable on this Postgres store: ${blocker}`);
    const iso = new PgQueryIsolation(app as Kysely<unknown>, schema, base, opts);
    if (opts.preprovisioned) await iso.prepare().catch((e: Error) => opts.onUnavailable?.(e.message));
    else await ensureIsolation(app, schema, opts.setupLockTimeoutMs);
    return iso;
  }

  private roleFor(callerId: string): string {
    return this.opts.preprovisioned?.role ?? callerRole(this.schema, callerId);
  }

  /** Pre-provisioned: the roles exist, then the isolation DDL (which then creates no role). Retried until it succeeds. */
  private prepare(): Promise<void> {
    this.prepared ??= (async () => {
      const role = this.opts.preprovisioned!.role;
      if (!QUERY_USER.test(role)) throw unavailable(`the query login "${role.slice(0, 64)}" is not a plain role name (db.queryUser)`);
      const r = isolationRoles(this.schema);
      const names = [r.reader, r.raw, role, `${role}_raw`];
      const found = new Set((await sql<{ n: string }>`SELECT rolname AS n FROM pg_roles WHERE rolname IN (${sql.join(names)})`.execute(this.app)).rows.map((x) => x.n));
      const missing = names.find((n) => !found.has(n));
      if (missing) throw unavailable(`role ${missing} does not exist; re-run fleet-host bootstrap`);
      await ensureIsolation(this.app, this.schema, this.opts.setupLockTimeoutMs);
    })().catch((e) => {
      this.prepared = null;
      throw e;
    });
    return this.prepared;
  }

  async query(caller: QueryCaller, q: QueryArgs): Promise<unknown[]> {
    const role = this.roleFor(caller.callerId);
    const gen = this.generation(role);
    const n = this.pending.get(role) ?? 0;
    if (n > (this.opts.maxQueued ?? DEFAULT_MAX_QUEUED)) throw new Error(BUSY);
    this.pending.set(role, n + 1);
    let work: Promise<unknown[]> | undefined;
    let abandoned = false;
    let counted = true;
    const done = () => {
      if (!counted) return;
      counted = false;
      const left = (this.pending.get(role) ?? 1) - 1;
      if (left > 0) this.pending.set(role, left); else this.pending.delete(role);
    };
    try {
      const release = await this.lockFor(role)();
      try {
        this.checkGeneration(role, gen);
        const free = await this.slot();
        try {
          work = this.call(role, gen, caller.scope, q, Date.now() + this.callMs());
          return await this.deadline(work, () => { abandoned = true; });
        } finally {
          free();
        }
      } finally {
        // An abandoned call keeps the role lock until it settles, so the role's calls stay ordered.
        if (work && abandoned) void work.catch(() => undefined).finally(() => { release(); done(); });
        else { release(); done(); }
      }
    } catch (e) {
      if (!abandoned) done();
      throw e;
    }
  }

  private async call(role: string, gen: number, scope: ReadonlySet<string>, q: QueryArgs, deadlineAt: number): Promise<unknown[]> {
    await this.ensureRole(role, gen);
    await this.writeScope(role, gen, scope);
    try {
      return await this.runAs(role, q, deadlineAt);
    } catch (e) {
      // Another process re-provisioned the role (one process per schema is the supported mode).
      if ((e as { code?: string }).code !== INVALID_PASSWORD) throw e;
      this.ensured.delete(role);
      await this.ensureRole(role, gen);
      return await this.runAs(role, q, deadlineAt);
    }
  }

  private callMs(): number {
    return this.opts.callTimeoutMs ?? 2 * (this.opts.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS) + 10_000;
  }

  private deadline<T>(work: Promise<T>, onLate: () => void): Promise<T> {
    const ms = this.callMs();
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { onLate(); reject(new Error(`query did not finish within ${ms} ms`)); }, ms);
    });
    return Promise.race([work, late]).finally(() => clearTimeout(timer));
  }

  async forgetCaller(callerId: string): Promise<void> {
    // Bootstrap owns a pre-provisioned role, and every call rewrites its grants.
    if (this.opts.preprovisioned) return;
    const role = callerRole(this.schema, callerId);
    this.generations.set(role, this.generation(role) + 1);
    const release = await this.lockFor(role)();
    try {
      await this.pools.get(role)?.end();
      this.pools.delete(role);
      this.ensured.delete(role);
      await this.app.transaction().execute(async (trx) => {
        await sql`DELETE FROM mcp_grants WHERE role_name = ${role}`.execute(trx);
        await sql.raw(`DROP ROLE IF EXISTS ${role}`).execute(trx);
        await sql.raw(`DROP ROLE IF EXISTS ${role}_raw`).execute(trx);
      });
    } finally {
      release();
    }
  }

  async end(): Promise<void> {
    await Promise.all([...this.pools.values()].map((p) => p.end()));
    this.pools.clear();
  }

  private generation(role: string): number {
    return this.generations.get(role) ?? 0;
  }

  private checkGeneration(role: string, gen: number): void {
    if (this.generation(role) !== gen) throw new Error('the caller workspace was removed');
  }

  private lockFor(role: string): () => Promise<() => void> {
    let lock = this.locks.get(role);
    if (!lock) { lock = writeLock(); this.locks.set(role, lock); }
    return lock;
  }

  /** A global slot: at most maxConcurrent calls run, maxQueued wait, the rest are refused. */
  private async slot(): Promise<() => void> {
    const free = () => {
      const next = this.waiting.shift();
      if (next) next(); else this.active--;
    };
    if (this.active < (this.opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT)) {
      this.active++;
      return free;
    }
    if (this.waiting.length >= (this.opts.maxQueued ?? DEFAULT_MAX_QUEUED)) {
      throw new Error(BUSY);
    }
    await new Promise<void>((r) => this.waiting.push(r));
    return free;
  }

  /** The role exists, with a password minted for this process and never stored. */
  private ensureRole(role: string, gen: number): Promise<void> {
    const pre = this.opts.preprovisioned;
    if (pre) {
      return this.prepare().then(() => {
        if (this.pools.has(role)) return;
        const pool = new pg.Pool(rolePoolConfig(this.base, role, pre.password));
        pool.on('error', (e) => this.opts.onPoolError?.(e));
        this.pools.set(role, pool);
      });
    }
    let p = this.ensured.get(role);
    if (!p) {
      p = this.provision(role, gen);
      this.ensured.set(role, p);
      p.catch(() => this.ensured.delete(role));
    }
    return p;
  }

  private async provision(role: string, gen: number): Promise<void> {
    this.checkGeneration(role, gen);
    const r = isolationRoles(this.schema);
    const password = randomBytes(32).toString('base64url');
    await this.app.transaction().execute(async (trx) => {
      const run = (text: string) => sql.raw(text).execute(trx);
      await this.boundStorePool(trx);
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

  private async boundStorePool(trx: Kysely<unknown>): Promise<void> {
    await sql.raw(`SET LOCAL lock_timeout = ${this.opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS}`).execute(trx);
    await sql.raw(`SET LOCAL statement_timeout = ${this.opts.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS}`).execute(trx);
  }

  /** Rewritten on every call, so a revoked grant stops applying at once. */
  private async writeScope(role: string, gen: number, scope: ReadonlySet<string>): Promise<void> {
    this.checkGeneration(role, gen);
    await this.app.transaction().execute(async (trx) => {
      await this.boundStorePool(trx);
      if (this.opts.preprovisioned) await assertConfined(trx, role, this.schema);
      await sql`DELETE FROM mcp_grants WHERE role_name = ${role}`.execute(trx);
      const ids = [...scope];
      if (ids.length > 0) {
        await sql`INSERT INTO mcp_grants (role_name, workspace_id) VALUES ${sql.join(ids.map((w) => sql`(${role}, ${w})`))}`.execute(trx);
      }
    });
  }

  /** Runs `exec` on one pooled connection. On a client-level error or the call
   *  deadline it rejects, cancels the backend and destroys the connection. */
  private async runAs(role: string, q: QueryArgs, deadlineAt: number): Promise<unknown[]> {
    if (!Number.isSafeInteger(q.maxRows) || q.maxRows < 1) throw new Error('maxRows must be a positive integer');
    const pool = this.pools.get(role);
    if (!pool) throw new Error('caller role pool missing');
    let c: pg.PoolClient;
    try {
      c = await pool.connect();
    } catch (e) {
      if (!this.opts.preprovisioned) throw e;
      const code = (e as { code?: unknown }).code;
      const hint = code === '28P01' || code === '28000' ? ' (fleet-host bootstrap creates it; IAM must allow rds-db:connect for it)' : '';
      throw unavailable(`cannot log in as ${role}: ${String((e as Error).message).slice(0, MAX_ERROR_CHARS)}${hint}`);
    }
    if (!this.guarded.has(c)) {
      const stream = (c as unknown as { connection: { stream: NodeJS.ReadableStream & { destroy(e?: Error): void } } }).connection.stream;
      guardMessageSize(stream, this.opts.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES);
      this.guarded.add(c);
    }
    const callMs = this.callMs();
    let failure: Error | undefined;
    let fail!: (e: Error) => void;
    const failed = new Promise<never>((_, reject) => {
      fail = (e) => { failure ??= e; reject(e); };
    });
    failed.catch(() => undefined);
    c.on('error', fail);
    const timer = setTimeout(() => fail(new Error(`query did not finish within ${callMs} ms`)), Math.max(0, deadlineAt - Date.now()));
    try {
      return await Promise.race([this.exec(c, role, q, deadlineAt), failed]);
    } catch (e) {
      throw clipError(e);
    } finally {
      clearTimeout(timer);
      if (!failure) {
        // Session-level effects outlive a rollback (advisory locks, LISTEN).
        try { await Promise.race([c.query('DISCARD ALL'), failed]); } catch (e) { failure ??= e as Error; }
      }
      c.removeListener('error', fail);
      if (failure) {
        c.on('error', () => undefined);
        await this.stopBackend(c);
      }
      c.release(failure);
    }
  }

  /** Cancels the backend over a fresh connection (the protocol CancelRequest
   *  needs no privilege); if that can't be sent, tries pg_terminate_backend as the store role. */
  private async stopBackend(c: pg.PoolClient): Promise<void> {
    const { host, port, processID, secretKey } = c as unknown as { host: string; port: number; processID: number | null; secretKey: number | null };
    if (processID == null || secretKey == null) return;
    if (await sendCancel(host, port, processID, secretKey)) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      sql`SELECT pg_terminate_backend(${processID})`.execute(this.app),
      new Promise((r) => { timer = setTimeout(r, CANCEL_TIMEOUT_MS); }),
    ]).catch(() => undefined).finally(() => clearTimeout(timer));
  }

  /** Re-applied before every statement that runs the caller's SQL: set_config
   *  in one FETCH would otherwise lift the limits for the next. */
  private async bound(c: pg.PoolClient, deadlineAt: number): Promise<void> {
    const left = Math.max(1, deadlineAt - Date.now() + CANCEL_GRACE_MS);
    const statementMs = Math.min(this.opts.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS, left);
    const lockMs = Math.min(this.opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS, left);
    await c.query(`SET LOCAL statement_timeout = ${statementMs}; SET LOCAL lock_timeout = ${lockMs}`);
  }

  private async exec(c: pg.PoolClient, role: string, q: QueryArgs, deadlineAt: number): Promise<unknown[]> {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    try {
      if (q.includeRaw) await c.query(`SET LOCAL ROLE ${role}_raw`);
      await this.bound(c, deadlineAt);
      await c.query(`SET LOCAL search_path = ${this.schema}, public`);
      await c.query(`SET LOCAL TimeZone = 'UTC'`);
      // Temp views shadow the tables, so `SELECT * FROM events` works without raw_jsonl.
      await c.query(`CREATE TEMP VIEW events AS SELECT ${SNAPSHOT_EVENT_COLS}${q.includeRaw ? ', raw_jsonl' : ''} FROM ${this.schema}.events`);
      for (const t of MCP_QUERY_TABLES) {
        if (t !== 'events') await c.query(`CREATE TEMP VIEW ${t} AS SELECT * FROM ${this.schema}.${t}`);
      }
      await c.query('SET TRANSACTION READ ONLY');
      // Each row comes back as one JSON text, size-checked on the server. The
      // aliases are random so the caller's SQL can't close the subquery and
      // select around the checks. A cursor accepts only SELECT/VALUES/WITH (no
      // data-modifying WITH); the extended protocol refuses a second statement.
      const tag = randomBytes(12).toString('hex');
      const [qa, ra, ja] = [`q_${tag}`, `r_${tag}`, `j_${tag}`];
      const tooLarge = `${this.schema}.mcp_row_too_large`;
      const declare: pg.QueryConfig & { queryMode: 'extended' } = {
        text: `DECLARE mcp_q NO SCROLL CURSOR FOR
          SELECT CASE WHEN octet_length(${ra}.${ja}) > ${MAX_QUERY_BYTES} THEN ${tooLarge}(octet_length(${ra}.${ja}), ${MAX_QUERY_BYTES}) ELSE ${ra}.${ja} END AS j
          FROM (SELECT CASE WHEN pg_column_size(${qa}) > ${4 * MAX_QUERY_BYTES} THEN ${tooLarge}(pg_column_size(${qa}), ${4 * MAX_QUERY_BYTES})
                       ELSE row_to_json(${qa})::text END AS ${ja}
                FROM (\n${trimTail(q.sql)}\n) ${qa}) ${ra}`,
        values: q.params,
        queryMode: 'extended',
      };
      await c.query(declare);
      const rows: unknown[] = [];
      let bytes = 2;
      while (rows.length < q.maxRows) {
        const n = Math.min(FETCH_BATCH, q.maxRows - rows.length);
        await this.bound(c, deadlineAt);
        const batch = (await c.query<{ j: string }>(`FETCH FORWARD ${n} FROM mcp_q`)).rows;
        for (const { j } of batch) {
          bytes += Buffer.byteLength(j) + 1;
          if (bytes > MAX_QUERY_BYTES) {
            throw new Error(`result too large (over ${MAX_QUERY_BYTES} bytes); add LIMIT or aggregate server-side`);
          }
          rows.push(JSON.parse(j));
        }
        if (batch.length < n) break;
      }
      return rows;
    } finally {
      await c.query('ROLLBACK');
    }
  }
}

function unavailable(why: string): QueryUnavailableError {
  return new QueryUnavailableError(`query is unavailable on this Postgres store: ${why}`);
}

/** Every role a pre-provisioned login can reach (by INHERIT or SET) must be one bootstrap gave it, none elevated:
 *  through any other, such as the store role, its SQL could read past row-level security. */
async function assertConfined(k: Kysely<unknown>, role: string, schema: string): Promise<void> {
  const r = isolationRoles(schema);
  const ok = new Set([role, `${role}_raw`, r.reader, r.raw, 'rds_iam']);
  const reached = (await sql<{ n: string; elevated: boolean }>`
    WITH RECURSIVE up(oid) AS (
      SELECT oid FROM pg_roles WHERE rolname = ${role}
      UNION SELECT a.roleid FROM pg_auth_members a JOIN up ON a.member = up.oid)
    SELECT r.rolname AS n, r.rolsuper OR r.rolbypassrls OR r.rolreplication OR r.rolcreaterole OR r.rolcreatedb AS elevated
      FROM up JOIN pg_roles r ON r.oid = up.oid ORDER BY r.rolname COLLATE "C"`.execute(k)).rows;
  const stray = reached.find((x) => !ok.has(x.n));
  if (stray) throw unavailable(`role ${role} reaches role ${stray.n}; re-run fleet-host bootstrap to revoke it`);
  const high = reached.find((x) => x.elevated);
  if (high) throw unavailable(`role ${high.n} has SUPERUSER, BYPASSRLS, REPLICATION, CREATEROLE or CREATEDB`);
}

/** Sends a protocol CancelRequest for backend `pid`; resolves false when it couldn't be delivered. */
function sendCancel(host: string, port: number, pid: number, secret: number): Promise<boolean> {
  return new Promise((resolve) => {
    let sent = false;
    let settled = false;
    const s = host.startsWith('/') ? netConnect(`${host}/.s.PGSQL.${port}`) : netConnect(port, host);
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      s.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => done(sent), CANCEL_TIMEOUT_MS);
    s.on('error', () => done(false));
    s.on('connect', () => {
      const msg = Buffer.alloc(16);
      msg.writeInt32BE(16, 0);
      msg.writeInt32BE(80877102, 4);
      msg.writeInt32BE(pid, 8);
      msg.writeInt32BE(secret, 12);
      s.end(msg, () => { sent = true; });
    });
    // The server closes the connection once it has acted on the request.
    s.on('close', () => done(sent));
  });
}
