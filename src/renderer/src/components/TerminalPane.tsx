// Multi-session terminal pane.
//
// A workspace can have multiple claude sessions running in parallel —
// each session is a separate `docker exec claude` PTY inside the
// workspace's container. The tab strip at the top of this pane lists
// those sessions; the body stacks one TerminalSession per session,
// with only the active one visible.
//
// Session inventory (the tab list, names, active tab, next-num) is
// persisted to <userData>/state/<name>/sessions.json via
// window.api.sessions. On mount we load it; on every change we write it
// back. This means the tab list survives app quit + relaunch. The
// actual PTYs are still re-spawned fresh on relaunch in PR1 — in-memory
// context is lost; PR2's in-container broker is what preserves that.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { WorkspaceObservabilitySummary } from '../../../preload';
import type { MirrorSetting, CleanupSetting } from '../App';
import { TerminalSession } from './TerminalSession';
import { ToastView } from './Toast';
import { ModalBackdrop } from './ModalBackdrop';
import { makeToast } from '../toasts';
import { readyToRefresh } from './refreshQueue';
import { reorderDragHandlers } from '../dropIngestion';
import { useBlinkSync } from '../blinkSync';
import { usePortalMenu } from './portalMenu';
import { IconAuto, IconEject, IconPencil, IconRefresh } from './menuIcons';

/**
 * A session tab's status dot. `live`/`ended` colors it; `busy` makes it pulse
 * (claude is working in this session), wall-clock-synchronized via `useBlinkSync`
 * so it blinks in lockstep with the workspace chip + Sessions-row indicators.
 * A separate component because the hook can't run inside the `.map()` over tabs.
 */
function SessionTabDot({ ended, busy, waiting }: { ended: boolean; busy: boolean; waiting: boolean }): JSX.Element {
  const active = !ended && (busy || waiting);
  const cls = waiting && !ended ? 'waiting' : busy && !ended ? 'busy' : '';
  const label = ended ? 'session ended' : waiting ? 'waiting on your input' : busy ? 'Claude is working…' : 'session live';
  const blink = useBlinkSync(active);
  return (
    <span
      className={`session-tab-dot ${ended ? 'ended' : 'live'} ${cls}`}
      style={blink}
      aria-label={label}
      title={label}
    />
  );
}

