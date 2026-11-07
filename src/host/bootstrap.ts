// `fleet-host bootstrap`: what the app role can't do for itself, done as an admin. Each step checks, applies only if
// the check fails, and every check must pass afterwards. It never logs in as the app role and never runs migrations.
import { readFile } from 'node:fs/promises';
import type { ConnectionOptions } from 'node:tls';
import pg from 'pg';
import { parse as parseConnectionString } from 'pg-connection-string';
import { passwordProvider } from '../main/store/passwordProvider.js';
import { isolationRoles, MAX_SCHEMA_LEN } from '../main/store/pgQueryIsolation.js';
import { plaintextAuthGuard } from '../main/store/pgScramOnly.js';
import { pgSsl } from '../main/store/pgSsl.js';
import { pgPoolConfig, QUERY_USER, type PostgresStoreConfig } from '../main/store/storeConfig.js';
import type { AdminCredential } from './adminCreds.js';
import type { Logger } from './log.js';
import { scramVerifier } from './scram.js';

export interface BootstrapTarget {
  host: string;
  port: number;
  database: string;
  /** The app login role. */
  user: string;
  /** MCP `query`'s login (D71): no password, never a member of `user`. */
  queryUser: string;
  schema: string;
  ssl: false | ConnectionOptions;
  /** GRANT rds_iam; the role gets no password. */
  iam: boolean;
  /** Used only when bootstrap creates the role; null creates it without one. */
  appPassword: (() => Promise<string>) | null;
}

export interface BootstrapOptions {
  log: Logger;
  maintenanceDb?: string;
  /** Each secret bootstrap reads, for output scrubbing. */
  onSecret?: (v: string) => void;
  connectTimeoutMs?: number;
}

export class BootstrapError extends Error {}

interface Step {
  what: string;
  check(): Promise<boolean>;
  /** Returns what it changed. */
  apply(): Promise<string | string[]>;
}

const id = pg.escapeIdentifier;
// Arbitrary constant: serializes concurrent bootstraps on one server.
const BOOTSTRAP_LOCK = 7_340_212;

/** Endpoint, role and TLS from the host config `db:` block, under the same rules the host connects with. */
export function bootstrapTarget(cfg: PostgresStoreConfig, env: NodeJS.ProcessEnv, appPasswordFile?: string): BootstrapTarget {
  const fromFile = appPasswordFile
    ? async () => {
        const v = (await readFile(appPasswordFile, 'utf8')).replace(/\r?\n$/, '');
        if (!v) throw new BootstrapError('--app-password-file is empty');
        return v;
      }
    : null;
  const c = cfg.connection;
  if ('host' in c) {
    const iam = c.password.kind === 'aws-rds-iam';
    if (iam && fromFile) throw new BootstrapError('--app-password-file conflicts with db.password kind aws-rds-iam');
    return {
      host: c.host, port: c.port, database: c.database, user: c.user, queryUser: cfg.queryUser ?? `${c.user}_query`,
      schema: cfg.schema, ssl: pgSsl(c.ssl, c.caFile), iam,
      appPassword: iam ? null : (fromFile ?? passwordProvider(c.password, c, env))
    };
  }
  const p = pgPoolConfig(cfg, env);
  const u = parseConnectionString(p.connectionString as string);
  if (!u.database || !u.user) throw new BootstrapError('the db connection string must name the database and the user');
  const pw = u.password;
  return {
    host: u.host || env.PGHOST || 'localhost', port: u.port ? Number(u.port) : 5432, database: u.database, user: u.user,
    queryUser: cfg.queryUser ?? `${u.user}_query`,
    schema: cfg.schema, ssl: p.ssl as false | ConnectionOptions, iam: false,
    appPassword: fromFile ?? (pw ? async () => pw : null)
  };
}

