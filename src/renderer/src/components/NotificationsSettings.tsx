// Settings › Notifications (#407 Phase 2): default level, downtime schedules
// (week view + list + add/edit), rules made from the 🔔, and an OS check.
// Changes save immediately (each control is its own small write), unlike the
// Settings tab's batch Save, because the rules are also edited from the 🔔.
import { useCallback, useEffect, useState } from 'react';
import type { Downtime, NotifyLevel, NotifySettings } from '../../../preload';
import { BYPASS_LABELS, LEVEL_LABELS, downtimeSummary, hhmm, hhmmToMin, minToHHMM, ruleScopeLabel } from '../notifyView';

interface Props {
  names: Record<string, string>;
}

const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const KEY_COLORS = ['b-c0', 'b-c1', 'b-c2', 'b-c3'];
type Draft = { id?: string; name: string; days: number[]; start: string; end: string; bypass: Downtime['bypass']; enabled: boolean };
const blank: Draft = { name: '', days: [0, 1, 2, 3, 4], start: '22:00', end: '07:00', bypass: 'none', enabled: true };

/** Blocks [startMin, endMin) per weekday for the week view; overnight windows spill into the next day. */
function blocks(d: Downtime): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (const day of d.days) {
    if (d.startMin === d.endMin) out.push([day, 0, 1440]);
    else if (d.endMin > d.startMin) out.push([day, d.startMin, d.endMin]);
    else {
      out.push([day, d.startMin, 1440]);
      out.push([(day + 1) % 7, 0, d.endMin]);
    }
  }
  return out;
}