interface Props {
  containerId: string;
  /** ULID — used for sessions.json path and observability lookups. */
  workspaceId: string;
  /** The workspace's durable-mirror defaults (manifest). New tabs inherit
   *  `mirrorDefault`; the close-time modal pre-selects `cleanupDefault`. */
  mirrorDefault: MirrorSetting;
  cleanupDefault: CleanupSetting;
  paused: boolean;
  /**
   * Whether this pane is the currently-selected workspace. Hidden panes
   * stay fully mounted so their xterm scrollback + broker connections
   * persist across workspace switches; this just controls painting via
   * `visibility: hidden` (layout preserved so xterm keeps its measured
   * cols/rows and doesn't need to refit on show).
   */
  visible: boolean;
  /**
   * Latest observability summary for this workspace, distributed from
   * App.tsx's centralized poll. Drives the context-bar fill at the top
   * of the terminal area. Null while observability has no data yet —
   * the bar falls back to a full identity band so a fresh workspace
   * still reads visually correct.
   */
  summary: WorkspaceObservabilitySummary | null;
  /**
   * When true, render the restart-to-apply banner above the session-tab
   * strip. Set by App.tsx after an EditWorkspaceModal save changes any
   * container-level field (env, image, authMode, resources) on a running
   * workspace. Render-only edits (name, description, labels, color)
   * never trigger the banner.
   */
  restartBanner?: boolean;
  onRestartFromBanner?: () => void;
  onDismissBanner?: () => void;
  /** Latest committee message injected into this workspace (#123); the `nonce`
   *  re-triggers the transient `[committee]` toast on each new inbound. */
  inbound?: { message: string; nonce: number } | null;
  onResume: () => void;
  /**
   * Reports the active tab's broker session id whenever it changes
   * (mount, tab-switch, close-last-and-recreate). App.tsx uses this to
   * drive the per-tab observability summary lookup so the
   * ObservabilityPane reflects whichever tab the user is looking at,
   * not the workspace's most-recently-active claude session.
   *
   * `isFresh` distinguishes a tab the user just created via `+` (true)
   * from one loaded from `sessions.json` (false). App.tsx uses this to
   * decide whether to fall back to the workspace summary when the
   * per-tab fetch returns null: fresh tabs legitimately have no data
   * (showing the previous tab's numbers would be wrong), but
   * loaded-from-inventory tabs probably have real claude activity that
   * hasn't been mapped yet (pre-PR tabs, concurrent-attach skip cases)
   * — there the workspace summary at least surfaces what's happening.
   */
  onActiveTabChange?: (
    workspaceId: string,
    brokerSessionId: string,
    isFresh: boolean
  ) => void;
  /**
   * Fires when this workspace's busy state flips (busy = any of its sessions
   * is actively working, per the title-glyph detector). Drives the chip's
   * "working" indicator in App.
   */
  onBusyChange?: (workspaceId: string, busy: boolean) => void;
  /**
   * Reports the full set of this workspace's currently-busy *broker* session
   * ids whenever it changes. App resolves these to claude session UUIDs to
   * pulse the matching rows in the left-rail Sessions list. Distinct from
   * `onBusyChange` (a per-workspace aggregate that drives the chip): this
   * carries per-session granularity and fires on every flip.
   */
  onBusyIdsChange?: (workspaceId: string, brokerSessionIds: string[]) => void;
  /** Live tab report for the Sessions list's Open group: the broker session
   *  ids of tabs whose PTY has not ended. Emitted on every tab-list or
   *  lifecycle change, and [] when this pane unmounts. */
  onLiveIdsChange?: (workspaceId: string, brokerSessionIds: string[]) => void;
  /**
   * A resume request targeted at THIS workspace (App only passes it to the
   * matching pane). Opens a new tab that attaches with `claude --resume
   * <claudeSessionId>`. `token` distinguishes repeat resumes of the same
   * session so the effect re-fires; App clears the request via
   * `onResumeConsumed` once the tab is added. Null when there's nothing to
   * resume.
   */
  resumeRequest?: { claudeSessionId: string; title: string; token: number } | null;
  onResumeConsumed?: () => void;
  /** Activate an existing tab (Sessions-list jump-to-tab). Token-guarded
   *  like resumeRequest so the same tab can be jumped to repeatedly. */
  activateRequest?: { brokerSessionId: string; token: number } | null;
  onActivateConsumed?: () => void;
  /**
   * A loadout-reload request targeted at THIS workspace (#16). Set by App when a
   * loadout is installed and the auto-reload setting is on. The pane reloads its
   * ACTIVE session in place (`--resume`) once that session is idle — deferring
   * while claude is working. `token` distinguishes repeat requests. App clears
   * it via `onReloadConsumed` once the pane has taken ownership.
   */
  reloadRequest?: { token: number } | null;
  onReloadConsumed?: () => void;
  /** Fired the moment the active session actually starts reloading (after the
   *  idle gate) — App uses it to show a "reloading…" toast over the flicker. */
  onReloadStarted?: () => void;
  /**
   * Fired when the user picks Refresh on a session chip. The parent shows the
   * shared toast; `busyNow` selects the copy ("…when idle" while claude works).
   */
  onRefreshRequested?: (sessionName: string, busyNow: boolean) => void;
  /** Fired when a requested refresh was skipped because the tab's conversation
   *  could not be identified (#195) — the parent toasts the skip. */
  onRefreshUnresolved?: (sessionName: string) => void;
  /** Claude session UUIDs blocked on AskUserQuestion — drives waiting indicators (Task 7). */
  waitingSessionIds?: Set<string>;
}

function contextBarPct(summary: WorkspaceObservabilitySummary | null): number {
  if (!summary?.lastTurnContextTokens) return 100;
  const raw = (summary.lastTurnContextTokens / summary.contextWindowTokens) * 100;
  return Math.max(0, Math.min(100, raw));
}

function contextBarTooltip(summary: WorkspaceObservabilitySummary | null): string {
  if (!summary?.lastTurnContextTokens) {
    return 'Workspace accent — no transcript activity yet';
  }
  const tokens = summary.lastTurnContextTokens;
  const limit = summary.contextWindowTokens;
  const pct = (tokens / limit) * 100;
  return `Context: ${tokens.toLocaleString()} / ${limit.toLocaleString()} tokens (${pct.toFixed(1)}%)`;
}

interface Session {
  id: string;
  name: string;
  createdAt: number;
  /** Set on a resume tab — its first attach runs `claude --resume <uuid>`. */
  resumeOf?: string;
  /** Per-session durable-mirror override; absent = use the workspace default. */
  mirror?: MirrorSetting;
  /** When true, `name` tracks Claude's session summary; a manual rename clears it. */
  autoName?: boolean;
}

function uid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `s-${Math.random().toString(36).slice(2, 10)}`;
}

