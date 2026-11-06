// The app-managed local Postgres (remote-workspaces spec §7): a pinned
// pgvector image in a labelled container on a named volume, published on a
// loopback port. Docker access is injected (managedDocker.ts), so this file
// runs in unit tests without a daemon.
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { scramVerifier } from './scram.js';
import type { PostgresStoreConfig } from './storeConfig.js';

/** Pinned by digest: a new image (a pgvector or PG minor bump) arrives only with an app release. */
export const MANAGED_PG_IMAGE =
  'pgvector/pgvector:0.8.7-pg16@sha256:0dd3149a06e4579a0d70d8fef9945636cd514005e7237deb27f9b67886f8dc4f';
/** The data directory's major version. A different major needs pg_upgrade, which the app doesn't run. */
export const MANAGED_PG_MAJOR = '16';
export const MANAGED_PG_CONTAINER = 'claude-fleet-postgres';
export const MANAGED_PG_VOLUME = 'claude-fleet-postgres-data';
/** Not com.claude-fleet.managed: that label marks workspace containers (docker.ts listLiveWorkspaces). */
export const STORE_LABEL = 'com.claude-fleet.store';
export const STORE_MAJOR_LABEL = 'com.claude-fleet.store.pg-major';
export const MANAGED_DATABASE = 'fleet';
export const MANAGED_USER = 'fleet_app';
export const MANAGED_SCHEMA = 'fleet';

export interface ManagedContainer {
  running: boolean;
  /** The image reference the container was created from. */
  image: string;
  hostPort: number | null;
  hostIp: string | null;
  labels: Record<string, string>;
}

export interface ManagedContainerSpec {
  name: string;
  image: string;
  env: string[];
  labels: Record<string, string>;
  volume: string;
  hostPort: number;
}

export interface ManagedDocker {
  ping(): Promise<boolean>;
  hasImage(ref: string): Promise<boolean>;
  pull(ref: string, onProgress: (message: string) => void): Promise<void>;
  inspectVolume(name: string): Promise<{ labels: Record<string, string> } | null>;
  createVolume(name: string, labels: Record<string, string>): Promise<void>;
  inspectContainer(name: string): Promise<ManagedContainer | null>;
  createContainer(spec: ManagedContainerSpec): Promise<void>;
  start(name: string): Promise<void>;
  stop(name: string, timeoutS: number): Promise<void>;
  remove(name: string): Promise<void>;
  /** Exit code and combined output; `env` is set on this exec only. Exit -1 when `timeoutMs` passes. */
  exec(name: string, cmd: string[], env?: string[], timeoutMs?: number): Promise<{ exitCode: number; output: string }>;
}

export type ManagedPgFailure = 'docker-down' | 'volume' | 'start' | 'not-ready' | 'bootstrap';

export class ManagedPgError extends Error {
  constructor(readonly reason: ManagedPgFailure, message: string) { super(message); }
}

export interface ManagedDeps {
  docker: ManagedDocker;
  /** The fleet_app password in the vault (`store:managed` / APP_PASSWORD). */
  password: { get(): Promise<string | null>; set(value: string): Promise<void> };
  onProgress?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
  freePort?: () => Promise<number>;
  readyTimeoutMs?: number;
  /** Test-only override of MANAGED_PG_CONTAINER / MANAGED_PG_VOLUME. */
  names?: { container: string; volume: string };
}

/** Idempotent bootstrap, run as the superuser over the container's own socket
 *  (local trust, the image's default). The password arrives as a SCRAM
 *  verifier, so the plaintext is never in an exec argument or a server log. */
export function bootstrapSql(o: { user: string; schema: string; verifier: string }): string {
  return `DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${o.user}') THEN CREATE ROLE ${o.user} LOGIN; END IF;
END $$;
ALTER ROLE ${o.user} LOGIN CREATEROLE PASSWORD '${o.verifier}';
CREATE SCHEMA IF NOT EXISTS ${o.schema} AUTHORIZATION ${o.user};
ALTER SCHEMA ${o.schema} OWNER TO ${o.user};
CREATE EXTENSION IF NOT EXISTS vector SCHEMA public;
ALTER EXTENSION vector UPDATE;
`;
}

/** Nothing logs in as the superuser over TCP: it has no password, and pg_hba rejects it. */
const LOCK_SUPERUSER = 'ALTER ROLE postgres PASSWORD NULL;\n';
const PG_HBA = ['local all all trust', 'host all postgres all reject', 'host all all all scram-sha-256'];

/** The exec script: pg_hba first (loaded by the closing pg_reload_conf), then the SQL from $FLEET_PG_SQL. */
export function bootstrapScript(): string {
  const hba = PG_HBA.map((l) => `'${l}'`).join(' ');
  return `set -e; printf '%s\\n' ${hba} > "$PGDATA/pg_hba.conf"; `
    + `printf '%s' "$FLEET_PG_SQL" | psql -v ON_ERROR_STOP=1 -X -q -U postgres -d ${MANAGED_DATABASE} -f -`;
}

const isBindConflict = (e: unknown): boolean =>
  /port is already allocated|address already in use|bind for \S+ failed/i.test(String((e as Error)?.message ?? e));

const redactVerifier = (s: string): string => s.replace(/SCRAM-SHA-256\$[^'\s]+/g, '[verifier]');

export async function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => (typeof addr === 'object' && addr ? resolve(addr.port) : reject(new Error('no port'))));
    });
  });
}