export async function bootstrap(t: BootstrapTarget, admin: AdminCredential, o: BootstrapOptions): Promise<string[]> {
  const sameRole = () => new BootstrapError(`the admin user ${admin.user} is the app role (db.user); use the master credential`);
  if (admin.user === t.user) throw sameRole();
  if (t.queryUser === t.user || t.queryUser === admin.user) {
    throw new BootstrapError(`db.queryUser ${t.queryUser} is the app role or the admin; it must be a role of its own`);
  }
  const changed: string[] = [];
  const run = async (steps: Step[]) => {
    for (const s of steps) {
      if (await s.check()) continue;
      for (const done of [await s.apply()].flat()) {
        changed.push(done);
        o.log.log('info', `bootstrap: ${done}`);
      }
    }
    for (const s of steps) if (!(await s.check())) throw new BootstrapError(`bootstrap: ${s.what} is still not in place after applying it`);
  };
  const m = await adminClient(t, admin, o.maintenanceDb ?? 'postgres', o);
  try {
    if ((await one<{ same: boolean }>(m, 'SELECT current_user = $1 AS same', [t.user]))?.same) throw sameRole();
    // Session-level, held until the target steps finish; released when m ends.
    await m.query('SELECT pg_advisory_lock($1)', [BOOTSTRAP_LOCK]);
    await run(databaseSteps(m, t));
    const c = await adminClient(t, admin, t.database, o);
    try {
      await run(await targetSteps(c, t, o));
    } finally {
      await c.end().catch(() => undefined);
    }
  } finally {
    await m.end().catch(() => undefined);
  }
  return changed;
}

async function adminClient(t: BootstrapTarget, admin: AdminCredential, database: string, o: BootstrapOptions): Promise<pg.Client> {
  const Client = plaintextAuthGuard(t.ssl).Client ?? pg.Client;
  const c = new Client({
    host: t.host, port: t.port, database, user: admin.user, password: admin.password, ssl: t.ssl,
    connectionTimeoutMillis: o.connectTimeoutMs ?? 10_000, application_name: 'fleet-host bootstrap'
  });
  c.on('error', () => undefined);
  try {
    await c.connect();
  } catch (e) {
    await c.end().catch(() => undefined);
    const code = (e as { code?: unknown }).code;
    if (code === '28P01' || code === '28000') {
      throw new BootstrapError(`admin login to database "${database}" as "${admin.user}" failed (${code}): check the admin credential`);
    }
    throw e;
  }
  return c;
}

async function one<T>(c: pg.Client, text: string, params: unknown[] = []): Promise<T | undefined> {
  return (await c.query(text, params)).rows[0] as T | undefined;
}

function databaseSteps(c: pg.Client, t: BootstrapTarget): Step[] {
  return [
    {
      what: `database ${t.database}`,
      check: async () => !!(await one(c, 'SELECT 1 FROM pg_database WHERE datname = $1', [t.database])),
      async apply() {
        await c.query(`CREATE DATABASE ${id(t.database)}`);
        return `created database ${t.database}`;
      }
    }
  ];
}

