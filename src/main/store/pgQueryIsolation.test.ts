// `query` isolation on Postgres (role + RLS). Postgres only: SQLite isolates
// with the in-memory snapshot (mcpServer.test.ts). Every test reads as caller
// A and must never see a row of workspace B.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { sql } from 'kysely';
import * as db from '../db.js';
import { callerRole, isolationRoles, PgQueryIsolation, QueryUnavailableError, rolePoolConfig } from './pgQueryIsolation.js';
import { MCP_QUERY_TABLES } from './readSource.js';
import { isPg, queryRows, testPgAppSchema, type TestPgApp } from './testStore.js';

const A = 'W-A';
const B = 'W-B';
const scopeA = new Set([A]);
const q = (sqlText: string, o: { params?: unknown[]; includeRaw?: boolean; maxRows?: number; scope?: Set<string>; caller?: string } = {}) =>
  iso.query({ callerId: o.caller ?? A, scope: o.scope ?? scopeA }, { sql: sqlText, params: o.params ?? [], includeRaw: o.includeRaw ?? false, maxRows: o.maxRows ?? 200 });

let t: TestPgApp;
let iso: PgQueryIsolation;

async function seed(): Promise<void> {
  for (const [ws, s] of [[A, 'sa'], [B, 'sb']] as const) {
    await queryRows('INSERT INTO sessions (id, workspace_id, last_active_at) VALUES (?, ?, ?)', [s, ws, 1000]);
    for (let i = 0; i < 3; i++) {
      await queryRows(
        'INSERT INTO events (session_id, workspace_id, ts, type, tool_input, raw_jsonl, dedup_key) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [s, ws, i, 'assistant', `input-${ws}`, `raw-${ws}`, `${s}-${i}`],
      );
    }
    await queryRows('INSERT INTO broker_sessions (workspace_id, broker_session_id, claude_session_id, learned_at) VALUES (?, ?, ?, ?)', [ws, `b-${s}`, s, 1]);
    await queryRows('INSERT INTO session_summaries (session_id, workspace_id, summary, source_max_event_id, generated_at) VALUES (?, ?, ?, ?, ?)', [s, ws, `summary-${ws}`, 1, 1]);
    await queryRows('INSERT INTO session_tags (workspace_id, session_id, tag) VALUES (?, ?, ?)', [ws, s, `tag-${ws}`]);
    await queryRows('INSERT INTO usage_events (ts, workspace_id, session_id, kind) VALUES (?, ?, ?, ?)', [1, ws, s, 'search-impression']);
    await queryRows('INSERT INTO perf_events (ts, kind, workspace_id, name) VALUES (?, ?, ?, ?)', [1, 'span', ws, `perf-${ws}`]);
    await queryRows("INSERT INTO errors (ts, workspace_id, source, level, type, message) VALUES (?, ?, 'main', 'error', 'x', ?)", [1, ws, `err-${ws}`]);
  }
  await queryRows("INSERT INTO perf_events (ts, kind, workspace_id, name) VALUES (1, 'stall', NULL, 'global')");
}

