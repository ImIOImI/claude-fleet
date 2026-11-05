// Rename a remote bookmark on this computer only; the host keeps its name.
import { useState } from 'react';
import { ipcErrorText } from '../remoteView';
import { ModalBackdrop } from './ModalBackdrop';

export function RenameRemoteModal({ id, name, onClose }: { id: string; name: string; onClose: () => void }) {
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await window.api.remote.rename(id, draft);
      onClose();
    } catch (err) {
      setError(ipcErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalBackdrop onClose={busy ? undefined : onClose}>
      <div className="modal" role="dialog" aria-label="Rename locally" onClick={(e) => e.stopPropagation()}>
        <h2>Rename locally</h2>
        <p className="muted">Only this computer sees the new name. The host keeps its own.</p>
        <div className="form-row">
          <label htmlFor="remote-rename">Name</label>
          <input
            id="remote-rename"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && draft.trim() && !busy) void save();
            }}
            disabled={busy}
            autoFocus
          />
          {error && <span className="form-hint error-text">{error}</span>}
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !draft.trim()} onClick={() => void save()}>
            Save
          </button>
        </div>
      </div>
    </ModalBackdrop>
  );
}
