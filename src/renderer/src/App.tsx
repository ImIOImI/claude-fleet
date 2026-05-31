import { useEffect, useState } from 'react';
import { WorkspaceTabStrip } from './components/WorkspaceTabStrip';
import { SessionsPane } from './components/SessionsPane';
import { ObservabilityPane } from './components/ObservabilityPane';
import { TerminalPane } from './components/TerminalPane';
import { BottomBar } from './components/BottomBar';
import { WorkspaceModal } from './components/WorkspaceModal';
import type { WorkspaceFormSubmit } from './components/WorkspaceForm';
import { CloseWorkspaceModal } from './components/CloseWorkspaceModal';
import type { WorkspaceObservabilitySummary } from '../../preload';

export type WorkspaceState = 'running' | 'paused' | 'stopped' | 'deleted';
export type WorkspaceKind = 'container' | 'local';
export type AuthMode = 'oauth' | 'apikey';

export interface WorkspaceColor {
  hue: number;
}
export interface WorkspaceEnv {
  plain: Record<string, string>;
  secretKeys: string[];
}
export interface WorkspaceResources {
  cpus?: number;
  memoryMb?: number;
}

/**
 * Render-side projection of the main-process `Workspace` type. Identity is
 * the ULID (`id`) — stable across renames, container churn, etc. The
 * `containerId` is only present for live workspaces (state !== 'deleted')
 * and is what backend operations like attach/stop/pause/remove need.
 */
export interface WorkspaceSummary {
  id: string;
  name: string;
  description?: string;
  labels: string[];
  color?: WorkspaceColor;
  containerId?: string;
  state: WorkspaceState;
  status?: string;
  workspaceRoot: string;
  workspaceSubdir: string;
  kind: WorkspaceKind;
  image?: string;
  authMode: AuthMode;
  env: WorkspaceEnv;
  resources?: WorkspaceResources;
  createdAt: number;
  lastUsedAt: number;
}

// One of 14 preset hues from the workspace color palette (OKLCH L=72%
// C=0.14, evenly spaced 360°/14 ≈ 25.7° apart). If the workspace hasn't
// picked a hue, hash the name into the same space so two workspaces with
// different names get different chip colors without explicit picking.
const PRESET_HUES = Array.from({ length: 14 }, (_, i) => Math.round((i * 360) / 14));
export function hueFor(ws: { name: string; color?: WorkspaceColor }): number {
  if (typeof ws.color?.hue === 'number') return ws.color.hue;
  let h = 0;
  for (let i = 0; i < ws.name.length; i++) h = (h * 31 + ws.name.charCodeAt(i)) >>> 0;
  return PRESET_HUES[h % PRESET_HUES.length];
}

/** CSS background-color for a hue at the workspace palette's L/C. */
export function colorFor(ws: { name: string; color?: WorkspaceColor }): string {
  return `oklch(72% 0.14 ${hueFor(ws)})`;
}

