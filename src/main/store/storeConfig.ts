// The store choice (config.json `store`; fleet-host's `db:`). Parsing and pg
// pool options only; no I/O beyond checking for and reading a CA file.
// Errors name keys, never values: config values may hold secrets.
import { existsSync } from 'node:fs';
import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';
import { parse as parseConnectionString } from 'pg-connection-string';
import type pg from 'pg';
import { passwordProvider, type PasswordSource } from './passwordProvider.js';
import { pgSsl, type SslMode } from './pgSsl.js';
import type { PgPoolConfig } from './postgres.js';

/** Where the fleet-host image installs the AWS RDS global bundle. */
export const DEFAULT_CA_FILE = '/etc/ssl/certs/rds-global-bundle.pem';

export type PgConnection =
  | { connectionString: string; caFile?: string }
  | { env: string; caFile?: string }
  | { host: string; port: number; database: string; user: string; password: PasswordSource; ssl: SslMode; caFile?: string };

export interface PostgresStoreConfig {
  kind: 'postgres';
  connection: PgConnection;
  /** Default 'fleet'. Must already exist; the store never creates it. */
  schema: string;
  /** Default 4. */
  poolMax: number;
}

/** config.json `{ kind: 'postgres', managed: true }`: the app-managed container (managedPostgres.ts). */
export interface ManagedStoreConfig {
  kind: 'managed';
  poolMax: number;
}

export type StoreConfig = { kind: 'sqlite' } | PostgresStoreConfig | ManagedStoreConfig;

export class StoreConfigError extends Error {}

/** config.json exists but isn't valid JSON. */
export class ConfigJsonError extends StoreConfigError {}

export interface ParseOptions {
  /** fleet-host only: a desktop config.json is not a secret store. */
  allowStaticSecrets: boolean;
  /** The desktop only: fleet-host has no Docker to manage a container with. */
  allowManaged?: boolean;
  fileExists?: (path: string) => boolean;
}

type Obj = Record<string, unknown>;

const fail = (m: string): never => { throw new StoreConfigError(`store: ${m}`); };
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const onlyKeys = (o: Obj, allowed: readonly string[], where = ''): void => {
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) fail(`unknown key "${/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(k) ? k : '?'}"${where}`);
  }
};
const str = (o: Obj, k: string): string => {
  const v = o[k];
  return typeof v === 'string' && v.trim() ? v.trim() : fail(`${k} must be a non-empty string`);
};
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const envName = (o: Obj, k: string): string => {
  const v = str(o, k);
  return ENV_NAME.test(v) ? v : fail(`${k} must be an env var name`);
};
const REGION = /^[a-z]{2}(-[a-z]+)+-\d+$/;

function parsePassword(v: unknown, opts: ParseOptions): PasswordSource {
  if (!isObj(v)) return fail('password must be { kind: "static" | "env" | "aws-rds-iam" }');
  switch (v.kind) {
    case 'static':
      if (!opts.allowStaticSecrets) fail('password kind "static" is not allowed in config.json; use "env" or "aws-rds-iam"');
      onlyKeys(v, ['kind', 'value'], ' in password');
      return { kind: 'static', value: str(v, 'value') };
    case 'env':
      onlyKeys(v, ['kind', 'name'], ' in password');
      return { kind: 'env', name: envName(v, 'name') };
    case 'aws-rds-iam': {
      onlyKeys(v, ['kind', 'region'], ' in password');
      if (v.region === undefined) return { kind: 'aws-rds-iam' };
      const region = str(v, 'region');
      return REGION.test(region) ? { kind: 'aws-rds-iam', region } : fail('password.region must be an AWS region');
    }
    default:
      return fail('password.kind must be "static", "env" or "aws-rds-iam"');
  }
}

const SSL_PARAM = /^(ssl.*|uselibpqcompat)$/i;

/** Validates a connection string and splits off its sslmode, so TLS is always
 *  set by pgSsl and never by pg's own sslmode/ssl/PGSSLMODE handling. */
