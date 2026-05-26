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
import { TerminalSession } from './TerminalSession';

/** Assumed model context window for the bar fill. 200K covers stock 4.x; the
 *  1M-context variant would under-report (looks fuller than it is) — acceptable
 *  for v1. Switch to per-model lookup when slot consumers mature. */
const CONTEXT_LIMIT_TOKENS = 200_000;

interface Props {
  containerId: string;
  workspaceName: string;
  paused: boolean;
  /** Latest observability summary for this workspace; drives the context-bar fill. */
  summary: WorkspaceObservabilitySummary | null;
  onResume: () => void;
}

interface Session {
  id: string;
  name: string;
  createdAt: number;
}

function uid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `s-${Math.random().toString(36).slice(2, 10)}`;
}

export function TerminalPane({ containerId, workspaceName, paused, summary, onResume }: Props) {
  const [loaded, setLoaded] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [nextNum, setNextNum] = useState(2);

  // Load inventory on mount, defaulting to a fresh "main" if there's
  // nothing on disk (first attach to this workspace ever, or its
  // sessions.json was deleted). Persist the default immediately so a
  // fast quit doesn't drop the session.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const inv = await window.api.sessions.read(workspaceName);
      if (cancelled) return;
      if (inv.sessions.length === 0) {
        const main: Session = { id: uid(), name: 'main', createdAt: Date.now() };
        setSessions([main]);
        setActiveId(main.id);
        setNextNum(2);
        await window.api.sessions.write(workspaceName, {
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
  }, [workspaceName]);

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
      .write(workspaceName, {
        version: 1,
        sessions,
        nextNum,
        activeId: activeId || undefined
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('sessions.write failed:', err);
      });
  }, [loaded, workspaceName, sessions, nextNum, activeId]);

  function addSession(): void {
    if (!loaded) return;
    const id = uid();
    const name = `session ${nextNum}`;
    setSessions((prev) => [...prev, { id, name, createdAt: Date.now() }]);
    setActiveId(id);
    setNextNum((n) => n + 1);
  }

  function closeSession(id: string): void {
    if (!loaded) return;
    setSessions((prev) => {
      const idx = prev.findIndex((s) => s.id === id);
      if (idx < 0) return prev;
      const next = prev.filter((s) => s.id !== id);
      if (next.length === 0) {
        // Never leave the workspace with zero sessions — drop a fresh
        // main back in so there's always somewhere to type.
        const fresh: Session = { id: uid(), name: 'main', createdAt: Date.now() };
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

  return (
    <div className="terminal-pane">
      <div className="session-tab-strip" role="tablist" aria-label="Terminal sessions">
        {sessions.map((s) => (
          <div
            key={s.id}
            role="tab"
            aria-selected={s.id === activeId}
            className={`session-tab ${s.id === activeId ? 'active' : ''}`}
            onClick={() => setActiveId(s.id)}
          >
            <span className="session-tab-name">{s.name}</span>
            <button
              className="session-tab-close"
              aria-label={`Close ${s.name}`}
              title="Close session"
              onClick={(e) => {
                e.stopPropagation();
                closeSession(s.id);
              }}
            >
              ×
            </button>
          </div>
        ))}
        <button
          className="session-tab-new"
          onClick={addSession}
          title="New session in this workspace"
          aria-label="New session"
          disabled={!loaded || paused}
        >
          +
        </button>
      </div>
      {/* Context bar — workspace's hue band at the top of the terminal,
          fills from 0..100% with the most recent assistant turn's
          context-window usage (input + cache_read + cache_create over
          an assumed 200K limit). Renders as a pure identity band (100%
          fill) while no data is available. Wrapper supplies the breathing
          room above the bar (matches the design's ContextBar padding). */}
      <div className="terminal-accent-band-row" aria-hidden="true">
        <div
          className="terminal-accent-band"
          style={{
            ['--pct' as never]: `${contextBarPct(summary)}%`
          }}
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
            sessionId={s.id}
            visible={s.id === activeId}
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
    </div>
  );
}

function contextBarPct(summary: WorkspaceObservabilitySummary | null): number {
  if (!summary?.lastTurnContextTokens) return 100; // identity-band fallback
  const raw = (summary.lastTurnContextTokens / CONTEXT_LIMIT_TOKENS) * 100;
  return Math.max(0, Math.min(100, raw));
}

function contextBarTooltip(summary: WorkspaceObservabilitySummary | null): string {
  if (!summary?.lastTurnContextTokens) {
    return 'Workspace accent — no transcript activity yet';
  }
  const tokens = summary.lastTurnContextTokens;
  const pct = (tokens / CONTEXT_LIMIT_TOKENS) * 100;
  return `Context: ${tokens.toLocaleString()} / ${CONTEXT_LIMIT_TOKENS.toLocaleString()} tokens (${pct.toFixed(1)}%)`;
}
