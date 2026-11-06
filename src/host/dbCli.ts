// `fleet-host bootstrap` and `fleet-host migrate`: one-shot Job commands. JSON lines on stdout; every secret read is
// scrubbed from each line.
import { parseArgs } from 'node:util';
import { awsGetSecret, resolveAdminCredential, type AdminSource, type GetSecretString } from './adminCreds.js';
import { bootstrap, bootstrapTarget } from './bootstrap.js';
import { HostConfigError, loadHostConfig, readHostEnv } from './config.js';
import { migrateHostStore } from './hostMigrate.js';
import { createLogger, type LogSink } from './log.js';
import type { PgTrack } from '../main/store/pgMigrate.js';
import type { PostgresStoreConfig } from '../main/store/storeConfig.js';

export const USAGE = [
  'fleet-host bootstrap (--admin-secret-arn ARN [--admin-user-field F] [--admin-password-field F] [--region R]',
  '                      | --admin-password-file PATH | --admin-password-env NAME | --admin-iam [--region R])',
  '                     [--admin-user NAME] [--app-password-file PATH] [--maintenance-db NAME]',
  'fleet-host migrate'
].join('\n');

export class UsageError extends Error {}

export interface BootstrapArgs {
  admin: AdminSource;
  appPasswordFile: string | undefined;
  maintenanceDb: string;
}

export interface DbCliDeps {
  env: NodeJS.ProcessEnv;
  sink: LogSink;
  getSecret?: GetSecretString;
  /** Tests: more store migrations, run like the real ones. */
  extraTracks?: readonly PgTrack[];
}

const OPTIONS = {
  'admin-secret-arn': { type: 'string' },
  'admin-user-field': { type: 'string' },
  'admin-password-field': { type: 'string' },
  'admin-password-file': { type: 'string' },
  'admin-password-env': { type: 'string' },
  'admin-iam': { type: 'boolean' },
  'admin-user': { type: 'string' },
  region: { type: 'string' },
  'app-password-file': { type: 'string' },
  'maintenance-db': { type: 'string' }
} as const;

export function parseBootstrapArgs(argv: string[]): BootstrapArgs {
  let v: ReturnType<typeof parseArgs<{ args: string[]; options: typeof OPTIONS; strict: true }>>['values'];
  try {
    v = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: false }).values;
  } catch (e) {
    // parseArgs quotes the offending argument, which may be a value.
    throw new UsageError(`invalid arguments (${(e as { code?: string }).code ?? 'error'})`);
  }
  const arn = v['admin-secret-arn'] || undefined;
  const file = v['admin-password-file'] || undefined;
  const envName = v['admin-password-env'] || undefined;
  const iam = v['admin-iam'] === true;
  if ([arn, file, envName, iam || undefined].filter((x) => x !== undefined).length !== 1) {
    throw new UsageError('pass exactly one of --admin-secret-arn, --admin-password-file, --admin-password-env, --admin-iam');
  }
  if (!arn && (v['admin-user-field'] !== undefined || v['admin-password-field'] !== undefined)) {
    throw new UsageError('--admin-user-field and --admin-password-field need --admin-secret-arn');
  }
  if (v.region !== undefined && !arn && !iam) throw new UsageError('--region applies only to --admin-secret-arn and --admin-iam');
  if (envName && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) throw new UsageError('--admin-password-env must be an env var name');
  const user = v['admin-user'] || undefined;
  const rest = { appPasswordFile: v['app-password-file'] || undefined, maintenanceDb: v['maintenance-db'] || 'postgres' };
  if (arn) {
    return {
      admin: { kind: 'secret', arn, userField: v['admin-user-field'] || 'username', passwordField: v['admin-password-field'] || 'password', region: v.region, user },
      ...rest
    };
  }
  if (!user) throw new UsageError('--admin-user is required with --admin-password-file, --admin-password-env and --admin-iam');
  if (file) return { admin: { kind: 'file', path: file, user }, ...rest };
  if (envName) return { admin: { kind: 'env', name: envName, user }, ...rest };
  return { admin: { kind: 'aws-rds-iam', user, region: v.region }, ...rest };
}

/** `lists` may grow after creation (tokens minted mid-run). */
export function scrubbingSink(sink: LogSink, lists: readonly (readonly string[])[]): LogSink {
  return (line) => {
    let out = line;
    for (const s of lists.flat()) {
      if (!s) continue;
      for (const form of new Set([s, JSON.stringify(s).slice(1, -1)])) out = out.split(form).join('[redacted]');
    }
    sink(out);
  };
}

async function dbConfig(path: string): Promise<PostgresStoreConfig> {
  const c = await loadHostConfig(path);
  if (!c.db) throw new HostConfigError(`${path} has no db: block`);
  return c.db;
}

/** 0 ok, 1 failed, 2 usage. */
export async function runDbCommand(argv: string[], d: DbCliDeps): Promise<number> {
  const found: string[] = [];
  const lists: (readonly string[])[] = [found];
  const log = createLogger(scrubbingSink(d.sink, lists));
  const cmd = argv[0];
  try {
    const env = readHostEnv(d.env);
    if (cmd === 'bootstrap') {
      const args = parseBootstrapArgs(argv.slice(1));
      const cfg = await dbConfig(env.configPath);
      const target = bootstrapTarget(cfg, d.env, args.appPasswordFile);
      let src = args.admin;
      if (src.kind === 'aws-rds-iam' && target.ssl === false) throw new UsageError('--admin-iam needs ssl "verify-full" on db:');
      const c = cfg.connection;
      if (src.kind === 'aws-rds-iam' && !src.region && 'password' in c && c.password.kind === 'aws-rds-iam') src = { ...src, region: c.password.region };
      const admin = await resolveAdminCredential(src, { env: d.env, getSecret: d.getSecret ?? awsGetSecret, target });
      lists.push(admin.secrets);
      const changed = await bootstrap(target, admin, { log, maintenanceDb: args.maintenanceDb, onSecret: (s) => found.push(s) });
      log.log('info', changed.length ? 'bootstrap complete' : 'bootstrap complete: already in place, nothing changed', {
        database: target.database, role: target.user, schema: target.schema, changed
      });
      return 0;
    }
    if (cmd === 'migrate') {
      if (argv.length > 1) throw new UsageError('migrate takes no arguments');
      const cfg = await dbConfig(env.configPath);
      const versions = await migrateHostStore(cfg, { env: d.env, log, extraTracks: d.extraTracks });
      log.log('info', 'migrate complete', { schema: cfg.schema, versions });
      return 0;
    }
    throw new UsageError('unknown command');
  } catch (err) {
    const usage = err instanceof UsageError;
    log.log('error', `${cmd ?? 'fleet-host'} failed`, { error: (err as Error).message, ...(usage ? { usage: USAGE } : {}) });
    return usage ? 2 : 1;
  }
}
