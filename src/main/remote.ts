// The `remote` backend (remote-workspaces §6): a bookmark of a fleet-host.
// Lifecycle belongs to the deployment, so start/pause/stop/image calls throw;
// liveness is /healthz, attach is /attach. The tier on the bookmark is display
// only: attach decides from a fresh /whoami, and the host enforces regardless.
import type { Backend } from './backend.js';
import type { Workspace, WorkspaceSpec } from './workspaces.js';
import { attachRemotePty } from './remoteAttach.js';
import { RemoteClient, RemoteError, type WhoAmI } from './remoteClient.js';

export const MANAGED_MSG = 'This remote workspace is managed by its deployment';
export const TIER_REFRESH_MS = 60_000;
export const HEALTH_POLL_MS = 15_000;
/** `status` of a bookmark not probed yet this run. */
export const CHECKING_STATUS = 'checking host';

type RemoteSpec = WorkspaceSpec & { kind: 'remote'; remote: NonNullable<WorkspaceSpec['remote']> };

export interface RemoteBackendDeps {
  token(): Promise<string | null>;
  /** The signed-in login; a change voids the /whoami throttle. */
  login?: () => Promise<string | null>;
  listManifests(): Promise<WorkspaceSpec[]>;
  writeManifest(spec: WorkspaceSpec): Promise<void>;
  /** Delete the bookmark's local state dir (manifest + local tab list). */
  deleteState(id: string): Promise<void>;
  /** Withdraw every local workspace's publish opt-in towards this bookmark. */
  revokePublish?: (id: string) => Promise<void>;
  now?: () => number;
  /** Timer seam; returns a cancel. Default: an unref'd setTimeout. */
  schedule?: (fn: () => void, ms: number) => () => void;
}

export interface RemoteSourceInfo {
  id: string;
  url: string;
  name: string;
  hue: number | null;
  tier: 'read' | 'steer' | 'session' | null;
  state: 'running' | 'unreachable' | null;
}

export interface RemoteBackend extends Backend {
  clientFor(url: string): RemoteClient;
  /** Re-read /whoami for a bookmark and persist a changed tier. */
  refreshTier(spec: WorkspaceSpec): Promise<WhoAmI>;
  /** Probe now (one bookmark or all known) and wait for the result. */
  refresh(id?: string): Promise<void>;
  /** Stop every background probe (app quit). */
  stop(): void;
  /** Bookmarks the probe loop knows, with cached liveness; no I/O. */
  sources(): RemoteSourceInfo[];
  isRemote(id: string): boolean;
}

interface Watch {
  spec: RemoteSpec;
  state: 'running' | 'unreachable' | null;
  inflight: Promise<void> | null;
  cancel: (() => void) | null;
}

const managed = async (): Promise<never> => {
  throw new Error(MANAGED_MSG);
};
const unsupported = (what: string) => async (): Promise<never> => {
  throw new Error(`${what} is not available for remote workspaces`);
};

class WrongWorkspaceError extends RemoteError {
  constructor(message: string) {
    super('protocol', message);
  }
}

const isRemote = (s: WorkspaceSpec | undefined): s is RemoteSpec => s?.kind === 'remote' && !!s.remote;

