import type { WorkspaceSummary } from '../App';

interface Props {
  workspaces: WorkspaceSummary[];
  selectedId: string | null;
  backendReady: boolean | null;
  vaultAvailable: boolean | null;
  mockMode: boolean;
  onSelect: (id: string) => void;
  onNewWorkspace: () => void;
  onOpenProfiles: () => void;
}

// Deterministic hue assignment by workspace name. Six rotating CSS vars
// defined in styles.css — same name always gets the same color, no random
// churn between renders.
function hueFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `var(--hue-${(h % 6) + 1})`;
}

export function WorkspaceTabStrip({
  workspaces,
  selectedId,
  backendReady,
  vaultAvailable,
  mockMode,
  onSelect,
  onNewWorkspace,
  onOpenProfiles
}: Props) {
  // Top strip only shows workspaces that have a live backend (running or
  // stopped). "deleted" workspaces show up in the new-workspace modal's
  // past-workspaces list instead.
  const live = workspaces.filter((w) => w.state !== 'deleted');

  return (
    <div className="top-strip">
      <div className="app-name">
        claude-fleet
        <span className="meta">
          {live.length} workspace{live.length === 1 ? '' : 's'}
        </span>
      </div>

      {live.map((w) => (
        <button
          key={w.id}
          className={`ws-chip ${w.id === selectedId ? 'active' : ''}`}
          onClick={() => onSelect(w.id)}
          style={{ ['--hue' as never]: hueFor(w.name) }}
          title={w.status}
        >
          <span className={`dot ${w.state === 'running' ? 'running' : ''}`} />
          <span className="name">{w.name}</span>
        </button>
      ))}

      <button
        className="btn"
        onClick={onNewWorkspace}
        disabled={backendReady === false}
        title={
          backendReady === false ? 'Docker daemon unreachable' : 'Create a new workspace'
        }
      >
        + New workspace
      </button>

      <div className="top-strip-actions">
        {mockMode && (
          <span className="mock-chip" title="CLAUDE_FLEET_MOCK=1 — Docker + PTY are simulated">
            MOCK MODE
          </span>
        )}
        <span className="daemon-status">
          <span className={`dot ${backendReady === false ? 'unreachable' : ''}`} />
          {backendReady === false ? 'disconnected' : 'docker'}
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
