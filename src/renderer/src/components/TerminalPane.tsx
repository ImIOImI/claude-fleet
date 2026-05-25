// Multi-session terminal pane.
//
// A workspace can have multiple claude sessions running in parallel —
// each session is a separate `docker exec claude` PTY inside the
// workspace's container. The tab strip at the top of this pane lists
// those sessions; the body stacks one TerminalSession per session,
// with only the active one visible.
//
// Session state (the array + active id + auto-increment counter) lives
// in this component's local state. The parent App.tsx forces a remount
// of this pane via `key={containerId}` when the workspace changes, so
// session state doesn't accidentally leak across workspaces. Persisting
// sessions across workspace switches is a future concern — for now,
// switching workspaces always starts a fresh "main" session in the new
// workspace.

import { useState } from 'react';
import { TerminalSession } from './TerminalSession';

interface Props {
  containerId: string;
}

interface Session {
  id: string;
  name: string;
}

function uid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `s-${Math.random().toString(36).slice(2, 10)}`;
}

export function TerminalPane({ containerId }: Props) {
  // Auto-increment for "session N" names. Doesn't decrement on close, so
  // names stay stable: deleting session 2 doesn't renumber session 3.
  const [nextNum, setNextNum] = useState(2);
  const [sessions, setSessions] = useState<Session[]>(() => [
    { id: uid(), name: 'main' }
  ]);
  const [activeId, setActiveId] = useState<string>(() => sessions[0]?.id ?? '');

  function addSession(): void {
    const id = uid();
    const name = `session ${nextNum}`;
    setSessions((prev) => [...prev, { id, name }]);
    setActiveId(id);
    setNextNum((n) => n + 1);
  }

  function closeSession(id: string): void {
    setSessions((prev) => {
      const idx = prev.findIndex((s) => s.id === id);
      if (idx < 0) return prev;
      const next = prev.filter((s) => s.id !== id);
      if (next.length === 0) {
        // Never leave the workspace with zero sessions — drop a fresh
        // main back in so there's always somewhere to type.
        const fresh = { id: uid(), name: 'main' };
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
        >
          +
        </button>
      </div>
      <div className="session-stack">
        {sessions.map((s) => (
          <TerminalSession
            key={s.id}
            containerId={containerId}
            visible={s.id === activeId}
          />
        ))}
      </div>
    </div>
  );
}
