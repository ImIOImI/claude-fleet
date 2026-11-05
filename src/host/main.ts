// fleet-host wiring: config, identity, lease, broker, endpoint, reload, shutdown.
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { hostname } from 'node:os';
import { AttachHub } from './attachHub.js';
import { buildAuthContext, githubProviderFactory, type AuthContext, type ProviderFactory } from './auth.js';
import { brokerOps as realBrokerOps, type BrokerOps } from './brokerOps.js';
import { loadHostConfig, readHostEnv, type HostConfig } from './config.js';
import { createReloader, watchConfigDir } from './configReload.js';
import { startCredHelper, type CredServer } from './credServer.js';
import { brokerWatch, EventHub, pruneDeadOwners } from './events.js';
import type { PgTrack } from '../main/store/pgMigrate.js';
import { pgPoolConfig } from '../main/store/storeConfig.js';
import { openHostDbRetrying, startDbHealth, type DbHealth, type HostDbHandle } from './hostDb.js';
import { resolveWorkspaceId } from './hostState.js';
import { startHolder, type Holder } from './holder.js';
import { LEASE_RENEW_MS, LEASE_TTL_MS, LeaseManager, memoryLeaseStore, type LeaseStore, type LostReason } from './lease.js';
import { postgresLeaseStore } from './pgLease.js';
import { createLogger, type LogSink } from './log.js';
import { brokerRpcChannels } from './rpc.js';
import { createHostServer, installCrashGuards, type HostServer } from './server.js';

export const BROKER_POLL_MS = 2_000;
export const OWNER_PRUNE_MS = 60_000;
/** Bound on releasing the lease after a crash; the process then exits regardless. */
export const FATAL_STOP_MS = 2_000;
/** Bound on each of closing the holder's stores and the host pool on shutdown, inside the 30 s grace period. */
export const STORE_CLOSE_MS = 5_000;
/** EX_TEMPFAIL: the host DB is unreachable. fleet-host-entry restarts it without counting toward its crash-loop give-up. */
export const EXIT_DB_UNAVAILABLE = 75;

const PG_CONN_ERRNO = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE']);

/** Connection-level failures (network, server shutdown, pool connect timeout), not SQL or code errors. */
export function isDbUnavailable(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && (PG_CONN_ERRNO.has(code) || /^(08|57P0)/.test(code))) return true;
  return /Connection terminated|timeout exceeded when trying to connect/i.test((err as Error | null)?.message ?? '');
}

export interface RunHostOptions {
  env?: NodeJS.ProcessEnv;
  /** Defaults to the host DB's lease, or memoryLeaseStore() (single replica only) without db. */
  leaseStore?: LeaseStore;
  leaseRenewMs?: number;
  leaseTtlMs?: number;
  exit?: (code: number) => void;
  /** Signal and crash-event source. */
  proc?: NodeJS.EventEmitter;
  logSink?: LogSink;
  authFactory?: ProviderFactory;
  brokerOps?: BrokerOps;
  ownerPruneMs?: number;
  brokerPollMs?: number;
  fatalStopMs?: number;
  storeCloseMs?: number;
  /** Tests: more store migrations on the holder, run like the real ones. */
  extraStoreTracks?: readonly PgTrack[];
  /** GitHub API base for the App credential helper (tests). */
  githubApiBase?: string;
}

export interface RunningHost {
  server: Server;
  shutdown(code: number): Promise<void>;
}