function containerSpec(names: { container: string; volume: string }, hostPort: number): ManagedContainerSpec {
  return {
    name: names.container,
    image: MANAGED_PG_IMAGE,
    // The image demands a superuser password at initdb: a throwaway read from a file keeps it out of `docker inspect`.
    env: [
      'POSTGRES_PASSWORD_FILE=/proc/sys/kernel/random/uuid',
      `POSTGRES_DB=${MANAGED_DATABASE}`,
      'POSTGRES_INITDB_ARGS=--locale=C.UTF-8 --encoding=UTF8',
    ],
    labels: { [STORE_LABEL]: 'postgres', [STORE_MAJOR_LABEL]: MANAGED_PG_MAJOR },
    volume: names.volume,
    hostPort,
  };
}

const isOurs = (c: ManagedContainer): boolean =>
  c.image === MANAGED_PG_IMAGE && c.labels[STORE_LABEL] === 'postgres' && c.hostIp === '127.0.0.1' && c.hostPort !== null;

/** Start (creating on first use) the managed container and return the store
 *  config that reaches it. Safe to call again at any time. */
export async function ensureManagedPostgres(d: ManagedDeps, poolMax: number): Promise<PostgresStoreConfig> {
  const progress = d.onProgress ?? (() => undefined);
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const freePort = d.freePort ?? freeLoopbackPort;
  const names = d.names ?? { container: MANAGED_PG_CONTAINER, volume: MANAGED_PG_VOLUME };
  const docker = d.docker;
  if (!(await docker.ping())) throw new ManagedPgError('docker-down', 'Docker is not running: the managed Postgres store needs it');

  if (!(await docker.hasImage(MANAGED_PG_IMAGE))) {
    progress('Pulling the Postgres image…');
    await docker.pull(MANAGED_PG_IMAGE, progress);
  }

  const vol = await docker.inspectVolume(names.volume);
  if (!vol) {
    await docker.createVolume(names.volume, { [STORE_LABEL]: 'postgres', [STORE_MAJOR_LABEL]: MANAGED_PG_MAJOR });
  } else if (vol.labels[STORE_LABEL] !== 'postgres') {
    throw new ManagedPgError('volume', `the Docker volume ${names.volume} exists but wasn't created by claude-fleet`);
  } else if (vol.labels[STORE_MAJOR_LABEL] !== MANAGED_PG_MAJOR) {
    throw new ManagedPgError('volume', `the volume ${names.volume} holds Postgres ${vol.labels[STORE_MAJOR_LABEL] ?? '?'} data; this build runs Postgres ${MANAGED_PG_MAJOR}`);
  }

  const c = await docker.inspectContainer(names.container);
  let port = c?.hostPort ?? null;
  let running = false;
  if (c && isOurs(c)) {
    running = c.running;
  } else if (c) {
    // A new pinned image, or a container not as we create it: recreate on the same volume and port.
    progress('Updating the Postgres container…');
    if (c.running) await docker.stop(names.container, 30);
    await docker.remove(names.container);
  }
  if (!c || !isOurs(c)) {
    port ??= await freePort();
    await docker.createContainer(containerSpec(names, port));
  }
  if (port === null) throw new ManagedPgError('start', 'the Postgres container publishes no host port');
  if (!running) {
    try {
      await docker.start(names.container);
    } catch (e) {
      if (!isBindConflict(e)) throw new ManagedPgError('start', `the Postgres container did not start: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
      // Something else holds the port: move to a fresh one; the data stays on the volume.
      progress('Moving Postgres to a free port…');
      await docker.remove(names.container);
      port = await freePort();
      await docker.createContainer(containerSpec(names, port));
      try {
        await docker.start(names.container);
      } catch (e2) {
        throw new ManagedPgError('start', `the Postgres container did not start: ${String((e2 as Error)?.message ?? e2).slice(0, 300)}`);
      }
    }
  }

  // TCP, not the socket: during initdb the entrypoint's temporary server
  // listens on the socket only, and it stops before the real one starts.
  const deadline = Date.now() + (d.readyTimeoutMs ?? 90_000);
  progress('Starting Postgres…');
  for (;;) {
    const r = await docker.exec(names.container, ['pg_isready', '-t', '3', '-h', '127.0.0.1', '-p', '5432', '-U', 'postgres', '-d', MANAGED_DATABASE], undefined, 10_000);
    if (r.exitCode === 0) break;
    if (Date.now() >= deadline) throw new ManagedPgError('not-ready', 'Postgres did not become ready in time');
    await sleep(1000);
  }

  let password = await d.password.get();
  if (!password) {
    password = randomBytes(32).toString('base64url');
    await d.password.set(password);
  }
  const sqlText = LOCK_SUPERUSER
    + bootstrapSql({ user: MANAGED_USER, schema: MANAGED_SCHEMA, verifier: scramVerifier(password) })
    + 'SELECT pg_reload_conf();\n';
  const boot = await docker.exec(names.container, ['sh', '-c', bootstrapScript()], [`FLEET_PG_SQL=${sqlText}`], 60_000);
  if (boot.exitCode !== 0) throw new ManagedPgError('bootstrap', `Postgres bootstrap failed: ${redactVerifier(boot.output).slice(0, 500)}`);

  return {
    kind: 'postgres',
    connection: { host: '127.0.0.1', port, database: MANAGED_DATABASE, user: MANAGED_USER, password: { kind: 'static', value: password }, ssl: 'disable' },
    schema: MANAGED_SCHEMA,
    poolMax,
  };
}

/** Best effort at quit: Postgres's WAL makes an unclean stop safe. */
export async function stopManagedPostgres(docker: ManagedDocker, container = MANAGED_PG_CONTAINER): Promise<void> {
  const c = await docker.inspectContainer(container).catch(() => null);
  if (c?.running) await docker.stop(container, 10);
}
