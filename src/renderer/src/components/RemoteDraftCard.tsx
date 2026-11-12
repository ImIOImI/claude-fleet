// An entry drafted here for a remote host's config (D127): no Approve, since
// it lands through a platform-ops PR. Copy as host config copies exactly the
// text shown. Rationale and YAML render as text only.
import { useState } from 'react';
import type { RemoteDraft } from '../../../preload';
import { relativeAgo } from '../inboxView';
import { configEntryYaml } from '../remoteAutomationsView';
import { OriginBadge } from './OriginBadge';

export function RemoteDraftCard({ draft: d }: { draft: RemoteDraft }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const text = configEntryYaml(d.definition, d.origin);
  return (
    <article className="proposal remote-draft" aria-label={`Draft for ${d.workspaceName}`}>
      <div className="pr-eyebrow">
        <span className="pr-kind">{d.kind === 'new' ? 'Host config draft' : 'Host config change'}</span>
        <OriginBadge name={d.workspaceName} hue={null} tier={null} />
        <span className="ib-dim">· {relativeAgo(d.createdAt)}</span>
      </div>
      <h3 className="pr-title">{d.name}</h3>
      {d.rationale && <blockquote className="pr-why">{d.rationale}</blockquote>}
      <p className="remote-managed">For the host config of {d.workspaceName}: add it through a platform-ops PR. Nothing runs until that PR merges.</p>
      <pre className="ib-pre" aria-label={`Host config entry for ${d.name}`}>{text}</pre>
      <div className="pr-actions">
        <button className="btn btn-sm primary" onClick={() => {
          setError(null);
          void window.api.clipboard.write(text).then(() => setCopied(true), (e) => setError(String((e as Error).message ?? e)));
        }}>{copied ? 'Copied' : 'Copy as host config'}</button>
        <span className="ib-spacer" />
        <button className="btn btn-sm" onClick={() => void window.api.automations.dismissRemoteDraft(d.id)}>Dismiss</button>
      </div>
      {error && <p className="form-hint error-text" role="alert">{error}</p>}
    </article>
  );
}
