// Settings › Storage › History and inbox: SQLite or the managed Postgres
// container. A move to Postgres applies at restart; a move back from a running
// Postgres store copies the inbox back first and relaunches.
import { useEffect, useState } from 'react';
import type { StoreSettings } from '../../../preload';
import {
  STORE_CHOICES,
  storeErrorText,
  storeNotices,
  switchBackProgressText,
  storeSwitchConfirm,
  storeSwitchNote,
  type SettableChoice,
} from '../storeView';
import { ModalBackdrop } from './ModalBackdrop';

export function StorageSettings() {
  const [s, setS] = useState<StoreSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<SettableChoice | null>(null);
  const [busy, setBusy] = useState(false);
  const [relaunching, setRelaunching] = useState(false);

  useEffect(() => {
    let live = true;
    window.api.store.getSettings()
      .then((x) => { if (live) setS(x); })
      .catch((e: unknown) => { if (live) setError(storeErrorText(e)); });
    const off = window.api.store.onStatus((status) => setS((cur) => (cur ? { ...cur, status } : cur)));
    return () => { live = false; off(); };
  }, []);

  if (!s) return error ? <p className="setting-desc error-text">{error}</p> : null;
  if (s.configured === 'external') {
    return (
      <p className="setting-desc store-choice-external">
        History and inbox are in an external Postgres store set in config.json (<code>store</code>). Edit the file to change it.
      </p>
    );
  }

  const confirm = pending ? storeSwitchConfirm(s.active, s.configured, pending) : null;

  async function apply(): Promise<void> {
    if (!pending || !confirm) return;
    setBusy(true);
    setError(null);
    try {
      const next = await window.api.store.setChoice(pending);
      setS(next);
      if (confirm.relaunches && next.configured === pending) setRelaunching(true);
      setPending(null);
    } catch (e) {
      setError(storeErrorText(e));
    } finally {
      setBusy(false);
    }
  }

  const note = storeSwitchNote(s.active, s.configured);
  const notices = storeNotices(s);
  return (
    <div className="store-choice" role="radiogroup" aria-label="History and inbox store">
      <div className="setting-title">History and inbox</div>
      {STORE_CHOICES.map((c) => (
        <label key={c.id} className="setting-row store-choice-row">
          <input
            type="radio"
            name="store-choice"
            value={c.id}
            checked={s.configured === c.id}
            disabled={busy || relaunching}
            onChange={() => { setError(null); setPending(c.id); }}
          />
          <span className="setting-row-text">
            <span className="setting-title">{c.label}</span>
            <span className="setting-desc">{c.desc}</span>
          </span>
        </label>
      ))}
      {notices.map((n) => <p key={n} className="setting-desc store-choice-notice">{n}</p>)}
      {relaunching && <p className="setting-desc"><strong>Switched.</strong> The app is relaunching on SQLite.</p>}
      {!relaunching && s.restartRequired && note && (
        <div className="store-choice-restart">
          <p className="setting-desc"><strong>Restart required.</strong> {note}</p>
          <button type="button" className="btn" onClick={() => void window.api.app.relaunch()}>Restart now</button>
        </div>
      )}
      {!confirm && error && <p className="setting-desc error-text">{error}</p>}
      {confirm && (
        <ModalBackdrop onClose={busy ? undefined : () => setPending(null)}>
          <div className="modal store-confirm" role="dialog" aria-label={confirm.title} onClick={(e) => e.stopPropagation()}>
            <h2>{confirm.title}</h2>
            {confirm.steps.map((step) => <p key={step} className="store-confirm-step">{step}</p>)}
            {busy && confirm.relaunches && (
              <div className="form-status">{switchBackProgressText(s.status)}</div>
            )}
            {error && <div className="form-hint error-text">{error}</div>}
            <div className="modal-footer">
              <span className="modal-footer-spacer" />
              <button type="button" className="btn" onClick={() => setPending(null)} disabled={busy}>Cancel</button>
              <button type="button" className="btn primary" onClick={() => void apply()} disabled={busy}>
                {busy ? '…' : confirm.confirmLabel}
              </button>
            </div>
          </div>
        </ModalBackdrop>
      )}
    </div>
  );
}