export async function runHost(opts: RunHostOptions = {}): Promise<RunningHost> {
  const log = createLogger(opts.logSink);
  const proc = opts.proc ?? process;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  // Node's default SIGHUP action exits; the handler stays for the life of the process.
  let onHup = (): void => undefined;
  proc.on('SIGHUP', () => onHup());
  let lease: LeaseManager | undefined;
  let fatal = false;
  const uninstallGuards = installCrashGuards(
    log,
    () => {
      fatal = true;
      host?.halt(1011, 'host failed');
      const stopped = lease ? lease.stop() : Promise.resolve();
      const bound = new Promise<void>((resolve) => setTimeout(resolve, opts.fatalStopMs ?? FATAL_STOP_MS).unref());
      void Promise.race([stopped, bound]).finally(() => exit(1));
    },
    proc
  );

  const env = readHostEnv(opts.env ?? process.env);
  const factory = opts.authFactory ?? githubProviderFactory;
  let config!: HostConfig;
  let auth!: AuthContext;
  let host: HostServer | undefined;

  const reloader = createReloader({
    path: env.configPath,
    load: loadHostConfig,
    apply: async (next) => {
      config = next;
      auth = buildAuthContext(next, factory);
      if (next.trustedProxyHops > 0) {
        log.log('warn', 'trustedProxyHops > 0: per-address limiting keys on the Twingate connector here; leave 0', {
          trustedProxyHops: next.trustedProxyHops
        });
      }
      await host?.reverifyAll();
    },
    log
  });
  if (!(await reloader.reload('start'))) {
    uninstallGuards();
    throw new Error(`host config rejected: ${env.configPath}`);
  }
  const procEnv = opts.env ?? process.env;
  try {
    // An invalid db block fails here, before listening; only connecting is retried.
    if (config.db) pgPoolConfig(config.db, procEnv);
    else log.log('warn', 'no db configured: process-local lease and no ingest; run exactly one replica');
  } catch (err) {
    uninstallGuards();
    throw err;
  }
  let cred: CredServer | null = null;
  try {
    const app = config.github?.app;
    if (app) cred = await startCredHelper({ app, socketPath: env.credSocket, github: () => config.github, log, apiBase: opts.githubApiBase });
    else log.log('info', 'github app credential helper off (github.appId unset)');
  } catch (err) {
    uninstallGuards();
    throw err;
  }

  const ops = opts.brokerOps ?? realBrokerOps(env.brokerSocket);
  const hub = new AttachHub(ops, { hostPort: env.port, log });
  const events = new EventHub();
  const holderId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  // Set by bringUp(); with db the server listens before they exist.
  let hostDb: HostDbHandle | null = null;
  let dbHealth: DbHealth | null = null;
  let workspaceId: string | null = null;
  let leaseMgr: LeaseManager | null = null;
  let started = false;
  const startAbort = new AbortController();
  const server = createHostServer({
    workspace: () => ({ ...config.workspace, id: workspaceId as string }),
    auth: () => auth,
    lease: () => leaseMgr?.state ?? 'standby',
    healthy: () => !!leaseMgr?.running && (dbHealth?.ok() ?? true),
    db: () => (!config.db ? 'none' : !dbHealth ? 'connecting' : dbHealth.ok() ? 'ok' : 'down'),
    starting: () => !started,
    hub,
    events,
    rpc: brokerRpcChannels(ops, hub.owners, env.port),
    log,
    trustedProxyHops: () => config.trustedProxyHops
  });
  host = server;

  const stopWatch = watchConfigDir(
    env.configPath,
    () => void reloader.reload('file change'),
    undefined,
    (err) => log.log('warn', 'config watch failed; SIGHUP still reloads', { error: err.message })
  );
  onHup = () => void reloader.reload('SIGHUP');

  const watch = brokerWatch(ops, events, hub);
  let polling = false;
  const poller = setInterval(() => {
    if (polling || leaseMgr?.state !== 'holder' || events.size === 0) return;
    polling = true;
    watch
      .poll()
      .catch((err: Error) => log.log('warn', 'broker poll failed', { error: err.message }))
      .finally(() => (polling = false));
  }, opts.brokerPollMs ?? BROKER_POLL_MS);
  const pruner = setInterval(() => {
    if (leaseMgr?.state !== 'holder') return;
    pruneDeadOwners(ops, hub).catch((err: Error) => log.log('warn', 'owner prune failed', { error: err.message }));
  }, opts.ownerPruneMs ?? OWNER_PRUNE_MS);

  const storeCloseMs = opts.storeCloseMs ?? STORE_CLOSE_MS;
  async function closeWithin(what: string, close: () => Promise<unknown>): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const closed = close().then(
      () => true,
      (err: Error) => {
        log.log('warn', 'store close failed', { what, error: err.message });
        return true;
      }
    );
    const timedOut = new Promise<false>((r) => (timer = setTimeout(() => r(false), storeCloseMs)));
    if (!(await Promise.race([closed, timedOut]))) log.log('warn', 'store close timed out', { what, ms: storeCloseMs });
    clearTimeout(timer);
  }

  let holderP: Promise<Holder | null> | null = null;
  let stopping: Promise<void> | null = null;
  function shutdown(code: number): Promise<void> {
    stopping ??= (async () => {
      log.log('info', 'shutting down', { code, lease: leaseMgr?.state ?? 'standby' });
      startAbort.abort();
      clearInterval(poller);
      clearInterval(pruner);
      stopWatch();
      onHup = () => undefined;
      proc.off('SIGTERM', onTerm);
      proc.off('SIGINT', onTerm);
      // Frames stop before the lease is released, so no viewer acts during the handover.
      server.halt(1001, 'host shutting down');
      // Holder resources close while the lease still fences their last writes.
      if (holderP) await closeWithin('holder stores', async () => (await holderP)?.stop());
      await leaseMgr?.stop();
      await server.close();
      await cred?.close();
      dbHealth?.stop();
      const pool = hostDb;
      if (pool) await closeWithin('host pool', () => pool.end());
      uninstallGuards();
      if (!fatal) exit(code);
    })();
    return stopping;
  }
  const onTerm = (): void => void shutdown(0);
  proc.once('SIGTERM', onTerm);
  proc.once('SIGINT', onTerm);

  async function bringUp(): Promise<void> {
    if (config.db) {
      const h = await openHostDbRetrying(config.db, { env: procEnv, log, signal: startAbort.signal });
      hostDb = h;
      dbHealth = startDbHealth(h.ping, { log });
    }
    const id = await resolveWorkspaceId(env.stateDir, config.workspace.id);
    if (startAbort.signal.aborted) return;
    const renewMs = opts.leaseRenewMs ?? LEASE_RENEW_MS;
    const ttlMs = opts.leaseTtlMs ?? LEASE_TTL_MS;
    workspaceId = id;
    const m = new LeaseManager({
      holder: holderId,
      store: opts.leaseStore ?? (hostDb ? postgresLeaseStore(hostDb.k, id, { lockTimeoutMs: Math.floor((ttlMs - renewMs) / 2) }) : memoryLeaseStore()),
      renewMs,
      ttlMs,
      onError: (err) => log.log('warn', 'lease store error', { error: err.message })
    });
    leaseMgr = m;
    lease = m;
    m.on('acquired', (epoch: number) => {
      log.log('info', 'lease acquired', { epoch, workspaceId: id });
      const db = config.db;
      if (!db || startAbort.signal.aborted) return;
      holderP = startHolder({
        db,
        env: procEnv,
        workspaceId: id,
        holder: holderId,
        epoch: () => (m.state === 'holder' ? m.epoch : null),
        onLost: () => m.markLost('superseded'),
        log,
        extraTracks: opts.extraStoreTracks
      }).catch((err: Error) => {
        log.log('error', 'holder start failed; giving up the lease', { error: err.message });
        m.markLost(isDbUnavailable(err) ? 'unreachable' : 'superseded');
        return null;
      });
    });
    m.on('lost', (reason: LostReason) => {
      log.log('error', 'lease lost; exiting', { reason });
      void shutdown(reason === 'unreachable' ? EXIT_DB_UNAVAILABLE : 1);
    });
    m.start();
    if (config.db) await m.tick();
    started = true;
  }

  if (!config.db) {
    try {
      await bringUp();
    } catch (err) {
      await cred?.close();
      uninstallGuards();
      throw err;
    }
  }
  await new Promise<void>((resolve, reject) => {
    server.server.once('error', reject);
    server.server.listen(env.port, '0.0.0.0', () => {
      server.server.off('error', reject);
      resolve();
    });
  });
  log.log('info', 'fleet-host listening', { port: env.port, workspaceId, workspace: config.workspace.name });
  if (config.db) {
    void bringUp().then(
      () => started && log.log('info', 'fleet-host ready', { workspaceId, lease: leaseMgr?.state }),
      (err: Error) => {
        if (startAbort.signal.aborted) return;
        log.log('error', 'host start failed; exiting', { error: err.message });
        void shutdown(1);
      }
    );
  }
  return { server: server.server, shutdown };
}
