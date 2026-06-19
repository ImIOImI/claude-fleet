import { useState } from 'react';
import type { WorkspaceObservabilitySummary } from '../../../preload';
import { colorFor, type WorkspaceSummary } from '../App';
import {
  workspaceHostPath,
  workspacePathLabel,
  formatResourceLimits
} from '../observabilityWorkspace';

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
  /** The selected workspace — drives the Workspace metadata block (path/image/limits). */
  workspace: WorkspaceSummary | null;
  /** The fleet's shared folder (<fleetRoot>/shared), or null before config loads. */
  sharedDir: string | null;
  /** All workspaces — drives the Fleet scope (per-workspace cost rows). */
  workspaces: WorkspaceSummary[];
  /** Per-workspace summaries keyed by ULID; Fleet view reads `usd` from each. */
  summaries: Record<string, WorkspaceObservabilitySummary | null>;
  /** One entry per session tab in the selected workspace (context bars). */
  terminals: Array<{ id: string; name: string; contextTokens: number; windowTokens: number }>;
  /** The active tab's session id (highlighted in the context bars). */
  activeTerminalId: string | null;
  /** When true, the rail is minimized to a thin reopen strip. */
  collapsed: boolean;
  /** Toggle the collapsed state (persisted by App.tsx). */
  onToggleCollapse: () => void;
}

type Scope = 'workspace' | 'fleet';

export function ObservabilityPane({
  workspaceName,
  summary,
  workspace,
  sharedDir,
  workspaces,
  summaries,
  terminals,
  activeTerminalId,
  collapsed,
  onToggleCollapse
}: Props) {
  const [scope, setScope] = useState<Scope>('workspace');
  const live = workspaces.filter((w) => w.state !== 'deleted');

  if (collapsed) {
    return (
      <aside className="pane sidebar-right obs-rail-collapsed">
        <button
          type="button"
          className="obs-rail-toggle obs-rail-expand"
          onClick={onToggleCollapse}
          title="Show observability"
          aria-label="Show observability"
        >
          ‹
        </button>
      </aside>
    );
  }

  return (
    <aside className="pane sidebar-right">
      <div className="pane-header">
        <span>Observability</span>
        <div className="pane-header-right">
          {scope === 'workspace' && summary?.model && (
            <span className="obs-model">{summary.model}</span>
          )}
          <button
            type="button"
            className="obs-rail-toggle"
            onClick={onToggleCollapse}
            title="Hide observability"
            aria-label="Hide observability"
          >
            ›
          </button>
        </div>
      </div>
      {live.length > 0 && (
        <ScopeToggle
          scope={scope}
          onScope={setScope}
          workspaceName={workspaceName}
          fleetCount={live.length}
        />
      )}
      <div className="pane-body">
        {scope === 'fleet' ? (
          <FleetView workspaces={live} summaries={summaries} />
        ) : !workspaceName ? (
          <EmptyState message="No workspace selected." />
        ) : (
          <div className="obs-stack">
            {!summary || summary.sessionId === null ? (
              <EmptyState message="No transcript events yet." subdued />
            ) : (
              <SummaryView
                summary={summary}
                terminals={terminals}
                activeTerminalId={activeTerminalId}
              />
            )}
            {workspace && <WorkspaceBlock workspace={workspace} sharedDir={sharedDir} />}
          </div>
        )}
      </div>
    </aside>
  );
}

function ScopeToggle({
  scope,
  onScope,
  workspaceName,
  fleetCount
}: {
  scope: Scope;
  onScope: (s: Scope) => void;
  workspaceName: string | null;
  fleetCount: number;
}) {
  return (
    <div className="obs-scope-toggle" role="tablist" aria-label="Observability scope">
      <button
        role="tab"
        aria-selected={scope === 'workspace'}
        className={`obs-scope-btn ${scope === 'workspace' ? 'active' : ''}`}
        onClick={() => onScope('workspace')}
        title={workspaceName ?? 'No workspace selected'}
      >
        This workspace
      </button>
      <button
        role="tab"
        aria-selected={scope === 'fleet'}
        className={`obs-scope-btn ${scope === 'fleet' ? 'active' : ''}`}
        onClick={() => onScope('fleet')}
      >
        Fleet · {fleetCount}
      </button>
    </div>
  );
}