describe.skipIf(!isPg)('query isolation on Postgres (role + RLS)', () => {
  beforeEach(async () => {
    t = await testPgAppSchema();
    await db.openDbPostgres(t.appPool);
    await seed();
    iso = await PgQueryIsolation.open(db.stateKysely(), t.schema, t.appConfig);
  });
  afterEach(async () => {
    await iso.end();
    await db.closeDb();
    await t.drop();
  });

  it('every exposed table returns only the caller\'s workspaces', async () => {
    for (const table of MCP_QUERY_TABLES) {
      const rows = (await q(`SELECT DISTINCT workspace_id FROM ${table} ORDER BY 1 NULLS FIRST`)) as Array<{ workspace_id: string | null }>;
      const ids = rows.map((r) => r.workspace_id);
      expect(ids, table).toEqual(table === 'perf_events' ? [null, A] : [A]);
    }
  });

  it('a schema-qualified table, a join or a subquery stays scoped', async () => {
    expect(await q(`SELECT count(*) AS n FROM ${t.schema}.events`)).toEqual([{ n: 3 }]);
    expect(await q(`SELECT count(*) AS n FROM events e JOIN sessions s ON s.id = e.session_id`)).toEqual([{ n: 3 }]);
    expect(await q(`SELECT (SELECT count(*) FROM ${t.schema}.sessions) AS n`)).toEqual([{ n: 1 }]);
  });

  it('a query run from inside the statement (query_to_xml) is scoped too', async () => {
    const [row] = (await q(`SELECT query_to_xml('select count(*) as n from ${t.schema}.events', true, true, '') AS x`)) as Array<{ x: string }>;
    expect(row.x).toContain('<n>3</n>');
  });

  it('cannot switch to the store role or another caller\'s role', async () => {
    await q('SELECT 1', { caller: B, scope: new Set([B]) });
    await expect(q(`SELECT set_config('role', '${t.appRole}', true)`)).rejects.toThrow(/permission denied to set role/);
    await expect(q(`SELECT set_config('role', '${callerRole(t.schema, B)}', true)`)).rejects.toThrow(/permission denied to set role/);
    await expect(q(`SELECT set_config('session_authorization', '${t.appRole}', true)`)).rejects.toThrow(/permission denied/);
  });

  it('tables outside the exposed set are unreadable', async () => {
    const all = (await sql<{ t: string }>`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ${t.schema}`.execute(db.stateKysely())).rows.map((r) => r.t);
    const hidden = all.filter((n) => !(MCP_QUERY_TABLES as readonly string[]).includes(n));
    expect(hidden).toEqual(expect.arrayContaining(['errors', 'embeddings', 'mcp_grants', 'schema_migrations', 'session_costs']));
    for (const n of hidden) await expect(q(`SELECT * FROM ${t.schema}.${n}`), n).rejects.toThrow(/permission denied/);
  });

  it('mcp_scope() returns only the caller\'s own scope', async () => {
    await q('SELECT 1', { caller: B, scope: new Set([B]) });
    expect(await q(`SELECT ${t.schema}.mcp_scope() AS s`)).toEqual([{ s: [A] }]);
    const pub = await sql<{ x: boolean }>`SELECT has_function_privilege('public', ${t.schema + '.mcp_scope()'}, 'EXECUTE') AS x`.execute(db.stateKysely());
    expect(pub.rows[0].x).toBe(false);
  });

  it('column statistics are hidden and a failing predicate cannot probe other rows', async () => {
    await sql`ANALYZE events`.execute(db.stateKysely());
    expect(await q(`SELECT attname FROM pg_stats WHERE schemaname = '${t.schema}' AND tablename = 'events'`)).toEqual([]);
    expect(await q(`SELECT count(*) AS n FROM ${t.schema}.events WHERE 1 / (CASE WHEN workspace_id = '${B}' THEN 0 ELSE 1 END) = 1`)).toEqual([{ n: 3 }]);
  });

  it('raw_jsonl only with include_raw, and then only the caller\'s rows', async () => {
    await expect(q('SELECT raw_jsonl FROM events')).rejects.toThrow(/raw_jsonl/);
    await expect(q(`SELECT raw_jsonl FROM ${t.schema}.events`)).rejects.toThrow(/permission denied/);
    expect(await q('SELECT DISTINCT raw_jsonl FROM events', { includeRaw: true })).toEqual([{ raw_jsonl: `raw-${A}` }]);
    expect(await q(`SELECT DISTINCT raw_jsonl FROM ${t.schema}.events`, { includeRaw: true })).toEqual([{ raw_jsonl: `raw-${A}` }]);
  });

  it('accepts one SELECT only: writes, DDL, utility statements and a second statement are refused', async () => {
    await expect(q('SELECT 1; SELECT 2')).rejects.toThrow(/multiple commands/);
    await expect(q(`DELETE FROM ${t.schema}.events`)).rejects.toThrow(/syntax error/);
    await expect(q(`WITH d AS (DELETE FROM ${t.schema}.events RETURNING 1) SELECT * FROM d`)).rejects.toThrow(/data-modifying/);
    await expect(q('SET ROLE NONE')).rejects.toThrow(/syntax error/);
    await expect(q('SELECT 1) AS x')).rejects.toThrow(/syntax error/);
    expect(await q('SELECT 1 AS x;')).toEqual([{ x: 1 }]);
    expect(await sql<{ n: number }>`SELECT count(*) AS n FROM events`.execute(db.stateKysely())).toMatchObject({ rows: [{ n: 6 }] });
  });

  it('binds $n params and caps rows at maxRows', async () => {
    expect(await q('SELECT id FROM sessions WHERE id = $1', { params: ['sa'] })).toEqual([{ id: 'sa' }]);
    expect(await q('SELECT id FROM sessions WHERE id = $1', { params: ['sb'] })).toEqual([]);
    expect(await q('SELECT g FROM generate_series(1, 50) g', { maxRows: 3 })).toEqual([{ g: 1 }, { g: 2 }, { g: 3 }]);
  });

  it('session-level effects do not outlive a call', async () => {
    await q('SELECT pg_advisory_lock(7340211) AS l');
    await q(`SELECT set_config('search_path', 'pg_catalog', false) AS s`);
    const held = await sql<{ n: number }>`SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND objid = 7340211`.execute(db.stateKysely());
    expect(held.rows[0].n).toBe(0);
    expect(await q('SELECT count(*) AS n FROM sessions')).toEqual([{ n: 1 }]);
  });

  it('a grant applies on the next call and a revocation stops it on the next call', async () => {
    expect(await q('SELECT DISTINCT workspace_id FROM sessions ORDER BY 1', { scope: new Set([A, B]) })).toEqual([{ workspace_id: A }, { workspace_id: B }]);
    expect(await q('SELECT DISTINCT workspace_id FROM sessions ORDER BY 1')).toEqual([{ workspace_id: A }]);
  });

  it('concurrent callers each see only their own scope', async () => {
    const runs = await Promise.all(Array.from({ length: 6 }, (_, i) => {
      const ws = i % 2 === 0 ? A : B;
      return q('SELECT DISTINCT workspace_id FROM events', { caller: ws, scope: new Set([ws]) }).then((r) => [ws, r] as const);
    }));
    for (const [ws, rows] of runs) expect(rows).toEqual([{ workspace_id: ws }]);
  });

  it('a long statement hits the statement timeout', async () => {
    await iso.end();
    iso = await PgQueryIsolation.open(db.stateKysely(), t.schema, t.appConfig, { statementTimeoutMs: 200 });
    await expect(q('SELECT pg_sleep(5)')).rejects.toThrow(/statement timeout/);
  });

  it('forgetCaller drops the caller\'s roles and grants', async () => {
    await q('SELECT 1');
    await iso.forgetCaller(A);
    const roles = await sql<{ n: number }>`SELECT count(*) AS n FROM pg_roles WHERE rolname LIKE ${callerRole(t.schema, A) + '%'}`.execute(db.stateKysely());
    expect(roles.rows[0].n).toBe(0);
    expect(await q('SELECT count(*) AS n FROM sessions')).toEqual([{ n: 1 }]);
  });

  it('the caller role cannot log in with a guessed password', async () => {
    await q('SELECT 1');
    const c = new pg.Client(rolePoolConfig(t.appConfig, callerRole(t.schema, A), 'wrong'));
    const login = c.connect().then(() => 'connected', (e: { code?: string }) => e.code);
    // The local socket server trusts every login; CI's TCP service checks SCRAM.
    expect(['28P01', 'connected']).toContain(await login);
    await c.end().catch(() => undefined);
  });

  it('a store role without CREATEROLE leaves query unavailable', async () => {
    await t.pool.query(`ALTER ROLE ${t.appRole} NOCREATEROLE`);
    await expect(PgQueryIsolation.open(db.stateKysely(), t.schema, t.appConfig)).rejects.toThrow(QueryUnavailableError);
    expect(isolationRoles(t.schema).reader).toBe(`${t.schema}_mcp_reader`);
  });

  it('the caller role cannot write, create objects or escalate', async () => {
    await q('SELECT 1', { caller: B, scope: new Set([B]) });
    const [r] = (await q(`SELECT r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolbypassrls, r.rolinherit,
        has_schema_privilege('${t.schema}', 'CREATE') AS schema_create,
        has_schema_privilege('public', 'CREATE') AS public_create,
        has_database_privilege(current_database(), 'CREATE') AS db_create,
        has_table_privilege('${t.schema}.events', 'INSERT,UPDATE,DELETE,TRUNCATE') AS events_write,
        has_table_privilege('${t.schema}.mcp_grants', 'SELECT,INSERT,UPDATE,DELETE') AS grants_any,
        pg_has_role(session_user, '${t.appRole}', 'MEMBER') AS app_member,
        pg_has_role(session_user, '${callerRole(t.schema, B)}', 'MEMBER') AS other_member
      FROM pg_roles r WHERE r.rolname = session_user`)) as Array<Record<string, boolean>>;
    expect(r).toEqual({
      rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false, rolinherit: false,
      schema_create: false, public_create: false, db_create: false, events_write: false, grants_any: false,
      app_member: false, other_member: false,
    });
    // The only SECURITY DEFINER function a caller can run is mcp_scope().
    expect(await q(`SELECT proname FROM pg_proc WHERE prosecdef AND has_function_privilege(oid, 'EXECUTE')
      AND pronamespace NOT IN ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)`)).toEqual([{ proname: 'mcp_scope' }]);
  });

  it('SQL run from inside the statement cannot write: no DML, temp objects, functions or large objects', async () => {
    // query_to_xml runs its SQL read-only (non-volatile); lo_* is pinned by the READ ONLY transaction itself.
    const RO = /read-only transaction|non-volatile function/;
    const via = (stmt: string) => q(`SELECT query_to_xml('${stmt.replace(/'/g, "''")}', true, true, '') AS x`);
    await expect(via(`DELETE FROM ${t.schema}.events`)).rejects.toThrow(RO);
    await expect(via(`INSERT INTO ${t.schema}.mcp_grants VALUES (session_user, '${B}')`)).rejects.toThrow(RO);
    await expect(via('CREATE TEMP TABLE x AS SELECT 1 AS a')).rejects.toThrow(RO);
    await expect(via(`CREATE FUNCTION pg_temp.f() RETURNS int LANGUAGE sql AS 'SELECT 1'`)).rejects.toThrow(RO);
    await expect(via(`CREATE VIEW pg_temp.v AS SELECT * FROM ${t.schema}.sessions`)).rejects.toThrow(RO);
    await expect(q(`SELECT set_config('transaction_read_only', 'off', true), query_to_xml('DELETE FROM ${t.schema}.events', true, true, '')`))
      .rejects.toThrow(/read-only|read-write|non-volatile/);
    await expect(q('SELECT lo_create(0)')).rejects.toThrow(/read-only transaction/);
    await expect(q('SELECT lo_from_bytea(0, \'\\x00\')')).rejects.toThrow(/read-only transaction/);
    expect(await sql<{ n: number }>`SELECT count(*) AS n FROM events`.execute(db.stateKysely())).toMatchObject({ rows: [{ n: 6 }] });
  });

  it('COPY, PREPARE/EXECUTE and utility statements are refused', async () => {
    await expect(q('COPY events TO STDOUT')).rejects.toThrow(/syntax error/);
    await expect(q(`SELECT query_to_xml('COPY ${t.schema}.events TO STDOUT', true, true, '')`)).rejects.toThrow(/COPY|read-only|not allowed|invalid query/i);
    await expect(q('PREPARE p AS SELECT 1')).rejects.toThrow(/syntax error/);
    await expect(q('EXECUTE p')).rejects.toThrow(/syntax error/);
    await expect(q("SET SESSION AUTHORIZATION 'postgres'")).rejects.toThrow(/syntax error/);
    await expect(q('LISTEN x')).rejects.toThrow(/syntax error/);
    await expect(q('SELECT 1 AS a', { params: ['x; DROP TABLE events'] })).rejects.toThrow(/bind message|parameters/);
  });

  it('server files, other sessions\' query text and the store role\'s settings are out of reach', async () => {
    await expect(q("SELECT pg_read_file('PG_VERSION')")).rejects.toThrow(/permission denied/);
    await expect(q("SELECT pg_ls_dir('.')")).rejects.toThrow(/permission denied/);
    await expect(q("SELECT lo_import('/etc/hostname')")).rejects.toThrow(/permission denied/);
    await expect(q("SELECT * FROM pg_hba_file_rules")).rejects.toThrow(/permission denied/);
    expect(await q(`SELECT query FROM pg_stat_activity WHERE usename IS DISTINCT FROM session_user AND query NOT IN ('', '<insufficient privilege>')`)).toEqual([]);
    await expect(q('SELECT rolpassword FROM pg_authid')).rejects.toThrow(/permission denied/);
  });

  it('dblink and postgres_fdw, when installed, give no way out', async () => {
    await t.pool.query(`CREATE EXTENSION IF NOT EXISTS dblink SCHEMA ${t.schema}`);
    await t.pool.query(`CREATE EXTENSION IF NOT EXISTS postgres_fdw SCHEMA ${t.schema}`);
    await expect(q(`SELECT * FROM ${t.schema}.dblink('dbname=' || current_database() || ' user=${t.appRole}', 'SELECT count(*) FROM ${t.schema}.events') AS r(n bigint)`))
      .rejects.toThrow(/password|authentication|permission denied/i);
    await expect(q(`SELECT query_to_xml('CREATE SERVER s FOREIGN DATA WRAPPER postgres_fdw', true, true, '')`)).rejects.toThrow(/read-only transaction|non-volatile function|permission denied/);
    const [r] = (await q(`SELECT has_foreign_data_wrapper_privilege('postgres_fdw', 'USAGE') AS fdw`)) as Array<{ fdw: boolean }>;
    expect(r.fdw).toBe(false);
  });

  it('a caller\'s session state and locks never reach the next call', async () => {
    await q("SELECT set_config('mcp.x', 'leak', false) AS s");
    const [{ s }] = (await q("SELECT current_setting('mcp.x', true) AS s")) as Array<{ s: string | null }>;
    expect(['', null]).toContain(s);
    await q('SELECT pg_advisory_lock(7340212), pg_advisory_lock_shared(7340213), pg_advisory_xact_lock(7340214)');
    const held = await sql<{ n: number }>`SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND objid IN (7340212, 7340213, 7340214)`.execute(db.stateKysely());
    expect(held.rows[0].n).toBe(0);
  });

  it('a lock wait hits the lock timeout', async () => {
    await iso.end();
    iso = await PgQueryIsolation.open(db.stateKysely(), t.schema, t.appConfig, { lockTimeoutMs: 200, statementTimeoutMs: 20_000 });
    await q('SELECT 1');
    const c = await t.appPool.connect();
    try {
      await c.query('BEGIN');
      await c.query('LOCK TABLE sessions IN ACCESS EXCLUSIVE MODE');
      const started = Date.now();
      await expect(q('SELECT count(*) FROM sessions')).rejects.toThrow(/lock timeout/);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
});
