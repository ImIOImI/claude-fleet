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
import type { WorkspaceObservabilitySummary } from '../../../preload';
import type { MirrorSetting, CleanupSetting } from '../App';
import { TerminalSession } from './TerminalSession';

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
   * A resume request targeted at THIS workspace (App only passes it to the
   * matching pane). Opens a new tab that attaches with `claude --resume
   * <claudeSessionId>`. `token` distinguishes repeat resumes of the same
   * session so the effect re-fires; App clears the request via
   * `onResumeConsumed` once the tab is added. Null when there's nothing to
   * resume.
   */
  resumeRequest?: { claudeSessionId: string; title: string; token: number } | null;
  onResumeConsumed?: () => void;
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
  onResume,
  onActiveTabChange,
  onBusyChange,
  resumeRequest,
  onResumeConsumed
}: Props) {
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
  const busyIdsRef = useRef<Set<string>>(new Set());
  const handleActivity = (sessionId: string, busy: boolean): void => {
    const set = busyIdsRef.current;
    const was = set.size > 0;
    if (busy) set.add(sessionId);
    else set.delete(sessionId);
    const now = set.size > 0;
    if (now !== was) onBusyChange?.(workspaceId, now);
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
          return (
            <div
              key={s.id}
              role="tab"
              aria-selected={s.id === activeId}
              className={`session-tab ${s.id === activeId ? 'active' : ''}`}
              onClick={() => setActiveId(s.id)}
            >
              <span
                className={`session-tab-dot ${ended ? 'ended' : 'live'}`}
                aria-label={ended ? 'session ended' : 'session live'}
                title={ended ? 'session ended' : 'session live'}
              />
              <span className="session-tab-name">{s.name}</span>
              <button
                className="session-tab-close"
                aria-label={`Close ${s.name}`}
                title="Close session"
                onClick={(e) => {
                  e.stopPropagation();
                  void requestClose(s);
                }}
              >
                ×
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
        <div className="modal-backdrop" onClick={() => setCloseTarget(null)}>
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
        </div>
      )}
    </div>
  );
}
