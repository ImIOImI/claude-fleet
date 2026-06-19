// Permanent-delete confirmation. Distinct from `CloseWorkspaceModal`:
// Close keeps the state dir + manifest so the workspace stays in the
// Saved list (recoverable); Delete purges everything — state dir,
// manifest, every keytar secret under the workspace's id.

import { useState } from 'react';
import type { WorkspaceSummary } from '../App';

interface Props {
  workspace: WorkspaceSummary;
  onClose: () => void;
  onDeleted: () => void;
}

export function DeleteWorkspaceModal({ workspace, onClose, onDeleted }: Props) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      // Stop the container first if it's live — `workspace:remove` with
      // `force: true` would also work, but a graceful stop gives any
      // in-flight Claude work a chance to flush its JSONL.
      if (workspace.containerId && (workspace.state === 'running' || workspace.state === 'paused')) {
        setStatus('Stopping…');
        try {
          await window.api.workspace.stop(workspace.containerId);
        } catch (err) {
          // Best-effort — if stop fails, fall through to force-remove.
          console.warn('workspace.stop during delete failed:', err);
        }
      }
      // Always remove + purge the state dir, even for a saved workspace with
      // no live container — pass the ULID so the main process can wipe the
      // state dir without a container to read the id from. (Gating this on
      // containerId was the bug: saved workspaces were never deleted.)
      setStatus('Removing container + state dir…');
      await window.api.workspace.remove(workspace.containerId ?? '', {
        deleteState: true,
        id: workspace.id
      });
      setStatus('Purging vault entries…');
      try {
        await window.api.vault.deleteAllForWorkspace(workspace.id);
      } catch (err) {
        // Best-effort — manifest is gone either way; orphan keytar
        // entries get caught on next migration run.
        console.warn('vault.deleteAllForWorkspace failed:', err);
      }
      onDeleted();
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
        <h2>Delete workspace</h2>
        <p className="modal-eyebrow">{workspace.name}</p>
        <p style={{ margin: '8px 0 16px', lineHeight: 1.5 }}>
          Permanently delete <strong>{workspace.name}</strong>? This removes the workspace
          state directory and every secret env value stored for it in the OS keychain.
          <br />
          <strong style={{ color: 'var(--danger, #ef4d4d)' }}>This cannot be undone.</strong>
        </p>
        {status && <div className="form-status">{status}</div>}
        {error && <div className="form-hint error-text">{error}</div>}
        <div className="modal-footer">
          <span className="modal-footer-spacer" />
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn danger" onClick={confirm} disabled={busy}>
            {busy ? '…' : 'Delete permanently'}
          </button>
        </div>
      </div>
    </div>
  );
}
