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
import { openHostDbRetrying, startDbHealth, type DbHealth, type HostDbHandle } from './hostDb.js';
import { resolveWorkspaceId } from './hostState.js';
import { LeaseManager, memoryLeaseStore, type LeaseStore } from './lease.js';
import { createLogger, type LogSink } from './log.js';
import { brokerRpcChannels } from './rpc.js';
import { createHostServer, installCrashGuards, type HostServer } from './server.js';

export const BROKER_POLL_MS = 2_000;
export const OWNER_PRUNE_MS = 60_000;
/** Bound on releasing the lease after a crash; the process then exits regardless. */
export const FATAL_STOP_MS = 2_000;

export interface RunHostOptions {
  env?: NodeJS.ProcessEnv;
  /** Defaults to memoryLeaseStore(), which is correct only for a single replica. */
  leaseStore?: LeaseStore;
  exit?: (code: number) => void;
  /** Signal and crash-event source. */
  proc?: NodeJS.EventEmitter;
  logSink?: LogSink;
  authFactory?: ProviderFactory;
  brokerOps?: BrokerOps;
  ownerPruneMs?: number;
  brokerPollMs?: number;
  fatalStopMs?: number;
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
  let hostDb: HostDbHandle | null = null;
  let dbHealth: DbHealth | null = null;
  try {
    if (config.db) {
      hostDb = await openHostDbRetrying(config.db, { env: opts.env ?? process.env, log });
      dbHealth = startDbHealth(hostDb.ping, { log });
    } else {
      log.log('warn', 'no db configured: process-local lease and no ingest; run exactly one replica');
    }
  } catch (err) {
    uninstallGuards();
    throw err;
  }
  const workspaceId = await resolveWorkspaceId(env.stateDir, config.workspace.id);
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
  const leaseMgr = new LeaseManager({
    holder: `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`,
    store: opts.leaseStore ?? memoryLeaseStore(),
    onError: (err) => log.log('warn', 'lease store error', { error: err.message })
  });
  lease = leaseMgr;
  const server = createHostServer({
    workspace: () => ({ ...config.workspace, id: workspaceId }),
    auth: () => auth,
    lease: () => leaseMgr.state,
    healthy: () => leaseMgr.running && (dbHealth?.ok() ?? true),
    db: () => (dbHealth ? (dbHealth.ok() ? 'ok' : 'down') : 'none'),
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
    if (polling || leaseMgr.state !== 'holder' || events.size === 0) return;
    polling = true;
    watch
      .poll()
      .catch((err: Error) => log.log('warn', 'broker poll failed', { error: err.message }))
      .finally(() => (polling = false));
  }, opts.brokerPollMs ?? BROKER_POLL_MS);
  const pruner = setInterval(() => {
    if (leaseMgr.state !== 'holder') return;
    pruneDeadOwners(ops, hub).catch((err: Error) => log.log('warn', 'owner prune failed', { error: err.message }));
  }, opts.ownerPruneMs ?? OWNER_PRUNE_MS);

  let stopping: Promise<void> | null = null;
  function shutdown(code: number): Promise<void> {
    stopping ??= (async () => {
      log.log('info', 'shutting down', { code, lease: leaseMgr.state });
      clearInterval(poller);
      clearInterval(pruner);
      stopWatch();
      onHup = () => undefined;
      proc.off('SIGTERM', onTerm);
      proc.off('SIGINT', onTerm);
      // Frames stop before the lease is released, so no viewer acts during the handover.
      server.halt(1001, 'host shutting down');
      await leaseMgr.stop();
      await server.close();
      await cred?.close();
      dbHealth?.stop();
      await hostDb?.end().catch(() => undefined);
      uninstallGuards();
      if (!fatal) exit(code);
    })();
    return stopping;
  }
  const onTerm = (): void => void shutdown(0);

  leaseMgr.on('acquired', (epoch: number) => log.log('info', 'lease acquired', { epoch, workspaceId }));
  leaseMgr.on('lost', () => {
    log.log('error', 'lease lost; exiting');
    void shutdown(1);
  });
  proc.once('SIGTERM', onTerm);
  proc.once('SIGINT', onTerm);

  leaseMgr.start();
  await new Promise<void>((resolve, reject) => {
    server.server.once('error', reject);
    server.server.listen(env.port, '0.0.0.0', () => {
      server.server.off('error', reject);
      resolve();
    });
  });
  log.log('info', 'fleet-host listening', { port: env.port, workspaceId, workspace: config.workspace.name });
  return { server: server.server, shutdown };
}
