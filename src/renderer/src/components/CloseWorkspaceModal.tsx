import { useState } from 'react';
import type { WorkspaceSummary } from '../App';

interface Props {
  workspace: WorkspaceSummary;
  onClose: () => void;
  onClosed: () => void;
}

export function CloseWorkspaceModal({ workspace, onClose, onClosed }: Props) {
  const running = workspace.state === 'running';
  const [deleteState, setDeleteState] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stopOnly = async () => {
    setBusy(true);
    setStatus('Stopping…');
    setError(null);
    try {
      await window.api.workspace.stop(workspace.id);
      onClosed();
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
      setStatus(null);
    }
  };

  const stopAndRemove = async () => {
    setBusy(true);
    setError(null);
    try {
      if (running) {
        setStatus('Stopping…');
        await window.api.workspace.stop(workspace.id);
      }
      setStatus(deleteState ? 'Removing workspace and state directory…' : 'Removing workspace…');
      await window.api.workspace.remove(workspace.id, { deleteState });
      onClosed();
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
        <h2>Close workspace</h2>
        <p className="modal-eyebrow">
          {workspace.name} — {workspace.status}
        </p>
        <label
          style={{
            display: 'flex',
            gap: 10,
            alignItems: 'flex-start',
            fontSize: 13,
            margin: '4px 0 12px',
            cursor: busy ? 'default' : 'pointer'
          }}
        >
          <input
            type="checkbox"
            checked={deleteState}
            onChange={(e) => setDeleteState(e.target.checked)}
            disabled={busy}
            style={{ marginTop: 3 }}
          />
          <span>
            Also delete the state directory
            <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 3, lineHeight: 1.4 }}>
              Removes <code>~/.config/claude-fleet/state/{workspace.name}/</code> including the
              workspace manifest. The workspace will no longer appear in the past list. A future
              workspace with the same name will start fresh.
            </div>
          </span>
        </label>
        {status && <div className="form-status">{status}</div>}
        {error && <div className="form-hint error-text">{error}</div>}
        <div className="modal-footer">
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          {running && (
            <button className="btn" onClick={stopOnly} disabled={busy}>
              {busy ? '…' : 'Stop only'}
            </button>
          )}
          <button className="btn danger" onClick={stopAndRemove} disabled={busy}>
            {busy ? '…' : running ? 'Stop & remove' : 'Remove'}
          </button>
        </div>
      </div>
    </div>
  );
}
