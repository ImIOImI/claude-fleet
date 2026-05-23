import type { ContainerSummary } from '../App';

interface Props {
  containers: ContainerSummary[];
  selectedId: string | null;
  daemonReachable: boolean | null;
  vaultAvailable: boolean | null;
  mockMode: boolean;
  onSelect: (id: string) => void;
  onNewContainer: () => void;
  onOpenProfiles: () => void;
}

// Deterministic hue assignment by container name. Six rotating CSS vars defined
// in styles.css — same name always gets the same color, no random churn.
function hueFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `var(--hue-${(h % 6) + 1})`;
}

export function ContainerTabStrip({
  containers,
  selectedId,
  daemonReachable,
  vaultAvailable,
  mockMode,
  onSelect,
  onNewContainer,
  onOpenProfiles
}: Props) {
  return (
    <div className="top-strip">
      <div className="app-name">
        claude-fleet
        <span className="meta">
          {containers.length} container{containers.length === 1 ? '' : 's'}
        </span>
      </div>

      {containers.map((c) => (
        <button
          key={c.id}
          className={`ct-chip ${c.id === selectedId ? 'active' : ''}`}
          onClick={() => onSelect(c.id)}
          style={{ ['--hue' as never]: hueFor(c.name) }}
          title={c.status}
        >
          <span className={`dot ${c.state === 'running' ? 'running' : ''}`} />
          <span className="name">{c.name}</span>
        </button>
      ))}

      <button
        className="btn"
        onClick={onNewContainer}
        disabled={daemonReachable === false}
        title={
          daemonReachable === false ? 'Docker daemon unreachable' : 'Create a new container'
        }
      >
        + New container
      </button>

      <div className="top-strip-actions">
        {mockMode && (
          <span className="mock-chip" title="CLAUDE_FLEET_MOCK=1 — Docker + PTY are simulated">
            MOCK MODE
          </span>
        )}
        <span className="daemon-status">
          <span className={`dot ${daemonReachable === false ? 'unreachable' : ''}`} />
          {daemonReachable === false ? 'disconnected' : 'docker'}
        </span>
        {vaultAvailable !== false && (
          <button className="btn" onClick={onOpenProfiles}>
            Profiles…
          </button>
        )}
      </div>
    </div>
  );
}
