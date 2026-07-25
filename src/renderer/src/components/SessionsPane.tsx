// Left-rail Sessions list (#3).
//
// Global, container-filterable list of every claude session the JSONL
// watcher has indexed. Each row is resumable via `claude --resume <id>`
// (App wires the actual resume), renamable (manual override stored in the
// sqlite `sessions` row), and deletable (drops the cache rows + the on-disk
// transcript).
//
// Scope mirrors the ObservabilityPane: "This workspace" (the selected one)
// or "All" (every live workspace). Data is fetched from the main process
// via `window.api.sessions.list`; we refetch on scope/selection change, on
// every observability summary push (so new + just-active sessions surface
// live), and after our own rename/delete actions.

import { useCallback, useEffect, useRef, useState } from 'react';
import { colorFor } from '../App';
import type { SessionListItem } from '../../../preload';
import { sessionsForScope } from '../sessionsView';
import { useBlinkSync } from '../blinkSync';
import type { OpenTabRef } from '../busySessions';

type Scope = 'workspace' | 'all';

/**
 * Leading "busy" pulse on a Sessions row whose claude session is actively
 * working. Wall-clock-synchronized via `useBlinkSync` so it blinks in lockstep
 * with the workspace chip + session-tab indicators. A component (not an inline
 * span) so the hook runs unconditionally — the dot is only mounted when busy.
 */
function SessionBusyDot({ waiting }: { waiting: boolean }): JSX.Element {
  const blink = useBlinkSync(true);
  const label = waiting ? 'Waiting on your input' : 'Claude is working…';
  return <span className={`session-busy-dot ${waiting ? 'waiting' : ''}`} style={blink} aria-label={label} title={label} />;
}

interface Props {
  selectedWorkspaceId: string | null;
  /** Claude session UUIDs whose session is actively working — pulses its row. */
  busySessionIds?: Set<string>;
  /** Claude session UUIDs blocked on AskUserQuestion — will drive a waiting indicator (Task 7). */
  waitingSessionIds?: Set<string>;
  /** Claude session UUID → open tab address; drives the Open group (Task 6). */
  openSessions?: Map<string, OpenTabRef>;
  /** Resume a session — App brings the container up, then opens a resume tab. */
  onResume: (item: SessionListItem) => void;
  /** When true, render without the outer `.pane` wrapper / title — the
   *  caller (LeftRail accordion) provides the section header. (#16-followup) */
  embedded?: boolean;
}

function displayTitle(s: SessionListItem): string {
  return s.userSetName || s.aiTitle || s.firstUserMessage || '(untitled session)';
}

