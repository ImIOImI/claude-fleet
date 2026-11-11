// `query` on the host MCP (D71): bootstrap pre-provisions the isolation roles and the `<app>_query` login; the app
// role stays NOCREATEROLE. CI's Postgres has no rds_iam, so the query login gets a password here (test only).
import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { parse as parseConnectionString } from 'pg-connection-string';
import { openDbPostgres, closeDb, stateKysely } from '../main/db.js';
import { migratePostgres } from '../main/store/pgMigrate.js';
import { migratePgStores } from '../main/store/pgStores.js';
import { postgresKysely } from '../main/store/postgres.js';
import { openPgMcpReadSource } from '../main/store/pgReadSource.js';
import { scramVerifier } from '../main/store/scram.js';
import { isPg, testPgAppSchema, type TestPgApp } from '../main/store/testStore.js';
import { bootstrap } from './bootstrap.js';
import { startHostMcp, type HostMcp } from './hostMcp.js';
import { HOST_TRACK } from './hostSchema.js';
import { createLogger } from './log.js';

const HOSTED = '01JC0000000000000000000000';
const OTHER = '01JC0000000000000000000001';
const quiet = { log: createLogger(() => undefined) };

async function call(sock: string, line: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const c = connect(sock);
    let buf = '';
    c.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl >= 0) { c.end(); resolve(JSON.parse(buf.slice(0, nl))); }
    });
    c.on('error', reject);
    c.write(JSON.stringify(line) + '\n');
  });
}

let nextId = 1;
const tool = async (sock: string, name: string, args: object) =>
  (await call(sock, { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } })).result as { content: { text: string }[]; isError?: boolean };
const query = (sock: string, sql: string) => tool(sock, 'query', { sql });
const rowsOf = (r: { content: { text: string }[]; isError?: boolean }) => {
  expect(r.isError).toBeUndefined();
  return JSON.parse(r.content[0].text);
};