async function targetSteps(c: pg.Client, t: BootstrapTarget, o: BootstrapOptions): Promise<Step[]> {
  type Role = { login: boolean; super: boolean; createdb: boolean; createrole: boolean; privileged: boolean };
  const role = () =>
    one<Role>(
      c,
      `SELECT rolcanlogin AS login, rolsuper AS super, rolcreatedb AS createdb, rolcreaterole AS createrole,
              rolbypassrls OR rolreplication OR CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rds_superuser')
                THEN pg_has_role(rolname, 'rds_superuser', 'MEMBER') ELSE false END AS privileged
         FROM pg_roles WHERE rolname = $1`,
      [t.user]
    );
  const admin = adminOf(c);
  const ok = async (text: string, params: unknown[]) => !!(await one<{ ok: boolean }>(c, text, params))?.ok;
  const searchPath = `${t.schema}, public`;
  const steps: Step[] = [
    {
      what: `login role ${t.user}`,
      async check() {
        const r = await role();
        if (r?.super) throw new BootstrapError(`role ${t.user} is a superuser; refusing it as the app role`);
        if (r?.privileged) throw new BootstrapError(`role ${t.user} has BYPASSRLS, REPLICATION or rds_superuser; refusing it as the app role`);
        return !!r && r.login && !r.createdb && !r.createrole;
      },
      async apply() {
        if (await role()) {
          await admin.need(t.user, 'alter it');
          await c.query(`ALTER ROLE ${id(t.user)} LOGIN NOCREATEDB NOCREATEROLE`);
          return `altered role ${t.user} to LOGIN NOCREATEDB NOCREATEROLE`;
        }
        const pw = t.appPassword ? await t.appPassword() : null;
        if (pw) o.onSecret?.(pw);
        await c.query(`CREATE ROLE ${id(t.user)} LOGIN${pw ? ` PASSWORD ${pg.escapeLiteral(scramVerifier(pw))}` : ''}`);
        return `created role ${t.user} (LOGIN, ${pw ? 'password set' : 'no password'})`;
      }
    }
  ];
  if (t.iam) {
    steps.push({
      what: `rds_iam membership of ${t.user}`,
      async check() {
        if (!(await one(c, `SELECT 1 FROM pg_roles WHERE rolname = 'rds_iam'`))) {
          throw new BootstrapError('role rds_iam does not exist: aws-rds-iam needs an RDS or Aurora database');
        }
        return ok(`SELECT pg_has_role($1, 'rds_iam', 'MEMBER') AS ok`, [t.user]);
      },
      async apply() {
        await admin.need('rds_iam', `grant it to ${t.user}`);
        await c.query(`GRANT rds_iam TO ${id(t.user)}`);
        return `granted rds_iam to ${t.user}`;
      }
    });
  }
  steps.push(
    {
      what: `search_path of ${t.user}`,
      async check() {
        const r = await one<{ cfg: string[] | null }>(
          c,
          'SELECT s.setconfig AS cfg FROM pg_db_role_setting s JOIN pg_roles r ON r.oid = s.setrole WHERE s.setdatabase = 0 AND r.rolname = $1',
          [t.user]
        );
        return (r?.cfg ?? []).some((e) => e.replace(/"/g, '') === `search_path=${searchPath}`);
      },
      async apply() {
        await admin.need(t.user, 'set its search_path');
        await c.query(`ALTER ROLE ${id(t.user)} SET search_path = ${id(t.schema)}, public`);
        return `set search_path of ${t.user} to ${searchPath}`;
      }
    },
    {
      what: 'extension vector 0.8.0 or later',
      async check() {
        const v = (await one<{ v: string }>(c, `SELECT extversion AS v FROM pg_extension WHERE extname = 'vector'`))?.v;
        if (!v) return false;
        const [maj, min] = v.split('.').map(Number);
        return maj > 0 || min >= 8;
      },
      async apply() {
        if (await one(c, `SELECT 1 FROM pg_extension WHERE extname = 'vector'`)) {
          await c.query('ALTER EXTENSION vector UPDATE');
          return 'updated extension vector';
        }
        await c.query('CREATE EXTENSION IF NOT EXISTS vector SCHEMA public');
        return 'created extension vector';
      }
    },
    {
      what: `schema ${t.schema} owned by ${t.user}`,
      check: async () => (await one<{ owner: string }>(c, 'SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = $1', [t.schema]))?.owner === t.user,
      async apply() {
        const owner = (await one<{ owner: string }>(c, 'SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = $1', [t.schema]))?.owner;
        const exists = owner !== undefined;
        if (exists && !(await ok(`SELECT pg_has_role(current_user, $1, 'USAGE') AS ok`, [owner]))) {
          throw new BootstrapError(`schema ${t.schema} is owned by ${owner}, which the admin cannot act as; change its owner to ${t.user} or drop it`);
        }
        await asRole(c, admin, t.user, () =>
          c.query(exists ? `ALTER SCHEMA ${id(t.schema)} OWNER TO ${id(t.user)}` : `CREATE SCHEMA ${id(t.schema)} AUTHORIZATION ${id(t.user)}`)
        );
        return exists ? `changed owner of schema ${t.schema} to ${t.user}` : `created schema ${t.schema} owned by ${t.user}`;
      }
    },
    {
      what: `CONNECT on database ${t.database} for ${t.user}`,
      check: () => ok(`SELECT has_database_privilege($1, current_database(), 'CONNECT') AS ok`, [t.user]),
      async apply() {
        await c.query(`GRANT CONNECT ON DATABASE ${id(t.database)} TO ${id(t.user)}`);
        return `granted CONNECT on database ${t.database} to ${t.user}`;
      }
    },
    {
      what: `USAGE on schema public for ${t.user}`,
      check: () => ok(`SELECT has_schema_privilege($1, 'public', 'USAGE') AS ok`, [t.user]),
      async apply() {
        await c.query(`GRANT USAGE ON SCHEMA public TO ${id(t.user)}`);
        return `granted USAGE on schema public to ${t.user}`;
      }
    },
    {
      what: `no CREATE on schema public for ${t.user}`,
      check: async () => !(await ok(`SELECT has_schema_privilege($1, 'public', 'CREATE') AS ok`, [t.user])),
      async apply() {
        await c.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
        return 'revoked CREATE on schema public from PUBLIC';
      }
    }
  );
  const skip = !(await admin.v16())
    ? 'it needs Postgres 16 or later'
    : t.schema.length > MAX_SCHEMA_LEN ? `the schema name is longer than ${MAX_SCHEMA_LEN} characters`
      : !QUERY_USER.test(t.queryUser) ? `db.queryUser ${t.queryUser} must match [a-z_][a-z0-9_]* and be at most 59 characters`
        : null;
  if (skip) o.log.log('warn', `bootstrap: MCP query roles not provisioned: ${skip}`);
  else steps.push(...queryRoleSteps(c, t, admin));
  return steps;
}

/** What PgQueryIsolation's pre-provisioned mode logs in as and SETs ROLE to (D71). The app role administers none of it. */
function queryRoleSteps(c: pg.Client, t: BootstrapTarget, admin: AdminRights): Step[] {
  const r = isolationRoles(t.schema);
  const q = t.queryUser;
  const qRaw = `${q}_raw`;
  type Attrs = { login: boolean; inherit: boolean; connlimit: number; createdb: boolean; createrole: boolean; privileged: boolean };
  const attrs = (name: string) =>
    one<Attrs>(
      c,
      `SELECT rolcanlogin AS login, rolinherit AS inherit, rolconnlimit AS connlimit, rolcreatedb AS createdb, rolcreaterole AS createrole,
              rolsuper OR rolbypassrls OR rolreplication AS privileged FROM pg_roles WHERE rolname = $1`,
      [name]
    );
  const refuse = (name: string, a: Attrs | undefined) => {
    if (a?.privileged) throw new BootstrapError(`role ${name} is a superuser or has BYPASSRLS or REPLICATION; refusing it for MCP query`);
  };
  const nologin = (name: string): Step => ({
    what: `NOLOGIN role ${name}`,
    async check() {
      const a = await attrs(name);
      refuse(name, a);
      return !!a && !a.login && !a.createdb && !a.createrole;
    },
    async apply() {
      if (!(await attrs(name))) {
        await c.query(`CREATE ROLE ${id(name)} NOLOGIN`);
        return `created role ${name} (NOLOGIN)`;
      }
      await admin.need(name, 'alter it');
      await c.query(`ALTER ROLE ${id(name)} NOLOGIN NOCREATEDB NOCREATEROLE`);
      return `altered role ${name} to NOLOGIN`;
    }
  });
  type Edge = { role: string; member: string; inherit: boolean };
  // `set` is always TRUE: the raw edge is reached by SET ROLE; the others are as GRANT's default.
  const allowed: Edge[] = [
    { role: r.reader, member: q, inherit: true },
    { role: r.reader, member: qRaw, inherit: true },
    { role: r.raw, member: qRaw, inherit: true },
    { role: qRaw, member: q, inherit: false }
  ];
  const opts = (inherit: boolean) => `INHERIT ${inherit ? 'TRUE' : 'FALSE'}, SET TRUE`;
  const grant = (e: Edge): Step => ({
    what: `membership of ${e.member} in ${e.role}`,
    check: async () =>
      !!(await one(
        c,
        `SELECT 1 FROM pg_auth_members a WHERE a.roleid = to_regrole($1) AND a.member = to_regrole($2)
           GROUP BY a.roleid HAVING bool_or(a.inherit_option = $3 AND a.set_option)`,
        [e.role, e.member, e.inherit]
      )),
    async apply() {
      await admin.need(e.role, `grant it to ${e.member}`);
      await c.query(`GRANT ${id(e.role)} TO ${id(e.member)} WITH ${opts(e.inherit)}`);
      return `granted ${e.role} to ${e.member} (${opts(e.inherit)})`;
    }
  });
  const ours = [q, qRaw, r.reader, r.raw];
  // Any other direct membership of these roles could reach the app role's tables (or worse) from a query.
  const extra = () =>
    c.query<{ role: string; member: string; grantor: string }>(
      `SELECT r.rolname AS role, m.rolname AS member, g.rolname AS grantor
         FROM pg_auth_members a JOIN pg_roles r ON r.oid = a.roleid JOIN pg_roles m ON m.oid = a.member JOIN pg_roles g ON g.oid = a.grantor
        WHERE m.rolname = ANY($1)
          AND NOT (r.rolname = 'rds_iam' AND m.rolname = $2)
          AND NOT (r.rolname, m.rolname) IN (SELECT * FROM unnest($3::text[], $4::text[]))
        ORDER BY r.rolname COLLATE "C", m.rolname COLLATE "C"`,
      [ours, q, allowed.map((e) => e.role), allowed.map((e) => e.member)]
    ).then((x) => x.rows);
  const steps: Step[] = [
    nologin(r.reader),
    nologin(r.raw),
    {
      what: `query login role ${q}`,
      async check() {
        const a = await attrs(q);
        refuse(q, a);
        return !!a && a.login && !a.inherit && a.connlimit === 4 && !a.createdb && !a.createrole;
      },
      async apply() {
        if (!(await attrs(q))) {
          await c.query(`CREATE ROLE ${id(q)} LOGIN NOINHERIT CONNECTION LIMIT 4`);
          return `created role ${q} (LOGIN NOINHERIT CONNECTION LIMIT 4, no password)`;
        }
        await admin.need(q, 'alter it');
        await c.query(`ALTER ROLE ${id(q)} LOGIN NOINHERIT NOCREATEDB NOCREATEROLE CONNECTION LIMIT 4`);
        return `altered role ${q} to LOGIN NOINHERIT NOCREATEDB NOCREATEROLE CONNECTION LIMIT 4`;
      }
    },
    nologin(qRaw),
    {
      what: `rds_iam membership of ${q}`,
      // Only where the server has IAM auth (RDS, Aurora); elsewhere the login has no way in, and query degrades.
      check: async () =>
        !(await one(c, `SELECT 1 FROM pg_roles WHERE rolname = 'rds_iam'`)) ||
        !!(await one<{ ok: boolean }>(c, `SELECT pg_has_role($1, 'rds_iam', 'MEMBER') AS ok`, [q]))?.ok,
      async apply() {
        await admin.need('rds_iam', `grant it to ${q}`);
        await c.query(`GRANT rds_iam TO ${id(q)}`);
        return `granted rds_iam to ${q}`;
      }
    },
    ...allowed.map(grant),
    {
      what: `no other memberships of ${ours.join(', ')}`,
      check: async () => (await extra()).length === 0,
      async apply() {
        const done: string[] = [];
        for (const e of await extra()) {
          await admin.need(e.role, `revoke it from ${e.member}`);
          await c.query(`REVOKE ${id(e.role)} FROM ${id(e.member)} GRANTED BY ${id(e.grantor)}`);
          done.push(`revoked ${e.role} from ${e.member}`);
        }
        return done;
      }
    },
    {
      what: `CONNECT on database ${t.database} for ${q}`,
      check: async () => !!(await one<{ ok: boolean }>(c, `SELECT has_database_privilege($1, current_database(), 'CONNECT') AS ok`, [q]))?.ok,
      async apply() {
        await c.query(`GRANT CONNECT ON DATABASE ${id(t.database)} TO ${id(q)}`);
        return `granted CONNECT on database ${t.database} to ${q}`;
      }
    }
  ];
  return steps;
}

/** Runs `fn` able to SET ROLE to `role`. A PG16 CREATEROLE admin (the RDS master) holds only ADMIN on roles it
 *  created; the grant it takes here is revoked in the same transaction. */
async function asRole(c: pg.Client, admin: AdminRights, role: string, fn: () => Promise<unknown>): Promise<void> {
  const v16 = await admin.v16();
  const can = (await one<{ ok: boolean }>(c, `SELECT pg_has_role(current_user, $1, '${v16 ? 'SET' : 'MEMBER'}') AS ok`, [role]))!.ok;
  if (can) {
    await fn();
    return;
  }
  await admin.need(role, 'make it a schema owner');
  await c.query('BEGIN');
  try {
    await c.query(`GRANT ${id(role)} TO CURRENT_USER${v16 ? ' WITH INHERIT FALSE, SET TRUE' : ''}`);
    await fn();
    await c.query(`REVOKE ${id(role)} FROM CURRENT_USER`);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  }
}

interface AdminRights {
  v16(): Promise<boolean>;
  /** Throws a BootstrapError naming `role` unless the admin may administer it. */
  need(role: string, why: string): Promise<void>;
}

/** PG16 needs the ADMIN option to alter or grant a role; before 16, CREATEROLE sufficed. */
function adminOf(c: pg.Client): AdminRights {
  let info: Promise<{ v16: boolean; super: boolean; createrole: boolean }> | null = null;
  const get = () =>
    (info ??= one<{ v: number; super: boolean; createrole: boolean }>(
      c,
      `SELECT current_setting('server_version_num')::int AS v, rolsuper AS super, rolcreaterole AS createrole FROM pg_roles WHERE rolname = current_user`
    ).then((r) => ({ v16: r!.v >= 160000, super: r!.super, createrole: r!.createrole })));
  return {
    v16: async () => (await get()).v16,
    async need(role, why) {
      const a = await get();
      if (a.super || (!a.v16 && a.createrole)) return;
      const r = await one<{ ok: boolean }>(c, `SELECT pg_has_role(current_user, $1, 'MEMBER WITH ADMIN OPTION') AS ok`, [role]);
      if (!r?.ok) throw new BootstrapError(`the admin has no ADMIN option on role ${role} (needed to ${why})`);
    }
  };
}
