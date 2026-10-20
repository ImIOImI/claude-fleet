// A workspace's automation proposal (#407 Phase 5): why it needs you, what it
// could do, the YAML diff, and Approve / Edit then approve / Reject — per item
// for batches. Auto-applied and approved changes stay revertible.
import { useState } from 'react';
import { stringify } from 'yaml';
import type { Proposal, ProposalItem } from '../../../preload';
import { compact, diffLines } from '../lineDiff';
import { relativeAgo, sourceLabel } from '../inboxView';
import { AutomationEditor } from './AutomationEditor';
import { AskClaude } from './AskClaude';

interface Props {
  proposal: Proposal;
  names: Record<string, string>;
  canDiscuss?: boolean;
  onDiscussed?: () => void;
  onWatch?: () => void;
  /** The automations workspace; only its own drafts can be refined in place. */
  automationsWsId?: string | null;
}

const KIND = { new: 'Proposal · new automation', change: 'Proposal · change', batch: 'Proposal' } as const;
const DECISION: Record<ProposalItem['decision'], string> = {
  pending: 'needs you', accepted: 'approved', declined: 'declined', 'auto-applied': 'auto-applied', reverted: 'reverted'
};
const toYaml = (v: unknown) => stringify(v, { lineWidth: 0 });
const err = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

function Diff({ item }: { item: ProposalItem }) {
  const lines = compact(diffLines(item.before ? toYaml(item.before) : '', toYaml(item.after)), 2);
  return (
    <pre className="ib-pre diff pr-diff" aria-label={`Changes to ${item.name}`}>
      {lines.map((l, i) =>
        l.type === 'gap' ? <span key={i} className="gap">  …{'\n'}</span>
          : <span key={i} className={l.type}>{l.type === 'add' ? '+ ' : l.type === 'del' ? '- ' : '  '}{l.text}{'\n'}</span>)}
    </pre>
  );
}

export function ProposalCard({ proposal: p, names, canDiscuss = false, onDiscussed, onWatch, automationsWsId = null }: Props) {
  const pending = p.status === 'pending';
  const [accept, setAccept] = useState<Set<number>>(new Set(p.items.map((_, i) => i)));
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<unknown>) => { setError(null); void fn().catch((e) => setError(err(e))); };
  const single = p.items.length === 1 ? p.items[0] : null;
  const pendingIdx = p.items.map((it, i) => (it.decision === 'pending' ? i : -1)).filter((i) => i >= 0);

  return (
    <article className={`proposal${p.kind === 'batch' ? ' batch' : ''}${pending ? '' : ' decided'}`} aria-label={`Proposal from ${sourceLabel(p.proposer, names)}`}>
      <div className="pr-eyebrow">
        <span className="pr-kind">{p.kind === 'batch' ? `Proposal · ${p.items.length} changes` : KIND[p.kind]}</span>
        <span className="ib-dim">from</span><span className="src">{sourceLabel(p.proposer, names)}</span>
        <span className="ib-dim">· {relativeAgo(p.createdAt)}</span>
        {!pending && <span className="state-chip">{p.status}</span>}
      </div>
      <h3 className="pr-title">{single ? single.name : p.rationale?.split('\n')[0].slice(0, 90) ?? `${p.items.length} automation changes`}</h3>
      {p.rationale && <blockquote className="pr-why">{p.rationale}</blockquote>}

      {single ? (
        <>
          {single.reasons.length > 0 && single.decision === 'pending' && (
            <div className="pr-flags"><span className="pr-flags-label">Needs your approval because it</span>
              {single.reasons.map((r) => <span key={r} className="flag">{r}</span>)}
            </div>
          )}
          {single.flags.length > 0 && <div className="pr-caps">{single.flags.map((f) => <span key={f} className="tag">{f}</span>)}</div>}
          <Diff item={single} />
        </>
      ) : (
        <ul className="batch-list">
          {p.items.map((it, i) => (
            <li key={i} className={it.decision === 'pending' ? 'needs' : 'auto-ok'}>
              <b>{it.name}</b>
              <span className="ib-dim">{it.reasons.length ? it.reasons.join(' · ') : 'low-risk change'}</span>
              <span className={`b-state ${it.decision === 'pending' ? 'wait' : it.decision === 'declined' || it.decision === 'reverted' ? '' : 'ok'}`}>{DECISION[it.decision]}</span>
              {it.decision === 'pending' && pending && (
                <span className="b-pick">
                  <button className={`btn-mini${accept.has(i) ? ' on' : ''}`} aria-pressed={accept.has(i)} onClick={() => setAccept((s) => new Set(s).add(i))}>Accept</button>
                  <button className={`btn-mini${accept.has(i) ? '' : ' on'}`} aria-pressed={!accept.has(i)} onClick={() => setAccept((s) => { const n = new Set(s); n.delete(i); return n; })}>Decline</button>
                </span>
              )}
              {(it.decision === 'auto-applied' || it.decision === 'accepted') && it.before && (
                <button className="btn-mini" onClick={() => run(() => window.api.proposals.revert(p.id, i))}>Revert</button>
              )}
            </li>
          ))}
        </ul>
      )}

      {single && (single.decision === 'auto-applied' || single.decision === 'accepted') && single.before && (
        <div className="pr-actions"><button className="btn btn-sm" onClick={() => run(() => window.api.proposals.revert(p.id, 0))}>Revert this change</button></div>
      )}
      {p.note && <p className="pr-note"><span className="ib-dim">Your note:</span> {p.note}</p>}

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
          <button className="btn primary" onClick={() => run(() => window.api.proposals.approve(p.id, single ? {} : { accept: pendingIdx.filter((i) => accept.has(i)) }))}>
            {single ? 'Approve' : 'Apply accepted'}
          </button>
          {single && <button className="btn" onClick={() => setEditing(toYaml(single.after))}>Edit, then approve</button>}
          {canDiscuss && (
            <button className="btn ask-btn" title="Sends this proposal (as data) to a session in the automations workspace for a review"
              onClick={() => run(async () => { await window.api.automations.discuss(p.id); onDiscussed?.(); })}>Ask Claude about this</button>
          )}
          <span className="ib-spacer" />
          <button className="btn danger" onClick={() => setRejecting(true)}>{single ? 'Reject…' : 'Decline all…'}</button>
        </div>
      ))}
      {pending && single && single.decision === 'pending' && !!automationsWsId && p.proposer.id === automationsWsId && !rejecting && (
        <AskClaude
          label={`Ask for changes to ${single.name}`}
          placeholder="Ask for changes… (Claude revises the draft; the new version replaces this card)"
          button="Ask for changes"
          send={(t) => window.api.proposals.refine(p.id, 0, t)}
          sentNote="Sent. The revised version will replace this card."
          onWatch={onWatch}
        />
      )}
      {error && <p className="form-hint error-text" role="alert">{error}</p>}
      {editing !== null && (
        <AutomationEditor
          automationId={single?.automationId ?? null}
          initialYaml={editing}
          title={`Edit, then approve: ${single?.name ?? ''}`}
          submitLabel="Approve edited version"
          onSubmit={async (text) => { await window.api.proposals.approve(p.id, { editedYaml: text, editedIndex: 0 }); }}
          onClose={() => setEditing(null)}
          onSaved={() => setEditing(null)}
        />
      )}
    </article>
  );
}
