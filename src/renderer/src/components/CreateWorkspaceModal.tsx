import { useEffect, useState } from 'react';
import type { WorkspaceSummary } from '../App';

interface Props {
  open: boolean;
  workspaces: WorkspaceSummary[];
  onClose: () => void;
  onCreate: (
    spec: {
      name: string;
      workspaceRoot: string;
      workspaceSubdir: string;
      profileName: string;
    },
    setStatus: (msg: string) => void
  ) => Promise<void>;
  onRestart: (
    workspace: WorkspaceSummary,
    setStatus: (msg: string) => void
  ) => Promise<void>;
}

// 16 × 16 = 256 friendly defaults. Adjective list deliberately upbeat (no
// "angry-llama"); animals trimmed to short, recognizable picks so the
// chip rendered in the top strip stays compact.
const ADJECTIVES = [
  'happy', 'calm', 'bold', 'quiet', 'swift', 'lucky', 'brave', 'clever',
  'eager', 'gentle', 'jolly', 'kind', 'merry', 'nimble', 'plucky', 'witty'
];
const ANIMALS = [
  'llama', 'otter', 'fox', 'panda', 'lemur', 'koala', 'bunny', 'finch',
  'gecko', 'owl', 'wren', 'seal', 'mouse', 'hare', 'frog', 'crane'
];
function petName(): string {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const n = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  return `${a}-${n}`;
}

// Persisted across modal opens (and app restarts) so the workspace input
// pre-fills with whatever was last used — a fresh workspace is almost
// always against the same repo as the previous one.
const LAST_WORKSPACE_ROOT_KEY = 'claude-fleet:lastWorkspaceRoot';

function loadLastWorkspaceRoot(): string {
  try {
    return localStorage.getItem(LAST_WORKSPACE_ROOT_KEY) ?? '';
  } catch {
    return '';
  }
}

function saveLastWorkspaceRoot(path: string): void {
  try {
    localStorage.setItem(LAST_WORKSPACE_ROOT_KEY, path);
  } catch {
    // localStorage may be unavailable in odd sandbox modes; persistence
    // is a nice-to-have so swallow.
  }
}

function relativeTime(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 60_000) return 'just now';
  const m = Math.floor(delta / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  return `${mo}mo ago`;
}