function FleetView({
  workspaces,
  summaries
}: {
  workspaces: WorkspaceSummary[];
  summaries: Record<string, WorkspaceObservabilitySummary | null>;
}) {
  const rows = workspaces.map((w) => ({
    id: w.id,
    name: w.name,
    state: w.state,
    hue: colorFor(w),
    usd: summaries[w.id]?.usd ?? 0
  }));
  const total = rows.reduce((a, r) => a + r.usd, 0);

  return (
    <div className="obs-stack">
      <section className="obs-cost-block">
        <div className="obs-section-title">
          Fleet · cost across {rows.length} workspace{rows.length === 1 ? '' : 's'}
        </div>
        <div className="obs-cost-amount mono">{formatUsd(total)}</div>
        <div className="obs-share-bar" aria-hidden="true">
          {rows.map((r) => (
            <span
              key={r.id}
              className="obs-share-seg"
              style={{ flex: total > 0 ? r.usd : 1, background: r.hue }}
              title={`${r.name} · ${formatUsd(r.usd)}`}
            />
          ))}
        </div>
      </section>

      <section className="obs-section">
        <div className="obs-section-title">Workspaces</div>
        {rows.map((r) => (
          <div key={r.id} className="obs-fleet-row">
            <span className="obs-fleet-dot" style={{ background: r.hue }} />
            <span className="obs-fleet-name">{r.name}</span>
            <span className={`obs-fleet-state ${r.state}`}>{r.state}</span>
            <span className="obs-fleet-cost mono">{formatUsd(r.usd)}</span>
          </div>
        ))}
      </section>
    </div>
  );
}

function SummaryView({
  summary,
  terminals,
  activeTerminalId
}: {
  summary: WorkspaceObservabilitySummary;
  terminals: Array<{ id: string; name: string; contextTokens: number; windowTokens: number }>;
  activeTerminalId: string | null;
}) {
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
        <Sparkline series={summary.costSeries ?? []} />
      </section>

      <section className="obs-section">
        <div className="obs-section-title">Tokens</div>
        <TokenRow label="input" value={summary.inputTokens} />
        <TokenRow label="cache create" value={summary.cacheCreationInputTokens} />
        <TokenRow label="cache read" value={summary.cacheReadInputTokens} subdued />
        <TokenRow label="output" value={summary.outputTokens} accent />
      </section>

      <ContextRows terminals={terminals} activeId={activeTerminalId} />

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

/**
 * Workspace metadata block — the host path (click to reveal in the OS file
 * manager), the runner image, and the resource limits. The Path row is the
 * only actionable one; Image/Limits are static.
 */
function WorkspaceBlock({
  workspace,
  sharedDir
}: {
  workspace: WorkspaceSummary;
  sharedDir: string | null;
}) {
  const fullPath = workspaceHostPath(workspace);
  const limits = formatResourceLimits(workspace.resources);

  const openPath = async (path: string) => {
    const err = await window.api.fs.openPath(path);
    if (err) {
      void window.api.app.logError({
        type: 'openPath',
        message: `Could not open folder: ${err}`,
        extra: { path }
      });
    }
  };

  return (
    <section className="obs-section">
      <div className="obs-section-title">Workspace</div>
      <div className="obs-ws-card">
        <button
          type="button"
          className="obs-ws-row obs-ws-action"
          onClick={() => openPath(fullPath)}
          title={`Open ${fullPath} (private — only this container)`}
        >
          <span className="obs-ws-key">private</span>
          <span className="obs-ws-val mono">{workspacePathLabel(workspace)}</span>
          <span className="obs-ws-icon" aria-hidden="true">
            <FolderIcon />
          </span>
        </button>
        {sharedDir && (
          <button
            type="button"
            className="obs-ws-row obs-ws-action"
            onClick={() => openPath(sharedDir)}
            title={`Open ${sharedDir} (shared — every container)`}
          >
            <span className="obs-ws-key">shared</span>
            <span className="obs-ws-val mono">/shared</span>
            <span className="obs-ws-icon" aria-hidden="true">
              <FolderIcon />
            </span>
          </button>
        )}
        {workspace.image && (
          <div className="obs-ws-row">
            <span className="obs-ws-key">image</span>
            <span className="obs-ws-val mono" title={workspace.image}>
              {workspace.image}
            </span>
          </div>
        )}
        {limits && (
          <div className="obs-ws-row">
            <span className="obs-ws-key">limits</span>
            <span className="obs-ws-val mono">{limits}</span>
          </div>
        )}
      </div>
    </section>
  );
}

function FolderIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M1.5 4a1 1 0 0 1 1-1H6l1.5 1.5h6a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H2.5a1 1 0 0 1-1-1V4z" />
    </svg>
  );
}

