import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { WorkspaceObservabilitySummary } from '../../../preload';
import { colorFor, type WorkspaceState, type WorkspaceSummary } from '../App';
import { isManager, isReachable, ManagerGlyph, WifiGlyph } from './committee';
import { useBlinkSync } from '../blinkSync';
import { reorderDragHandlers } from '../dropIngestion';
import { dotClass } from './chipState';
import { usePortalMenu } from './portalMenu';
import { IconCopy, IconEject, IconPause, IconPencil, IconPlay, IconStop, IconTrash } from './menuIcons';
import { isWarm } from '../fleetTemperature';

/**
 * The chip's status dot. A separate component so the busy pulse can be
 * wall-clock-synchronized via `useBlinkSync` (a hook, so it can't live in the
 * `.map()` over workspaces) — keeping the chip dot in lockstep with the session
 * tab + Sessions-row busy pulses.
 */
function ChipDot({ state, busy, waiting }: { state: WorkspaceState; busy: boolean; waiting: boolean }): JSX.Element {
  const blink = useBlinkSync(busy || waiting);
  return <span className={`${dotClass({ base: `dot ${state}`, busy, waiting })}`} style={blink} />;
}

/** Tooltip describing a reachable workspace's committee opt-in. */
function reachableTitle(w: WorkspaceSummary): string {
  const who =
    w.accessibility?.acceptFrom && w.accessibility.acceptFrom.length > 0
      ? `accepts: ${w.accessibility.acceptFrom.join(', ')}`
      : 'accepts any granted manager';
  const role = w.accessibility?.roleHint ? ` · ${w.accessibility.roleHint}` : '';
  return `Reachable by managers (${who})${role}`;
}

interface Props {
  workspaces: WorkspaceSummary[];
  /**
   * Per-workspace observability summary, keyed by workspace id (ULID).
   * Values are `null` while the IPC poll hasn't returned yet or the
   * workspace has no events ingested. Drives the chip's secondary
   * "active …" / "idle …" line.
   */
  summaries: Record<string, WorkspaceObservabilitySummary | null>;
  /**
   * Per-workspace busy flag (claude actively working, from the PTY title
   * glyph). Drives a "working" indicator on running chips.
   */
  busyByWorkspace: Record<string, boolean>;
  selectedId: string | null;
  backendReady: boolean | null;
  mockMode: boolean;
  onSelect: (id: string) => void;
  onNewWorkspace: () => void;
  /** Open the app Settings dialog (fleet root, etc.). */
  onOpenSettings: () => void;
  /** Open the CloseWorkspaceModal for the given workspace (full close UX). */
  onCloseWorkspace: (workspace: WorkspaceSummary) => void;
  /** Open the EditWorkspaceModal for the given workspace. */
  onEditWorkspace: (workspace: WorkspaceSummary) => void;
  /** Open the WorkspaceModal in Clone mode with this workspace as the source. */
  onCloneWorkspace: (workspace: WorkspaceSummary) => void;
  /** Open the DeleteWorkspaceModal (purge) — distinct from Close (keep state dir). */
  onDeleteWorkspace: (workspace: WorkspaceSummary) => void;
  /** Re-pull workspace:list — called after a chip-menu action mutates state. */
  onRefresh: () => void;
  /** Drag-reorder: move `draggedId` to sit before `targetId` in the strip (#1). */
  onReorderWorkspace: (draggedId: string, targetId: string) => void;
  /** Per-workspace waiting flag: true when the workspace has a session blocked on AskUserQuestion. */
  waitingByWorkspace?: Record<string, boolean>;
}

/**
 * "active 2m ago" / "idle 1h ago" / null when the workspace has no
 * observability data yet. Threshold for active vs idle is 5 minutes —
 * short enough that an attentive session reads as active, long enough
 * that brief pauses (reading a long claude reply, switching windows)
 * don't flip to idle prematurely.
 */
function chipActivityText(s: WorkspaceObservabilitySummary | null | undefined): string | null {
  if (!s || s.lastActiveAt == null) return null;
  const delta = Date.now() - s.lastActiveAt;
  const verb = delta < 5 * 60_000 ? 'active' : 'idle';
  if (delta < 60_000) return `${verb} just now`;
  if (delta < 3_600_000) return `${verb} ${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${verb} ${Math.round(delta / 3_600_000)}h ago`;
  return `${verb} ${Math.round(delta / 86_400_000)}d ago`;
}


