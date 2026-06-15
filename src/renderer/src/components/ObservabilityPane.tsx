import type { WorkspaceObservabilitySummary } from '../../../preload';

interface Props {
  /** Active workspace name, or null when nothing is selected. */
  workspaceName: string | null;
  /**
   * Latest observability summary for the active workspace. Distributed
   * from App.tsx's centralized poll so this pane, the workspace chip,
   * and the terminal-pane context bar all share one source of truth
   * (one IPC per workspace per tick instead of one per consumer).
   * Null while no workspace is selected, or while no events have been
   * ingested for the selected workspace.
   */
  summary: WorkspaceObservabilitySummary | null;
}

export function ObservabilityPane({ workspaceName, summary }: Props) {
  return (
    <aside className="pane sidebar-right">
      <div className="pane-header">
        <span>Observability</span>
        {summary?.model && <span className="obs-model">{summary.model}</span>}
      </div>
      <div className="pane-body">
        {!workspaceName ? (
          <EmptyState message="No workspace selected." />
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

      <section className="obs-cost-block">
        <div className="obs-cost-amount mono">{formatUsd(summary.usd)}</div>
        <div className="obs-cost-label">session cost</div>
      </section>

      <section className="obs-section">
        <div className="obs-section-title">Tokens</div>
        <TokenRow label="input" value={summary.inputTokens} />
        <TokenRow label="cache create" value={summary.cacheCreationInputTokens} />
        <TokenRow label="cache read" value={summary.cacheReadInputTokens} subdued />
        <TokenRow label="output" value={summary.outputTokens} accent />
      </section>

      {(summary.recentToolCalls ?? []).length > 0 && (
        <section className="obs-section">
          <div className="obs-section-title">Recent tools</div>
          {(summary.recentToolCalls ?? []).map((t, i) => (
            <div key={i} className={`obs-tool-row ${t.status}`}>
              <span className="obs-tool-name">{t.name}</span>
              {t.input && (
                <span className="obs-tool-input" title={t.input}>
                  {t.input}
                </span>
              )}
              <span className="obs-tool-meta mono">
                {t.durationMs != null ? formatDuration(t.durationMs) : '…'}
                {t.status === 'error' && <span className="obs-tool-err"> err</span>}
              </span>
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

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function formatUsd(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  if (usd < 100) return `$${usd.toFixed(2)}`;
  if (usd < 1000) return `$${usd.toFixed(1)}`;
  return `$${Math.round(usd).toLocaleString('en-US')}`;
}

function relativeTime(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 5_000) return 'just now';
  if (delta < 60_000) return `${Math.round(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  return `${Math.round(delta / 86_400_000)}d ago`;
}
