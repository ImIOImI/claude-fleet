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
// live), and after our own rename/delete actions. Remote bookmarks' rows come
// from `sessions.listRemote` and merge in by recency, tagged with a cloud glyph.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { colorFor } from '../App';
import type { SessionListItem } from '../../../preload';
import { type MergedSessions, type SessionCursor, type UnavailableSource } from '../../../preload/federation';
import {
  sessionsForScope,
  filterSessions,
  partitionByOpen,
  orderByRecencyBucket,
  splitHeadless,
  splitCapture,
  tagCounts,
  limitSessions,
  withRemote,
  isRemoteRow,
  unavailableText,
  refreshedRemote,
  reloadedRemote,
  remoteForScope,
  loadedMoreRemote,
  mergeUnavailable,
  canResumeHere,
  relativeTime,
  searchTargets,
  type RemoteResumeInfo
} from '../sessionsView';
import { CloudGlyph } from './CloudGlyph';
import { TranscriptSearch } from './TranscriptSearch';
import { useBlinkSync } from '../blinkSync';
import type { OpenTabRef } from '../busySessions';
import { usePortalMenu } from './portalMenu';
import { unpublishConfirmText, unpublishNote } from './publishTargets';
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
  /** Workspace id → live broker ids in tab-strip order. The Open group follows
   *  it so activity never reshuffles rows (only tab open/close/drag does). */
  /** Claude session UUID of the tab the user is in — rendered as the current row. */
  currentSessionId?: string | null;
  /** Resume a session — App brings the container up, then opens a resume tab. */
  onResume: (item: SessionListItem) => void;
  /** Remote bookmark id → tier and liveness; gates Resume on remote rows. */
  remoteResume?: Record<string, RemoteResumeInfo>;
  /** Remote bookmark id → name; names the hosts a transcript search reaches. */
  remoteNames?: Record<string, string>;
  /** Workspace id → names of the hosts it publishes to; its rows offer Unpublish. */
  publishTargets?: Record<string, string[]>;
  /** Display prefs (uiPrefs): hide the per-session USD badge. Default show. */
  showSessionCost?: boolean;
  /** Display prefs: trim the Recent list to the newest N (0 = unlimited). */
  maxSessions?: number;
  /** Display prefs: hide Recent sessions idle > N days (0 = unlimited). */
  maxSessionAgeDays?: number;
  /** When true, render without the outer `.pane` wrapper / title — the
   *  caller (LeftRail accordion) provides the section header. (#16-followup) */
  embedded?: boolean;
}

const blockedTitle = (s: SessionListItem, remote: Record<string, RemoteResumeInfo> | undefined): string =>
  remote?.[s.workspaceId]?.running === false
    ? 'Host unavailable: resume once it is reachable'
    : 'Resuming here needs the session tier on this host';

