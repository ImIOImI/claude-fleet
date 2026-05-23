import { useEffect, useState } from 'react';
import { ContainerTabStrip } from './components/ContainerTabStrip';
import { SessionsPane } from './components/SessionsPane';
import { ObservabilityPane } from './components/ObservabilityPane';
import { TerminalPane } from './components/TerminalPane';
import { BottomBar } from './components/BottomBar';
import { CreateContainerModal } from './components/CreateContainerModal';
import { CloseContainerModal } from './components/CloseContainerModal';
import { ProfilesDialog } from './components/ProfilesDialog';

export interface ContainerSummary {
  id: string;
  name: string;
  state: string;
  status: string;
}

export function App() {
  const apiReady = typeof window !== 'undefined' && !!window.api;
  const [daemonReachable, setDaemonReachable] = useState<boolean | null>(null);
  const [vaultAvailable, setVaultAvailable] = useState<boolean | null>(null);
  const [mockMode, setMockMode] = useState(false);
  const [containers, setContainers] = useState<ContainerSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [profilesOpen, setProfilesOpen] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);

  const refresh = async () => {
    if (!window.api) return;
    const ok = await window.api.docker.ping();
    setDaemonReachable(ok);
    if (ok) setContainers(await window.api.docker.list());
    else setContainers([]);
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

  const selected = containers.find((c) => c.id === selectedId) ?? null;

  const handleCreate = async (
    spec: { name: string; workspaceRoot: string; workspaceSubdir: string; profileName: string },
    setStatus: (msg: string) => void
  ) => {
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

    await window.api.docker.ensureImage(({ message }) => setStatus(message));
    setStatus('Creating container…');
    await window.api.docker.create({
      name: spec.name,
      workspaceRoot: spec.workspaceRoot,
      workspaceSubdir: spec.workspaceSubdir,
      profile: labelProfile,
      env
    });
    refresh();
  };

  return (
    <div className="app">
      <ContainerTabStrip
        containers={containers}
        selectedId={selectedId}
        daemonReachable={daemonReachable}
        vaultAvailable={vaultAvailable}
        mockMode={mockMode}
        onSelect={setSelectedId}
        onNewContainer={() => setCreateOpen(true)}
        onOpenProfiles={() => setProfilesOpen(true)}
      />

      <div className="app-body">
        <SessionsPane />

        <main className="main-pane">
          <div className="main-header">
            {daemonReachable === false ? null : selected ? (
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
                    onClick={() => setCloseOpen(true)}
                    title="Stop and/or remove this container"
                  >
                    Close…
                  </button>
                </span>
              </>
            ) : containers.length > 0 ? (
              <span style={{ color: 'var(--text-muted)' }}>Select a container.</span>
            ) : null}
          </div>

          <div className="main-body">
            {daemonReachable === false ? (
              <DockerDisconnected onRetry={refresh} />
            ) : selected ? (
              <TerminalPane containerId={selected.id} />
            ) : containers.length === 0 ? (
              <FirstRun onNewContainer={() => setCreateOpen(true)} />
            ) : (
              <div className="empty">
                <p style={{ color: 'var(--text-muted)' }}>No container selected.</p>
              </div>
            )}
          </div>
        </main>

        <ObservabilityPane />
      </div>

      <BottomBar vaultAvailable={vaultAvailable} />

      <CreateContainerModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreate={handleCreate}
      />
      {vaultAvailable !== false && (
        <ProfilesDialog open={profilesOpen} onClose={() => setProfilesOpen(false)} />
      )}
      {closeOpen && selected && (
        <CloseContainerModal
          container={selected}
          onClose={() => setCloseOpen(false)}
          onClosed={() => {
            setSelectedId(null);
            refresh();
          }}
        />
      )}
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

function FirstRun({ onNewContainer }: { onNewContainer: () => void }) {
  return (
    <div className="empty">
      <div className="icon-card">▢</div>
      <span className="eyebrow">first run</span>
      <h2>No containers yet</h2>
      <p>
        Each container runs <code>claude</code> in an isolated Docker workspace. Spin up your
        first to get started.
      </p>
      <button className="btn primary" onClick={onNewContainer}>
        + New container
      </button>
      <span className="hint">You'll need a workspace folder and an API key</span>
    </div>
  );
}
