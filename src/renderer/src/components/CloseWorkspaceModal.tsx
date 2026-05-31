import { useState } from 'react';
import type { WorkspaceSummary } from '../App';

interface Props {
  workspace: WorkspaceSummary;
  onClose: () => void;
  onClosed: () => void;
}

export function CloseWorkspaceModal({ workspace, onClose, onClosed }: Props) {
  const running = workspace.state === 'running';
  const paused = workspace.state === 'paused';
  const [deleteState, setDeleteState] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // workspace.id is the ULID (workspace identity). workspace.containerId
  // is the Docker container hash and is what stop/pause/remove address.
  // For start, the main process resolves by id (label lookup).
  const containerId = workspace.containerId!;

  const stopOnly = async () => {
    setBusy(true);
    setStatus('Stopping…');
    setError(null);
    try {
      await window.api.workspace.stop(containerId);
      onClosed();
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
      setStatus(null);
    }
  };

  const pause = async () => {
    setBusy(true);
    setStatus('Pausing…');
    setError(null);
    try {
      await window.api.workspace.pause(containerId);
      onClosed();
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
      setStatus(null);
    }
  };

  const resume = async () => {
    setBusy(true);
    setStatus('Resuming…');
    setError(null);
    try {
      await window.api.workspace.start(workspace.id);
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
      if (running || paused) {
        setStatus('Stopping…');
        await window.api.workspace.stop(containerId);
      }
      setStatus(deleteState ? 'Removing workspace and state directory…' : 'Removing workspace…');
      await window.api.workspace.remove(containerId, { deleteState });
      if (deleteState) {
        // Purge per-workspace vault secrets when the state dir is wiped —
        // otherwise the keychain accumulates orphan entries keyed by the
        // (now-discarded) id.
        try {
          await window.api.vault.deleteAllForWorkspace(workspace.id);
        } catch (err) {
          console.warn('vault.deleteAllForWorkspace failed:', err);
        }
      }
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
              Removes <code>~/.config/claude-fleet/state/{workspace.id}/</code> (the workspace
              manifest, transcripts, broker socket) and purges every secret env value stored for
              this workspace in the OS keychain. The workspace will no longer appear in the past
              list and a future workspace with the same name will start fresh.
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
          {running && (
            <button
              className="btn"
              onClick={pause}
              disabled={busy}
              title="Freeze processes via docker pause; resume preserves session state"
            >
              {busy ? '…' : 'Pause'}
            </button>
          )}
          {paused && (
            <button className="btn primary" onClick={resume} disabled={busy}>
              {busy ? '…' : 'Resume'}
            </button>
          )}
          <button className="btn danger" onClick={stopAndRemove} disabled={busy}>
            {busy ? '…' : running || paused ? 'Stop & remove' : 'Remove'}
          </button>
        </div>
      </div>
    </div>
  );
}
