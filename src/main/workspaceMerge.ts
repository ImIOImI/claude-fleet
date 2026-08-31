// Backend-merge for workspace:list, extracted from ipc.ts so the docker-
// degraded-mode logic (#380) is unit-testable without electron. Live entries
// win for state/status; manifests provide the user-facing fields. When the
// docker backend is unreachable (daemon-connect error ONLY), container
// manifests are synthesized as state:'unreachable' from the last-known-state
// map instead of falling through to a false 'deleted'.
import type { Workspace, WorkspaceSpec, WorkspaceState } from './workspaces.js';

// Shape-only import: FACTORY_MIRROR's type. Use whatever type ipc.ts's
// `mirror` field carries (see WorkspaceSpec['mirror']).
type Mirror = NonNullable<WorkspaceSpec['mirror']>;

const DAEMON_CONNECT_CODES = new Set(['ECONNREFUSED', 'ENOENT', 'ENOTFOUND', 'EPIPE', 'ECONNRESET']);

/** True only for "the daemon socket isn't there / hung up" errors. Anything
 *  else (API errors, label filter bugs) must keep rejecting loudly. */
export function isDaemonConnectError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && DAEMON_CONNECT_CODES.has(code);
}

export interface MergeOptions {
  dockerResult: PromiseSettledResult<Workspace[]>;
  localLive: Workspace[];
  manifests: WorkspaceSpec[];
  /** Mutated in place: repopulated from merged container states on docker
   *  success; read for synthesis on daemon-connect failure. */
  lastKnown: Map<string, WorkspaceState>;
  privateDir: (id: string) => Promise<string>;
  factoryMirror: Mirror;
}

export async function mergeWorkspaces(opts: MergeOptions): Promise<Workspace[]> {
  const { dockerResult, localLive, manifests, lastKnown, privateDir, factoryMirror } = opts;
  const dockerDown = dockerResult.status === 'rejected';
  if (dockerDown && !isDaemonConnectError(dockerResult.reason)) throw dockerResult.reason;
  const dockerLive = dockerResult.status === 'fulfilled' ? dockerResult.value : [];

  // ── identical to the previous ipc.ts merge ──────────────────────────────
  const liveById = new Map<string, Workspace>();
  for (const w of [...dockerLive, ...localLive]) if (!liveById.has(w.id)) liveById.set(w.id, w);
  const manifestById = new Map(manifests.map((m) => [m.id, m]));
  const result: Workspace[] = [];

  for (const w of liveById.values()) {
    const m = manifestById.get(w.id);
    result.push({
      ...w,
      // Manifest is authoritative for user-facing fields; container labels
      // only carry id/name/subdir/workspaceRoot.
      name: m?.name ?? w.name,
      description: m?.description,
      labels: m?.labels ?? w.labels,
      color: m?.color,
      // Container: workspaceRoot is always the canonical private folder derived
      // from the fleet root + id — never trust stale labels/manifests (a
      // container created before the fleet-root migration still carries the old
      // path). Local: the user picked an existing host dir, so honor the
      // manifest's workspaceRoot (#16).
      workspaceRoot: w.kind === 'local' ? m?.workspaceRoot ?? w.workspaceRoot : await privateDir(w.id),
      workspaceSubdir: w.workspaceSubdir || m?.workspaceSubdir || '',
      authMode: m?.authMode ?? w.authMode,
      endpointId: m?.endpointId,
      env: m?.env ?? w.env,
      resources: m?.resources,
      mirror: m?.mirror ?? factoryMirror,
      installedLoadouts: m?.installedLoadouts ?? [],
      control: m?.control,
      accessibility: m?.accessibility,
      createdAt: m?.createdAt ?? w.createdAt,
      lastUsedAt: m?.lastUsedAt ?? w.lastUsedAt
    });
    manifestById.delete(w.id);
  }

  for (const m of manifestById.values()) {
    const root = m.kind === 'local' ? m.workspaceRoot : await privateDir(m.id);
    if (dockerDown && m.kind !== 'local') {
      // Degraded synthesis (#380). Honest-state rule: a last-known 'deleted'
      // stays 'deleted' (the last successful listing proved the container
      // gone; an outage doesn't un-prove it).
      const lk = lastKnown.get(m.id);
      result.push({
        ...m,
        workspaceRoot: root,
        state: lk === 'deleted' ? 'deleted' : 'unreachable',
        ...(lk !== undefined && lk !== 'deleted' && lk !== 'unreachable'
          ? { lastKnownState: lk as Workspace['lastKnownState'] }
          : {})
      });
    } else {
      result.push({ ...m, workspaceRoot: root, state: 'deleted' });
    }
  }

  // Refresh the last-known map only from a successful docker listing — a
  // down-merge must not overwrite the states it needs for synthesis.
  if (!dockerDown) {
    lastKnown.clear();
    for (const w of result) if (w.kind !== 'local') lastKnown.set(w.id, w.state);
  }
  return result;
}