export function App() {
  const apiReady = typeof window !== 'undefined' && !!window.api;
  const [backendReady, setBackendReady] = useState<boolean | null>(null);
  const [vaultAvailable, setVaultAvailable] = useState<boolean | null>(null);
  const [mockMode, setMockMode] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [closeTargetId, setCloseTargetId] = useState<string | null>(null);
  const [summaries, setSummaries] = useState<
    Record<string, WorkspaceObservabilitySummary | null>
  >({});

  // Per-workspace active tab id, bubbled up from TerminalPane.
  // Keyed by workspace id (ULID) — names are mutable, ids aren't.
  const [activeTabByWorkspace, setActiveTabByWorkspace] = useState<
    Record<string, string>
  >({});

  const [activeTabSummary, setActiveTabSummary] = useState<
    WorkspaceObservabilitySummary | null
  >(null);

  const refresh = async () => {
    if (!window.api) return;
    const ok = await window.api.workspace.backendReady();
    setBackendReady(ok);
    if (!ok) {
      setWorkspaces([]);
      return;
    }
    const list = (await window.api.workspace.list()) as WorkspaceSummary[];
    setWorkspaces(list);
  };

  useEffect(() => {
    if (!apiReady) return;
    refresh();
    window.api.vault.available().then(setVaultAvailable);
    window.api.app.mockMode().then(setMockMode);
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [apiReady]);

  // Observability summary distribution. Updates arrive via live push +
  // 30s safety poll. Re-keyed on the sorted workspace-id list so an
  // add/remove triggers resubscribe but a per-workspace lastUsedAt nudge
  // doesn't.
  const liveIds = workspaces
    .filter((w) => w.state !== 'deleted')
    .map((w) => w.id)
    .sort()
    .join(',');
  useEffect(() => {
    if (!apiReady) return;
    if (!liveIds) {
      setSummaries({});
      return;
    }
    const ids = liveIds.split(',');
    let cancelled = false;
    const refreshAll = async (): Promise<void> => {
      const entries = await Promise.all(
        ids.map(async (id) => {
          try {
            const s = await window.api.observability.summaryForWorkspace(id);
            return [id, s] as const;
          } catch {
            return [id, null] as const;
          }
        })
      );
      if (cancelled) return;
      setSummaries(Object.fromEntries(entries));
    };

    void refreshAll();

    const unsubscribe = window.api.observability.onSummary((workspaceId, summary) => {
      if (cancelled) return;
      if (!ids.includes(workspaceId)) return;
      setSummaries((prev) => ({ ...prev, [workspaceId]: summary }));
    });

    const id = setInterval(refreshAll, 30_000);
    return () => {
      cancelled = true;
      unsubscribe();
      clearInterval(id);
    };
  }, [apiReady, liveIds]);

  const selectedWorkspace = workspaces.find((w) => w.id === selectedId) ?? null;
  const selectedWorkspaceId = selectedWorkspace?.id ?? null;
  const activeTabId = selectedWorkspaceId
    ? activeTabByWorkspace[selectedWorkspaceId] ?? null
    : null;
  useEffect(() => {
    if (!apiReady || !selectedWorkspaceId || !activeTabId) {
      setActiveTabSummary(null);
      return;
    }
    let cancelled = false;
    const fetchOne = async (): Promise<void> => {
      try {
        const s = await window.api.observability.summaryForBrokerSession(
          selectedWorkspaceId,
          activeTabId
        );
        if (!cancelled) setActiveTabSummary(s);
      } catch {
        if (!cancelled) setActiveTabSummary(null);
      }
    };
    void fetchOne();
    const unsubscribe = window.api.observability.onSummary((pushedWorkspaceId) => {
      if (pushedWorkspaceId === selectedWorkspaceId) void fetchOne();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [apiReady, selectedWorkspaceId, activeTabId]);

  if (!apiReady) {
    return (
      <div className="app">
        <div className="empty">
          <div className="preload-error">
            <h2>Preload script not loaded</h2>
            <p>
              <code>window.api</code> is undefined — the preload script failed to load. Stop and
              restart <code>npm run dev</code>; if you still see this after a clean restart, check
              the terminal where dev is running for a preload error.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const selected = selectedWorkspace;
  const liveCount = workspaces.filter((w) => w.state !== 'deleted').length;

  /**
   * Persist any newly-typed secret env values to the keychain. Pre-existing
   * secrets the form passed through unchanged (no value in `secrets`,
   * still listed in `secretKeys`) are left alone.
   */
  const persistSecrets = async (id: string, submit: WorkspaceFormSubmit): Promise<void> => {
    for (const [key, value] of Object.entries(submit.secrets)) {
      if (!value) continue;
      try {
        await window.api.vault.setSecret(id, key, value);
      } catch (err) {
        console.warn(`vault.setSecret(${id}, ${key}) failed:`, err);
      }
    }
  };

  /**
   * Mint workspace identity + persist any secret env values to the OS
   * keychain, then call `workspace:create`. Secrets are written *before*
   * the container is created so the main process can resolve them at
   * start time (see docker.ts → vault.resolveEnv).
   */
  const handleCreate = async (
    submit: WorkspaceFormSubmit,
    setStatus: (msg: string | null) => void
  ): Promise<void> => {
    const id = submit.id ?? `ws-${Date.now()}`; // WorkspaceModal mints a real ULID before calling
    const kind = submit.kind;

    if (kind === 'container') {
      await window.api.workspace.ensureImage(({ message }) => setStatus(message));
    }

    await persistSecrets(id, submit);

    setStatus('Creating workspace…');
    await window.api.workspace.create({
      id,
      name: submit.name,
      description: submit.description,
      labels: submit.labels,
      color: submit.color,
      workspaceRoot: submit.workspaceRoot,
      workspaceSubdir: submit.workspaceSubdir,
      kind,
      image: submit.image,
      authMode: submit.authMode,
      env: { plain: submit.plainEnv, secretKeys: submit.secretKeys },
      resources: submit.resources
    });
    setSelectedId(id);
    refresh();
  };

  /**
   * Resume a saved workspace, applying any edits the user made in the
   * Saved-tab expand-edit form. Three cases by the workspace's current
   * state:
   *   - **stopped / paused**: write the updated manifest, then
   *     `workspace:start(id)` resumes the existing container by id-label
   *     lookup. Container-level edits (env, image, resources, authMode)
   *     don't take effect until the container is recreated — Phase 2's
   *     restart-to-apply banner surfaces this.
   *   - **deleted** (manifest exists, no container): the create flow runs
   *     with the original id reused so state-dir + vault + observability
   *     history stay attached.
   *   - **container disappeared between list + click**: `workspace:start`
   *     returns null and we fall through to recreate.
   */
  const handleResume = async (
    submit: WorkspaceFormSubmit,
    setStatus: (msg: string | null) => void
  ): Promise<void> => {
    const id = submit.id;
    if (!id) throw new Error('handleResume requires submit.id');

    await persistSecrets(id, submit);

    // Always write the manifest first so renderer-visible edits
    // (description, labels, color) take effect immediately even if the
    // container needs a restart for env/image changes.
    setStatus('Saving changes…');
    await window.api.workspace.writeManifest({
      id,
      name: submit.name,
      description: submit.description,
      labels: submit.labels,
      color: submit.color,
      workspaceRoot: submit.workspaceRoot,
      workspaceSubdir: submit.workspaceSubdir,
      kind: submit.kind,
      image: submit.image,
      authMode: submit.authMode,
      env: { plain: submit.plainEnv, secretKeys: submit.secretKeys },
      resources: submit.resources,
      createdAt: Date.now(),
      lastUsedAt: Date.now()
    });

    setStatus(`Starting ${submit.name}…`);
    const started = (await window.api.workspace.start(id)) as WorkspaceSummary | null;
    if (started) {
      setSelectedId(id);
      refresh();
      return;
    }
    // No container exists — recreate from spec, reusing the id.
    if (submit.kind === 'container') {
      await window.api.workspace.ensureImage(({ message }) => setStatus(message));
    }
    setStatus('Recreating workspace…');
    await window.api.workspace.create({
      id,
      name: submit.name,
      description: submit.description,
      labels: submit.labels,
      color: submit.color,
      workspaceRoot: submit.workspaceRoot,
      workspaceSubdir: submit.workspaceSubdir,
      kind: submit.kind,
      image: submit.image,
      authMode: submit.authMode,
      env: { plain: submit.plainEnv, secretKeys: submit.secretKeys },
      resources: submit.resources
    });
    setSelectedId(id);
    refresh();
  };

  return (
    <div className="app">
      <WorkspaceTabStrip
        workspaces={workspaces}
        summaries={summaries}
        selectedId={selectedId}
        backendReady={backendReady}
        mockMode={mockMode}
        onSelect={setSelectedId}
        onNewWorkspace={() => setCreateOpen(true)}
        onCloseWorkspace={(w) => setCloseTargetId(w.id)}
        onRefresh={refresh}
      />

      <div className="app-body">
        <SessionsPane />

        <main
          className="main-pane"
          style={selected ? { ['--hue' as never]: `${hueFor(selected)}deg` } : undefined}
        >
          <div className="main-body">
            {backendReady === false ? (
              <DockerDisconnected onRetry={refresh} />
            ) : liveCount === 0 ? (
              <FirstRun onNewWorkspace={() => setCreateOpen(true)} />
            ) : !selected || !selected.containerId ? (
              <div className="empty">
                <p style={{ color: 'var(--text-muted)' }}>No workspace selected.</p>
              </div>
            ) : null}
            {workspaces
              .filter((w) => w.state !== 'deleted' && w.containerId)
              .map((w) => (
                <TerminalPane
                  key={w.id}
                  visible={selectedId === w.id}
                  workspaceId={w.id}
                  containerId={w.containerId!}
                  paused={w.state === 'paused'}
                  summary={summaries[w.id] ?? null}
                  onResume={async () => {
                    await window.api.workspace.start(w.id);
                    refresh();
                  }}
                  onActiveTabChange={(workspaceId, brokerSessionId) => {
                    setActiveTabByWorkspace((prev) =>
                      prev[workspaceId] === brokerSessionId
                        ? prev
                        : { ...prev, [workspaceId]: brokerSessionId }
                    );
                  }}
                />
              ))}
          </div>
        </main>

        <ObservabilityPane
          workspaceName={selected?.name ?? null}
          summary={activeTabSummary}
        />
      </div>

      <BottomBar vaultAvailable={vaultAvailable} />

      <WorkspaceModal
        open={createOpen}
        workspaces={workspaces}
        vaultAvailable={vaultAvailable}
        onClose={() => setCreateOpen(false)}
        onCreate={handleCreate}
        onResume={handleResume}
      />
      {(() => {
        if (!closeTargetId) return null;
        const target = workspaces.find((w) => w.id === closeTargetId);
        if (!target || !target.containerId) return null;
        return (
          <CloseWorkspaceModal
            workspace={target}
            onClose={() => setCloseTargetId(null)}
            onClosed={() => {
              if (selectedId === target.id) setSelectedId(null);
              refresh();
            }}
          />
        );
      })()}
    </div>
  );
}

function DockerDisconnected({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="empty">
      <div className="icon-card error">!</div>
      <span className="eyebrow error">
        <span className="dot" />
        disconnected
      </span>
      <h2>Docker daemon unreachable</h2>
      <p>
        Start Docker Desktop (with WSL2 integration on Windows). claude-fleet will reconnect
        automatically once it's back.
      </p>
      <button className="btn" onClick={onRetry}>
        Retry connection
      </button>
    </div>
  );
}

function FirstRun({ onNewWorkspace }: { onNewWorkspace: () => void }) {
  return (
    <div className="empty">
      <div className="icon-card">▢</div>
      <span className="eyebrow">first run</span>
      <h2>No workspaces yet</h2>
      <p>
        Each workspace runs <code>claude</code> in an isolated Docker container against a host
        directory. Spin up your first to get started.
      </p>
      <button className="btn primary" onClick={onNewWorkspace}>
        + New workspace
      </button>
      <span className="hint">You'll need a workspace folder and an API key</span>
    </div>
  );
}
