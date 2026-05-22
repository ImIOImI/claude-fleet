import { useEffect, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { TerminalPane } from './components/TerminalPane';
import { CloseContainerModal } from './components/CloseContainerModal';

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
        <div className="preload-error">
          <h2>Preload script not loaded</h2>
          <p>
            <code>window.api</code> is undefined — the preload script failed to load. Stop and
            restart <code>npm run dev</code>; if you still see this after a clean restart, check
            the terminal where dev is running for a preload error.
          </p>
        </div>
      </div>
    );
  }

  const selected = containers.find((c) => c.id === selectedId) ?? null;

  return (
    <div className="app">
      <Sidebar
        containers={containers}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onCreated={refresh}
        vaultAvailable={vaultAvailable}
      />
      <div className="main">
        <div className="main-header">
          {mockMode && (
            <span
              style={{
                background: '#7c2d12',
                color: '#fed7aa',
                padding: '2px 8px',
                borderRadius: 4,
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: 0.5
              }}
              title="CLAUDE_FLEET_MOCK=1 — Docker + PTY are simulated"
            >
              MOCK MODE
            </span>
          )}
          {daemonReachable === false && (
            <span style={{ color: '#ef4444' }}>
              Docker daemon unreachable — start Docker Desktop (with WSL2 integration).
            </span>
          )}
          {daemonReachable && vaultAvailable === false && (
            <span style={{ color: '#f59e0b' }} title="See README → Running dev on WSL">
              OS keychain unavailable — using ANTHROPIC_API_KEY from env. Profiles disabled.
            </span>
          )}
          {daemonReachable && selected && (
            <>
              <span>{selected.name}</span>
              <span style={{ color: '#6b7280' }}>{selected.status}</span>
              <button
                onClick={() => setCloseOpen(true)}
                style={{
                  marginLeft: 'auto',
                  background: '#3a1f1f',
                  color: '#fca5a5',
                  border: '1px solid #5a2a2a',
                  borderRadius: 6,
                  padding: '4px 10px',
                  fontSize: 12,
                  cursor: 'pointer'
                }}
                title="Stop and/or remove this container"
              >
                Close…
              </button>
            </>
          )}
          {daemonReachable && !selected && vaultAvailable !== false && <span>Select a container.</span>}
        </div>
        <div className="main-body">
          {selected ? (
            <TerminalPane containerId={selected.id} />
          ) : (
            <div className="empty">No container selected</div>
          )}
        </div>
      </div>
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
