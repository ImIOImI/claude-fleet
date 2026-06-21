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
import { colorFor, type WorkspaceSummary } from '../App';
import type { SessionListItem } from '../../../preload';

type Scope = 'workspace' | 'all';

interface Props {
  workspaces: WorkspaceSummary[];
  selectedWorkspaceId: string | null;
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

export function SessionsPane({ workspaces, selectedWorkspaceId, onResume, embedded = false }: Props) {
  const [scope, setScope] = useState<Scope>('workspace');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<SessionListItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  // Inline-edit + inline-delete-confirm state, keyed by session id.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const liveWorkspaceCount = workspaces.filter(
    (w) => w.state !== 'deleted' && w.containerId
  ).length;

  const load = useCallback(async () => {
    const wsId = scope === 'workspace' ? selectedWorkspaceId ?? undefined : undefined;
    // In workspace scope with nothing selected there's nothing to show.
    if (scope === 'workspace' && !wsId) {
      setItems([]);
      setLoaded(true);
      return;
    }
    try {
      const rows = await window.api.sessions.list(wsId);
      setItems(rows);
    } catch {
      setItems([]);
    } finally {
      setLoaded(true);
    }
  }, [scope, selectedWorkspaceId]);

  // Refetch on scope/selection change.
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

  const q = query.trim().toLowerCase();
  const filtered = q
    ? items.filter(
        (s) =>
          displayTitle(s).toLowerCase().includes(q) ||
          s.workspaceName.toLowerCase().includes(q)
      )
    : items;

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
            All · {liveWorkspaceCount}
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
              return (
                <li key={s.id} className="session-row">
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