export function NotificationsSettings({ names }: Props) {
  const [s, setS] = useState<NotifySettings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [tested, setTested] = useState(false);

  const reload = useCallback(() => void window.api.notifications.settings().then(setS), []);
  useEffect(() => {
    reload();
    void window.api.notifications.permission().then((p) => setSupported(p.supported));
    return window.api.notifications.onChanged(() => reload());
  }, [reload]);

  const saveDraft = async () => {
    if (!draft) return;
    const startMin = hhmmToMin(draft.start), endMin = hhmmToMin(draft.end);
    if (startMin === null || endMin === null) return setError('Times must look like 22:00.');
    if (!draft.days.length) return setError('Pick at least one day.');
    setError(null);
    await window.api.notifications.saveDowntime({ id: draft.id, name: draft.name || 'Downtime', days: draft.days, startMin, endMin, bypass: draft.bypass, enabled: draft.enabled });
    setDraft(null);
    reload();
  };

  if (!s) return <div className="new-tab"><p className="setting-desc">Loading…</p></div>;
  const now = new Date();
  const todayIdx = (now.getDay() + 6) % 7;
  const nowPct = ((now.getHours() * 60 + now.getMinutes()) / 1440) * 100;

  return (
    <div className="new-tab notif-settings" role="tabpanel">
      <div className="settings-section">
        <div className="settings-section-header">Delivery</div>
        <div className="setting-row">
          <div className="setting-row-text">
            <label className="setting-title" htmlFor="sn-level">Notify me for</label>
            <p className="setting-desc">Default for anything without a more specific rule.</p>
          </div>
          <select id="sn-level" value={s.defaultLevel} onChange={(e) => void window.api.notifications.setDefaultLevel(e.target.value as NotifyLevel).then(reload)}>
            {(['all', 'high', 'urgent', 'off'] as NotifyLevel[]).map((l) => <option key={l} value={l}>{LEVEL_LABELS[l]}</option>)}
          </select>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-header">Downtime</div>
        <p className="setting-desc">Recurring times when notifications are held. Todos still arrive. When a downtime ends you get one summary.</p>
        <div className="week" aria-label="Downtime this week">
          <div className="week-hours"><span />{[0, 6, 12, 18, 24].map((h) => <span key={h} style={{ left: `${(h / 24) * 100}%` }}>{String(h).padStart(2, '0')}</span>)}</div>
          {DAY_SHORT.map((d, i) => (
            <div className="week-row" key={d}>
              <span className={`week-day${i === todayIdx ? ' today' : ''}`}>{d}</span>
              <div className="week-track">
                {s.downtimes.filter((x) => x.enabled).flatMap((x) => {
                  const color = KEY_COLORS[s.downtimes.indexOf(x) % KEY_COLORS.length];
                  return blocks(x).filter(([day]) => day === i).map(([, a, b], k) => (
                    <span key={`${x.id}-${k}`} className={`wblk ${color}`} title={x.name} style={{ left: `${(a / 1440) * 100}%`, width: `${((b - a) / 1440) * 100}%` }} />
                  ));
                })}
                {i === todayIdx && <span className="week-now" style={{ left: `${nowPct}%` }} />}
              </div>
            </div>
          ))}
        </div>
        <ul className="dt-list" aria-label="Downtime schedules">
          {s.downtimes.map((d, i) => (
            <li key={d.id}>
              <input type="checkbox" aria-label={`${d.name} enabled`} checked={d.enabled} onChange={(e) => void window.api.notifications.saveDowntime({ ...d, enabled: e.target.checked }).then(reload)} />
              <span className={`wkey ${KEY_COLORS[i % KEY_COLORS.length]}`} />
              <b>{d.name}</b>
              <span className="mono ib-dim">{downtimeSummary(d)}</span>
              <span className={`dt-thru${d.bypass === 'none' ? '' : ' on'}`}>{BYPASS_LABELS[d.bypass]}</span>
              <span className="dt-actions">
                <button className="btn-mini" onClick={() => setDraft({ id: d.id, name: d.name, days: d.days, start: minToHHMM(d.startMin), end: minToHHMM(d.endMin), bypass: d.bypass, enabled: d.enabled })}>Edit</button>
                <button className="btn-mini danger" onClick={() => void window.api.notifications.removeDowntime(d.id).then(reload)}>Remove</button>
              </span>
            </li>
          ))}
        </ul>
        {draft ? (
          <div className="dt-form" aria-label="Downtime editor">
            <div className="dt-form-row">
              <input aria-label="Downtime name" placeholder="Name, e.g. Nights" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              <input aria-label="Starts at" className="sn-time" value={draft.start} onChange={(e) => setDraft({ ...draft, start: e.target.value })} />
              <span className="ib-dim">to</span>
              <input aria-label="Ends at" className="sn-time" value={draft.end} onChange={(e) => setDraft({ ...draft, end: e.target.value })} />
            </div>
            <div className="dt-days" role="group" aria-label="Days">
              {DAY_SHORT.map((d, i) => (
                <label key={d} className={`dt-day${draft.days.includes(i) ? ' on' : ''}`}>
                  <input type="checkbox" checked={draft.days.includes(i)} onChange={(e) => setDraft({ ...draft, days: e.target.checked ? [...draft.days, i] : draft.days.filter((x) => x !== i) })} />
                  {d}
                </label>
              ))}
            </div>
            <div className="dt-form-row">
              <label htmlFor="dt-bypass" className="ib-dim">During it</label>
              <select id="dt-bypass" value={draft.bypass} onChange={(e) => setDraft({ ...draft, bypass: e.target.value as Downtime['bypass'] })}>
                <option value="none">Hold everything (urgent waits)</option>
                <option value="urgent">Let urgent through</option>
                <option value="urgent+input">Let urgent and needs-input through</option>
              </select>
              <span className="ib-spacer" />
              <button className="btn btn-sm" onClick={() => { setDraft(null); setError(null); }}>Cancel</button>
              <button className="btn btn-sm primary" onClick={() => void saveDraft()}>Save downtime</button>
            </div>
            {error && <p className="form-hint error-text">{error}</p>}
          </div>
        ) : (
          <button className="btn btn-sm" onClick={() => setDraft({ ...blank })}>+ Add downtime</button>
        )}
      </div>

      <div className="settings-section">
        <div className="settings-section-header">Rules</div>
        <p className="setting-desc">Made from the 🔔 on any todo or notification. The most specific rule wins: item, then source, then tag, then the default.</p>
        {s.rules.length === 0 ? (
          <p className="setting-desc ib-dim">No rules yet.</p>
        ) : (
          <table className="rules">
            <thead><tr><th>Applies to</th><th>Level</th><th>Snooze</th><th /></tr></thead>
            <tbody>
              {s.rules.map((r) => (
                <tr key={r.id}>
                  <td><span className="scope-k">{r.scopeKind === 'key' ? 'item' : r.scopeKind}</span>{ruleScopeLabel(r.scopeKind, r.scopeValue, names)}</td>
                  <td>{LEVEL_LABELS[r.level]}</td>
                  <td className={r.snoozeUntil && r.snoozeUntil > Date.now() ? 'mono' : 'ib-dim'}>
                    {r.snoozeUntil && r.snoozeUntil > Date.now() ? `until ${new Date(r.snoozeUntil).toDateString() === new Date().toDateString() ? hhmm(r.snoozeUntil) : new Date(r.snoozeUntil).toLocaleDateString()}` : '—'}
                  </td>
                  <td><button className="btn-mini" onClick={() => void window.api.notifications.removeRule(r.id).then(reload)}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="settings-section">
        <div className="settings-section-header">Desktop notifications</div>
        <div className="setting-row">
          <div className="setting-row-text">
            <span className="setting-title"><span className={`sn-ok${supported === false ? ' off' : ''}`} />
              {supported === false ? 'Desktop notifications are not supported here' : 'Desktop notifications are available'}
            </span>
            <p className="setting-desc">When the window is focused you get an in-app toast instead. If desktop notifications stop showing, check your OS notification settings.</p>
          </div>
          <button className="btn btn-sm" onClick={() => void window.api.notifications.test().then(() => setTested(true))}>{tested ? 'Sent' : 'Send a test'}</button>
        </div>
      </div>
    </div>
  );
}
