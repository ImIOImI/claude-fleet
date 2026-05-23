import { useEffect, useState } from 'react';

interface Props {
  open: boolean;
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
// pre-fills with whatever was last used — a fresh container is almost
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

export function CreateContainerModal({ open, onClose, onCreate }: Props) {
  const [name, setName] = useState('');
  const [workspaceRoot, setWorkspaceRoot] = useState<string>(loadLastWorkspaceRoot);
  const [workspaceSubdir, setWorkspaceSubdir] = useState('');
  const [profileName, setProfileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [namePlaceholder, setNamePlaceholder] = useState<string>(petName);

  // Refresh the suggested name and re-read the persisted workspace each
  // time the modal opens so re-opens reflect the latest stored value
  // (and don't reuse a previously-shown name suggestion).
  useEffect(() => {
    if (open) {
      setNamePlaceholder(petName());
      setWorkspaceRoot(loadLastWorkspaceRoot());
    }
  }, [open]);

  if (!open) return null;

  // Effective name: what the user typed, or the placeholder suggestion
  // they didn't override. Tab+Enter on a fresh modal uses the suggestion.
  const effectiveName = name.trim() || namePlaceholder;
  const nameOk = /^[a-zA-Z0-9_-]+$/.test(effectiveName);

  const browse = async () => {
    const picked = await window.api.dialog.pickDirectory(workspaceRoot.trim() || undefined);
    if (picked) setWorkspaceRoot(picked);
  };

  const submit = async () => {
    if (busy) return;
    if (!effectiveName) {
      setError('Container name is required.');
      return;
    }
    if (!nameOk) {
      setError('Container name must match [a-zA-Z0-9_-]+ (no spaces, slashes, or dots).');
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
        <h2>New container</h2>
        <p className="modal-eyebrow">spin up a runner pointing at a workspace</p>
        <div className="form-row">
          <label>Name</label>
          <input
            aria-label="Container name"
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
            {busy ? 'Creating…' : 'Create & start'}
          </button>
        </div>
      </div>
    </div>
  );
}
