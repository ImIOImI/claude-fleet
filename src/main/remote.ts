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

type RemoteSpec = WorkspaceSpec & { kind: 'remote'; remote: NonNullable<WorkspaceSpec['remote']> };

export interface RemoteBackendDeps {
  token(): Promise<string | null>;
  listManifests(): Promise<WorkspaceSpec[]>;
  writeManifest(spec: WorkspaceSpec): Promise<void>;
  /** Delete the bookmark's local state dir (manifest + local tab list). */
  deleteState(id: string): Promise<void>;
  now?: () => number;
}

export interface RemoteBackend extends Backend {
  clientFor(url: string): RemoteClient;
  /** Re-read /whoami for a bookmark and persist a changed tier. */
  refreshTier(spec: WorkspaceSpec): Promise<WhoAmI>;
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
  const lastWhoami = new Map<string, number>();

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
    lastWhoami.set(spec.id, now());
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

  async function liveRow(spec: RemoteSpec): Promise<Workspace> {
    const row = (state: Workspace['state'], s: WorkspaceSpec = spec): Workspace => ({ ...s, state, containerId: spec.id });
    try {
      if ((await clientFor(spec.remote.url).healthz()).lease !== 'holder') return row('unreachable');
    } catch {
      return row('unreachable');
    }
    if (now() - (lastWhoami.get(spec.id) ?? -Infinity) < TIER_REFRESH_MS) return row('running');
    try {
      const who = await refreshTier(spec);
      return row('running', { ...spec, remote: { ...spec.remote, tier: who.tier, login: who.user.login } });
    } catch (err) {
      return row(err instanceof WrongWorkspaceError ? 'unreachable' : 'running');
    }
  }

  return {
    clientFor,
    refreshTier,
    ping: async () => true,
    ensureImage: managed,
    async listLiveWorkspaces() {
      return Promise.all((await deps.listManifests()).filter(isRemote).map(liveRow));
    },
    createWorkspace: managed,
    inspectImage: managed,
    startWorkspace: managed,
    isResumeImageStale: async () => false,
    pauseWorkspace: managed,
    stopWorkspace: managed,
    async removeWorkspace(containerId) {
      const spec = await bookmark(containerId);
      await deps.deleteState(spec.id);
      lastWhoami.delete(spec.id);
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
