import { useEffect, useState } from 'react';
import { WorkspaceTabStrip } from './components/WorkspaceTabStrip';
import { SessionsPane } from './components/SessionsPane';
import { ObservabilityPane } from './components/ObservabilityPane';
import { TerminalPane } from './components/TerminalPane';
import { BottomBar } from './components/BottomBar';
import { CreateWorkspaceModal } from './components/CreateWorkspaceModal';
import { CloseWorkspaceModal } from './components/CloseWorkspaceModal';
import { ProfilesDialog } from './components/ProfilesDialog';
import type { WorkspaceObservabilitySummary } from '../../preload';

export type WorkspaceState = 'running' | 'paused' | 'stopped' | 'deleted';
export type WorkspaceKind = 'container' | 'local';

// Same deterministic hash WorkspaceTabStrip uses so a workspace's chip and
// its terminal area pick up identical colors. Six rotating CSS vars defined
// in styles.css.
function hueFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `var(--hue-${(h % 6) + 1})`;
}

export interface WorkspaceSummary {
  name: string;
  // The renderer keys selection / chips by `id` (= container id for live
  // workspaces, synthetic "deleted:<name>" for deleted ones). containerId
  // is what backend operations like attach/stop/remove need; it's only
  // present when state !== 'deleted'.
  id: string;
  containerId?: string;
  state: WorkspaceState;
  status?: string;
  workspaceRoot: string;
  workspaceSubdir: string;
  profile: string;
  kind: WorkspaceKind;
  image?: string;
  createdAt: number;
  lastUsedAt: number;
}

