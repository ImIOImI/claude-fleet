import { useEffect, useState } from 'react';
import type { ServingPort } from '../../../preload';
import { formatUptime } from './portsFormat';

export interface PortRowData extends ServingPort {
  workspaceId: string;
  /** Fleet scope only: dot hue + name shown before the port. */
  workspaceName?: string;
  hue?: string;
  /** Tab name of the session whose process tree owns the server; absent when
   *  the broker couldn't attribute one or the tab has been closed. */
  sessionName?: string;
}

/**
 * "Serving" rail section — the durable home of the port-preview flow. One
 * row per HTTP-serving container port; ↗ opens the loopback preview (same
 * path as the detection toast), ✕ kills the server via the broker behind a
 * two-step inline confirm. Renders nothing when no port is serving. The
 * kill button always renders; if the broker is too old to support KILLPORT,
 * the failure is surfaced at kill time via toast. Each row optionally shows
 * a session chip naming the owning tab — click focuses that tab (switching
 * workspace first in fleet scope); absent when the broker couldn't attribute
 * the port or the tab is gone.
 */
export function PortsSection({
  rows,
  showWorkspace,
  onOpen,
  onKill,
  onFocusSession
}: {
  rows: PortRowData[];
  showWorkspace: boolean;
  onOpen: (workspaceId: string, port: number) => void;
  onKill: (workspaceId: string, port: number) => void;
  onFocusSession: (workspaceId: string, brokerSessionId: string) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <section className="obs-section">
      <div className="obs-section-title">Serving</div>
      {rows.map((r) => (
        <PortRow
          key={`${r.workspaceId}:${r.port}`}
          row={r}
          showWorkspace={showWorkspace}
          onOpen={onOpen}
          onKill={onKill}
          onFocusSession={onFocusSession}
        />
      ))}
    </section>
  );
}

function PortRow({
  row,
  showWorkspace,
  onOpen,
  onKill,
  onFocusSession
}: {
  row: PortRowData;
  showWorkspace: boolean;
  onOpen: (workspaceId: string, port: number) => void;
  onKill: (workspaceId: string, port: number) => void;
  onFocusSession: (workspaceId: string, brokerSessionId: string) => void;
}) {
  // Two-step kill confirm: first ✕ swaps the actions for a "kill?" chip
  // that reverts after 3s untouched; the second click sends the kill.
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 3000);
    return () => clearTimeout(t);
  }, [confirming]);

  const startedAt = new Date(row.firstSeenAt).toLocaleString();
  return (
    <div className="obs-port-row">
      {showWorkspace && (
        <>
          <span className="obs-fleet-dot" style={{ background: row.hue }} />
          <span className="obs-port-ws" title={`${row.workspaceName} · ${formatUptime(row.firstSeenAt)} (since ${startedAt})`}>
            {row.workspaceName}
          </span>
        </>
      )}
      <span className="obs-port-num mono">:{row.port}</span>
      {row.cmdline && (
        <span className="obs-port-cmd" title={row.cmdline}>
          {row.cmdline}
        </span>
      )}
      {row.sessionId && row.sessionName && (
        <button
          type="button"
          className="obs-port-chip"
          title={`Session "${row.sessionName}" started this server — click to focus its tab`}
          aria-label={`Focus session ${row.sessionName}`}
          onClick={() => onFocusSession(row.workspaceId, row.sessionId!)}
        >
          <span className="obs-port-chip-glyph">▸</span>
          <span className="obs-port-chip-name">{row.sessionName}</span>
        </button>
      )}
      {!showWorkspace && (
        <span className="obs-port-up" title={`since ${startedAt}`}>
          {formatUptime(row.firstSeenAt)}
        </span>
      )}
      {confirming ? (
        <button
          type="button"
          className="obs-port-kill-confirm"
          aria-label={`Confirm kill server on port ${row.port}`}
          onClick={() => {
            setConfirming(false);
            onKill(row.workspaceId, row.port);
          }}
        >
          kill?
        </button>
      ) : (
        <>
          <button
            type="button"
            className="obs-port-btn"
            title="Open preview"
            aria-label={`Open preview of port ${row.port}`}
            onClick={() => onOpen(row.workspaceId, row.port)}
          >
            ↗
          </button>
          <button
            type="button"
            className="obs-port-btn kill"
            title="Kill server"
            aria-label={`Kill server on port ${row.port}`}
            onClick={() => setConfirming(true)}
          >
            ✕
          </button>
        </>
      )}
    </div>
  );
}
