import { useState } from 'react';
import type { ContainerSummary } from '../App';

interface Props {
  container: ContainerSummary;
  onClose: () => void;
  onClosed: () => void;
}

export function CloseContainerModal({ container, onClose, onClosed }: Props) {
  const running = container.state === 'running';
  const [deleteState, setDeleteState] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stopOnly = async () => {
    setBusy(true);
    setStatus('Stopping…');
    setError(null);
    try {
      await window.api.docker.stop(container.id);
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
        await window.api.docker.stop(container.id);
      }
      setStatus(deleteState ? 'Removing container and state directory…' : 'Removing container…');
      await window.api.docker.remove(container.id, { deleteState });
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
        <h2>Close container</h2>
        <p className="muted">
          <strong style={{ color: '#d8dde6' }}>{container.name}</strong> — {container.status}
        </p>
        <label
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'flex-start',
            fontSize: 13,
            margin: '12px 0',
            cursor: busy ? 'default' : 'pointer'
          }}
        >
          <input
            type="checkbox"
            checked={deleteState}
            onChange={(e) => setDeleteState(e.target.checked)}
            disabled={busy}
            style={{ marginTop: 2 }}
          />
          <span>
            Also delete the state directory
            <div style={{ color: '#6b7280', fontSize: 11, marginTop: 2 }}>
              Removes <code>~/.config/claude-fleet/state/{container.name}/</code>. A future
              container with the same name will start fresh.
            </div>
          </span>
        </label>
        {status && <div className="form-status">{status}</div>}
        {error && <div className="form-hint error-text">{error}</div>}
        <div className="modal-footer">
          <button onClick={onClose} disabled={busy}>
            Cancel
          </button>
          {running && (
            <button onClick={stopOnly} disabled={busy}>
              {busy ? '…' : 'Stop only'}
            </button>
          )}
          <button onClick={stopAndRemove} disabled={busy}>
            {busy ? '…' : running ? 'Stop & remove' : 'Remove'}
          </button>
        </div>
      </div>
    </div>
  );
}