function splitConnectionString(cs: string, allowStaticSecrets: boolean): { connectionString: string; ssl: SslMode | undefined } {
  let url: URL;
  try { url = new URL(cs); } catch { return fail('connectionString is not a URL'); }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') fail('connectionString must start with postgres:// or postgresql://');
  if ((url.password || url.searchParams.has('password')) && !allowStaticSecrets) {
    fail('connectionString must not embed a password in config.json; use "env" or the discrete fields');
  }
  let ssl: SslMode | undefined;
  for (const k of [...new Set(url.searchParams.keys())]) {
    if (k === 'sslmode') {
      const m = url.searchParams.getAll(k);
      if (m.length !== 1 || (m[0] !== 'disable' && m[0] !== 'verify-full')) fail('connectionString sslmode must be "disable" or "verify-full"');
      ssl = m[0] as SslMode;
    } else if (SSL_PARAM.test(k)) {
      fail(`connectionString parameter "${/^[A-Za-z_]{1,40}$/.test(k) ? k : '?'}" is not allowed; use sslmode and caFile`);
    }
  }
  if (ssl === undefined) return { connectionString: cs, ssl };
  url.searchParams.delete('sslmode');
  return { connectionString: url.search === '' ? url.toString().replace(/\?$/, '') : url.toString(), ssl };
}

function caFileOf(o: Obj): string | undefined {
  if (o.caFile === undefined) return undefined;
  const f = str(o, 'caFile');
  return isAbsolute(f) ? f : fail('caFile must be an absolute path');
}

function resolveCaFile(caFile: string | undefined, fileExists: (p: string) => boolean): string {
  if (caFile) return caFile;
  if (fileExists(DEFAULT_CA_FILE)) return DEFAULT_CA_FILE;
  return fail(`ssl "verify-full" needs caFile (the server CA bundle; default ${DEFAULT_CA_FILE} is absent)`);
}

const TOP = ['kind', 'schema', 'poolMax'];
const CA_WITH_DISABLE = 'caFile with ssl "disable" is contradictory; use "verify-full" or drop caFile';

/** A Unix socket directory or a loopback address: traffic never leaves the machine. */
function isLocalHost(host: string): boolean {
  if (host.startsWith('/')) return true;
  const h = host.toLowerCase();
  if (h === 'localhost' || h === '::1') return true;
  return isIP(h) === 4 && h.startsWith('127.');
}

function parseConnection(o: Obj, opts: ParseOptions): PgConnection {
  const forms = ['connectionString', 'env', 'host'].filter((k) => o[k] !== undefined);
  if (forms.length !== 1) fail('needs exactly one of connectionString, env, or host (with database, user, password)');
  if (o.connectionString !== undefined) {
    onlyKeys(o, [...TOP, 'connectionString', 'caFile']);
    const cs = str(o, 'connectionString');
    const { ssl } = splitConnectionString(cs, opts.allowStaticSecrets);
    const caFile = caFileOf(o);
    if (caFile && ssl === 'disable') fail(CA_WITH_DISABLE);
    return caFile ? { connectionString: cs, caFile } : { connectionString: cs };
  }
  if (o.env !== undefined) {
    onlyKeys(o, [...TOP, 'env', 'caFile']);
    const caFile = caFileOf(o);
    const env = envName(o, 'env');
    return caFile ? { env, caFile } : { env };
  }
  onlyKeys(o, [...TOP, 'host', 'port', 'database', 'user', 'password', 'ssl', 'caFile']);
  const port = o.port === undefined ? 5432 : o.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) fail('port must be an integer 1-65535');
  const ssl = o.ssl === undefined ? 'verify-full' : o.ssl;
  if (ssl !== 'disable' && ssl !== 'verify-full') fail('ssl must be "disable" or "verify-full"');
  const password = parsePassword(o.password, opts);
  if (password.kind === 'aws-rds-iam' && ssl !== 'verify-full') fail('aws-rds-iam needs ssl "verify-full"');
  const conn: PgConnection = {
    host: str(o, 'host'), port: port as number, database: str(o, 'database'), user: str(o, 'user'),
    password, ssl: ssl as SslMode,
  };
  const caFile = caFileOf(o);
  if (conn.ssl === 'verify-full') conn.caFile = resolveCaFile(caFile, opts.fileExists ?? existsSync);
  else if (caFile) fail(CA_WITH_DISABLE);
  return conn;
}

