import { useEffect, useState } from 'react';
import { WorkspaceTabStrip } from './components/WorkspaceTabStrip';
import { SessionsPane } from './components/SessionsPane';
import { ObservabilityPane } from './components/ObservabilityPane';
import { TerminalPane } from './components/TerminalPane';
import { BottomBar } from './components/BottomBar';
import { CreateWorkspaceModal } from './components/CreateWorkspaceModal';
import { CloseWorkspaceModal } from './components/CloseWorkspaceModal';
import { ProfilesDialog } from './components/ProfilesDialog';

export type WorkspaceState = 'running' | 'paused' | 'stopped' | 'deleted';
export type WorkspaceKind = 'container' | 'local';

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
  // selectedId never refers to a deleted workspace.
  const selected = workspaces.find((w) => w.id === selectedId) ?? null;
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

        <main className="main-pane">
          <div className="main-header">
            {backendReady === false ? null : selected ? (
              <>
                <span style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
                  {selected.name}
                </span>
                <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                  {selected.status}
                </span>
                <span style={{ marginLeft: 'auto' }}>
                  <button
                    className="btn danger"
                    onClick={() => setCloseTargetId(selected.id)}
                    title="Stop and/or remove this workspace"
                  >
                    Close…
                  </button>
                </span>
              </>
            ) : liveCount > 0 ? (
              <span style={{ color: 'var(--text-muted)' }}>Select a workspace.</span>
            ) : null}
          </div>

          <div className="main-body">
            {backendReady === false ? (
              <DockerDisconnected onRetry={refresh} />
            ) : selected && selected.containerId ? (
              <TerminalPane containerId={selected.containerId} />
            ) : liveCount === 0 ? (
              <FirstRun onNewWorkspace={() => setCreateOpen(true)} />
            ) : (
              <div className="empty">
                <p style={{ color: 'var(--text-muted)' }}>No workspace selected.</p>
              </div>
            )}
          </div>
        </main>

        <ObservabilityPane />
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