export function createRemoteBackend(deps: RemoteBackendDeps): RemoteBackend {
  const now = deps.now ?? Date.now;
  const clients = new Map<string, RemoteClient>();
  const login = deps.login ?? (async () => null);
  const lastWhoami = new Map<string, { at: number; login: string | null }>();
  const watches = new Map<string, Watch>();
  let stopped = false;
  const schedule =
    deps.schedule ??
    ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return () => clearTimeout(t);
    });

  function clientFor(url: string): RemoteClient {
    let c = clients.get(url);
    if (!c) {
      c = new RemoteClient({ url, token: deps.token });
      clients.set(url, c);
    }
    return c;
  }

  async function bookmark(id: string): Promise<RemoteSpec> {
    const m = (await deps.listManifests()).find((s) => s.id === id);
    if (!isRemote(m)) throw new Error(`no remote workspace ${id}`);
    return m;
  }

  async function refreshTier(spec: WorkspaceSpec): Promise<WhoAmI> {
    if (!isRemote(spec)) throw new Error(`no remote workspace ${spec.id}`);
    const url = spec.remote.url;
    lastWhoami.set(spec.id, { at: now(), login: await login().catch(() => null) });
    const who = await clientFor(url).whoami();
    if (who.workspace.id !== spec.id) {
      throw new WrongWorkspaceError(`${url} now serves a different workspace; forget this one and add it again`);
    }
    // Re-read so a concurrent rename or re-add isn't clobbered; only the tier fields change.
    const cur = (await deps.listManifests()).find((s) => s.id === spec.id);
    if (isRemote(cur) && cur.remote.url === url && (cur.remote.tier !== who.tier || cur.remote.login !== who.user.login)) {
      await deps.writeManifest({ ...cur, remote: { ...cur.remote, tier: who.tier, login: who.user.login, checkedAt: now() } });
    }
    return who;
  }

  async function whoamiFresh(id: string): Promise<boolean> {
    const last = lastWhoami.get(id);
    return !!last && now() - last.at < TIER_REFRESH_MS && last.login === (await login().catch(() => null));
  }

  const retryAfter = (err: unknown): number => (err instanceof RemoteError ? (err.retryAfterMs ?? 0) : 0);

  async function probeState(spec: RemoteSpec): Promise<{ state: 'running' | 'unreachable'; retryAfterMs: number }> {
    try {
      if ((await clientFor(spec.remote.url).healthz()).lease !== 'holder') return { state: 'unreachable', retryAfterMs: 0 };
    } catch (err) {
      return { state: 'unreachable', retryAfterMs: retryAfter(err) };
    }
    if (await whoamiFresh(spec.id)) return { state: 'running', retryAfterMs: 0 };
    try {
      await refreshTier(spec);
      return { state: 'running', retryAfterMs: 0 };
    } catch (err) {
      return { state: err instanceof WrongWorkspaceError ? 'unreachable' : 'running', retryAfterMs: retryAfter(err) };
    }
  }

  function unwatch(id: string): void {
    watches.get(id)?.cancel?.();
    watches.delete(id);
  }

  function probe(w: Watch): Promise<void> {
    if (w.inflight) return w.inflight;
    w.cancel?.();
    w.cancel = null;
    w.inflight = probeState(w.spec).then(({ state, retryAfterMs }) => {
      w.inflight = null;
      if (watches.get(w.spec.id) !== w || stopped) return;
      w.state = state;
      w.cancel = schedule(() => void probe(w), Math.max(HEALTH_POLL_MS, retryAfterMs));
    });
    return w.inflight;
  }

  /** Track the current bookmarks; never waits on the network. */
  function sync(remotes: RemoteSpec[]): void {
    const ids = new Set(remotes.map((r) => r.id));
    for (const id of [...watches.keys()]) if (!ids.has(id)) unwatch(id);
    for (const spec of remotes) {
      const w = watches.get(spec.id);
      if (w && w.spec.remote.url === spec.remote.url) {
        w.spec = spec;
        continue;
      }
      unwatch(spec.id);
      const fresh: Watch = { spec, state: null, inflight: null, cancel: null };
      watches.set(spec.id, fresh);
      if (!stopped) void probe(fresh);
    }
  }

  function row(spec: RemoteSpec): Workspace {
    const state = watches.get(spec.id)?.state ?? null;
    return { ...spec, state: state ?? 'unreachable', containerId: spec.id, ...(state === null ? { status: CHECKING_STATUS } : {}) };
  }

  return {
    clientFor,
    refreshTier,
    ping: async () => true,
    ensureImage: managed,
    async listLiveWorkspaces() {
      const remotes = (await deps.listManifests()).filter(isRemote);
      sync(remotes);
      return remotes.map(row);
    },
    async refresh(id) {
      if (stopped) return;
      sync((await deps.listManifests()).filter(isRemote));
      await Promise.all([...watches.values()].filter((w) => id === undefined || w.spec.id === id).map(probe));
    },
    stop() {
      stopped = true;
      for (const id of [...watches.keys()]) unwatch(id);
    },
    sources: () =>
      [...watches.values()].map((w) => ({
        id: w.spec.id, url: w.spec.remote.url, name: w.spec.name, hue: w.spec.color?.hue ?? null, tier: w.spec.remote.tier, state: w.state
      })),
    isRemote: (id) => watches.has(id),
    createWorkspace: managed,
    inspectImage: managed,
    startWorkspace: managed,
    isResumeImageStale: async () => false,
    pauseWorkspace: managed,
    stopWorkspace: managed,
    async removeWorkspace(containerId) {
      const spec = await bookmark(containerId);
      await deps.revokePublish?.(spec.id);
      await deps.deleteState(spec.id);
      lastWhoami.delete(spec.id);
      unwatch(spec.id);
    },
    async attachPty(containerId, sessionId, cols, rows, resumeOf) {
      const spec = await bookmark(containerId);
      const who = await refreshTier(spec);
      return attachRemotePty({ client: clientFor(spec.remote.url), sessionId, cols, rows, resumeOf, canCreate: who.tier === 'session' });
    },
    getBrokerLogs: async () => '',
    committeePost: unsupported('Committee post'),
    spawnHeadless: unsupported('Headless sessions'),
    headlessState: unsupported('Headless sessions'),
    closeHeadless: unsupported('Headless sessions'),
    execScript: unsupported('Script steps')
  };
}