/**
 * Per-terminal context bars — one row per session tab in the workspace, each
 * showing how full that session's context window is (latest turn's tokens /
 * window). The active tab is dotted + bold; the fill tints warn ≥75% / danger
 * ≥90%, with an 80% compaction-threshold tick. Renders nothing with no tabs.
 */
function ContextRows({
  terminals,
  activeId
}: {
  terminals: Array<{ id: string; name: string; contextTokens: number; windowTokens: number }>;
  activeId: string | null;
}) {
  if (terminals.length === 0) return null;
  return (
    <section className="obs-section">
      <div className="obs-section-title">
        Context · {terminals.length} terminal{terminals.length === 1 ? '' : 's'}
      </div>
      {terminals.map((t) => {
        const pct = t.windowTokens > 0 ? Math.min(1, t.contextTokens / t.windowTokens) : 0;
        const tone = pct >= 0.9 ? 'crit' : pct >= 0.75 ? 'hot' : '';
        return (
          <div key={t.id} className="obs-ctx-row">
            <span className={`obs-ctx-name ${t.id === activeId ? 'active' : ''}`}>
              {t.id === activeId && <span className="obs-ctx-active-dot" aria-hidden="true" />}
              <span className="obs-ctx-name-text">{t.name}</span>
            </span>
            <span className="obs-ctx-bar" aria-hidden="true">
              <span className="obs-ctx-fill" style={{ width: `${Math.max(2, pct * 100)}%` }} />
              <span className="obs-ctx-tick" />
            </span>
            <span className={`obs-ctx-pct mono ${tone}`}>{Math.round(pct * 100)}%</span>
          </div>
        );
      })}
    </section>
  );
}

/**
 * Mini per-turn cost sparkline. Each bar is one assistant turn's USD from
 * `summary.costSeries` (oldest→newest), height normalized to the max in the
 * window and opacity ramped so recent turns read brighter. Renders nothing
 * until there are ≥2 turns with non-zero cost — a single bar isn't a trend.
 */
function Sparkline({ series }: { series: number[] }) {
  const data = series.filter((n) => Number.isFinite(n));
  const max = Math.max(...data, 0);
  if (data.length < 2 || max <= 0) return null;
  return (
    <div className="obs-sparkline" title="per-turn cost (recent turns)" aria-hidden="true">
      {data.map((v, i) => (
        <span
          key={i}
          className="obs-sparkline-bar"
          style={{
            height: `${Math.max(6, (v / max) * 100)}%`,
            opacity: 0.4 + (i / data.length) * 0.5
          }}
        />
      ))}
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
      <p style={{ margin: 0, color: 'var(--ink-2)' }}>{message}</p>
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
