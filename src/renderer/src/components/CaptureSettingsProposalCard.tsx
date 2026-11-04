// A workspace's proposed knowledge-capture settings change (#483 §5a): the
// field-by-field changes, why it needs approval, Approve / Reject.
import { useState } from 'react';
import type { Proposal } from '../../../preload';
import { relativeAgo, sourceLabel } from '../inboxView';
import { Markdown } from './Markdown';

const err = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export function CaptureSettingsProposalCard({ proposal: p, names }: { proposal: Proposal; names: Record<string, string> }) {
  const pending = p.status === 'pending';
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<unknown>) => { setError(null); void fn().catch((e) => setError(err(e))); };
  const c = p.captureSettings;
  return (
    <article className={`proposal${pending ? '' : ' decided'}`} aria-label={`Knowledge capture proposal from ${sourceLabel(p.proposer, names)}`}>
      <div className="pr-eyebrow">
        <span className="pr-kind">Proposal · knowledge capture settings</span>
        <span className="ib-dim">from</span><span className="src">{sourceLabel(p.proposer, names)}</span>
        <span className="ib-dim">· {relativeAgo(p.createdAt)}</span>
        {!pending && <span className="state-chip">{p.status}</span>}
      </div>
      <h3 className="pr-title">Change knowledge capture for {c ? (names[c.workspaceId] ?? c.workspaceId) : 'a workspace'}</h3>
      {p.rationale && <blockquote className="pr-why"><Markdown text={p.rationale} /></blockquote>}
      {c && pending && c.reasons.length > 0 && (
        <div className="pr-flags"><span className="pr-flags-label">Needs your approval because it</span>
          {c.reasons.map((r) => <span key={r} className="flag">{r}</span>)}
        </div>
      )}
      {c && <ul className="batch-list">{c.changes.map((line) => <li key={line}><span>{line}</span></li>)}</ul>}
      {p.note && <p className="pr-note"><span className="ib-dim">Your note:</span> <Markdown text={p.note} inline /></p>}
      {pending && (rejecting ? (
        <div className="pr-reject">
          <textarea aria-label="Note for the workspace" placeholder="Optional: why (the workspace can read this)" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="pr-actions">
            <button className="btn btn-sm" onClick={() => setRejecting(false)}>Cancel</button>
            <button className="btn btn-sm danger" onClick={() => run(() => window.api.proposals.reject(p.id, note))}>Reject</button>
          </div>
        </div>
      ) : (
        <div className="pr-actions">
          <button className="btn primary" onClick={() => run(() => window.api.proposals.approve(p.id, {}))}>Approve</button>
          <span className="ib-spacer" />
          <button className="btn danger" onClick={() => setRejecting(true)}>Reject…</button>
        </div>
      ))}
      {error && <p className="form-hint error-text" role="alert">{error}</p>}
    </article>
  );
}