export function App() {
  const apiReady = typeof window !== 'undefined' && !!window.api;
  const [backendReady, setBackendReady] = useState<boolean | null>(null);
  const [vaultAvailable, setVaultAvailable] = useState<boolean | null>(null);
  const [mockMode, setMockMode] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [profilesOpen, setProfilesOpen] = useState(false);
  // The Close modal can be opened on any workspace, not just the selected
  // one (the hamburger menu on each chip opens it directly). Track the
  // target workspace by id rather than a boolean.
  const [closeTargetId, setCloseTargetId] = useState<string | null>(null);
  // Centralized observability polling: one IPC call per workspace per
  // tick, distributed to chip / observability pane / terminal-pane
  // context-bar via props. Hoisting from the previous per-pane polling
  // means multiple slot consumers (chip, pane, context-bar) all share
  // a single source of truth and don't fire duplicate IPCs.
  const [summaries, setSummaries] = useState<
    Record<string, WorkspaceObservabilitySummary | null>
  >({});

  // Active terminal-tab id per workspace, bubbled up from each
  // TerminalPane via onActiveTabChange. Drives the per-tab observability
  // summary fetch for the selected workspace below — the ObservabilityPane
  // shows the focused tab's claude session instead of the workspace's
  // most-recently-active.
  const [activeTabByWorkspace, setActiveTabByWorkspace] = useState<
    Record<string, string>
  >({});

  // (No `isFresh` tracking — the ObservabilityPane now derives its
  // contents purely from the per-tab summary fetch. Unmapped tabs show
  // the empty state regardless of how they were added, which keeps
  // tab switching from leaking the previous tab's data through a
  // workspace-summary fallback. See SPEC §11 *Per-tab mapping*.)

  // ObservabilityPane summary scoped to the selected workspace's active
  // tab. Falls back to the workspace summary (`summaries[name]`) below
  // when no per-tab data has arrived yet (initial fetch in flight, or
  // mapping hasn't been learned because the broker still has the claude
  // alive from a previous app run — see broker_sessions table).
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
    const list = (await window.api.workspace.list()) as Array<{
      name: string;
      containerId?: string;
      state: WorkspaceState;
      status?: string;
      workspaceRoot: string;
      workspaceSubdir: string;
      profile: string;
      kind?: WorkspaceKind;
      image?: string;
      createdAt: number;
      lastUsedAt: number;
    }>;
    setWorkspaces(
      list.map((w) => ({
        ...w,
        kind: w.kind ?? 'container',
        id: w.containerId ?? `deleted:${w.name}`
      }))
    );
  };

  useEffect(() => {
    if (!apiReady) return;
    refresh();
    window.api.vault.available().then(setVaultAvailable);
    window.api.app.mockMode().then(setMockMode);
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [apiReady]);

  // Observability summary distribution. The chip strip, observability pane,
  // and terminal-pane context bar all read from this shared map.
  //
  // Updates arrive two ways:
  //   1. Live push from main on every JSONL ingest batch (see
  //      `observability.onSummary` in preload + the `'ingest'` emitter on
  //      JsonlWatcher). One push per batch keys the affected workspace.
  //   2. A 30s safety poll that re-fetches every workspace's summary. It
  //      backs up the push (in case an event is lost) and forces a re-render
  //      so the chip's relative-time text ("active 2m ago") rolls forward
  //      even when no new ingests are happening.
  //
  // Re-keys on the sorted-by-name workspace list so a workspace add/remove
  // triggers a resubscribe but a `lastUsedAt` nudge from the 5s refresh
  // doesn't.
  const liveNames = workspaces
    .filter((w) => w.state !== 'deleted')
    .map((w) => w.name)
    .sort()
    .join(',');
  useEffect(() => {
    if (!apiReady) return;
    if (!liveNames) {
      setSummaries({});
      return;
    }
    const names = liveNames.split(',');
    let cancelled = false;
    const refreshAll = async (): Promise<void> => {
      const entries = await Promise.all(
        names.map(async (name) => {
          try {
            const s = await window.api.observability.summaryForWorkspace(name);
            return [name, s] as const;
          } catch {
            return [name, null] as const;
          }
        })
      );
      if (cancelled) return;
      setSummaries(Object.fromEntries(entries));
    };

    void refreshAll();

    const unsubscribe = window.api.observability.onSummary((workspaceName, summary) => {
      if (cancelled) return;
      // Drop pushes for workspaces that aren't in the current live set
      // (e.g., late-arriving push after a workspace was just removed).
      if (!names.includes(workspaceName)) return;
      setSummaries((prev) => ({ ...prev, [workspaceName]: summary }));
    });

    const id = setInterval(refreshAll, 30_000);
    return () => {
      cancelled = true;
      unsubscribe();
      clearInterval(id);
    };
  }, [apiReady, liveNames]);

  // Per-tab observability fetch for the currently-selected workspace
  // and active tab. Re-fires when either changes, plus whenever a push
  // lands for the selected workspace (so the pane stays live without
  // its own poll). Skipped when no workspace is selected or the tab id
  // hasn't been bubbled up yet — in both cases the fallback chain in
  // the JSX below (activeTabSummary ?? workspace summary) keeps the
  // pane displaying something usable.
  const selectedWorkspace = workspaces.find((w) => w.id === selectedId) ?? null;
  const selectedWorkspaceName = selectedWorkspace?.name ?? null;
  const activeTabId = selectedWorkspaceName
    ? activeTabByWorkspace[selectedWorkspaceName] ?? null
    : null;
  useEffect(() => {
    if (!apiReady || !selectedWorkspaceName || !activeTabId) {
      setActiveTabSummary(null);
      return;
    }
    let cancelled = false;
    const fetchOne = async (): Promise<void> => {
      try {
        const s = await window.api.observability.summaryForBrokerSession(
          selectedWorkspaceName,
          activeTabId
        );
        if (!cancelled) setActiveTabSummary(s);
      } catch {
        if (!cancelled) setActiveTabSummary(null);
      }
    };
    void fetchOne();
    const unsubscribe = window.api.observability.onSummary((pushedWorkspace) => {
      if (pushedWorkspace === selectedWorkspaceName) void fetchOne();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [apiReady, selectedWorkspaceName, activeTabId]);

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

  // Selection is keyed by .id; the top strip filters out deleted ones so
  // selectedId never refers to a deleted workspace. `selectedWorkspace`
  // is the same object — declared earlier so the per-tab observability
  // effect above can depend on its `.name`.
  const selected = selectedWorkspace;
  const liveCount = workspaces.filter((w) => w.state !== 'deleted').length;

  const handleCreate = async (
    spec: {
      name: string;
      workspaceRoot: string;
      workspaceSubdir: string;
      profileName: string;
      kind?: 'container' | 'local';
      image?: string;
    },
    setStatus: (msg: string) => void
  ) => {
    const kind = spec.kind ?? 'container';
    let env: Record<string, string> = {};
    const labelProfile = spec.profileName || 'oauth';

    if (spec.profileName) {
      const profile = await window.api.vault.get(spec.profileName);
      if (!profile) {
        throw new Error(
          `No vault profile "${spec.profileName}". Add one in Profiles first, or leave the field blank to use Claude.ai login.`
        );
      }
      if (profile.apiKey) {
        env = { ANTHROPIC_API_KEY: profile.apiKey };
      }
    }

    if (kind === 'container') {
      await window.api.workspace.ensureImage(({ message }) => setStatus(message));
    }
    setStatus('Creating workspace…');
    await window.api.workspace.create({
      name: spec.name,
      workspaceRoot: spec.workspaceRoot,
      workspaceSubdir: spec.workspaceSubdir,
      profile: labelProfile,
      kind,
      image: spec.image,
      env
    });
    refresh();
  };

  /**
   * Restart a past workspace. If the container still exists (running or
   * stopped), start it. If it's been deleted, recreate from the saved
   * manifest via the same flow as a brand-new create.
   */
  const handleRestart = async (
    workspace: WorkspaceSummary,
    setStatus: (msg: string) => void
  ) => {
    setStatus(`Starting ${workspace.name}…`);
    const started = (await window.api.workspace.start(workspace.name)) as
      | { containerId?: string }
      | null;
    if (started?.containerId) {
      setSelectedId(started.containerId);
      refresh();
      return;
    }
    // Container is gone — recreate from saved spec via the standard flow.
    await handleCreate(
      {
        name: workspace.name,
        workspaceRoot: workspace.workspaceRoot,
        workspaceSubdir: workspace.workspaceSubdir,
        profileName: workspace.profile === 'oauth' ? '' : workspace.profile,
        kind: workspace.kind,
        image: workspace.image
      },
      setStatus
    );
  };

  return (
    <div className="app">
      <WorkspaceTabStrip
        workspaces={workspaces}
        summaries={summaries}
        selectedId={selectedId}
        backendReady={backendReady}
        vaultAvailable={vaultAvailable}
        mockMode={mockMode}
        onSelect={setSelectedId}
        onNewWorkspace={() => setCreateOpen(true)}
        onOpenProfiles={() => setProfilesOpen(true)}
        onCloseWorkspace={(w) => setCloseTargetId(w.id)}
        onRefresh={refresh}
      />

      <div className="app-body">
        <SessionsPane />

        <main
          className="main-pane"
          // `--hue` is set when a workspace is selected so the session tab
          // strip's active underline and the accent band above the terminal
          // pick up that workspace's color (same hueFor used by the chip in
          // the workspace ribbon, so the visual identity is consistent).
          style={selected ? { ['--hue' as never]: hueFor(selected.name) } : undefined}
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
            {/*
              Always-mounted TerminalPanes — one per live workspace, kept
              alive for as long as the workspace itself exists. Only the
              one matching `selectedId` is visible; others are hidden via
              `visibility: hidden` (layout preserved so xterm keeps its
              real dimensions and doesn't need to refit on show).

              Keying by `name` (not `containerId`) means the pane
              survives container stop+start with state preserved; it
              only unmounts when the workspace itself is removed from
              the list. Each TerminalSession's broker connection stays
              open across workspace switches — switching is purely a CSS
              toggle, no detach/attach churn.
            */}
            {workspaces
              .filter((w) => w.state !== 'deleted' && w.containerId)
              .map((w) => (
                <TerminalPane
                  key={w.name}
                  visible={selectedId === w.id}
                  workspaceName={w.name}
                  containerId={w.containerId!}
                  paused={w.state === 'paused'}
                  summary={summaries[w.name] ?? null}
                  onResume={async () => {
                    await window.api.workspace.start(w.name);
                    refresh();
                  }}
                  onActiveTabChange={(wsName, brokerSessionId) => {
                    setActiveTabByWorkspace((prev) =>
                      prev[wsName] === brokerSessionId
                        ? prev
                        : { ...prev, [wsName]: brokerSessionId }
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

      <CreateWorkspaceModal
        open={createOpen}
        workspaces={workspaces}
        onClose={() => setCreateOpen(false)}
        onCreate={handleCreate}
        onRestart={handleRestart}
      />
      {vaultAvailable !== false && (
        <ProfilesDialog open={profilesOpen} onClose={() => setProfilesOpen(false)} />
      )}
      {(() => {
        if (!closeTargetId) return null;
        const target = workspaces.find((w) => w.id === closeTargetId);
        if (!target || !target.containerId) return null;
        return (
          <CloseWorkspaceModal
            workspace={{ ...target, id: target.containerId }}
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
