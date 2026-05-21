import { useState } from 'react';

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

export function CreateContainerModal({ open, onClose, onCreate }: Props) {
  const [name, setName] = useState('');
  const [workspaceRoot, setWorkspaceRoot] = useState('');
  const [workspaceSubdir, setWorkspaceSubdir] = useState('');
  const [profileName, setProfileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const nameOk = /^[a-zA-Z0-9_-]+$/.test(name);

  const browse = async () => {
    const picked = await window.api.dialog.pickDirectory(workspaceRoot.trim() || undefined);
    if (picked) setWorkspaceRoot(picked);
  };

  const submit = async () => {
    if (busy) return;
    if (!name) {
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
          name,
          workspaceRoot: ws,
          workspaceSubdir: workspaceSubdir.trim(),
          profileName: profileName.trim()
        },
        setStatus
      );
      setName('');
      setWorkspaceRoot('');
      setWorkspaceSubdir('');
      setProfileName('');
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
        <div className="form-row">
          <label>Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-container"
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
          <button onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button onClick={submit} disabled={busy}>
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
