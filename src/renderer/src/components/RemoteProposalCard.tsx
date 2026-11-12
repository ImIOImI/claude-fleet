// A host session's proposal is a config draft (D126): no Approve; Copy as host
// config, and Reject… (steer). Rationale, reasons and YAML are text only; Copy
// copies exactly the YAML shown.
import { useState } from 'react';
import type { RemoteProposal } from '../../../preload';
import { relativeAgo } from '../inboxView';
import { actionGate, configEntryYaml, rowKey, stableFingerprint } from '../remoteAutomationsView';
import { OriginBadge } from './OriginBadge';
import { useRemoteAction } from './useRemoteAction';

export function RemoteProposalCard({ proposal: p }: { proposal: RemoteProposal }) {
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const [copied, setCopied] = useState<number | null>(null);
  const act = useRemoteAction();
  const gate = actionGate(p.tier, p.workspaceName);
  const key = rowKey(p.origin, `reject:${p.id}`);
  const pending = p.status === 'pending';
  const reject = () => {
    const n = note.trim() || null;
    void act.run(key, stableFingerprint({ id: p.id, note: n }), (rid) => window.api.remoteProposals.reject(p.origin, p.id, n, rid))
      .then((r) => { if (r.ok) setRejecting(false); });
  };
  return (
    <article className={`proposal remote-draft${pending ? '' : ' decided'}`} aria-label={`Draft from ${p.workspaceName}`}>
      <div className="pr-eyebrow">
        <span className="pr-kind">{p.kind === 'new' ? 'Host config draft' : 'Host config change'}</span>
        <OriginBadge name={p.workspaceName} hue={p.workspaceColorHue} tier={p.tier} />
        <span className="ib-dim">· {relativeAgo(p.createdAt)}</span>
        {!pending && <span className="state-chip">{p.status}</span>}
      </div>
      {p.rationale && <blockquote className="pr-why">{p.rationale}</blockquote>}
      <p className="remote-managed">A draft from a session on {p.workspaceName}: it runs only once added to the host config through a platform-ops PR.</p>
      {p.items.map((it, i) => {
        const text = configEntryYaml(it.after, p.origin);
        return (
          <div key={i} className="pc-item">
            <div className="pr-title"><b>{it.name}</b>{it.reasons.length > 0 && <span className="ib-dim"> · {it.reasons.join(' · ')}</span>}</div>
            {it.flags.length > 0 && <div className="pr-caps">{it.flags.map((f) => <span key={f} className="tag">{f}</span>)}</div>}
            <pre className="ib-pre" aria-label={`Host config entry for ${it.name}`}>{text}</pre>
            <div className="pr-actions">
              <button className="btn btn-sm" onClick={() => { void window.api.clipboard.write(text).then(() => setCopied(i)); }}>
                {copied === i ? 'Copied' : 'Copy as host config'}
              </button>
            </div>
          </div>
        );
      })}
      {p.note && <p className="pr-note"><span className="ib-dim">Note:</span> {p.note}</p>}
      {pending && (rejecting ? (
        <div className="pr-reject">
          <textarea aria-label="Note for the session" maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional: why (the session can read this)" />
          <div className="pr-actions">
            <button className="btn btn-sm" onClick={() => setRejecting(false)}>Cancel</button>
            <button className="btn btn-sm danger" disabled={!!gate || act.busy.has(key)} title={gate ?? undefined} onClick={reject}>Reject</button>
          </div>
        </div>
      ) : (
        <div className="pr-actions">
          <span className="ib-spacer" />
          <button className="btn btn-sm danger" disabled={!!gate} title={gate ?? undefined} onClick={() => setRejecting(true)}>Reject…</button>
        </div>
      ))}
      {act.errors[key] && <p className="remote-msg">{act.errors[key]}</p>}
    </article>
  );
}