/** Validate an untrusted `store` value. Absent ⇒ SQLite. */
export function parseStoreConfig(v: unknown, opts: ParseOptions): StoreConfig {
  if (v === undefined || v === null) return { kind: 'sqlite' };
  if (!isObj(v)) return fail('must be an object');
  if (v.kind === 'sqlite') {
    onlyKeys(v, ['kind']);
    return { kind: 'sqlite' };
  }
  if (v.kind !== 'postgres') return fail('kind must be "sqlite" or "postgres"');
  if (v.managed !== undefined) {
    if (v.managed !== true) fail('managed must be true');
    if (!opts.allowManaged) fail('managed is not allowed here');
    onlyKeys(v, ['kind', 'managed', 'poolMax']);
    return { kind: 'managed', poolMax: parsePoolMax(v) };
  }
  const schema = v.schema === undefined ? 'fleet' : str(v, 'schema');
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) fail('schema must match [a-z_][a-z0-9_]*');
  return { kind: 'postgres', connection: parseConnection(v, opts), schema, poolMax: parsePoolMax(v) };
}

function parsePoolMax(v: Obj): number {
  const poolMax = v.poolMax === undefined ? 4 : v.poolMax;
  if (typeof poolMax !== 'number' || !Number.isInteger(poolMax) || poolMax < 1 || poolMax > 32) fail('poolMax must be an integer 1-32');
  return poolMax as number;
}

/** pg pool options for a parsed Postgres store. `ssl` is always explicit, so
 *  pg never falls back to PGSSLMODE. */
export function pgPoolConfig(
  cfg: PostgresStoreConfig, env: NodeJS.ProcessEnv = process.env, fileExists: (p: string) => boolean = existsSync,
): PgPoolConfig {
  const base = { schema: cfg.schema, max: cfg.poolMax, connectionTimeoutMillis: 10_000 };
  const c = cfg.connection;
  if ('connectionString' in c || 'env' in c) {
    let cs: string;
    if ('env' in c) {
      const v = env[c.env];
      if (!v) throw new StoreConfigError(`store: env var ${c.env} is not set`);
      cs = v;
    } else {
      cs = c.connectionString;
    }
    // An env var is a secret channel: a password in it is fine.
    const split = splitConnectionString(cs, true);
    if (split.ssl === 'disable' && c.caFile) throw new StoreConfigError(`store: ${CA_WITH_DISABLE}`);
    // No sslmode: verify-full unless the connection stays on this machine (pg's
    // own host fallback: ?host=, then the URL host, then PGHOST, then localhost).
    const mode = split.ssl
      ?? (c.caFile || !isLocalHost(parseConnectionString(cs).host || env.PGHOST || 'localhost') ? 'verify-full' : 'disable');
    const ssl = mode === 'verify-full' ? pgSsl('verify-full', resolveCaFile(c.caFile, fileExists)) : false;
    return { ...base, connectionString: split.connectionString, ssl };
  }
  if (c.password.kind === 'aws-rds-iam' && c.ssl !== 'verify-full') throw new StoreConfigError('store: aws-rds-iam needs ssl "verify-full"');
  const out: PgPoolConfig & pg.PoolConfig = {
    ...base, host: c.host, port: c.port, database: c.database, user: c.user,
    password: passwordProvider(c.password, { host: c.host, port: c.port, user: c.user }, env),
    ssl: pgSsl(c.ssl, c.caFile),
  };
  return out;
}

/** libpq/pg env vars that carry or locate credentials. */
const LIBPQ_SECRET_ENV = ['PGPASSWORD', 'PGPASSFILE', 'PGSERVICE', 'PGSERVICEFILE', 'PGSSLKEY', 'PGSSLCERT'];

/** Env vars that hold the store's credentials: host-only, never passed to a
 *  workspace process. `null` (config unreadable) assumes Postgres. */
export function storeSecretEnvNames(cfg: StoreConfig | null): string[] {
  if (cfg?.kind === 'sqlite') return [];
  const c = cfg?.kind === 'postgres' ? cfg.connection : undefined;
  const own = !c ? [] : 'env' in c ? [c.env] : 'password' in c && c.password.kind === 'env' ? [c.password.name] : [];
  return [...own, ...LIBPQ_SECRET_ENV];
}

/** A hint for an auth failure on aws-rds-iam; null otherwise. Names no secret. */
export function iamAuthHint(cfg: PostgresStoreConfig, e: unknown): string | null {
  const c = cfg.connection;
  if (!('password' in c) || c.password.kind !== 'aws-rds-iam') return null;
  const code = (e as { code?: unknown } | null)?.code;
  if (code !== '28P01' && code !== '28000') return null;
  return 'aws-rds-iam auth failed: check the DB user has the rds_iam role, the IAM policy allows rds-db:connect for it, host is the writer endpoint, and the system clock is synced';
}
