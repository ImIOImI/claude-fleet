import { useEffect, useState } from 'react';
import type { WorkspaceObservabilitySummary } from '../../../preload';

interface Props {
  /** Active workspace name, or null when nothing is selected. */
  workspaceName: string | null;
}

const POLL_MS = 2000;

export function ObservabilityPane({ workspaceName }: Props) {
  const [summary, setSummary] = useState<WorkspaceObservabilitySummary | null>(null);
  // Distinct from `summary == null`: until the first fetch returns, we don't
  // know whether the workspace has data. Avoids flashing the empty state.
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!workspaceName) {
      setSummary(null);
      setLoaded(true);
      return;
    }
    let cancelled = false;
    setLoaded(false);
    const fetchSummary = async () => {
      try {
        const next = await window.api.observability.summaryForWorkspace(workspaceName);
        if (cancelled) return;
        setSummary(next);
        setLoaded(true);
      } catch {
        // Observability is best-effort; a transient failure shouldn't
        // disrupt the rest of the app. Keep the previous summary.
      }
    };
    fetchSummary();
    const id = setInterval(fetchSummary, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [workspaceName]);

  return (
    <aside className="pane sidebar-right">
      <div className="pane-header">
        <span>Observability</span>
        {summary?.model && <span className="obs-model">{summary.model}</span>}
      </div>
      <div className="pane-body">
        {!workspaceName ? (
          <EmptyState message="No workspace selected." />
        ) : !loaded ? (
          <EmptyState message="Loading…" />
        ) : !summary || summary.sessionId === null ? (
          <EmptyState message="No transcript events yet." subdued />
        ) : (
          <SummaryView summary={summary} />
        )}
      </div>
    </aside>
  );
}

function SummaryView({ summary }: { summary: WorkspaceObservabilitySummary }) {
  return (
    <div className="obs-stack">
      <section className="obs-title-block">
        {summary.title && <div className="obs-title">{summary.title}</div>}
        <div className="obs-meta-row">
          {summary.lastActiveAt && <span>active {relativeTime(summary.lastActiveAt)}</span>}
          <span>·</span>
          <span>
            {summary.eventCount} event{summary.eventCount === 1 ? '' : 's'}
          </span>
        </div>
      </section>

      <section className="obs-section">
        <div className="obs-section-title">Tokens</div>
        <TokenRow label="input" value={summary.inputTokens} />
        <TokenRow label="cache create" value={summary.cacheCreationInputTokens} />
        <TokenRow label="cache read" value={summary.cacheReadInputTokens} subdued />
        <TokenRow label="output" value={summary.outputTokens} accent />
      </section>

      {summary.topTools.length > 0 && (
        <section className="obs-section">
          <div className="obs-section-title">Top tools</div>
          {summary.topTools.map((t) => (
            <div key={t.name} className="obs-row">
              <span className="obs-row-label">{t.name}</span>
              <span className="obs-row-value">{t.count}</span>
            </div>
          ))}
        </section>
      )}

      <section className="obs-section obs-section-quiet">
        <div className="obs-row">
          <span className="obs-row-label">started</span>
          <span className="obs-row-value mono">
            {summary.startedAt ? new Date(summary.startedAt).toLocaleString() : '—'}
          </span>
        </div>
        {summary.sessionId && (
          <div className="obs-row">
            <span className="obs-row-label">session</span>
            <span className="obs-row-value mono" title={summary.sessionId}>
              {summary.sessionId.slice(0, 8)}…
            </span>
          </div>
        )}
      </section>
    </div>
  );
}

function TokenRow({
  label,
  value,
  subdued,
  accent,
}: {
  label: string;
  value: number;
  subdued?: boolean;
  accent?: boolean;
}) {
  return (
    <div className={`obs-row ${subdued ? 'subdued' : ''} ${accent ? 'accent' : ''}`}>
      <span className="obs-row-label">{label}</span>
      <span className="obs-row-value mono">{formatTokens(value)}</span>
    </div>
  );
}

function EmptyState({ message, subdued }: { message: string; subdued?: boolean }) {
  return (
    <div className={`pane-placeholder ${subdued ? 'subdued' : ''}`}>
      <p style={{ margin: 0, color: 'var(--text-muted)' }}>{message}</p>
    </div>
  );
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 2 : 1)}K`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
}

function relativeTime(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 5_000) return 'just now';
  if (delta < 60_000) return `${Math.round(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  return `${Math.round(delta / 86_400_000)}d ago`;
}
