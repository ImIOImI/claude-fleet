// `fleet-host bootstrap`: what the app role can't do for itself, done as an admin. Each step checks, applies only if
// the check fails, and every check must pass afterwards. It never logs in as the app role and never runs migrations.
import { readFile } from 'node:fs/promises';
import type { ConnectionOptions } from 'node:tls';
import pg from 'pg';
import { parse as parseConnectionString } from 'pg-connection-string';
import { passwordProvider } from '../main/store/passwordProvider.js';
import { pgSsl } from '../main/store/pgSsl.js';
import { pgPoolConfig, type PostgresStoreConfig } from '../main/store/storeConfig.js';
import type { AdminCredential } from './adminCreds.js';
import type { Logger } from './log.js';
import { scramVerifier } from './scram.js';

export interface BootstrapTarget {
  host: string;
  port: number;
  database: string;
  /** The app login role. */
  user: string;
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
  apply(): Promise<string>;
}

const id = pg.escapeIdentifier;

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
      host: c.host, port: c.port, database: c.database, user: c.user, schema: cfg.schema, ssl: pgSsl(c.ssl, c.caFile), iam,
      appPassword: iam ? null : (fromFile ?? passwordProvider(c.password, c, env))
    };
  }
  const p = pgPoolConfig(cfg, env);
  const u = parseConnectionString(p.connectionString as string);
  if (!u.database || !u.user) throw new BootstrapError('the db connection string must name the database and the user');
  const pw = u.password;
  return {
    host: u.host || env.PGHOST || 'localhost', port: u.port ? Number(u.port) : 5432, database: u.database, user: u.user,
    schema: cfg.schema, ssl: p.ssl as false | ConnectionOptions, iam: false,
    appPassword: fromFile ?? (pw ? async () => pw : null)
  };
}

export async function bootstrap(t: BootstrapTarget, admin: AdminCredential, o: BootstrapOptions): Promise<string[]> {
  const changed: string[] = [];
  const run = async (steps: Step[]) => {
    for (const s of steps) {
      if (await s.check()) continue;
      const done = await s.apply();
      changed.push(done);
      o.log.log('info', `bootstrap: ${done}`);
    }
    for (const s of steps) if (!(await s.check())) throw new BootstrapError(`bootstrap: ${s.what} is still not in place after applying it`);
  };
  const m = await adminClient(t, admin, o.maintenanceDb ?? 'postgres', o);
  try {
    await run(databaseSteps(m, t));
  } finally {
    await m.end().catch(() => undefined);
  }
  const c = await adminClient(t, admin, t.database, o);
  try {
    await run(targetSteps(c, t, o));
  } finally {
    await c.end().catch(() => undefined);
  }
  return changed;
}

async function adminClient(t: BootstrapTarget, admin: AdminCredential, database: string, o: BootstrapOptions): Promise<pg.Client> {
  const c = new pg.Client({
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

function targetSteps(c: pg.Client, t: BootstrapTarget, o: BootstrapOptions): Step[] {
  type Role = { login: boolean; super: boolean; createdb: boolean; createrole: boolean };
  const role = () =>
    one<Role>(c, 'SELECT rolcanlogin AS login, rolsuper AS super, rolcreatedb AS createdb, rolcreaterole AS createrole FROM pg_roles WHERE rolname = $1', [t.user]);
  const ok = async (text: string, params: unknown[]) => !!(await one<{ ok: boolean }>(c, text, params))?.ok;
  const searchPath = `${t.schema}, public`;
  const steps: Step[] = [
    {
      what: `login role ${t.user}`,
      async check() {
        const r = await role();
        if (r?.super) throw new BootstrapError(`role ${t.user} is a superuser; refusing it as the app role`);
        return !!r && r.login && !r.createdb && !r.createrole;
      },
      async apply() {
        if (await role()) {
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
        const exists = !!(await one(c, 'SELECT 1 FROM pg_namespace WHERE nspname = $1', [t.schema]));
        await asRole(c, t.user, () =>
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
    }
  );
  return steps;
}

/** Runs `fn` able to SET ROLE to `role`. A PG16 CREATEROLE admin (the RDS master) holds only ADMIN on roles it
 *  created; the grant it takes here is revoked in the same transaction. */
async function asRole(c: pg.Client, role: string, fn: () => Promise<unknown>): Promise<void> {
  const v16 = (await one<{ v: number }>(c, `SELECT current_setting('server_version_num')::int AS v`))!.v >= 160000;
  const can = (await one<{ ok: boolean }>(c, `SELECT pg_has_role(current_user, $1, '${v16 ? 'SET' : 'MEMBER'}') AS ok`, [role]))!.ok;
  if (can) {
    await fn();
    return;
  }
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
