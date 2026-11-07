// fleet-host bootstrap against a real server. The test superuser stands in for the RDS master; every test makes its
// own database and roles and drops them after.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { connect, createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { parse as parseConnectionString } from 'pg-connection-string';
import * as db from '../main/db.js';
import { IdentityError } from '../main/identity/types.js';
import { isPg } from '../main/store/testStore.js';
import type { AdminCredential } from './adminCreds.js';
import { bootstrap, type BootstrapTarget } from './bootstrap.js';
import { runDbCommand } from './dbCli.js';
import { createLogger } from './log.js';
import { runHost } from './main.js';
import { scramVerifier } from './scram.js';
import { fakeBroker, person, TOKEN } from './testFakes.js';

const url = isPg ? parseConnectionString(process.env.PG_TEST_URL as string) : null;
const HOST = url?.host ?? '';
const PORT = Number(url?.port || 5432);
const SUPER = url?.user || 'postgres';
const SUPER_PW = url?.password || 'trust-auth-ignores-this';
const id = pg.escapeIdentifier;

async function client(user: string, password: string, database = 'postgres'): Promise<pg.Client> {
  const c = new pg.Client({ host: HOST, port: PORT, user, password, database });
  await c.connect();
  return c;
}
async function su<T>(fn: (c: pg.Client) => Promise<T>, database = 'postgres'): Promise<T> {
  const c = await client(SUPER, SUPER_PW, database);
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  // Each cleanup is independent: one failing (a role another test's crashed cleanup never got
  // to drop, say) must not skip the rest, here or in a later test's afterEach.
  for (const f of cleanups.splice(0).reverse()) {
    try {
      await f();
    } catch (e) {
      console.warn(`pg test cleanup failed: ${(e as Error).message}`);
    }
  }
});

/** A statement that can't throw: logs and moves on. A couple of retries absorb the ordinary
 *  race where a just-`shutdown()` host's pool is still disconnecting server-side (DROP DATABASE
 *  ... WITH (FORCE) forces it, but a role that still looks referenced can need a moment to clear);
 *  anything left after that (e.g. a role orphaned by an earlier run's own failed cleanup, still
 *  owning things in a database this run doesn't know about) is logged, never thrown, so it can't
 *  cascade into the rest of this cleanup or the next test's. */
