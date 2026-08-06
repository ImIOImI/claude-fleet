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

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { colorFor } from '../App';
import type { SessionListItem } from '../../../preload';
import { sessionsForScope, filterSessions, partitionByOpen, tagCounts } from '../sessionsView';
import { useBlinkSync } from '../blinkSync';
import type { OpenTabRef } from '../busySessions';
import { usePortalMenu } from './portalMenu';
import { IconPencil, IconRefresh, IconTrash } from './menuIcons';

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
  openSessions,
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
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [tagMenu, setTagMenu] = useState(false);

  // Row ⋮ menu: resume / rename / delete — shared portaled-menu mechanics.
  const { menu: rowMenu, toggle: toggleRowMenu, close: closeRowMenu } = usePortalMenu();

  const toggleTag = (t: string): void =>
    setActiveTags((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));

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
  const filtered = filterSessions(scoped, query, activeTags);
  const { open: openRows, recent: recentRows } = partitionByOpen(
    filtered,
    new Set(openSessions?.keys() ?? [])
  );
  const allTags = tagCounts(scoped);

  // FLIP: rows animate to their new slot when they move between the Open and
  // Recent groups (or reorder). Positions are captured after every render;
  // deltas against the previous render animate via the Web Animations API.
  const rowEls = useRef(new Map<string, HTMLLIElement>());
  const rowRef = (id: string) => (el: HTMLLIElement | null): void => {
    if (el) rowEls.current.set(id, el);
    else rowEls.current.delete(id);
  };
  const prevRects = useRef(new Map<string, DOMRect>());
  useLayoutEffect(() => {
    const next = new Map<string, DOMRect>();
    for (const [id, el] of rowEls.current) {
      const rect = el.getBoundingClientRect();
      const prev = prevRects.current.get(id);
      if (prev) {
        const dy = prev.top - rect.top;
        if (dy !== 0) {
          el.animate(
            [{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }],
            { duration: 350, easing: 'cubic-bezier(.2,.8,.2,1)' }
          );
        }
      }
      next.set(id, rect);
    }
    prevRects.current = next;
  });

  const renderRow = (s: SessionListItem): JSX.Element => {
    const editing = editingId === s.id;
    const confirming = confirmDeleteId === s.id;
    const color = colorFor({
      name: s.workspaceName,
      color: s.workspaceColorHue != null ? { hue: s.workspaceColorHue } : undefined
    });
    const busy = busySessionIds?.has(s.id) ?? false;
    const waiting = waitingSessionIds?.has(s.id) ?? false;
    const isOpen = openSessions?.has(s.id) ?? false;
    return (
      <li key={s.id} ref={rowRef(s.id)} data-sid={s.id} className={`session-row${waiting ? ' waiting' : busy ? ' busy' : ''}${isOpen ? ' open' : ''}`}>
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
              title={isOpen ? `Go to open tab — "${displayTitle(s)}"` : `Resume "${displayTitle(s)}"`}
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
            {s.tags.length > 0 && (
              <span className="session-row-tags">
                {s.tags.slice(0, 2).map((t) => (
                  <button
                    key={t}
                    className={`tag session-row-tag${activeTags.includes(t) ? ' on' : ''}`}
                    title={`Filter by "${t}"`}
                    onClick={() => toggleTag(t)}
                  >
                    {t}
                  </button>
                ))}
              </span>
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
                title="Session actions"
                aria-label="Session actions"
                aria-haspopup="menu"
                aria-expanded={rowMenu?.id === s.id}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleRowMenu(e.currentTarget, s.id);
                }}
              >
                ⋮
              </button>
            </div>
          )
        )}
      </li>
    );
  };

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
        {allTags.length > 0 && (
          <div className="library-filter sessions-tagfilter">
            <button
              className="tag-dd"
              onClick={() => setTagMenu((o) => !o)}
              aria-expanded={tagMenu}
            >
              Tags ▾
            </button>
            {activeTags.map((t) => (
              <button key={t} className="pill" onClick={() => toggleTag(t)} title="Remove filter">
                {t} ✕
              </button>
            ))}
            <span className="nofm">
              {filtered.length} of {scoped.length}
            </span>
            {tagMenu && (
              <div className="tag-menu" onMouseLeave={() => setTagMenu(false)}>
                {allTags.map(([t, n]) => (
                  <label key={t} className="tag-menu-item">
                    <input
                      type="checkbox"
                      checked={activeTags.includes(t)}
                      onChange={() => toggleTag(t)}
                    />
                    <span>{t}</span>
                    <span className="tm-count">{n}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="pane-body sessions-body">
        {!loaded ? null : scope === 'workspace' && !selectedWorkspaceId ? (
          <div className="pane-placeholder subdued">
            <strong>No workspace selected</strong>
            Pick a workspace above, or switch to <em>All</em> to see every session.
          </div>
        ) : filtered.length === 0 ? (
          <div className="pane-placeholder subdued">
            <strong>{q || activeTags.length > 0 ? 'No matches' : 'No sessions yet'}</strong>
            {q || activeTags.length > 0
              ? 'Try a different search.'
              : 'Claude sessions appear here once a transcript exists.'}
          </div>
        ) : (
          <ul className="sessions-list">
            {openRows.length > 0 && (
              <li className="session-group-label" aria-hidden="true">
                <span className="session-group-dot" /> Open · {openRows.length}
                <span className="session-group-line" />
              </li>
            )}
            {openRows.map(renderRow)}
            {openRows.length > 0 && recentRows.length > 0 && (
              <li className="session-group-label recent" aria-hidden="true">
                Recent<span className="session-group-line" />
              </li>
            )}
            {recentRows.map(renderRow)}
          </ul>
        )}
      </div>
      {rowMenu &&
        (() => {
          const s = items.find((x) => x.id === rowMenu.id);
          if (!s) return null;
          const isOpen = openSessions?.has(s.id) ?? false;
          return createPortal(
            <div
              className="ws-chip-menu"
              role="menu"
              style={{ position: 'fixed', top: rowMenu.top, left: rowMenu.left }}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                role="menuitem"
                title={isOpen ? 'Jump to the open terminal tab' : 'Resume this session'}
                onClick={() => {
                  closeRowMenu();
                  onResume(s);
                }}
              >
                <IconRefresh />
                <span>{isOpen ? 'Go to tab' : 'Resume'}</span>
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  closeRowMenu();
                  setDraftName(s.userSetName ?? displayTitle(s));
                  setEditingId(s.id);
                }}
              >
                <IconPencil />
                <span>Rename</span>
              </button>
              <div className="ws-chip-menu-divider" />
              <button
                role="menuitem"
                className="danger"
                title="Delete session + transcript"
                onClick={() => {
                  closeRowMenu();
                  setConfirmDeleteId(s.id);
                }}
              >
                <IconTrash />
                <span>Delete</span>
              </button>
            </div>,
            document.body
          );
        })()}
    </>
  );
  return embedded ? body : <aside className="pane sidebar-left">{body}</aside>;
}