describe.skipIf(!isPg)('host MCP query', () => {
  let t: TestPgApp | null = null;
  let mcp: HostMcp | null = null;
  let su: pg.Client | null = null;
  afterEach(async () => {
    // Each step is independent: a failure closing the MCP server or the raw client must not
    // skip t.drop(), which is what actually removes the test's roles.
    const steps: (() => Promise<unknown>)[] = [
      () => mcp?.close() ?? Promise.resolve(),
      () => closeDb(),
      () => su?.end() ?? Promise.resolve(),
      () => t?.drop() ?? Promise.resolve()
    ];
    for (const step of steps) {
      try {
        await step();
      } catch (e) {
        console.warn(`pg test cleanup failed: ${(e as Error).message}`);
      }
    }
    mcp = null;
    su = null;
    t = null;
  });

  /** A store bootstrapped as on a host (as the superuser, standing in for the RDS master), with another workspace's rows. */
  async function rig(o: { bootstrap?: boolean } = {}) {
    t = await testPgAppSchema();
    const url = parseConnectionString(process.env.PG_TEST_URL as string);
    const queryUser = `${t.appRole}_query`;
    su = new pg.Client({ connectionString: process.env.PG_TEST_URL });
    await su.connect();
    if (o.bootstrap !== false) {
      await bootstrap({
        host: url.host as string, port: Number(url.port || 5432), database: url.database as string, user: t.appRole, queryUser,
        schema: t.schema, ssl: false, iam: false, appPassword: null
      }, { user: url.user || 'postgres', password: url.password || 'trust', secrets: [] }, quiet);
    }
    expect((await su.query('SELECT rolcreaterole FROM pg_roles WHERE rolname = $1', [t.appRole])).rows[0].rolcreaterole).toBe(o.bootstrap === false);
    await migratePgStores(t.appPool, { state: true });
    await openDbPostgres(t.appPool, { migrate: false });
    await stateKysely().insertInto('sessions').values([
      { id: 'h1', workspace_id: HOSTED, cwd: null, started_at: 1, last_active_at: 2, ai_title: null, first_user_message: 'mine', user_set_name: null },
      { id: 'o1', workspace_id: OTHER, cwd: null, started_at: 1, last_active_at: 2, ai_title: null, first_user_message: 'theirs', user_set_name: null },
    ]).execute();
    const pw = randomBytes(18).toString('base64url');
    if (o.bootstrap !== false) await su.query(`ALTER ROLE ${pg.escapeIdentifier(queryUser)} PASSWORD ${pg.escapeLiteral(scramVerifier(pw))}`);
    return { queryUser, pw };
  }

  async function serve(role: string, password: () => Promise<string>, logs: string[] = [], scope?: () => Promise<readonly string[]>): Promise<string> {
    const rs = await openPgMcpReadSource(t!.schema, t!.appConfig, (m) => logs.push(m), { preprovisioned: { role, password } });
    expect(rs.queryFlavor).toBe('postgres');
    const socketPath = join(mkdtempSync(join(tmpdir(), 'hq-')), 'mcp', 'mcp.sock');
    mcp = await startHostMcp({ listen: { path: socketPath }, workspaceId: HOSTED, readSource: rs, log: createLogger(() => undefined), scope });
    return socketPath;
  }

  it('sees only the hosted workspace, under RLS, as the pre-provisioned login', async () => {
    const { queryUser, pw } = await rig();
    const sock = await serve(queryUser, async () => pw);
    expect(rowsOf(await query(sock, 'SELECT id FROM sessions ORDER BY id'))).toEqual([{ id: 'h1' }]);
    expect(rowsOf(await query(sock, `SELECT count(*)::int AS n FROM sessions WHERE workspace_id = '${OTHER}'`))).toEqual([{ n: 0 }]);
    expect(rowsOf(await query(sock, 'SELECT session_user AS s'))).toEqual([{ s: queryUser }]);
    const mine = await su!.query(`SELECT workspace_id FROM ${t!.schema}.mcp_grants WHERE role_name = $1`, [queryUser]);
    expect(mine.rows).toEqual([{ workspace_id: HOSTED }]);
  });

  it('query sees published partitions too, and never the publish or owner bookkeeping tables', async () => {
    const { queryUser, pw } = await rig();
    await migratePostgres(postgresKysely(t!.appPool), t!.schema, HOST_TRACK);
    await stateKysely().insertInto('sessions').values([
      { id: 'p1', workspace_id: 'pub_aaaa', cwd: null, started_at: 1, last_active_at: 2, ai_title: null, first_user_message: 'published', user_set_name: null },
      { id: 'p2', workspace_id: 'pub_bbbb', cwd: null, started_at: 1, last_active_at: 2, ai_title: null, first_user_message: 'not in scope', user_set_name: null }
    ]).execute();
    await su!.query(`INSERT INTO ${t!.schema}.publish_partitions (partition_id, owner_provider, owner_id, owner_login, source_workspace_id, created_at)
      VALUES ('pub_aaaa', 'github', '7', 'ann', '01JC0000000000000000000005', 1)`);
    const sock = await serve(queryUser, async () => pw, [], async () => ['pub_aaaa']);
    expect(rowsOf(await query(sock, 'SELECT id FROM sessions ORDER BY id'))).toEqual([{ id: 'h1' }, { id: 'p1' }]);
    expect(rowsOf(await query(sock, `SELECT count(*)::int AS n FROM sessions WHERE workspace_id = '${OTHER}'`))).toEqual([{ n: 0 }]);
    const grants = await su!.query(`SELECT workspace_id FROM ${t!.schema}.mcp_grants WHERE role_name = $1 ORDER BY workspace_id`, [queryUser]);
    expect(grants.rows).toEqual([{ workspace_id: HOSTED }, { workspace_id: 'pub_aaaa' }]);
    for (const table of ['publish_partitions', 'publish_sessions', 'session_owners']) {
      const r = await query(sock, `SELECT * FROM ${table}`);
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/permission denied/);
    }
  });

  it('cannot reach the app role from the query login', async () => {
    const { queryUser, pw } = await rig();
    const sock = await serve(queryUser, async () => pw);
    const r = await query(sock, `SELECT set_config('role', '${t!.appRole}', true) AS r`);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/permission denied to set role/);
  });

  it('a query login that is a member of the store role is refused, and recovers once the grant is gone', async () => {
    const { queryUser, pw } = await rig();
    const sock = await serve(queryUser, async () => pw);
    await su!.query(`GRANT ${pg.escapeIdentifier(t!.appRole)} TO ${pg.escapeIdentifier(`${queryUser}_raw`)}`);
    const r = await query(sock, 'SELECT id FROM sessions');
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(new RegExp(`query is unavailable on this Postgres store: role ${queryUser} reaches role ${t!.appRole}`));
    await su!.query(`REVOKE ${pg.escapeIdentifier(t!.appRole)} FROM ${pg.escapeIdentifier(`${queryUser}_raw`)}`);
    expect(rowsOf(await query(sock, 'SELECT id FROM sessions'))).toEqual([{ id: 'h1' }]);
  });

  it('a missing query role answers unavailable; the other tools still work and nothing is created', async () => {
    await rig({ bootstrap: false });
    await su!.query(`ALTER ROLE ${pg.escapeIdentifier(t!.appRole)} NOCREATEROLE`);
    const logs: string[] = [];
    const sock = await serve(`${t!.appRole}_query`, async () => 'unused', logs);
    const r = await query(sock, 'SELECT 1');
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/query is unavailable on this Postgres store: role \S+ does not exist; re-run fleet-host bootstrap/);
    expect(logs.join('\n')).toMatch(/does not exist/);
    expect(rowsOf(await tool(sock, 'list_sessions', {})).map((s: { id: string }) => s.id)).toEqual(['h1']);
    const made = await su!.query(`SELECT rolname FROM pg_roles WHERE rolname LIKE $1`, [`${t!.schema}\\_mcp\\_%`]);
    expect(made.rows).toEqual([]);
  });

  it('a refused login answers unavailable, and works once the server lets it in', async () => {
    const { queryUser, pw } = await rig();
    const sock = await serve(queryUser, async () => pw);
    await su!.query(`ALTER ROLE ${pg.escapeIdentifier(queryUser)} NOLOGIN`);
    const r = await query(sock, 'SELECT id FROM sessions');
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(new RegExp(`query is unavailable on this Postgres store: cannot log in as ${queryUser}: .*not permitted to log in.*rds-db:connect`));
    expect(rowsOf(await tool(sock, 'list_sessions', {})).map((s: { id: string }) => s.id)).toEqual(['h1']);
    await su!.query(`ALTER ROLE ${pg.escapeIdentifier(queryUser)} LOGIN`);
    expect(rowsOf(await query(sock, 'SELECT id FROM sessions'))).toEqual([{ id: 'h1' }]);
  });

  it('a password provider that fails (no rds-db:connect yet) answers unavailable', async () => {
    const { queryUser, pw } = await rig();
    // Trust auth never asks for the password.
    if (!(await passwordsChecked())) return;
    let allowed = false;
    const sock = await serve(queryUser, async () => {
      if (!allowed) throw new Error('not authorized to perform: rds-db:connect');
      return pw;
    });
    const r = await query(sock, 'SELECT id FROM sessions');
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(new RegExp(`query is unavailable on this Postgres store: cannot log in as ${queryUser}: not authorized to perform: rds-db:connect`));
    allowed = true;
    expect(rowsOf(await query(sock, 'SELECT id FROM sessions'))).toEqual([{ id: 'h1' }]);
  });
});

async function passwordsChecked(): Promise<boolean> {
  const url = parseConnectionString(process.env.PG_TEST_URL as string);
  const c = new pg.Client({ connectionString: process.env.PG_TEST_URL, password: `${url.password ?? ''}-wrong` });
  try {
    await c.connect();
    await c.end();
    return false;
  } catch {
    return true;
  }
}