async function dropStatement(c: pg.Client, sql: string, attempts = 5): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      await c.query(sql);
      return;
    } catch (e) {
      if (i === attempts) {
        console.warn(`pg test cleanup: ${sql} failed after ${attempts} attempts: ${(e as Error).message}`);
        return;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

function names() {
  const s = randomBytes(4).toString('hex');
  const n = { db: `fb_${s}`, schema: `fs_${s}`, app: `fb_app_${s}`, query: `fb_app_${s}_query`, admin: `fb_admin_${s}`, appPw: `app-${randomBytes(9).toString('hex')}` };
  cleanups.push(() =>
    su(async (c) => {
      // Ordered: the database (FORCE'd) goes first so nothing below still owns anything in it;
      // every role drop after that is independent of the others.
      await dropStatement(c, `DROP DATABASE IF EXISTS ${id(n.db)} WITH (FORCE)`);
      for (const r of [`${n.query}_raw`, n.query, `${n.schema}_mcp_reader`, `${n.schema}_mcp_raw`, ...CLI_SHARED_ROLES, n.app, n.admin]) {
        await dropStatement(c, `DROP ROLE IF EXISTS ${id(r)}`);
      }
    })
  );
  return n;
}

// The isolation roles are cluster-wide and named by schema: each test has its own schema, but the CLI's is fixed.
const CLI_SHARED_ROLES = ['fb_store_mcp_reader', 'fb_store_mcp_raw'];
const QUERY_CREATED = (n: ReturnType<typeof names>, schema = n.schema) => [
  `created role ${schema}_mcp_reader (NOLOGIN)`,
  `created role ${schema}_mcp_raw (NOLOGIN)`,
  `created role ${n.query} (LOGIN NOINHERIT CONNECTION LIMIT 4, no password)`,
  `created role ${n.query}_raw (NOLOGIN)`,
  `granted ${schema}_mcp_reader to ${n.query} (INHERIT TRUE, SET TRUE)`,
  `granted ${schema}_mcp_reader to ${n.query}_raw (INHERIT TRUE, SET TRUE)`,
  `granted ${schema}_mcp_raw to ${n.query}_raw (INHERIT TRUE, SET TRUE)`,
  `granted ${n.query}_raw to ${n.query} (INHERIT FALSE, SET TRUE)`
];

/** Direct memberships among the query roles and the app role: `role>member:inherit:set`. */
async function edges(n: ReturnType<typeof names>): Promise<string[]> {
  return su(async (c) => (await c.query(
    `SELECT r.rolname || '>' || m.rolname || ':' || a.inherit_option || ':' || a.set_option AS e
       FROM pg_auth_members a JOIN pg_roles r ON r.oid = a.roleid JOIN pg_roles m ON m.oid = a.member
      WHERE m.rolname = ANY($1) OR r.rolname = ANY($1)`,
    [[n.app, n.query, `${n.query}_raw`, `${n.schema}_mcp_reader`, `${n.schema}_mcp_raw`]])).rows.map((r) => r.e as string).sort());
}

const superAdmin = (): AdminCredential => ({ user: SUPER, password: SUPER_PW, secrets: [SUPER_PW] });
const target = (n: ReturnType<typeof names>, o: Partial<BootstrapTarget> = {}): BootstrapTarget => ({
  host: HOST, port: PORT, database: n.db, user: n.app, queryUser: n.query, schema: n.schema, ssl: false, iam: false,
  appPassword: async () => n.appPw, ...o
});
const quiet = { log: createLogger(() => undefined) };

async function state(n: ReturnType<typeof names>) {
  return su(async (c) => {
    const role = (await c.query('SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = $1', [n.app])).rows[0];
    const cfg = (await c.query('SELECT s.setconfig FROM pg_db_role_setting s JOIN pg_roles r ON r.oid = s.setrole WHERE s.setdatabase = 0 AND r.rolname = $1', [n.app])).rows[0]?.setconfig;
    const owner = (await c.query(`SELECT pg_get_userbyid(nspowner) AS o FROM pg_namespace WHERE nspname = $1`, [n.schema])).rows[0]?.o;
    const vector = (await c.query(`SELECT extversion FROM pg_extension WHERE extname = 'vector'`)).rowCount;
    return { role, cfg, owner, vector };
  }, n.db);
}

describe.skipIf(!isPg)('bootstrap', () => {
  it('creates everything on a fresh server, then a second run changes nothing', async () => {
    const n = names();
    const first = await bootstrap(target(n), superAdmin(), quiet);
    expect(first).toEqual([
      `created database ${n.db}`,
      `created role ${n.app} (LOGIN, password set)`,
      `set search_path of ${n.app} to ${n.schema}, public`,
      'created extension vector',
      `created schema ${n.schema} owned by ${n.app}`,
      ...QUERY_CREATED(n)
    ]);
    expect(await state(n)).toEqual({
      role: { rolcanlogin: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false },
      cfg: [`search_path=${n.schema}, public`],
      owner: n.app,
      vector: 1
    });
    expect(await bootstrap(target(n), superAdmin(), quiet)).toEqual([]);
  });

  it('stores only a SCRAM verifier the server accepts as its own', async () => {
    const n = names();
    await bootstrap(target(n), superAdmin(), quiet);
    const stored = await su(async (c) => (await c.query('SELECT rolpassword FROM pg_authid WHERE rolname = $1', [n.app])).rows[0].rolpassword as string);
    const salt = /^SCRAM-SHA-256\$4096:([^$]+)\$/.exec(stored)?.[1];
    expect(stored).toBe(scramVerifier(n.appPw, Buffer.from(salt as string, 'base64')));
  });

  it('repairs drift: a CREATEDB role, a wrong search_path, a schema owned by someone else', async () => {
    const n = names();
    await bootstrap(target(n), superAdmin(), quiet);
    await su(async (c) => {
      await c.query(`ALTER ROLE ${id(n.app)} CREATEDB CREATEROLE`);
      await c.query(`ALTER ROLE ${id(n.app)} SET search_path = public`);
      await c.query(`ALTER SCHEMA ${id(n.schema)} OWNER TO ${id(SUPER)}`);
    }, n.db);
    expect(await bootstrap(target(n), superAdmin(), quiet)).toEqual([
      `altered role ${n.app} to LOGIN NOCREATEDB NOCREATEROLE`,
      `set search_path of ${n.app} to ${n.schema}, public`,
      `changed owner of schema ${n.schema} to ${n.app}`
    ]);
    expect(await bootstrap(target(n), superAdmin(), quiet)).toEqual([]);
  });

  it('pre-provisions the query login and isolation roles; the app role stays NOCREATEROLE and administers none of them', async () => {
    const n = names();
    await bootstrap(target(n), superAdmin(), quiet);
    const roles = await su(async (c) => (await c.query(
      `SELECT rolname, rolcanlogin, rolinherit, rolconnlimit, rolcreaterole, rolcreatedb, rolsuper, rolbypassrls, rolpassword IS NULL AS nopw
         FROM pg_authid WHERE rolname = ANY($1) ORDER BY rolname`, [[n.query, `${n.query}_raw`, `${n.schema}_mcp_reader`, `${n.schema}_mcp_raw`]])).rows);
    const base = { rolcreaterole: false, rolcreatedb: false, rolsuper: false, rolbypassrls: false, nopw: true };
    expect(roles).toEqual([
      { rolname: n.query, rolcanlogin: true, rolinherit: false, rolconnlimit: 4, ...base },
      { rolname: `${n.query}_raw`, rolcanlogin: false, rolinherit: true, rolconnlimit: -1, ...base },
      { rolname: `${n.schema}_mcp_raw`, rolcanlogin: false, rolinherit: true, rolconnlimit: -1, ...base },
      { rolname: `${n.schema}_mcp_reader`, rolcanlogin: false, rolinherit: true, rolconnlimit: -1, ...base }
    ]);
    expect(await edges(n)).toEqual([
      `${n.query}_raw>${n.query}:false:true`,
      `${n.schema}_mcp_raw>${n.query}_raw:true:true`,
      `${n.schema}_mcp_reader>${n.query}:true:true`,
      `${n.schema}_mcp_reader>${n.query}_raw:true:true`
    ]);
    expect((await state(n)).role.rolcreaterole).toBe(false);
    expect(await su(async (c) => (await c.query(`SELECT pg_has_role($1, $2, 'MEMBER') AS m`, [n.query, n.app])).rows[0].m)).toBe(false);
  });

  it('repairs query-role drift: attributes, a lost grant, wrong options, and membership in the app role', async () => {
    const n = names();
    await bootstrap(target(n), superAdmin(), quiet);
    await su(async (c) => {
      await c.query(`ALTER ROLE ${id(n.query)} INHERIT CONNECTION LIMIT -1`);
      await c.query(`ALTER ROLE ${id(`${n.schema}_mcp_raw`)} LOGIN`);
      await c.query(`REVOKE ${id(`${n.schema}_mcp_reader`)} FROM ${id(n.query)}`);
      await c.query(`GRANT ${id(`${n.query}_raw`)} TO ${id(n.query)} WITH INHERIT TRUE`);
      await c.query(`GRANT ${id(n.app)} TO ${id(n.query)}`);
      await c.query(`GRANT ${id(n.app)} TO ${id(`${n.schema}_mcp_reader`)}`);
    });
    expect(await bootstrap(target(n), superAdmin(), quiet)).toEqual([
      `altered role ${n.schema}_mcp_raw to NOLOGIN`,
      `altered role ${n.query} to LOGIN NOINHERIT NOCREATEDB NOCREATEROLE CONNECTION LIMIT 4`,
      `granted ${n.schema}_mcp_reader to ${n.query} (INHERIT TRUE, SET TRUE)`,
      `granted ${n.query}_raw to ${n.query} (INHERIT FALSE, SET TRUE)`,
      `revoked ${n.app} from ${n.query}`,
      `revoked ${n.app} from ${n.schema}_mcp_reader`
    ]);
    expect(await su(async (c) => (await c.query(`SELECT pg_has_role($1, $2, 'MEMBER') AS m`, [n.query, n.app])).rows[0].m)).toBe(false);
    expect(await bootstrap(target(n), superAdmin(), quiet)).toEqual([]);
  });

  it('refuses a query login that is the app role', async () => {
    const n = names();
    await expect(bootstrap(target(n, { queryUser: n.app }), superAdmin(), quiet)).rejects.toThrow(/db.queryUser .* is the app role/);
  });

  it('refuses a superuser app role', async () => {
    const n = names();
    await su((c) => c.query(`CREATE ROLE ${id(n.app)} LOGIN SUPERUSER`));
    await expect(bootstrap(target(n), superAdmin(), quiet)).rejects.toThrow(/is a superuser/);
  });

  it('refuses an admin that is the app role, before changing anything', async () => {
    const n = names();
    await expect(bootstrap(target(n, { user: SUPER }), superAdmin(), quiet)).rejects.toThrow(/admin user .* is the app role/);
    // Refused before connecting: nothing listens on port 1.
    await expect(bootstrap(target(n, { user: SUPER, port: 1 }), superAdmin(), quiet)).rejects.toThrow(/admin user .* is the app role/);
    expect(await su(async (c) => (await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [n.db])).rowCount)).toBe(0);
  });

  it('refuses an app role with BYPASSRLS, REPLICATION or rds_superuser membership', async () => {
    const made = await su(async (c) => (await c.query(`SELECT 1 FROM pg_roles WHERE rolname = 'rds_superuser'`)).rowCount === 0 && (await c.query('CREATE ROLE rds_superuser NOLOGIN'), true));
    if (made) cleanups.unshift(() => su(async (c) => void (await c.query('DROP ROLE IF EXISTS rds_superuser'))));
    for (const attr of ['BYPASSRLS', 'REPLICATION', 'IN ROLE rds_superuser']) {
      const n = names();
      await su((c) => c.query(`CREATE ROLE ${id(n.app)} LOGIN ${attr}`));
      await expect(bootstrap(target(n), superAdmin(), quiet)).rejects.toThrow(/refusing it as the app role/);
    }
  });

  it('serialises concurrent runs on an advisory lock', async () => {
    const n = names();
    const [a, b] = await Promise.all([bootstrap(target(n), superAdmin(), quiet), bootstrap(target(n), superAdmin(), quiet)]);
    expect([a, b].map((x) => x.length).sort((x, y) => x - y)).toEqual([0, 13]);
  });

  it('revokes CREATE on schema public from PUBLIC', async () => {
    const n = names();
    await bootstrap(target(n), superAdmin(), quiet);
    await su((c) => c.query('GRANT CREATE ON SCHEMA public TO PUBLIC'), n.db);
    expect(await bootstrap(target(n), superAdmin(), quiet)).toEqual(['revoked CREATE on schema public from PUBLIC']);
    expect(await bootstrap(target(n), superAdmin(), quiet)).toEqual([]);
  });

  it('aws-rds-iam: grants rds_iam and sets no password', async () => {
    const n = names();
    const made = await su(async (c) => (await c.query(`SELECT 1 FROM pg_roles WHERE rolname = 'rds_iam'`)).rowCount === 0 && (await c.query('CREATE ROLE rds_iam NOLOGIN'), true));
    if (made) cleanups.unshift(() => su(async (c) => void (await c.query('DROP ROLE IF EXISTS rds_iam'))));
    const t = target(n, { iam: true, appPassword: null });
    const changed = await bootstrap(t, superAdmin(), quiet);
    expect(changed).toContain(`granted rds_iam to ${n.app}`);
    expect(changed).toContain(`granted rds_iam to ${n.query}`);
    for (const r of [n.app, n.query]) {
      const row = await su(async (c) => (await c.query(`SELECT rolpassword, pg_has_role(rolname, 'rds_iam', 'MEMBER') AS iam FROM pg_authid WHERE rolname = $1`, [r])).rows[0]);
      expect(row).toEqual({ rolpassword: null, iam: true });
    }
    expect(await bootstrap(t, superAdmin(), quiet)).toEqual([]);
  });

  it('aws-rds-iam without an rds_iam role names the problem', async () => {
    const n = names();
    const exists = await su(async (c) => (await c.query(`SELECT 1 FROM pg_roles WHERE rolname = 'rds_iam'`)).rowCount === 1);
    if (exists) return;
    await expect(bootstrap(target(n, { iam: true, appPassword: null }), superAdmin(), quiet)).rejects.toThrow(/rds_iam does not exist/);
  });

  /** A CREATEDB CREATEROLE admin, as the RDS master; the superuser pre-creates the database and pgvector (untrusted). */
  async function rdsLikeAdmin(n: ReturnType<typeof names>): Promise<AdminCredential> {
    const adminPw = `adm-${randomBytes(9).toString('hex')}`;
    await su(async (c) => {
      await c.query(`CREATE ROLE ${id(n.admin)} LOGIN CREATEDB CREATEROLE PASSWORD ${pg.escapeLiteral(adminPw)}`);
      await c.query(`CREATE DATABASE ${id(n.db)} OWNER ${id(n.admin)}`);
    });
    await su((c) => c.query('CREATE EXTENSION vector SCHEMA public'), n.db);
    return { user: n.admin, password: adminPw, secrets: [adminPw] };
  }

  it('a non-superuser admin is told who owns a foreign schema or which role it lacks ADMIN on', async () => {
    const n = names();
    const admin = await rdsLikeAdmin(n);
    await su((c) => c.query(`CREATE SCHEMA ${id(n.schema)} AUTHORIZATION ${id(SUPER)}`), n.db);
    const e1 = (await bootstrap(target(n), admin, quiet).catch((e: Error) => e)) as Error & { code?: string };
    expect(e1.message).toMatch(new RegExp(`schema ${n.schema} is owned by ${SUPER}`));
    expect(e1.code).toBeUndefined();

    const m = names();
    const admin2 = await rdsLikeAdmin(m);
    await su((c) => c.query(`CREATE ROLE ${id(m.app)} LOGIN`));
    const e2 = (await bootstrap(target(m), admin2, quiet).catch((e: Error) => e)) as Error & { code?: string };
    expect(e2.message).toMatch(new RegExp(`no ADMIN option on role ${m.app}`));
    expect(e2.code).toBeUndefined();
  });

  it('works as a non-superuser CREATEDB CREATEROLE admin (the RDS master) and leaves it no SET on the app role', async () => {
    const n = names();
    const admin = await rdsLikeAdmin(n);
    expect(await bootstrap(target(n), admin, quiet)).toEqual([
      `created role ${n.app} (LOGIN, password set)`,
      `set search_path of ${n.app} to ${n.schema}, public`,
      `created schema ${n.schema} owned by ${n.app}`,
      ...QUERY_CREATED(n)
    ]);
    const set = await su(async (c) => (await c.query(
      `SELECT count(*)::int AS n FROM pg_auth_members m WHERE m.roleid = (SELECT oid FROM pg_roles WHERE rolname = $1)
         AND m.member = (SELECT oid FROM pg_roles WHERE rolname = $2) AND m.set_option`, [n.app, n.admin])).rows[0].n);
    expect(set).toBe(0);
    expect(await bootstrap(target(n), admin, quiet)).toEqual([]);
  });

  it('a wrong admin user fails as an auth error that carries no password', async () => {
    const n = names();
    const err = await bootstrap(target(n), { user: n.admin, password: 'S3cret-never-printed', secrets: [] }, quiet).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/admin login to database "postgres" as "fb_admin_[0-9a-f]+" failed/);
    expect((err as Error).message).not.toContain('S3cret-never-printed');
  });
});
const ARN = 'arn:aws:secretsmanager:us-east-1:567639518918:secret:fleet-agent-infra-use1-rds--connection-string-glXLj2';