export function CreateWorkspaceModal({
  open,
  workspaces,
  onClose,
  onCreate,
  onRestart
}: Props) {
  const [name, setName] = useState('');
  const [workspaceRoot, setWorkspaceRoot] = useState<string>(loadLastWorkspaceRoot);
  const [workspaceSubdir, setWorkspaceSubdir] = useState('');
  const [profileName, setProfileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [namePlaceholder, setNamePlaceholder] = useState<string>(petName);

  // Refresh the suggested name and re-read the persisted workspace root
  // each time the modal opens so re-opens reflect the latest stored value
  // (and don't reuse a previously-shown name suggestion).
  useEffect(() => {
    if (open) {
      setNamePlaceholder(petName());
      setWorkspaceRoot(loadLastWorkspaceRoot());
      setError(null);
    }
  }, [open]);

  if (!open) return null;

  // Effective name: what the user typed, or the placeholder suggestion
  // they didn't override. Tab+Enter on a fresh modal uses the suggestion.
  const effectiveName = name.trim() || namePlaceholder;
  const nameOk = /^[a-zA-Z0-9_-]+$/.test(effectiveName);

  // Past workspaces shown at the top of the modal — most-recently used first.
  const pastWorkspaces = [...workspaces].sort((a, b) => b.lastUsedAt - a.lastUsedAt);

  const browse = async () => {
    const picked = await window.api.dialog.pickDirectory(workspaceRoot.trim() || undefined);
    if (picked) setWorkspaceRoot(picked);
  };

  const restart = async (workspace: WorkspaceSummary) => {
    if (busy) return;
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      await onRestart(workspace, setStatus);
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
      setStatus(null);
    }
  };

  const submit = async () => {
    if (busy) return;
    if (!effectiveName) {
      setError('Workspace name is required.');
      return;
    }
    if (!nameOk) {
      setError('Workspace name must match [a-zA-Z0-9_-]+ (no spaces, slashes, or dots).');
      return;
    }
    if (!workspaceRoot.trim()) {
      setError('Workspace root is required.');
      return;
    }
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      const ws = workspaceRoot.trim();
      const exists = await window.api.fs.isDirectory(ws);
      if (!exists) {
        const ok = window.confirm(
          `Workspace folder "${ws}" does not exist. Create it?`
        );
        if (!ok) return;
        setStatus(`Creating ${ws}…`);
        await window.api.fs.mkdirp(ws);
      }

      await onCreate(
        {
          name: effectiveName,
          workspaceRoot: ws,
          workspaceSubdir: workspaceSubdir.trim(),
          profileName: profileName.trim()
        },
        setStatus
      );
      saveLastWorkspaceRoot(ws);
      setName('');
      setWorkspaceSubdir('');
      setProfileName('');
      // Keep workspaceRoot — it's the user's persistent choice. The next
      // modal open will re-read it from localStorage via the useEffect
      // anyway, so this just keeps state consistent in-memory.
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
      setStatus(null);
    }
  };

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>New workspace</h2>
        <p className="modal-eyebrow">restart a past workspace, or create a new one</p>

        {pastWorkspaces.length > 0 && (
          <div className="past-workspaces" aria-label="Past workspaces">
            <div className="past-workspaces-label">Past workspaces</div>
            <ul className="past-workspace-list">
              {pastWorkspaces.map((w) => (
                <li key={w.id}>
                  <button
                    type="button"
                    className="past-workspace-row"
                    onClick={() => restart(w)}
                    disabled={busy}
                    title={`Restart ${w.name}`}
                  >
                    <span className={`dot ${w.state}`} />
                    <span className="ws-name">{w.name}</span>
                    <span className="ws-path" title={w.workspaceRoot}>
                      {w.workspaceRoot || <em>(no path on record)</em>}
                    </span>
                    <span className="ws-meta">
                      <span className={`ws-state ${w.state}`}>{w.state}</span>
                      <span className="ws-when">{relativeTime(w.lastUsedAt)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="modal-section-label">Create a new workspace</div>
        <div className="form-row">
          <label>Name</label>
          <input
            aria-label="Workspace name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={namePlaceholder}
            disabled={busy}
            autoFocus
          />
          {name && !nameOk && (
            <span className="form-hint error-text">
              Name must match [a-zA-Z0-9_-]+ (no spaces, slashes, or dots)
            </span>
          )}
        </div>
        <div className="form-row">
          <label>Workspace root (host path)</label>
          <div className="input-with-button">
            <input
              value={workspaceRoot}
              onChange={(e) => setWorkspaceRoot(e.target.value)}
              placeholder="/home/troy/repos"
              disabled={busy}
            />
            <button type="button" onClick={browse} disabled={busy}>
              Browse…
            </button>
          </div>
        </div>
        <div className="form-row">
          <label>Subdir inside workspace</label>
          <input
            value={workspaceSubdir}
            onChange={(e) => setWorkspaceSubdir(e.target.value)}
            placeholder="(optional)"
            disabled={busy}
          />
        </div>
        <div className="form-row">
          <label>Profile name</label>
          <input
            value={profileName}
            onChange={(e) => setProfileName(e.target.value)}
            placeholder="leave blank to use Claude.ai login (OAuth)"
            disabled={busy}
          />
        </div>
        {status && <div className="form-status">{status}</div>}
        {error && <div className="form-hint error-text">{error}</div>}
        <div className="modal-footer">
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit} disabled={busy}>
            {busy ? 'Working…' : 'Create & start'}
          </button>
        </div>
      </div>
    </div>
  );
}
