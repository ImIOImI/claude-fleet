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
  const [daemonReachable, setDaemonReachable] = useState<boolean | null>(null);
  const [containers, setContainers] = useState<ContainerSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const refresh = async () => {
    const ok = await window.api.docker.ping();
    setDaemonReachable(ok);
    if (ok) setContainers(await window.api.docker.list());
    else setContainers([]);
  };

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, []);

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