export function TerminalPane({
  containerId,
  workspaceId,
  mirrorDefault,
  cleanupDefault,
  paused,
  visible,
  summary,
  restartBanner,
  onRestartFromBanner,
  onDismissBanner,
  inbound,
  onResume,
  onActiveTabChange,
  onBusyChange,
  onBusyIdsChange,
  onLiveIdsChange,
  resumeRequest,
  onResumeConsumed,
  activateRequest,
  onActivateConsumed,
  reloadRequest,
  onReloadConsumed,
  onReloadStarted,
  onRefreshRequested,
  onRefreshUnresolved,
  waitingSessionIds
}: Props) {
  // Transient `[committee]` toast (#123): show the injected message briefly so a
  // human watching this expert knows why text just appeared, then auto-dismiss.
  const [committeeToast, setCommitteeToast] = useState<string | null>(null);
  useEffect(() => {
    if (!inbound) return;
    setCommitteeToast(inbound.message);
    const t = setTimeout(() => setCommitteeToast(null), 6000);
    return () => clearTimeout(t);
  }, [inbound?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const [loaded, setLoaded] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [nextNum, setNextNum] = useState(2);
  // Tab status: ids in this set have had their PTY exit (user `/exit`,
  // claude crash, attach failure). The session-ended overlay in
  // TerminalSession lets the user "Start new session" — when they do,
  // the session emits 'live' again and the id leaves the set.
  const [endedIds, setEndedIds] = useState<Set<string>>(new Set());
  // Set while a close-time "delete the mirror?" confirm is open for a tab that
  // has a transcript mirror on disk. Null = no confirm pending.
  const [closeTarget, setCloseTarget] = useState<{ id: string; name: string } | null>(null);
  // Ids the user created in this component lifetime via `addSession`
  // (the `+` button), as opposed to ids loaded from sessions.json on
  // mount. Drives the `isFresh` flag in onActiveTabChange so App.tsx
  // can decide whether to apply the workspace-summary fallback when
  // the per-tab observability fetch returns null. Set is intentionally
  // never pruned within the component's lifetime — once a tab is
  // marked fresh it stays fresh until the user reloads the app
  // (where it'd come back via inventory and be treated as loaded).
  const freshIdsRef = useRef<Set<string>>(new Set());

  // Busy session ids. The workspace is "busy" while any session is working;
  // bubble up only when the aggregate flips so the chip indicator is stable.
  // Mirrored into state (`busyIds`) so the idle-gated loadout reload can react.
  const busyIdsRef = useRef<Set<string>>(new Set());
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const handleActivity = (sessionId: string, busy: boolean): void => {
    const set = busyIdsRef.current;
    const was = set.size > 0;
    if (busy) set.add(sessionId);
    else set.delete(sessionId);
    const now = set.size > 0;
    if (now !== was) onBusyChange?.(workspaceId, now);
    // Always emit the per-session set (not just on aggregate flips) so App can
    // pulse exactly the running sessions' rows in the Sessions list.
    onBusyIdsChange?.(workspaceId, [...set]);
    setBusyIds(new Set(set));
  };

  const handleLifecycle = (sessionId: string, status: 'live' | 'ended') => {
    setEndedIds((prev) => {
      const wanted = status === 'ended';
      const has = prev.has(sessionId);
      if (wanted === has) return prev; // no-op
      const next = new Set(prev);
      if (wanted) next.add(sessionId);
      else next.delete(sessionId);
      return next;
    });
  };

  // Report live tabs (Sessions-list Open group). A tab is live unless its
  // PTY has ended; endedIds is exactly that set. Cleared on unmount so a
  // stopped workspace's tabs leave the Open group immediately.
  useEffect(() => {
    if (!loaded) return;
    onLiveIdsChange?.(
      workspaceId,
      sessions.filter((s) => !endedIds.has(s.id)).map((s) => s.id)
    );
  }, [loaded, workspaceId, sessions, endedIds, onLiveIdsChange]);
  useEffect(() => {
    return () => onLiveIdsChange?.(workspaceId, []);
  }, [workspaceId, onLiveIdsChange]);

  // Load inventory on mount, defaulting to a fresh "main" if there's
  // nothing on disk (first attach to this workspace ever, or its
  // sessions.json was deleted). Persist the default immediately so a
  // fast quit doesn't drop the session.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const inv = await window.api.sessions.read(workspaceId);
      if (cancelled) return;
      if (inv.sessions.length === 0) {
        const main: Session = { id: uid(), name: 'main', createdAt: Date.now() };
        setSessions([main]);
        setActiveId(main.id);
        setNextNum(2);
        await window.api.sessions.write(workspaceId, {
          version: 1,
          sessions: [main],
          nextNum: 2,
          activeId: main.id
        });
      } else {
        setSessions(inv.sessions);
        setActiveId(inv.activeId ?? inv.sessions[0].id);
        setNextNum(inv.nextNum);
      }
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // Persist on every change after the initial load. Best-effort: write
  // failures are logged but don't fault the UI — the worst case is the
  // user loses a tab list change on the next quit, which is recoverable
  // by recreating the tab.
  const skipFirstPersist = useRef(true);
  useEffect(() => {
    if (!loaded) return;
    if (skipFirstPersist.current) {
      skipFirstPersist.current = false;
      return;
    }
    void window.api.sessions
      .write(workspaceId, {
        version: 1,
        sessions,
        nextNum,
        activeId: activeId || undefined
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('sessions.write failed:', err);
      });
  }, [loaded, workspaceId, sessions, nextNum, activeId]);

  // Bubble activeId up to App so the ObservabilityPane can target the
  // claude session this tab maps to. Fires on inventory-load
  // (initial activeId set), tab-click, addSession, and the close-last
  // auto-recreate path — every setActiveId call.
  useEffect(() => {
    if (!activeId || !workspaceId) return;
    onActiveTabChange?.(workspaceId, activeId, freshIdsRef.current.has(activeId));
  }, [activeId, workspaceId, onActiveTabChange]);

  function addSession(): void {
    if (!loaded) return;
    const id = uid();
    const name = `session ${nextNum}`;
    freshIdsRef.current.add(id);
    setSessions((prev) => [...prev, { id, name, createdAt: Date.now() }]);
    setActiveId(id);
    setNextNum((n) => n + 1);
  }

  // Session-tab ⋮ menu: rename / auto-rename / close — shared portaled-menu
  // mechanics (state + close listeners + anchor math) live in usePortalMenu.
  const { menu: tabMenu, toggle: toggleTabMenu, close: closeTabMenu } = usePortalMenu();
  // Inline rename: the tab whose name is being edited, plus the draft text.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');

  function startRename(id: string): void {
    const s = sessions.find((x) => x.id === id);
    setDraftName(s?.name ?? '');
    setRenamingId(id);
  }
  function commitRename(id: string): void {
    const name = draftName.trim();
    setRenamingId(null);
    if (!name) return;
    // A manual rename takes ownership: turn auto-rename off so the summary
    // sync doesn't immediately overwrite it.
    setSessions((prev) =>
      prev.map((s) => (s.id === id ? { ...s, name, autoName: false } : s))
    );
  }
  function toggleAutoName(id: string): void {
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, autoName: !s.autoName } : s)));
  }

  // Auto-rename sync: for every tab with autoName on, mirror Claude's session
  // summary (the observed AI title) into the tab name, refreshed on each
  // observability push. Keyed on the *set* of auto-named tabs so flipping the
  // toggle re-runs immediately; name writes don't re-subscribe (autoKey stable).
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const autoKey = sessions
    .filter((s) => s.autoName)
    .map((s) => s.id)
    .sort()
    .join(',');
  useEffect(() => {
    if (!loaded || !autoKey) return;
    let cancelled = false;
    const sync = async (): Promise<void> => {
      for (const s of sessionsRef.current) {
        if (!s.autoName) continue;
        try {
          const sum = await window.api.observability.summaryForBrokerSession(workspaceId, s.id);
          const title = sum?.title?.trim().slice(0, 40);
          if (cancelled || !title) continue;
          setSessions((prev) =>
            prev.map((p) => (p.id === s.id && p.autoName && p.name !== title ? { ...p, name: title } : p))
          );
        } catch {
          /* best-effort — a tab with no resolvable title keeps its current name */
        }
      }
    };
    void sync();
    const unsub = window.api.observability.onSummary((wid) => {
      if (wid === workspaceId) void sync();
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [loaded, workspaceId, autoKey]);

  // Resolve each tab's claude session UUID so the tab dot can reflect the
  // per-claude "needs input" set (keyed by claude UUID). Refreshes on
  // observability pushes (the broker→claude mapping is learned as transcripts
  // ingest) and when the tab set changes.
  const [claudeIdByBroker, setClaudeIdByBroker] = useState<Map<string, string>>(new Map());
  const tabIdsKey = sessions.map((s) => s.id).sort().join(',');
  useEffect(() => {
    if (!loaded || sessions.length === 0) return;
    let cancelled = false;
    const resolve = async (): Promise<void> => {
      const next = new Map<string, string>();
      for (const s of sessionsRef.current) {
        try {
          const sum = await window.api.observability.summaryForBrokerSession(workspaceId, s.id);
          if (sum?.sessionId) next.set(s.id, sum.sessionId);
        } catch { /* mapping not learned yet */ }
      }
      if (cancelled) return;
      setClaudeIdByBroker((prev) => {
        if (prev.size === next.size && [...next].every(([k, v]) => prev.get(k) === v)) return prev;
        return next;
      });
    };
    void resolve();
    const unsub = window.api.observability.onSummary((wid) => { if (wid === workspaceId) void resolve(); });
    return () => { cancelled = true; unsub(); };
  }, [loaded, workspaceId, tabIdsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Drag-reorder of session tabs (#1). Move the dragged tab before the drop
  // target; the existing sessions.json persist effect saves the new order.
  const [dragSessionId, setDragSessionId] = useState<string | null>(null);
  function reorderSessions(draggedId: string, targetId: string): void {
    if (draggedId === targetId) return;
    setSessions((prev) => {
      const dragged = prev.find((s) => s.id === draggedId);
      if (!dragged) return prev;
      const without = prev.filter((s) => s.id !== draggedId);
      const ti = without.findIndex((s) => s.id === targetId);
      if (ti < 0) return prev;
      without.splice(ti, 0, dragged);
      return without;
    });
  }

  // Resume request from the Sessions list: open a new tab bound to the
  // claude session. The tab carries `resumeOf` so its first attach runs
  // `claude --resume <uuid>`. Marked fresh so the per-tab observability
  // fetch doesn't inherit a sibling's numbers before the mapping (learned
  // directly at attach time for resumes) resolves. Re-fires per `token` so
  // resuming the same session twice opens two tabs.
  const lastResumeToken = useRef<number | null>(null);
  useEffect(() => {
    if (!loaded || !resumeRequest) return;
    if (lastResumeToken.current === resumeRequest.token) return;
    lastResumeToken.current = resumeRequest.token;
    const id = uid();
    const name = resumeRequest.title.slice(0, 32) || 'resumed';
    freshIdsRef.current.add(id);
    setSessions((prev) => [
      ...prev,
      { id, name, createdAt: Date.now(), resumeOf: resumeRequest.claudeSessionId }
    ]);
    setActiveId(id);
    onResumeConsumed?.();
  }, [loaded, resumeRequest, onResumeConsumed]);

  // Jump-to-tab from the Sessions list: activate an existing tab instead of
  // opening a duplicate resume tab. Same token dance as resumeRequest.
  const lastActivateToken = useRef(0);
  useEffect(() => {
    if (!loaded || !activateRequest) return;
    if (lastActivateToken.current === activateRequest.token) return;
    lastActivateToken.current = activateRequest.token;
    if (sessions.some((s) => s.id === activateRequest.brokerSessionId)) {
      setActiveId(activateRequest.brokerSessionId);
    }
    onActivateConsumed?.();
  }, [loaded, activateRequest, sessions, onActivateConsumed]);

  // Loadout reload (#16): a request from App means "reload the active session in
  // place so the just-installed loadout takes effect". We hold it pending and
  // only fire once the active session is idle — interrupting a working claude
  // would be destructive. The token in `reloadTargets[activeId]` is handed to
  // the matching TerminalSession, which closes + re-attaches with `--resume`.
  // The map (rather than a single target) lets the loadout reload and the
  // manual chip-menu Refresh address different sessions independently.
  const [pendingReload, setPendingReload] = useState(false);
  const [reloadTargets, setReloadTargets] = useState<Record<string, number>>({});
  const reloadTokenRef = useRef(0);
  const lastReloadRequest = useRef<number | null>(null);
  useEffect(() => {
    if (!loaded || !reloadRequest) return;
    if (lastReloadRequest.current === reloadRequest.token) return;
    lastReloadRequest.current = reloadRequest.token;
    setPendingReload(true);
    onReloadConsumed?.();
  }, [loaded, reloadRequest, onReloadConsumed]);
  useEffect(() => {
    if (!pendingReload || !activeId) return;
    if (busyIds.has(activeId)) return; // claude is working — defer until idle
    setPendingReload(false);
    setReloadTargets((prev) => ({ ...prev, [activeId]: ++reloadTokenRef.current }));
    onReloadStarted?.();
  }, [pendingReload, activeId, busyIds, onReloadStarted]);

  // Manual chip-menu Refresh: a per-session queue. requestRefresh enqueues a
  // session id and shows the toast at click time; this effect drains the queue
  // into reloadTargets once each session is idle (readyToRefresh enforces the
  // not-busy / not-ended / still-exists rule). Shares reloadTargets with the
  // loadout reload, so a loadout reload of one tab and a manual refresh of
  // another fire independently when each goes idle.
  const [pendingRefresh, setPendingRefresh] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (pendingRefresh.size === 0) return;
    const existing = new Set(sessions.map((s) => s.id));
    const ready = readyToRefresh(pendingRefresh, busyIds, endedIds, existing);
    if (ready.length === 0) return;
    setPendingRefresh((prev) => {
      const next = new Set(prev);
      ready.forEach((id) => next.delete(id));
      return next;
    });
    setReloadTargets((prev) => {
      const next = { ...prev };
      ready.forEach((id) => {
        next[id] = ++reloadTokenRef.current;
      });
      return next;
    });
  }, [pendingRefresh, busyIds, endedIds, sessions]);

  function handleRefreshUnresolved(sessionId: string): void {
    const name = sessions.find((s) => s.id === sessionId)?.name ?? 'session';
    onRefreshUnresolved?.(name);
  }

  function requestRefresh(s: Session): void {
    if (!loaded || endedIds.has(s.id)) return;
    setPendingRefresh((prev) => {
      if (prev.has(s.id)) return prev;
      const next = new Set(prev);
      next.add(s.id);
      return next;
    });
    onRefreshRequested?.(s.name, busyIds.has(s.id));
  }

  function closeSession(id: string): void {
    if (!loaded) return;
    // Drop the closed tab from the ended-set so a future tab that
    // happens to recycle the id (unlikely with uid(), but cheap insurance)
    // doesn't inherit the prior ended state.
    setEndedIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setSessions((prev) => {
      const idx = prev.findIndex((s) => s.id === id);
      if (idx < 0) return prev;
      const next = prev.filter((s) => s.id !== id);
      if (next.length === 0) {
        // Never leave the workspace with zero sessions — drop a fresh
        // main back in so there's always somewhere to type. Mark it
        // fresh so the observability pane shows an empty state
        // (closing the last tab and getting a new "main" is morally
        // the same as clicking "+", and inheriting the closed tab's
        // numbers would be confusing).
        const fresh: Session = { id: uid(), name: 'main', createdAt: Date.now() };
        freshIdsRef.current.add(fresh.id);
        setActiveId(fresh.id);
        setNextNum(2);
        return [fresh];
      }
      if (activeId === id) {
        // Move focus to the neighbor on the left (or the new first tab).
        setActiveId(next[Math.max(0, idx - 1)].id);
      }
      return next;
    });
  }

  // The active tab's effective mirror setting (its override, else the
  // workspace default). Drives the tab-strip toggle.
  const activeSession = sessions.find((s) => s.id === activeId);
  const activeMirror: MirrorSetting = activeSession?.mirror ?? mirrorDefault;

  // Flip the active session's override. Persists via the sessions effect and
  // applies live in the watcher (turning off stops further mirroring; turning
  // on starts from now — earlier turns aren't backfilled).
  function toggleMirror(): void {
    if (!activeSession) return;
    const next: MirrorSetting = activeMirror === 'on' ? 'off' : 'on';
    setSessions((prev) => prev.map((s) => (s.id === activeSession.id ? { ...s, mirror: next } : s)));
    void window.api.mirror.setOverride(workspaceId, activeSession.id, next);
  }

  // Tab × — if this session has a mirror file, ask before dropping the tab;
  // otherwise close immediately (nothing to clean up).
  async function requestClose(s: Session): Promise<void> {
    const hasMirror = await window.api.mirror.hasForBrokerSession(workspaceId, s.id);
    if (hasMirror) setCloseTarget({ id: s.id, name: s.name });
    else closeSession(s.id);
  }

  async function confirmClose(deleteMirror: boolean): Promise<void> {
    const target = closeTarget;
    if (!target) return;
    setCloseTarget(null);
    if (deleteMirror) await window.api.mirror.deleteForBrokerSession(workspaceId, target.id);
    closeSession(target.id);
  }

  return (
    <div
      className="terminal-pane"
      // visibility:hidden preserves layout (xterm keeps real dimensions);
      // pointer-events:none is belt-and-suspenders so hidden panes never
      // intercept clicks meant for the visible one stacked at the same
      // coords. (Modern browsers should already do this for
      // visibility:hidden, but Playwright's actionability check trips
      // when multiple absolutely-positioned siblings overlap.)
      style={{
        visibility: visible ? 'visible' : 'hidden',
        pointerEvents: visible ? 'auto' : 'none'
      }}
      aria-hidden={!visible}
    >
      {committeeToast !== null && (
        <ToastView
          toast={makeToast(0, {
            kind: 'info',
            eyebrow: 'committee',
            message: committeeToast,
            placement: 'tab',
            sticky: false,
            dismissible: true
          })}
          onDismiss={() => setCommitteeToast(null)}
        />
      )}
      {restartBanner && (
        <div className="restart-banner" role="status" aria-live="polite">
          <span className="restart-banner-text">
            Changes apply on next start.
          </span>
          <button
            type="button"
            className="btn primary restart-banner-btn"
            onClick={onRestartFromBanner}
          >
            Restart now
          </button>
          <button
            type="button"
            className="restart-banner-dismiss"
            onClick={onDismissBanner}
            aria-label="Dismiss"
            title="Dismiss"
          >
            ×
          </button>
        </div>
      )}
      <div className="session-tab-strip" role="tablist" aria-label="Terminal sessions">
        {sessions.map((s) => {
          const ended = endedIds.has(s.id);
          const claudeId = claudeIdByBroker.get(s.id);
          const tabWaiting = !!claudeId && (waitingSessionIds?.has(claudeId) ?? false);
          return (
            <div
              key={s.id}
              role="tab"
              aria-selected={s.id === activeId}
              className={`session-tab ${s.id === activeId ? 'active' : ''} ${
                dragSessionId === s.id ? 'dragging' : ''
              }`}
              onClick={() => setActiveId(s.id)}
              // Don't drag while editing the name (the input owns the pointer).
              draggable={renamingId !== s.id}
              {...reorderDragHandlers({
                id: s.id,
                dragId: dragSessionId,
                setDragId: setDragSessionId,
                onReorder: reorderSessions
              })}
            >
              <SessionTabDot ended={ended} busy={busyIds.has(s.id)} waiting={tabWaiting} />
              {renamingId === s.id ? (
                <input
                  className="session-tab-rename"
                  autoFocus
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename(s.id);
                    else if (e.key === 'Escape') setRenamingId(null);
                  }}
                  onBlur={() => commitRename(s.id)}
                  aria-label="Session name"
                />
              ) : (
                <span className="session-tab-name">
                  {s.autoName && <span className="session-tab-auto" title="Auto-named from Claude's summary" aria-hidden="true">✦</span>}
                  {s.name}
                </span>
              )}
              <button
                className="session-tab-menu-trigger"
                aria-label={`Actions for ${s.name}`}
                aria-haspopup="menu"
                aria-expanded={tabMenu?.id === s.id}
                title="Session actions"
                onClick={(e) => {
                  e.stopPropagation();
                  toggleTabMenu(e.currentTarget, s.id);
                }}
              >
                ⋮
              </button>
            </div>
          );
        })}
        <button
          className="session-tab-new"
          onClick={addSession}
          title="New session in this workspace"
          aria-label="New session"
          disabled={!loaded || paused}
        >
          +
        </button>
        {/* Per-session durable-mirror toggle for the active tab. */}
        <button
          className={`session-mirror-toggle ${activeMirror === 'on' ? 'on' : 'off'}`}
          onClick={toggleMirror}
          disabled={!loaded || !activeSession}
          aria-pressed={activeMirror === 'on'}
          title={
            activeMirror === 'on'
              ? 'Transcript mirror on for this session — click to turn off'
              : 'Transcript mirror off for this session — click to turn on'
          }
        >
          <span className="session-mirror-dot" aria-hidden="true" />
          mirror {activeMirror}
        </button>
      </div>
      {tabMenu &&
        (() => {
          const s = sessions.find((x) => x.id === tabMenu.id);
          if (!s) return null;
          return createPortal(
            <div
              className="ws-chip-menu"
              role="menu"
              style={{ position: 'fixed', top: tabMenu.top, left: tabMenu.left }}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                role="menuitem"
                onClick={() => {
                  closeTabMenu();
                  startRename(s.id);
                }}
              >
                <IconPencil />
                <span>Rename</span>
              </button>
              <button
                role="menuitem"
                disabled={endedIds.has(s.id)}
                aria-disabled={endedIds.has(s.id)}
                title="Exit and resume this session (waits until it's idle)"
                onClick={() => {
                  closeTabMenu();
                  requestRefresh(s);
                }}
              >
                <IconRefresh />
                <span>Refresh</span>
              </button>
              <button
                role="menuitemcheckbox"
                aria-checked={!!s.autoName}
                title="Name this tab from Claude's session summary, kept up to date"
                onClick={() => {
                  closeTabMenu();
                  toggleAutoName(s.id);
                }}
              >
                <IconAuto />
                <span>Auto rename</span>
                {s.autoName && (
                  <span className="ws-chip-menu-check" aria-hidden="true">
                    ✓
                  </span>
                )}
              </button>
              <div className="ws-chip-menu-divider" />
              <button
                role="menuitem"
                className="danger"
                onClick={() => {
                  closeTabMenu();
                  void requestClose(s);
                }}
              >
                <IconEject />
                <span>Close</span>
              </button>
            </div>,
            document.body
          );
        })()}
      {/* Context bar — workspace's hue track at the top of the terminal,
          filling 0..100% with the latest assistant turn's context-window
          usage (input + cache_read + cache_creation over the session's
          effective window from `summary.contextWindowTokens`: 200K stock,
          1M for the [1m] variant or when observed usage already crossed
          200K). A subtle tick at 80% marks the compaction threshold.
          Falls back to a pure 100% identity band when no data is
          available, so a fresh workspace still reads visually correct.
          Wrapper supplies the breathing room above the bar (matches the
          design's ContextBar padding). */}
      <div className="terminal-accent-band-row" aria-hidden="true">
        <div
          className="terminal-accent-band"
          style={{ ['--pct' as never]: `${contextBarPct(summary)}%` }}
          title={contextBarTooltip(summary)}
        >
          <div className="terminal-accent-band-fill" />
        </div>
      </div>
      <div className={`session-stack ${paused ? 'paused' : ''}`}>
        {sessions.map((s) => (
          <TerminalSession
            key={s.id}
            containerId={containerId}
            workspaceId={workspaceId}
            sessionId={s.id}
            mirrorSetting={s.mirror ?? mirrorDefault}
            resumeOf={s.resumeOf}
            // Visible only when BOTH this workspace's pane is showing
            // AND this tab is the active one within it. Without ANDing
            // the outer `visible` in, the active tab's
            // `visibility: visible` would override the outer pane's
            // `visibility: hidden` (CSS visibility cascades downward
            // unless the child explicitly says 'visible', in which
            // case it paints regardless of an ancestor's 'hidden').
            // The user-visible bug was: clicking witty-wren's chip
            // showed gentle-crane's terminal, because every workspace's
            // active TerminalSession was actually painting and the one
            // later in DOM order won the stacking contest.
            visible={visible && s.id === activeId}
            paused={paused}
            onLifecycleChange={handleLifecycle}
            onActivityChange={handleActivity}
            reloadToken={reloadTargets[s.id] ?? null}
            onRefreshUnresolved={handleRefreshUnresolved}
          />
        ))}
        {paused && (
          <div className="paused-overlay" role="alertdialog" aria-label="Workspace paused">
            <div className="paused-card">
              <div className="paused-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                  <rect x="6" y="4" width="4.5" height="16" rx="1" />
                  <rect x="13.5" y="4" width="4.5" height="16" rx="1" />
                </svg>
              </div>
              <div className="paused-title">workspace paused</div>
              <div className="paused-help">
                The container is frozen. Sessions remain attached and will pick up where they
                left off on resume.
              </div>
              <button className="btn primary paused-resume" onClick={onResume}>
                <svg viewBox="0 0 12 12" width="11" height="11" fill="currentColor" aria-hidden="true">
                  <path d="M3 2 L10 6 L3 10 Z" />
                </svg>
                <span>Resume</span>
              </button>
            </div>
          </div>
        )}
      </div>
      {closeTarget && (
        <ModalBackdrop onClose={() => setCloseTarget(null)}>
          <div className="modal mirror-close-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Close {closeTarget.name}</h3>
            <p className="form-hint">
              This session has a durable transcript mirror saved on the host. Delete it, or keep
              it on disk for later?
            </p>
            <div className="modal-footer">
              <button type="button" className="btn" onClick={() => setCloseTarget(null)}>
                Cancel
              </button>
              <button
                type="button"
                className={`btn ${cleanupDefault === 'preserve' ? 'primary' : ''}`}
                onClick={() => void confirmClose(false)}
              >
                Keep &amp; close
              </button>
              <button
                type="button"
                className={`btn ${cleanupDefault === 'delete' ? 'primary' : ''}`}
                onClick={() => void confirmClose(true)}
              >
                Delete &amp; close
              </button>
            </div>
          </div>
        </ModalBackdrop>
      )}
    </div>
  );
}