// Output is scrubbed of the admin password, which is "fleet" on CI; the schema must not collide.
const CLI_SCHEMA = 'fb_store';

function hostConfig(n: ReturnType<typeof names>): string {
  const dir = mkdtempSync(join(tmpdir(), 'fh-boot-'));
  const path = join(dir, 'config.yaml');
  const dbBlock = { host: HOST, port: PORT, database: n.db, user: n.app, password: { kind: 'env', name: 'FB_APP_PW' }, ssl: 'disable', poolMax: 2, schema: CLI_SCHEMA };
  writeFileSync(path, `workspace: { id: 01JC0000000000000000000000, name: boot }\ngrants:\n  - { team: acme/platform, tier: session }\ndb: ${JSON.stringify(dbBlock)}\n`);
  return path;
}

async function cmd(argv: string[], env: NodeJS.ProcessEnv, getSecret?: (a: string, r: string) => Promise<string>) {
  const lines: string[] = [];
  const code = await runDbCommand(argv, { env, sink: (l) => lines.push(l), getSecret });
  return { code, out: lines.join('\n'), last: JSON.parse(lines.at(-1) as string) as Record<string, unknown> };
}

describe.skipIf(!isPg)('fleet-host bootstrap / migrate (CLI)', () => {
  it('bootstrap via the secret ARN (DB_USER/DB_PASSWORD), again via env; then the app role migrates and runs the host', async () => {
    const n = names();
    const cfg = hostConfig(n);
    const env = { FLEET_HOST_CONFIG: cfg, FB_APP_PW: n.appPw };
    const secret = JSON.stringify({ DB_USER: SUPER, DB_PASSWORD: SUPER_PW });
    const first = await cmd(['bootstrap', '--admin-secret-arn', ARN, '--admin-user-field', 'DB_USER', '--admin-password-field', 'DB_PASSWORD'], env, async () => secret);
    expect(first.code).toBe(0);
    expect(first.last).toMatchObject({ msg: 'bootstrap complete', database: n.db, role: n.app, schema: CLI_SCHEMA });
    expect((first.last.changed as string[]).length).toBe(13);
    expect(first.out).not.toContain(n.appPw);
    if (url?.password) expect(first.out).not.toContain(SUPER_PW);

    const again = await cmd(['bootstrap', '--admin-password-env', 'FB_ADMIN_PW', '--admin-user', SUPER], { ...env, FB_ADMIN_PW: SUPER_PW });
    expect(again.code).toBe(0);
    expect(again.last).toMatchObject({ msg: 'bootstrap complete: already in place, nothing changed', changed: [] });
    expect(again.out.split('\n')).toHaveLength(1);

    const mig = await cmd(['migrate'], env);
    expect(mig.code).toBe(0);
    expect(mig.last).toMatchObject({ msg: 'migrate complete', versions: { host: expect.any(Number), inbox: expect.any(Number), state: expect.any(Number) } });
    expect((await cmd(['migrate'], env)).last.versions).toEqual(mig.last.versions);

    const app = await client(n.app, n.appPw, n.db);
    try {
      await expect(app.query(`CREATE DATABASE ${id(`${n.db}_x`)}`)).rejects.toMatchObject({ code: '42501' });
      await expect(app.query(`CREATE ROLE ${id(`${n.app}_x`)}`)).rejects.toMatchObject({ code: '42501' });
      expect((await app.query('SELECT current_schema() AS s')).rows[0].s).toBe(CLI_SCHEMA);
    } finally {
      await app.end();
    }

    const port = await freePort();
    const dir = mkdtempSync(join(tmpdir(), 'fh-boot-host-'));
    const host = await runHost({
      env: { ...env, FLEET_HOST_PORT: String(port), FLEET_HOST_STATE: join(dir, 'state'), CLAUDE_FLEET_BROKER_SOCKET: join(dir, 'b.sock'), FLEET_HOST_PROJECTS: join(dir, 'projects'), FLEET_HOST_MCP_SOCKET: join(dir, 'run', 'mcp.sock') },
      exit: vi.fn(), proc: new EventEmitter(), logSink: () => undefined,
      authFactory: () => ({ id: 'github', verify: async (t) => { if (t !== TOKEN) throw new IdentityError('unauthorized', 'bad', 401); return person('owner', 1, ['acme/platform']); } }),
      brokerOps: fakeBroker([]).ops, leaseRenewMs: 200, leaseTtlMs: 1_000
    });
    try {
      await vi.waitFor(async () => expect((await fetch(`http://127.0.0.1:${port}/leader`)).status).toBe(200), { timeout: 10_000 });
      await vi.waitFor(() => expect(() => db.stateKysely()).not.toThrow(), { timeout: 10_000 });
      // The holder serves query as the pre-provisioned login; its password provider is IAM-only, so where the
      // server checks passwords it degrades.
      const res = await vi.waitFor(() => mcpCall(join(dir, 'run', 'mcp.sock'), 'query', { sql: 'SELECT session_user AS u' }), { timeout: 10_000 });
      if (await passwordsChecked()) {
        expect(res.isError).toBe(true);
        expect(res.content[0].text).toMatch(new RegExp(`query is unavailable on this Postgres store: cannot log in as ${n.query}: the query login signs in only by IAM`));
      } else {
        expect(JSON.parse(res.content[0].text)).toEqual([{ u: n.query }]);
      }
    } finally {
      await host.shutdown(0);
    }
  });

  it('missing or wrong admin credentials fail cleanly and echo nothing', async () => {
    const n = names();
    const env = { FLEET_HOST_CONFIG: hostConfig(n), FB_APP_PW: n.appPw };
    const bad = 'Wr0ng-Admin-Secret';
    const cases: [string[], NodeJS.ProcessEnv, RegExp][] = [
      [['bootstrap', '--admin-password-env', 'FB_ADMIN_PW', '--admin-user', SUPER], env, /FB_ADMIN_PW is not set/],
      [['bootstrap', '--admin-password-file', '/nonexistent/pw', '--admin-user', SUPER], env, /cannot read --admin-password-file: ENOENT/],
      [['bootstrap', '--admin-password-env', 'FB_ADMIN_PW', '--admin-user', n.admin], { ...env, FB_ADMIN_PW: bad }, /admin login to database "postgres"/]
    ];
    if (await passwordsChecked()) cases.push([['bootstrap', '--admin-password-env', 'FB_ADMIN_PW', '--admin-user', SUPER], { ...env, FB_ADMIN_PW: bad }, /28P01/]);
    for (const [argv, e, re] of cases) {
      const r = await cmd(argv, e);
      expect(r.code).toBe(1);
      expect(String(r.last.error)).toMatch(re);
      expect(r.out).not.toContain(bad);
      expect(r.out).not.toContain(n.appPw);
    }
    expect(await su(async (c) => (await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [n.db])).rowCount)).toBe(0);
  });
});

function mcpCall(sock: string, name: string, args: object): Promise<{ content: { text: string }[]; isError?: boolean }> {
  return new Promise((resolve, reject) => {
    const c = connect(sock);
    let buf = '';
    c.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl >= 0) { c.end(); resolve(JSON.parse(buf.slice(0, nl)).result); }
    });
    c.on('error', reject);
    c.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  });
}

async function passwordsChecked(): Promise<boolean> {
  try {
    await (await client(SUPER, `${SUPER_PW}-wrong`)).end();
    return false;
  } catch {
    return true;
  }
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}
