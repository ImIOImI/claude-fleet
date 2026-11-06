// What only the lease holder runs: the stores, fenced by the lease epoch,
// ingest, the automation runtime and the fleet-state MCP socket.
import { closeDb, stateKysely } from '../main/db.js';
import { pgReadSource } from '../main/store/pgReadSource.js';
import { postgresKysely } from '../main/store/postgres.js';
import type { PgTrack } from '../main/store/pgMigrate.js';
import { migratePgStores, openPgStores, type PgStores } from '../main/store/pgStores.js';
import type { PostgresStoreConfig } from '../main/store/storeConfig.js';
import { HOST_PG_POOL } from './hostDb.js';
import { HostIngest } from './hostIngest.js';
import type { HostDb } from './hostSchema.js';
import type { BrokerOps } from './brokerOps.js';
import type { HostAutomationEntry } from './config.js';
import type { EventHub } from './events.js';
import { startHostAutomations, type HostAutomations } from './hostAutomations.js';
import { hostMcpArgs, startHostMcp, type HostMcp } from './hostMcp.js';
import type { Logger } from './log.js';
import { leaseFence, LeaseLostError } from './pgLease.js';

export interface HolderOptions {
  db: PostgresStoreConfig;
  env: NodeJS.ProcessEnv;
  workspaceId: string;
  holder: string;
  epoch(): number | null;
  onLost(): void;
  log: Logger;
  projectsDir: string;
  /** Tests: more store migrations, run like the real ones. */
  extraTracks?: readonly PgTrack[];
  ops: BrokerOps;
  events: Pick<EventHub, 'publish'>;
  workspace: () => { id: string; name: string };
  automations: () => HostAutomationEntry[];
  mcp: { socketPath: string; socketGroup: number | null };
  /** First retry delay after a failed MCP start; doubles up to MCP_RETRY_MAX_MS. */
  mcpRetryMs?: number;
}

export interface Holder {
  stores: PgStores;
  automations: HostAutomations;
  stop(): Promise<void>;
}

export const MCP_RETRY_MS = 1_000;
export const MCP_RETRY_MAX_MS = 60_000;
const NO_QUERY = 'query is unavailable on fleet-host until its MCP isolation ships';

export async function startHolder(o: HolderOptions): Promise<Holder> {
  const fence = leaseFence({
    workspaceId: o.workspaceId,
    holder: o.holder,
    epoch: o.epoch,
    onLost: (err) => {
      o.log.log('error', 'write fenced off; giving up the lease', { error: err.message });
      o.onLost();
    }
  });
  const held = (when: string): void => {
    if (o.epoch() === null) throw new LeaseLostError(`not the holder ${when} store migrations`);
  };
  const stores = await openPgStores(o.db, {
    state: true,
    env: o.env,
    afterBeginWrite: fence,
    onPoolError: (e) => o.log.log('warn', 'store pool error', { error: e.message }),
    pool: HOST_PG_POOL,
    // Unfenced: a fenced migration would hold its fence lock on host_lease, stalling any takeover for the whole run.
    // The advisory lock still serializes migrators.
    migrate: async (pool) => {
      held('before');
      await migratePgStores(pool, { state: true, extraTracks: o.extraTracks });
      held('after');
    }
  });
  // Fenced although only read: offsets are written inside ingest's chunk transaction.
  const offsetsRead = postgresKysely<HostDb>(stores.pool, { afterBeginWrite: fence });
  const ingest = new HostIngest({ projectsDir: o.projectsDir, workspaceId: o.workspaceId, offsetsRead, log: o.log });
  let automations: HostAutomations | null = null;
  const mcp = mcpServer(o);
  const stopAll = async (): Promise<void> => {
    await mcp.stop();
    await automations?.stop();
    await ingest.stop();
    await offsetsRead.destroy();
    await stores.inbox.close();
    await closeDb();
    await stores.end();
  };
  try {
    await ingest.start();
    automations = await startHostAutomations({
      inbox: stores.inbox, workspace: o.workspace, ops: o.ops, mcpArgs: hostMcpArgs(o.mcp.socketPath), events: o.events, log: o.log
    });
    await automations.reconcile(o.automations());
  } catch (err) {
    await stopAll();
    throw err;
  }
  // Last, so no session call lands on a half-built runtime; a failed start retries and never ends the holder.
  mcp.start();
  let stopping: Promise<void> | null = null;
  return {
    stores,
    automations,
    stop() {
      stopping ??= stopAll();
      return stopping;
    }
  };
}

/** The MCP socket, retried with backoff. Each attempt gets its own read source (a failed start closes it). */
function mcpServer(o: HolderOptions): { start(): void; stop(): Promise<void> } {
  let served: HostMcp | null = null;
  let attempt: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let delay = o.mcpRetryMs ?? MCP_RETRY_MS;
  const tryStart = (): void => {
    timer = null;
    attempt = startHostMcp({
      socketPath: o.mcp.socketPath, socketGroup: o.mcp.socketGroup, workspaceId: o.workspaceId, log: o.log,
      readSource: pgReadSource({ isolation: null, unavailable: NO_QUERY, k: stateKysely })
    }).then(
      async (m) => {
        if (stopped) await m.close();
        else served = m;
      },
      (err: Error) => {
        if (stopped) return;
        o.log.log('error', 'mcp start failed; retrying', { error: err.message, inMs: delay });
        timer = setTimeout(tryStart, delay);
        timer.unref?.();
        delay = Math.min(delay * 2, MCP_RETRY_MAX_MS);
      }
    );
  };
  return {
    start: tryStart,
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await attempt;
      await served?.close();
      served = null;
    }
  };
}
