// App-level settings: the fleet root — the single host directory that holds
// every workspace's private folder (<root>/<id>) and the shared folder
// (<root>/shared) mounted into every container (changing it takes effect for
// new containers and on the next restart of existing ones) — plus the
// hardware-acceleration toggle (applied at the next app launch).

import { useEffect, useState } from 'react';

interface Props {
  onClose: () => void;
  /** Called after a successful save with the new config so the app can refresh. */
  onSaved: (config: { fleetRoot: string; sharedDir: string }) => void;
}

export function SettingsModal({ onClose, onSaved }: Props) {
  const [fleetRoot, setFleetRoot] = useState('');
  const [hwaDisabled, setHwaDisabled] = useState(false);
  // The persisted HWA value at open time — used to know whether the toggle
  // actually changed, so we only nudge "restart to apply" when it did.
  const [hwaInitial, setHwaInitial] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void window.api.config.get().then((cfg) => {
      if (live) {
        setFleetRoot(cfg.fleetRoot);
        setHwaDisabled(cfg.disableHardwareAcceleration);
        setHwaInitial(cfg.disableHardwareAcceleration);
        setLoaded(true);
      }
    });
    return () => {
      live = false;
    };
  }, []);

  const browse = async () => {
    const picked = await window.api.dialog.pickDirectory(fleetRoot.trim() || undefined);
    if (picked) setFleetRoot(picked);
  };

  const save = async () => {
    if (busy) return;
    const trimmed = fleetRoot.trim();
    if (!trimmed) {
      setError('Fleet root cannot be empty.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (hwaDisabled !== hwaInitial) {
        await window.api.config.setHardwareAccelDisabled(hwaDisabled);
      }
      const cfg = await window.api.config.setFleetRoot(trimmed);
      onSaved(cfg);
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-tabbed" onClick={(e) => e.stopPropagation()}>
        <div className="modal-tabs" role="tablist">
          <div className="modal-tab active" aria-current="page">
            Settings
          </div>
        </div>
        <div className="new-tab" role="tabpanel">
          <div className="form-row">
            <label>Fleet root (host path)</label>
            <div className="input-with-button">
              <input
                value={fleetRoot}
                onChange={(e) => setFleetRoot(e.target.value)}
                placeholder="/home/you/fleet"
                disabled={busy || !loaded}
              />
              <button type="button" onClick={browse} disabled={busy || !loaded}>
                Browse…
              </button>
            </div>
          </div>
          <p className="form-hint">
            Each workspace gets a private folder at <code>&lt;root&gt;/&lt;id&gt;</code> (mounted at{' '}
            <code>/workspace</code>, visible only to that container) plus a shared{' '}
            <code>&lt;root&gt;/shared</code> folder mounted into every container at{' '}
            <code>/shared</code>. Changing the root applies to new containers and to existing ones
            on their next restart.
          </p>
          <div className="form-row">
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={hwaDisabled}
                onChange={(e) => setHwaDisabled(e.target.checked)}
                disabled={busy || !loaded}
              />
              <span>Disable hardware acceleration</span>
            </label>
          </div>
          <p className="form-hint">
            Turn this on if Chromium&apos;s GPU process logs errors on startup (common on WSLg) —
            rendering falls back to CPU. Applies the next time you launch claude-fleet.
            {hwaDisabled !== hwaInitial && (
              <strong> Restart required to take effect.</strong>
            )}
          </p>
          {error && <div className="form-hint error-text">{error}</div>}
          <div className="modal-footer">
            <span className="modal-footer-spacer" />
            <button type="button" className="btn" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn primary" onClick={save} disabled={busy || !loaded}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
