// fleet-host bootstrap against a real server. The test superuser stands in for the RDS master; every test makes its
// own database and roles and drops them after.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
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
  for (const f of cleanups.splice(0).reverse()) await f();
});

function names() {
  const s = randomBytes(4).toString('hex');
  const n = { db: `fb_${s}`, app: `fb_app_${s}`, admin: `fb_admin_${s}`, appPw: `app-${randomBytes(9).toString('hex')}` };
  cleanups.push(() =>
    su(async (c) => {
      await c.query(`DROP DATABASE IF EXISTS ${id(n.db)} WITH (FORCE)`);
      await c.query(`DROP ROLE IF EXISTS ${id(n.app)}`);
      await c.query(`DROP ROLE IF EXISTS ${id(n.admin)}`);
    })
  );
  return n;
}

const superAdmin = (): AdminCredential => ({ user: SUPER, password: SUPER_PW, secrets: [SUPER_PW] });
const target = (n: ReturnType<typeof names>, o: Partial<BootstrapTarget> = {}): BootstrapTarget => ({
  host: HOST, port: PORT, database: n.db, user: n.app, schema: 'fleet', ssl: false, iam: false,
  appPassword: async () => n.appPw, ...o
});
const quiet = { log: createLogger(() => undefined) };

async function state(n: ReturnType<typeof names>) {
  return su(async (c) => {
    const role = (await c.query('SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = $1', [n.app])).rows[0];
    const cfg = (await c.query('SELECT s.setconfig FROM pg_db_role_setting s JOIN pg_roles r ON r.oid = s.setrole WHERE s.setdatabase = 0 AND r.rolname = $1', [n.app])).rows[0]?.setconfig;
    const owner = (await c.query(`SELECT pg_get_userbyid(nspowner) AS o FROM pg_namespace WHERE nspname = 'fleet'`)).rows[0]?.o;
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
      `set search_path of ${n.app} to fleet, public`,
      'created extension vector',
      `created schema fleet owned by ${n.app}`
    ]);
    expect(await state(n)).toEqual({
      role: { rolcanlogin: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false },
      cfg: ['search_path=fleet, public'],
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
      await c.query(`ALTER SCHEMA fleet OWNER TO ${id(SUPER)}`);
    }, n.db);
    expect(await bootstrap(target(n), superAdmin(), quiet)).toEqual([
      `altered role ${n.app} to LOGIN NOCREATEDB NOCREATEROLE`,
      `set search_path of ${n.app} to fleet, public`,
      `changed owner of schema fleet to ${n.app}`
    ]);
    expect(await bootstrap(target(n), superAdmin(), quiet)).toEqual([]);
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
    expect([a, b].map((x) => x.length).sort()).toEqual([0, 5]);
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
    expect(await bootstrap(t, superAdmin(), quiet)).toContain(`granted rds_iam to ${n.app}`);
    const row = await su(async (c) => (await c.query(`SELECT rolpassword, pg_has_role(rolname, 'rds_iam', 'MEMBER') AS iam FROM pg_authid WHERE rolname = $1`, [n.app])).rows[0]);
    expect(row).toEqual({ rolpassword: null, iam: true });
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
    await su((c) => c.query(`CREATE SCHEMA fleet AUTHORIZATION ${id(SUPER)}`), n.db);
    const e1 = (await bootstrap(target(n), admin, quiet).catch((e: Error) => e)) as Error & { code?: string };
    expect(e1.message).toMatch(new RegExp(`schema fleet is owned by ${SUPER}`));
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
      `set search_path of ${n.app} to fleet, public`,
      `created schema fleet owned by ${n.app}`
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
    expect((first.last.changed as string[]).length).toBe(5);
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
      env: { ...env, FLEET_HOST_PORT: String(port), FLEET_HOST_STATE: join(dir, 'state'), CLAUDE_FLEET_BROKER_SOCKET: join(dir, 'b.sock'), FLEET_HOST_PROJECTS: join(dir, 'projects') },
      exit: vi.fn(), proc: new EventEmitter(), logSink: () => undefined,
      authFactory: () => ({ id: 'github', verify: async (t) => { if (t !== TOKEN) throw new IdentityError('unauthorized', 'bad', 401); return person('owner', 1, ['acme/platform']); } }),
      brokerOps: fakeBroker([]).ops, leaseRenewMs: 200, leaseTtlMs: 1_000
    });
    try {
      await vi.waitFor(async () => expect((await fetch(`http://127.0.0.1:${port}/leader`)).status).toBe(200), { timeout: 10_000 });
      await vi.waitFor(() => expect(() => db.stateKysely()).not.toThrow(), { timeout: 10_000 });
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
