import { useEffect, useState } from 'react';
import type { ServingPort } from '../../../preload';
import { formatUptime } from './portsFormat';

export interface PortRowData extends ServingPort {
  workspaceId: string;
  /** Fleet scope only: dot hue + name shown before the port. */
  workspaceName?: string;
  hue?: string;
}

/**
 * "Serving" rail section — the durable home of the port-preview flow. One
 * row per HTTP-serving container port; ↗ opens the loopback preview (same
 * path as the detection toast), ✕ kills the server via the broker behind a
 * two-step inline confirm. Renders nothing when no port is serving. The
 * kill button is hidden for rows without a pid (old runner image's broker
 * can't attribute or kill).
 */
export function PortsSection({
  rows,
  showWorkspace,
  onOpen,
  onKill
}: {
  rows: PortRowData[];
  showWorkspace: boolean;
  onOpen: (workspaceId: string, port: number) => void;
  onKill: (workspaceId: string, port: number) => void;
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
        />
      ))}
    </section>
  );
}

function PortRow({
  row,
  showWorkspace,
  onOpen,
  onKill
}: {
  row: PortRowData;
  showWorkspace: boolean;
  onOpen: (workspaceId: string, port: number) => void;
  onKill: (workspaceId: string, port: number) => void;
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
          {row.pid !== null && (
            <button
              type="button"
              className="obs-port-btn kill"
              title="Kill server"
              aria-label={`Kill server on port ${row.port}`}
              onClick={() => setConfirming(true)}
            >
              ✕
            </button>
          )}
        </>
      )}
    </div>
  );
}
