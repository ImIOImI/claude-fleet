import { useEffect, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { TerminalPane } from './components/TerminalPane';

export interface ContainerSummary {
  id: string;
  name: string;
  state: string;
  status: string;
}

export function App() {
  const apiReady = typeof window !== 'undefined' && !!window.api;
  const [daemonReachable, setDaemonReachable] = useState<boolean | null>(null);
  const [containers, setContainers] = useState<ContainerSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

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
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [apiReady]);

  if (!apiReady) {
    const preloadRan = typeof window !== 'undefined' && (window as { __preloadOk?: boolean }).__preloadOk === true;
    return (
      <div className="app">
        <div className="preload-error">
          <h2>Preload script not loaded</h2>
          <p>
            <code>window.api</code> is undefined.
          </p>
          <p>
            Diagnostic: <code>window.__preloadOk</code> ={' '}
            <strong>{String(preloadRan)}</strong>.
            {preloadRan ? (
              <> The preload script ran but failed to expose <code>api</code> — check the terminal where <code>npm run dev</code> is running for an "exposeInMainWorld failed" error.</>
            ) : (
              <> The preload script never ran. Check the terminal where <code>npm run dev</code> is running for a load error, or for a missing log line: <code>[claude-fleet preload] script entered</code>.</>
            )}
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
      />
      <div className="main">
        <div className="main-header">
          {daemonReachable === false && (
            <span style={{ color: '#ef4444' }}>
              Docker daemon unreachable — start Docker Desktop (with WSL2 integration).
            </span>
          )}
          {daemonReachable && selected && (
            <>
              <span>{selected.name}</span>
              <span style={{ color: '#6b7280' }}>{selected.status}</span>
            </>
          )}
          {daemonReachable && !selected && <span>Select a container.</span>}
        </div>
        <div className="main-body">
          {selected ? (
            <TerminalPane containerId={selected.id} />
          ) : (
            <div className="empty">No container selected</div>
          )}
        </div>
      </div>
    </div>
  );
}