function displayTitle(s: SessionListItem): string {
  return s.userSetName || s.aiTitle || s.firstUserMessage || '(untitled session)';
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
  currentSessionId = null,
  onResume,
  remoteResume,
  remoteNames,
  publishTargets,
  showSessionCost = true,
  maxSessions = 0,
  maxSessionAgeDays = 0,
  embedded = false
}: Props) {
  const [scope, setScope] = useState<Scope>('workspace');
  const [query, setQuery] = useState('');
  const [headlessExpanded, setHeadlessExpanded] = useState(false);
  const [captureExpanded, setCaptureExpanded] = useState(false);
  const [localItems, setLocalItems] = useState<SessionListItem[]>([]);
  // Opaque: replace only with federation.ts results (see sessionsView.ts).
  const [remote, setRemote] = useState<MergedSessions<SessionListItem> | null>(null);
  const [unavailable, setUnavailable] = useState<UnavailableSource[]>([]);
  const items = useMemo(() => withRemote(localItems, remote), [localItems, remote]);
  const [loaded, setLoaded] = useState(false);
  // Inline-edit + inline delete/unpublish confirm state, keyed by session id.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [confirmAction, setConfirmAction] = useState<{ id: string; action: 'delete' | 'unpublish' } | null>(null);
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [tagMenu, setTagMenu] = useState(false);
  const [transcripts, setTranscripts] = useState(false);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [publishNote, setPublishNote] = useState<string | null>(null);

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
      setLocalItems(rows);
    } catch {
      setLocalItems([]);
    } finally {
      setLoaded(true);
    }
  }, []);

  // Refetch when the underlying data may have changed (scope/selection only
  // re-slice the already-loaded list, so they don't need a refetch).
  useEffect(() => {
    void load();
  }, [load]);

  const remoteOrigins = useRef(new Set<string>());
  // A full reload that resolves after a newer one started is dropped.
  const remoteSeq = useRef(0);
  const loadRemote = useCallback(async () => {
    const seq = ++remoteSeq.current;
    const r = await window.api.sessions.listRemote().catch(() => null);
    if (seq !== remoteSeq.current) return;
    if (!r) {
      setRemote(null);
      setUnavailable([]);
      return;
    }
    remoteOrigins.current = new Set([...r.pages.map((p) => p.origin), ...r.unavailable.map((u) => u.origin)]);
    setRemote((cur) => reloadedRemote(cur, r));
    setUnavailable(r.unavailable);
  }, []);
  const refreshOrigin = useCallback(async (origin: string) => {
    const r = await window.api.sessions.listRemote({ origin }).catch(() => null);
    if (!r) return;
    setRemote((cur) => refreshedRemote(cur, r, origin));
    setUnavailable((u) => mergeUnavailable(u, r, origin));
  }, []);
  const loadMore = useCallback(async (origin: string, after: SessionCursor) => {
    const r = await window.api.sessions.listRemote({ origin, after }).catch(() => null);
    if (!r) return;
    setRemote((cur) => loadedMoreRemote(cur, r, origin, after));
    setUnavailable((u) => mergeUnavailable(u, r, origin));
  }, []);
  useEffect(() => {
    void loadRemote();
    const t = setInterval(() => void loadRemote(), 60_000);
    return () => clearInterval(t);
  }, [loadRemote]);

  // Live refresh: every observability ingest may add/advance a session.
  // Throttle so a burst of pushes triggers at most one reload per beat; a
  // remote push refreshes only that origin, at most every 5 s.
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remoteTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const timers = remoteTimers.current;
    const unsub = window.api.observability.onSummary((workspaceId) => {
      if (remoteOrigins.current.has(workspaceId)) {
        if (timers.has(workspaceId)) return;
        timers.set(
          workspaceId,
          setTimeout(() => {
            timers.delete(workspaceId);
            void refreshOrigin(workspaceId);
          }, 5_000)
        );
        return;
      }
      if (reloadTimer.current) return;
      reloadTimer.current = setTimeout(() => {
        reloadTimer.current = null;
        void load();
      }, 1500);
    });
    return () => {
      unsub();
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, [load, refreshOrigin]);

  const unpublish = async (s: SessionListItem): Promise<void> => {
    setConfirmAction(null);
    try {
      setPublishNote(unpublishNote(await window.api.publish.unpublish(s.workspaceId, s.id)));
    } catch (err) {
      setPublishNote(`Unpublish failed: ${String(err)}`);
    }
  };

  const commitRename = async (id: string): Promise<void> => {
    const name = draftName.trim();
    setEditingId(null);
    await window.api.sessions.rename(id, name);
    await load();
  };

  const doDelete = async (item: SessionListItem): Promise<void> => {
    setConfirmAction(null);
    await window.api.sessions.delete(item.workspaceId, item.id);
    await load();
  };

  // Sessions shown for the active scope. Display-prefs limits (uiPrefs) trim
  // the Recent group only — open-tab rows always render — and are bypassed
  // while a search/tag filter is active so old sessions stay findable.
  const scoped = sessionsForScope(items, scope, selectedWorkspaceId);
  const q = query.trim().toLowerCase();
  const filtered = filterSessions(scoped, query, activeTags);
  const openIds = new Set(openSessions?.keys() ?? []);
  const parts = partitionByOpen(orderByRecencyBucket(filtered), openIds);
  const openRows = parts.open;
  // Automation runs leave Recent for their own collapsed group at the bottom,
  // so a new run never pushes the user's own sessions down.
  const { headless: headlessRows, rest: recentRows } = splitHeadless(parts.recent);
  // Knowledge-capture forks (#483) leave Recent for their own collapsed
  // group too, like automation runs.
  const { capture: captureRows, rest: recentRowsNoCapture } = splitCapture(recentRows);
  const limitOpts = { maxCount: maxSessions, maxAgeDays: maxSessionAgeDays };
  const bypassLimits = q !== '' || activeTags.length > 0;
  const recentShown = bypassLimits
    ? recentRowsNoCapture
    : limitSessions(recentRowsNoCapture, limitOpts, Date.now());
  const headlessShown = bypassLimits
    ? headlessRows
    : limitSessions(headlessRows, limitOpts, Date.now());
  const captureShown = bypassLimits ? captureRows : limitSessions(captureRows, limitOpts, Date.now());
  // Collapsed by default; a search/tag filter opens it so matches are visible.
  const showHeadless = headlessExpanded || bypassLimits;
  const showCapture = captureExpanded || bypassLimits;
  // "All · N" badge: what the All view lists under the current limits (#149) —
  // open rows + the limited recent rows over the FULL list, search ignored
  // (searching never changed the badge before either). Capture forks never
  // count toward the badge.
  const allParts = partitionByOpen(orderByRecencyBucket(items), openIds);
  const allSplit = splitHeadless(allParts.recent);
  const allSessionsCount =
    allParts.open.length +
    limitSessions(splitCapture(allSplit.rest).rest, limitOpts, Date.now()).length +
    limitSessions(allSplit.headless, limitOpts, Date.now()).length;
  const allTags = tagCounts(scoped);
  const unavailableNote = unavailableText(remoteForScope(unavailable, scope, selectedWorkspaceId));
  const names = remoteNames ?? {};
  const searchTarget = searchTargets(scope, selectedWorkspaceId, names, (id) => !(id in names) && !(id in (remoteResume ?? {})));

  // A picked hit filters the list to its session; scroll once the row renders.
  useEffect(() => {
    if (!pickedId) return;
    document.querySelector<HTMLElement>(`li[data-sid="${CSS.escape(pickedId)}"]`)?.scrollIntoView({ block: 'nearest' });
    setPickedId(null);
  }, [pickedId]);

  // FLIP: rows animate to their new slot when they move between the Open and
  // Recent groups, or cross a recency bucket (see orderByRecencyBucket). Positions are captured after every render;
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
    const confirming = confirmAction?.id === s.id ? confirmAction.action : null;
    const color = colorFor({
      name: s.workspaceName,
      color: s.workspaceColorHue != null ? { hue: s.workspaceColorHue } : undefined
    });
    const busy = busySessionIds?.has(s.id) ?? false;
    const waiting = waitingSessionIds?.has(s.id) ?? false;
    const isOpen = openSessions?.has(s.id) ?? false;
    const isCurrent = isOpen && s.id === currentSessionId;
    const remoteRow = isRemoteRow(s);
    const resumable = isOpen || canResumeHere(s, remoteResume);
    return (
      <li
        key={`${s.origin ?? 'local'}:${s.id}`}
        ref={rowRef(s.id)}
        data-sid={s.id}
        aria-current={isCurrent ? 'true' : undefined}
        className={`session-row${waiting ? ' waiting' : busy ? ' busy' : ''}${isOpen ? ' open' : ''}${isCurrent ? ' current' : ''}`}
      >
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
              title={
                isOpen
                  ? `Go to open tab — "${displayTitle(s)}"`
                  : resumable
                    ? `Resume "${displayTitle(s)}"`
                    : blockedTitle(s, remoteResume)
              }
              aria-disabled={resumable ? undefined : true}
              onClick={() => {
                if (resumable) onResume(s);
              }}
            >
              {displayTitle(s)}
            </button>
          )}
          <div className="session-row-meta">
            {remoteRow && <CloudGlyph title={`Remote · ${s.workspaceName}`} />}
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
            {showSessionCost && <span className="session-row-cost">{formatUsd(s.usd)}</span>}
          </div>
        </div>
        {confirming === 'delete' ? (
          <div className="session-row-confirm">
            <span>Delete?</span>
            <button className="btn-mini" onClick={() => setConfirmAction(null)}>
              Cancel
            </button>
            <button className="btn-mini danger" onClick={() => void doDelete(s)}>
              Delete
            </button>
          </div>
        ) : confirming === 'unpublish' ? (
          <div className="session-row-confirm">
            <span>{unpublishConfirmText(publishTargets?.[s.workspaceId] ?? [])}</span>
            <button className="btn-mini" onClick={() => setConfirmAction(null)}>
              Cancel
            </button>
            <button className="btn-mini danger" onClick={() => void unpublish(s)}>
              Unpublish
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
        <button
          className={`btn-mini sessions-transcripts-toggle${transcripts ? ' on' : ''}`}
          aria-pressed={transcripts}
          title="Search inside transcripts"
          onClick={() => setTranscripts((v) => !v)}
        >
          Transcripts
        </button>
        <button
          className="btn-mini"
          aria-label="Refresh sessions"
          title="Refresh sessions"
          onClick={() => {
            void load();
            void loadRemote();
          }}
        >
          <IconRefresh />
        </button>
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
        {transcripts && (
          <TranscriptSearch
            target={searchTarget}
            onPick={(hit) => {
              setQuery(hit.sessionId);
              setPickedId(hit.sessionId);
            }}
          />
        )}
        {!loaded ? null : scope === 'workspace' && !selectedWorkspaceId ? (
          <div className="pane-placeholder subdued">
            <strong>No workspace selected</strong>
            Pick a workspace above, or switch to <em>All</em> to see every session.
          </div>
        ) : openRows.length + recentShown.length + headlessShown.length + captureShown.length === 0 ? (
          <div className="pane-placeholder subdued">
            <strong>
              {q || activeTags.length > 0
                ? 'No matches'
                : filtered.length > 0
                  ? 'All sessions hidden by display filters'
                  : 'No sessions yet'}
            </strong>
            {q || activeTags.length > 0
              ? 'Try a different search.'
              : filtered.length > 0
                ? 'Raise Max sessions / Max session age in Settings → Display, or search.'
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
            {openRows.length > 0 && recentShown.length > 0 && (
              <li className="session-group-label recent" aria-hidden="true">
                Recent<span className="session-group-line" />
              </li>
            )}
            {recentShown.map(renderRow)}
            {headlessShown.length > 0 && (
              <li className="session-group-label recent">
                <button
                  className="session-group-toggle"
                  aria-expanded={showHeadless}
                  onClick={() => setHeadlessExpanded((v) => !v)}
                  title={showHeadless ? 'Hide automation runs' : 'Show automation runs'}
                >
                  <span className={`acc-chev ${showHeadless ? 'open' : ''}`} aria-hidden>
                    ▾
                  </span>
                  Automation runs · {headlessShown.length}
                </button>
                <span className="session-group-line" />
              </li>
            )}
            {showHeadless && headlessShown.map(renderRow)}
            {captureShown.length > 0 && (
              <li className="session-group-label recent">
                <button
                  className="session-group-toggle"
                  aria-expanded={showCapture}
                  onClick={() => setCaptureExpanded((v) => !v)}
                  title={showCapture ? 'Hide knowledge capture runs' : 'Show knowledge capture runs'}
                >
                  <span className={`acc-chev ${showCapture ? 'open' : ''}`} aria-hidden>▾</span>
                  Knowledge capture · {captureShown.length}
                </button>
                <span className="session-group-line" />
              </li>
            )}
            {showCapture && captureShown.map(renderRow)}
          </ul>
        )}
        {unavailableNote && <div className="sessions-unavailable subdued">{unavailableNote}</div>}
        {publishNote && <div className="sessions-unavailable subdued" role="status">{publishNote}</div>}
        {remote && remoteForScope(remote.more, scope, selectedWorkspaceId).map((m) => (
          <button key={m.origin} className="btn-mini sessions-more" onClick={() => void loadMore(m.origin, m.after)}>
            Load older sessions from {remote.rows.find((r) => r.origin === m.origin)?.workspaceName ?? 'remote'}
          </button>
        ))}
      </div>
      {rowMenu &&
        (() => {
          const s = items.find((x) => x.id === rowMenu.id);
          if (!s) return null;
          const isOpen = openSessions?.has(s.id) ?? false;
          const resumable = isOpen || canResumeHere(s, remoteResume);
          return createPortal(
            <div
              className="ws-chip-menu"
              role="menu"
              style={{ position: 'fixed', top: rowMenu.top, left: rowMenu.left }}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                role="menuitem"
                disabled={!resumable}
                title={isOpen ? 'Jump to the open terminal tab' : resumable ? 'Resume this session' : blockedTitle(s, remoteResume)}
                onClick={() => {
                  closeRowMenu();
                  onResume(s);
                }}
              >
                <IconRefresh />
                <span>{isOpen ? 'Go to tab' : 'Resume'}</span>
              </button>
              {!isRemoteRow(s) && (
                <>
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
                  {(publishTargets?.[s.workspaceId]?.length ?? 0) > 0 && (
                    <button
                      role="menuitem"
                      title={`Remove from ${publishTargets![s.workspaceId].join(', ')} and never publish it again`}
                      onClick={() => {
                        closeRowMenu();
                        setConfirmAction({ id: s.id, action: 'unpublish' });
                      }}
                    >
                      <IconTrash />
                      <span>Unpublish</span>
                    </button>
                  )}
                  <div className="ws-chip-menu-divider" />
                  <button
                    role="menuitem"
                    className="danger"
                    title="Delete session + transcript"
                    onClick={() => {
                      closeRowMenu();
                      setConfirmAction({ id: s.id, action: 'delete' });
                    }}
                  >
                    <IconTrash />
                    <span>Delete</span>
                  </button>
                </>
              )}
            </div>,
            document.body
          );
        })()}
    </>
  );
  return embedded ? body : <aside className="pane sidebar-left">{body}</aside>;
}