function IconGear(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
export function WorkspaceTabStrip({
  workspaces,
  summaries,
  busyByWorkspace,
  waitingByWorkspace = {},
  selectedId,
  backendReady,
  mockMode,
  onSelect,
  onNewWorkspace,
  onOpenSettings,
  onCloseWorkspace,
  onEditWorkspace,
  onCloneWorkspace,
  onDeleteWorkspace,
  onRefresh,
  onReorderWorkspace
}: Props) {
  // Chip ⋮ menu — shared portaled-menu mechanics (right-anchored).
  const { menu, toggle: toggleMenu, close: closeMenu } = usePortalMenu();
  // Id of the chip currently being dragged (for reorder), null when idle.
  const [dragId, setDragId] = useState<string | null>(null);

  // Top strip = the "warm" fleet: running + paused, and unreachable-was-warm
  // (#380). A daemon flap must not make chips vanish mid-session.
  // "stopped" and "deleted" are the "cold" fleet — they live in the
  // workspace modal's Saved list and need a restart (#21).
  const live = workspaces.filter(isWarm);
  const menuWorkspace = menu ? live.find((w) => w.id === menu.id) ?? null : null;

  async function doAction(action: 'start' | 'pause' | 'stop', w: WorkspaceSummary): Promise<void> {
    if (w.state === 'unreachable') return; // defense in depth — no daemon, no action
    closeMenu();
    try {
      if (action === 'start') {
        await window.api.workspace.start(w.id);
      } else if (w.containerId) {
        if (action === 'pause') await window.api.workspace.pause(w.containerId);
        else if (action === 'stop') await window.api.workspace.stop(w.containerId);
      }
    } finally {
      onRefresh();
    }
  }

  return (
    <div className="top-strip">
      <div className="app-name">
        <span className="brand-tile" aria-hidden="true">cf</span>
        <span className="brand-label">
          <span className="title">claude-fleet</span>
          <span className="meta">
            {live.length} workspace{live.length === 1 ? '' : 's'}
          </span>
        </span>
      </div>

      {live.map((w) => {
        // "Busy" = claude actively working in a running workspace (PTY title
        // glyph is a spinner). Drives a pulsing dot + "working…" sub-line.
        const unreachable = w.state === 'unreachable';
        const busy = w.state === 'running' && busyByWorkspace[w.id] === true;
        const waiting = w.state === 'running' && waitingByWorkspace[w.id] === true;
        return (
        <div
          key={w.id}
          className={`ws-chip-group ${w.id === selectedId ? 'active' : ''} ${
            dragId === w.id ? 'dragging' : ''
          } ${unreachable ? 'unreachable' : ''}`}
          style={{ ['--hue' as never]: colorFor(w) }}
          draggable
          {...reorderDragHandlers({
            id: w.id,
            dragId,
            setDragId,
            onReorder: onReorderWorkspace
          })}
        >
          <button
            className="ws-chip"
            onClick={() => onSelect(w.id)}
            title={waiting ? 'Waiting on your input' : busy ? 'Claude is working…' : w.status}
          >
            <ChipDot state={w.state} busy={busy} waiting={waiting} />
            {w.state === 'paused' && (
              <svg
                viewBox="0 0 8 8"
                width="8"
                height="8"
                fill="currentColor"
                aria-hidden="true"
                className="chip-paused-glyph"
              >
                <rect x="1" y="1" width="2" height="6" rx="0.5" />
                <rect x="5" y="1" width="2" height="6" rx="0.5" />
              </svg>
            )}
            {waiting && <span className="chip-wait-glyph" title="Waiting on your input">?</span>}
            <span className="ws-chip-text">
              <span className="name">{w.name}</span>
              {/*
                Always render the sub-line element, even when there's no
                activity text yet. An empty workspace's chip would
                otherwise be one line tall while a workspace with
                observability data would be two lines — the top strip
                ends up with jagged mixed-height chips. The non-breaking
                space (` `) reserves the line's vertical room
                without showing any visible character.
              */}
              <span className={`ws-chip-sub ${busy || waiting ? 'busy' : ''}`}>
                {unreachable
                  ? `unreachable${w.lastKnownState ? \` · was ${w.lastKnownState}\` : ''}`
                  : waiting ? 'needs input' : busy ? 'working…' : chipActivityText(summaries[w.id]) ?? ' '}
              </span>
            </span>
            {(isManager(w) || isReachable(w)) && (
              <span className="ws-chip-roles">
                {isManager(w) && (
                  <ManagerGlyph title={`Manager · controls ${w.control!.canControl!.length} workspace(s)`} />
                )}
                {isReachable(w) && <WifiGlyph title={reachableTitle(w)} />}
              </span>
            )}
          </button>
          {!unreachable && (
            <button
              className="ws-chip-menu-trigger"
              aria-label={`Actions for ${w.name}`}
              aria-haspopup="menu"
              aria-expanded={menu?.id === w.id}
              onClick={(e) => {
                e.stopPropagation();
                toggleMenu(e.currentTarget, w.id, 'right');
              }}
              title="Workspace actions"
            >
              ⋮
            </button>
          )}
        </div>
        );
      })}

      <button
        className="btn add-workspace"
        onClick={onNewWorkspace}
        disabled={backendReady === false}
        aria-label="Add workspace"
        title={
          backendReady === false
            ? 'Docker daemon unreachable'
            : 'Add a workspace — create a new one or resume a saved one'
        }
      >
        +
      </button>

      <div className="top-strip-actions">
        {mockMode && (
          <span className="mock-chip" title="CLAUDE_FLEET_MOCK=1 — Docker + PTY are simulated">
            MOCK MODE
          </span>
        )}
        <button
          className="icon-btn settings-btn"
          onClick={onOpenSettings}
          title="Settings"
          aria-label="Settings"
        >
          <IconGear />
        </button>
        <span
          className="daemon-status"
          title={
            backendReady === false
              ? 'No Docker daemon available — start Docker Desktop'
              : 'Docker daemon reachable'
          }
        >
          <span className={`dot ${backendReady === false ? 'unreachable' : ''}`} />
          Docker
        </span>
      </div>

      {menu && menuWorkspace &&
        createPortal(
          <div
            className="ws-chip-menu"
            role="menu"
            style={{ position: 'fixed', top: menu.top, right: menu.right }}
            onClick={(e) => e.stopPropagation()}
          >
            {menuWorkspace.state === 'running' && (
              <>
                {(menuWorkspace.kind !== 'local' || menuWorkspace.launcher?.mode === 'wsl') && (
                  <button role="menuitem" onClick={() => doAction('pause', menuWorkspace)}>
                    <IconPause />
                    <span>Pause</span>
                  </button>
                )}
                <button role="menuitem" onClick={() => doAction('stop', menuWorkspace)}>
                  <IconStop />
                  <span>Stop</span>
                </button>
              </>
            )}
            {menuWorkspace.state === 'paused' && (
              <button role="menuitem" onClick={() => doAction('start', menuWorkspace)}>
                <IconPlay />
                <span>Resume</span>
              </button>
            )}
            {menuWorkspace.state === 'stopped' && (
              <button role="menuitem" onClick={() => doAction('start', menuWorkspace)}>
                <IconPlay />
                <span>Start</span>
              </button>
            )}
            <div className="ws-chip-menu-divider" />
            <button
              role="menuitem"
              onClick={() => {
                closeMenu();
                onEditWorkspace(menuWorkspace);
              }}
            >
              <IconPencil />
              <span>Edit…</span>
            </button>
            <button
              role="menuitem"
              onClick={() => {
                closeMenu();
                onCloneWorkspace(menuWorkspace);
              }}
            >
              <IconCopy />
              <span>Clone…</span>
            </button>
            <div className="ws-chip-menu-divider" />
            <button
              role="menuitem"
              className="danger"
              onClick={() => {
                closeMenu();
                onCloseWorkspace(menuWorkspace);
              }}
            >
              <IconEject />
              <span>Close…</span>
            </button>
            <button
              role="menuitem"
              className="danger"
              onClick={() => {
                closeMenu();
                onDeleteWorkspace(menuWorkspace);
              }}
              title="Permanently delete (purges state dir + keychain entries)"
            >
              <IconTrash />
              <span>Delete…</span>
            </button>
          </div>,
          document.body
        )}
    </div>
  );
}
