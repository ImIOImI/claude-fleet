// Inbox header notify control (#407 Phase 2): always shows the current state
// ("Notifying · Nights at 22:00" / "Paused · until 15:30") and opens the pause menu.
import { useEffect, useRef, useState } from 'react';
import type { QuietState } from '../../../preload';
import { pausePresets, quietLabel } from '../notifyView';

interface Props {
  quiet: QuietState | null;
  onOpenSchedules: () => void;
}

export const BellIcon = () => (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
  </svg>
);
export const BellOffIcon = () => (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5" /><path d="M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /><path d="m2 2 20 20" />
  </svg>
);

export function NotifyControl({ quiet, onOpenSchedules }: Props) {
  const [open, setOpen] = useState(false);
  const [letUrgent, setLetUrgent] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  const label = quietLabel(quiet);
  const paused = label.state === 'paused';

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const pause = async (until: number | null) => {
    await window.api.notifications.pause({ until, letUrgent });
    setOpen(false);
  };
  const extend = async (until: number | null) => {
    await window.api.notifications.pause({ until, letUrgent: quiet?.pause?.letUrgent ?? letUrgent });
    setOpen(false);
  };
  const now = Date.now();

  return (
    <div className="ph-ctl-wrap" ref={ref}>
      <button
        className={`btn btn-sm ph-btn ${label.state === 'notifying' ? 'on' : 'paused'}${open ? ' open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Notifications: ${label.text}${label.detail ? ` ${label.detail}` : ''}`}
        onClick={() => setOpen((o) => !o)}
      >
        {label.state === 'notifying' ? <BellIcon /> : <BellOffIcon />}
        {label.text}
        {label.detail && <span className="ib-dim">· {label.detail}</span>} ▾
      </button>
      {open && (
        <div className="ws-chip-menu pause-menu hdr" role="menu">
          <div className="pm-state">
            {paused ? <BellOffIcon /> : <BellIcon />}
            <span>
              <b>{label.text}</b>
              <span className="ib-dim">
                {paused
                  ? `${label.detail} · ${quiet?.heldSinceQuiet ?? 0} held`
                  : label.state === 'downtime'
                    ? `${label.detail} · ${quiet?.heldSinceQuiet ?? 0} held`
                    : quiet?.nextDowntime ? `next downtime: ${label.detail}` : 'no downtime scheduled'}
              </span>
            </span>
          </div>
          <div className="ws-chip-menu-divider" />
          {paused ? (
            <>
              <button role="menuitem" onClick={() => void window.api.notifications.resume().then(() => setOpen(false))}>Resume now</button>
              <button role="menuitem" onClick={() => void extend((quiet?.pause?.until ?? now) + 30 * 60_000)}>Extend by 30 minutes</button>
              {pausePresets(now).filter((p) => p.hint).map((p) => (
                <button key={p.label} role="menuitem" onClick={() => void extend(p.until)}>Extend until 17:00 <span className="pm-hint">{p.hint}</span></button>
              ))}
              <button role="menuitem" onClick={() => void extend(null)}>Until I turn it back on</button>
            </>
          ) : (
            <>
              <div className="pm-label">Pause notifications</div>
              {pausePresets(now).map((p) => (
                <button key={p.label} role="menuitem" onClick={() => void pause(p.until)}>
                  {p.label}{p.hint && <span className="pm-hint">{p.hint}</span>}
                </button>
              ))}
            </>
          )}
          <div className="ws-chip-menu-divider" />
          <label className="pm-check">
            <input type="checkbox" checked={paused ? quiet?.pause?.letUrgent ?? true : letUrgent}
              onChange={(e) => {
                if (paused) void window.api.notifications.pause({ until: quiet?.pause?.until ?? null, letUrgent: e.target.checked });
                else setLetUrgent(e.target.checked);
              }} />
            Let urgent through
          </label>
          <div className="ws-chip-menu-divider" />
          <button role="menuitem" onClick={() => { setOpen(false); onOpenSchedules(); }}>Downtime schedules…</button>
        </div>
      )}
    </div>
  );
}
