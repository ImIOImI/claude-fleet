// What only the lease holder runs: the stores, fenced by the lease epoch,
// ingest, the transcript indexer, the automation runtime and the fleet-state MCP socket.
import { closeDb, stateKysely } from '../main/db.js';
import { openPgMcpReadSource } from '../main/store/pgReadSource.js';
import { postgresKysely } from '../main/store/postgres.js';
import type { PgTrack } from '../main/store/pgMigrate.js';
import { migratePgStores, openPgStores, type PgStores } from '../main/store/pgStores.js';
import type { OwnedReadSource } from '../main/store/readSource.js';
import type { EmbedFn } from '../main/vectors.js';
import { queryLogin, type PostgresStoreConfig } from '../main/store/storeConfig.js';
import { HOST_PG_POOL } from './hostDb.js';
import { historyReader, type HistoryReader } from './historyRead.js';
import { HostIngest } from './hostIngest.js';
import type { HostDb } from './hostSchema.js';
import type { BrokerOps } from './brokerOps.js';
import type { HostAutomationEntry } from './config.js';
import { startHostEmbedder, type HostEmbedder, type HostEmbedderOptions } from './embedder.js';
import type { EventHub } from './events.js';
import { startHostAutomations, type HostAutomations } from './hostAutomations.js';
import { startHostIndexer } from './hostIndexer.js';
import type { ListenTarget } from './endpoint.js';
import { startHostMcp, type HostMcp } from './hostMcp.js';
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
  /** The MCP's listener, the `--mcp-config` argument fresh steps get, and the mesh gate (false: never serve). */
  mcp: { listen: ListenTarget; args: string[]; ready: Promise<boolean> };
  /** First retry delay after a failed MCP start; doubles up to MCP_RETRY_MAX_MS. */
  mcpRetryMs?: number;
  /** D79: false = no sidecar, indexer or search_transcripts. */
  search: { embedder: boolean };
  embedDir: string;
  /** Tests: a stand-in sidecar. */
  embedder?: Pick<HostEmbedderOptions, 'launch' | 'env'>;
}

export interface Holder {
  stores: PgStores;
  automations: HostAutomations;
  history: HistoryReader;
  stop(): Promise<void>;
}

export const MCP_RETRY_MS = 1_000;
export const MCP_RETRY_MAX_MS = 60_000;
export const SUMMARY_HINT_MS = 2_000;

/** Calls `fn` once, `ms` after the first bump of a quiet period. */
export function trailingHint(
  fn: () => void, ms: number,
  schedule: (fn: () => void, ms: number) => () => void = (f, d) => { const t = setTimeout(f, d); t.unref?.(); return () => clearTimeout(t); },
): { bump(): void; stop(): void } {
  let cancel: (() => void) | null = null;
  let stopped = false;
  return {
    bump() {
      if (stopped || cancel) return;
      cancel = schedule(() => { cancel = null; if (!stopped) fn(); }, ms);
    },
    stop() {
      stopped = true;
      cancel?.();
      cancel = null;
    },
  };
}

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
  const embedder: HostEmbedder | null = o.search.embedder ? startHostEmbedder({ dir: o.embedDir, log: o.log, ...o.embedder }) : null;
  const indexer = embedder?.state() === 'ready'
    ? startHostIndexer({ embed: embedder.embed, log: o.log, paused: () => embedder.state() !== 'ready' })
    : null;
  const hint = trailingHint(() => o.events.publish('observability:summary', { workspaceId: o.workspaceId }), SUMMARY_HINT_MS);
  const ingest = new HostIngest({
    projectsDir: o.projectsDir, workspaceId: o.workspaceId, offsetsRead, log: o.log,
    onIngested: (id) => { hint.bump(); indexer?.bump(id); }
  });
  let automations: HostAutomations | null = null;
  // Fenced: provisioning and each call's mcp_grants rewrite are writes on the state handle.
  const mcp = mcpServer(o, embedder?.embed, () =>
    openPgMcpReadSource(stores.poolConfig.schema, stores.poolConfig, (message) => o.log.log('warn', 'mcp query isolation', { error: message }), {
      preprovisioned: queryLogin(o.db, stores.poolConfig, o.env)
    }));
  const stopAll = async (): Promise<void> => {
    hint.stop();
    await mcp.stop();
    await automations?.stop();
    await indexer?.stop();
    embedder?.close();
    await ingest.stop();
    await offsetsRead.destroy();
    await stores.inbox.close();
    await closeDb();
    await stores.end();
  };
  try {
    await ingest.start();
    if (indexer) void indexer.backfill().catch((err: Error) => o.log.log('warn', 'index backfill failed', { error: err.message }));
    automations = await startHostAutomations({
      inbox: stores.inbox, workspace: o.workspace, ops: o.ops, mcpArgs: o.mcp.args, events: o.events, log: o.log
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
    history: historyReader(stateKysely, o.workspaceId),
    stop() {
      stopping ??= stopAll();
      return stopping;
    }
  };
}

/** The MCP socket, retried with backoff. Each attempt gets its own read source (a failed start closes it). */
function mcpServer(o: HolderOptions, embed: EmbedFn | undefined, readSource: () => Promise<OwnedReadSource>): { start(): void; stop(): Promise<void> } {
  let served: HostMcp | null = null;
  let attempt: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let delay = o.mcpRetryMs ?? MCP_RETRY_MS;
  const tryStart = (): void => {
    timer = null;
    attempt = readSource()
      .then((rs) => startHostMcp({ listen: o.mcp.listen, workspaceId: o.workspaceId, log: o.log, readSource: rs, embed }))
      .then(
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
    start: () => void o.mcp.ready.then((ok) => {
      if (ok && !stopped) tryStart();
    }),
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await attempt;
      await served?.close();
      served = null;
    }
  };
}
