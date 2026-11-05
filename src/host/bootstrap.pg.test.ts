// fleet-host bootstrap against a real server. The test superuser stands in for the RDS master; every test makes its
// own database and roles and drops them after.
import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { parse as parseConnectionString } from 'pg-connection-string';
import { isPg } from '../main/store/testStore.js';
import type { AdminCredential } from './adminCreds.js';
import { bootstrap, type BootstrapTarget } from './bootstrap.js';
import { createLogger } from './log.js';
import { scramVerifier } from './scram.js';

const url = isPg ? parseConnectionString(process.env.PG_TEST_URL as string) : null;
const HOST = url?.host ?? '';
const PORT = Number(url?.port ?? 5432);
const SUPER = url?.user ?? 'postgres';
const SUPER_PW = url?.password ?? 'trust-auth-ignores-this';
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

  it('works as a non-superuser CREATEDB CREATEROLE admin (the RDS master) and leaves it no SET on the app role', async () => {
    const n = names();
    const adminPw = `adm-${randomBytes(9).toString('hex')}`;
    await su(async (c) => {
      await c.query(`CREATE ROLE ${id(n.admin)} LOGIN CREATEDB CREATEROLE PASSWORD ${pg.escapeLiteral(adminPw)}`);
      // pgvector is untrusted; on RDS rds_superuser creates it.
      await c.query(`CREATE DATABASE ${id(n.db)} OWNER ${id(n.admin)}`);
    });
    await su((c) => c.query('CREATE EXTENSION vector SCHEMA public'), n.db);
    const admin: AdminCredential = { user: n.admin, password: adminPw, secrets: [adminPw] };
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