function relativeTime(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 5_000) return 'just now';
  if (delta < 60_000) return `${Math.round(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  return `${Math.round(delta / 86_400_000)}d ago`;
}

function formatUsd(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  if (usd < 100) return `$${usd.toFixed(2)}`;
  if (usd < 1000) return `$${usd.toFixed(1)}`;
  return `$${Math.round(usd).toLocaleString('en-US')}`;
}

export function SessionsPane({
  selectedWorkspaceId,
  busySessionIds,
  waitingSessionIds,
  onResume,
  embedded = false
}: Props) {
  const [scope, setScope] = useState<Scope>('workspace');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<SessionListItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  // Inline-edit + inline-delete-confirm state, keyed by session id.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Load the full session list once and scope it client-side. The unfiltered
  // `sessions.list()` and the per-workspace `sessions.list(id)` query the same
  // table with identical ordering (db.ts listSessions), so filtering here is
  // equivalent to a scoped fetch — and it lets the "All · N" badge be a true
  // session count instead of a workspace count (#149).
  const load = useCallback(async () => {
    try {
      const rows = await window.api.sessions.list();
      setItems(rows);
    } catch {
      setItems([]);
    } finally {
      setLoaded(true);
    }
  }, []);

  // Refetch when the underlying data may have changed (scope/selection only
  // re-slice the already-loaded list, so they don't need a refetch).
  useEffect(() => {
    void load();
  }, [load]);

  // Live refresh: every observability ingest may add/advance a session.
  // Throttle so a burst of pushes triggers at most one reload per beat.
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const unsub = window.api.observability.onSummary(() => {
      if (reloadTimer.current) return;
      reloadTimer.current = setTimeout(() => {
        reloadTimer.current = null;
        void load();
      }, 1500);
    });
    return () => {
      unsub();
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
    };
  }, [load]);

  const commitRename = async (id: string): Promise<void> => {
    const name = draftName.trim();
    setEditingId(null);
    await window.api.sessions.rename(id, name);
    await load();
  };

  const doDelete = async (item: SessionListItem): Promise<void> => {
    setConfirmDeleteId(null);
    await window.api.sessions.delete(item.workspaceId, item.id);
    await load();
  };

  // Sessions shown for the active scope; the "All" badge counts the full list.
  const scoped = sessionsForScope(items, scope, selectedWorkspaceId);
  const allSessionsCount = items.length;
  const q = query.trim().toLowerCase();
  const filtered = q
    ? scoped.filter(
        (s) =>
          displayTitle(s).toLowerCase().includes(q) ||
          s.workspaceName.toLowerCase().includes(q)
      )
    : scoped;

  const body = (
    <>
      <div className={`pane-header sessions-header${embedded ? ' embedded' : ''}`}>
        {!embedded && <span>Sessions</span>}
        <div className="obs-scope-toggle" role="tablist" aria-label="Sessions scope">
          <button
            role="tab"
            aria-selected={scope === 'workspace'}
            className={`obs-scope-btn ${scope === 'workspace' ? 'active' : ''}`}
            onClick={() => setScope('workspace')}
            title="Sessions in the selected workspace"
          >
            This workspace
          </button>
          <button
            role="tab"
            aria-selected={scope === 'all'}
            className={`obs-scope-btn ${scope === 'all' ? 'active' : ''}`}
            onClick={() => setScope('all')}
          >
            All · {allSessionsCount}
          </button>
        </div>
        <input
          type="search"
          className="sessions-search"
          placeholder="Search sessions…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search sessions"
        />
      </div>
      <div className="pane-body sessions-body">
        {!loaded ? null : scope === 'workspace' && !selectedWorkspaceId ? (
          <div className="pane-placeholder subdued">
            <strong>No workspace selected</strong>
            Pick a workspace above, or switch to <em>All</em> to see every session.
          </div>
        ) : filtered.length === 0 ? (
          <div className="pane-placeholder subdued">
            <strong>{q ? 'No matches' : 'No sessions yet'}</strong>
            {q
              ? 'Try a different search.'
              : 'Claude sessions appear here once a transcript exists.'}
          </div>
        ) : (
          <ul className="sessions-list">
            {filtered.map((s) => {
              const editing = editingId === s.id;
              const confirming = confirmDeleteId === s.id;
              const color = colorFor({
                name: s.workspaceName,
                color: s.workspaceColorHue != null ? { hue: s.workspaceColorHue } : undefined
              });
              const busy = busySessionIds?.has(s.id) ?? false;
              const waiting = waitingSessionIds?.has(s.id) ?? false;
              return (
                <li key={s.id} className={`session-row${waiting ? ' waiting' : busy ? ' busy' : ''}`}>
                  {(busy || waiting) && <SessionBusyDot waiting={waiting} />}
                  <div className="session-row-main">
                    {editing ? (
                      <input
                        className="session-row-rename"
                        autoFocus
                        value={draftName}
                        onChange={(e) => setDraftName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void commitRename(s.id);
                          else if (e.key === 'Escape') setEditingId(null);
                        }}
                        onBlur={() => void commitRename(s.id)}
                        aria-label="Session name"
                      />
                    ) : (
                      <button
                        className="session-row-title"
                        title={`Resume "${displayTitle(s)}"`}
                        onClick={() => onResume(s)}
                      >
                        {displayTitle(s)}
                      </button>
                    )}
                    <div className="session-row-meta">
                      {scope === 'all' && (
                        <span className="session-row-ws" title={s.workspaceName}>
                          <span
                            className="session-row-dot"
                            style={{ background: color }}
                            aria-hidden="true"
                          />
                          {s.workspaceName}
                        </span>
                      )}
                      {s.lastActiveAt != null && (
                        <span className="session-row-time">{relativeTime(s.lastActiveAt)}</span>
                      )}
                      <span className="session-row-cost">{formatUsd(s.usd)}</span>
                    </div>
                  </div>
                  {confirming ? (
                    <div className="session-row-confirm">
                      <span>Delete?</span>
                      <button className="btn-mini" onClick={() => setConfirmDeleteId(null)}>
                        Cancel
                      </button>
                      <button className="btn-mini danger" onClick={() => void doDelete(s)}>
                        Delete
                      </button>
                    </div>
                  ) : (
                    !editing && (
                      <div className="session-row-actions">
                        <button
                          className="session-row-action"
                          title="Resume this session"
                          aria-label="Resume session"
                          onClick={() => onResume(s)}
                        >
                          ↻
                        </button>
                        <button
                          className="session-row-action"
                          title="Rename"
                          aria-label="Rename session"
                          onClick={() => {
                            setDraftName(s.userSetName ?? displayTitle(s));
                            setEditingId(s.id);
                          }}
                        >
                          ✎
                        </button>
                        <button
                          className="session-row-action"
                          title="Delete session + transcript"
                          aria-label="Delete session"
                          onClick={() => setConfirmDeleteId(s.id)}
                        >
                          🗑
                        </button>
                      </div>
                    )
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
  return embedded ? body : <aside className="pane sidebar-left">{body}</aside>;
}
