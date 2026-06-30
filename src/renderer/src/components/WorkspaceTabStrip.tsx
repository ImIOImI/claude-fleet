import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { WorkspaceObservabilitySummary } from '../../../preload';
import { colorFor, type WorkspaceState, type WorkspaceSummary } from '../App';
import { isManager, isReachable, ManagerGlyph, WifiGlyph } from './committee';
import { useBlinkSync } from '../blinkSync';
import { setInternalDragActive } from '../dropIngestion';

/**
 * The chip's status dot. A separate component so the busy pulse can be
 * wall-clock-synchronized via `useBlinkSync` (a hook, so it can't live in the
 * `.map()` over workspaces) — keeping the chip dot in lockstep with the session
 * tab + Sessions-row busy pulses.
 */
function ChipDot({ state, busy }: { state: WorkspaceState; busy: boolean }): JSX.Element {
  const blink = useBlinkSync(busy);
  return <span className={`dot ${state} ${busy ? 'busy' : ''}`} style={blink} />;
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


// ── Media-control icons for the menu ─────────────────────────────────
// All sized to a 12×12 viewBox so they sit on the menu's text baseline.
// `currentColor` lets each menu item pick up its hover/danger styling.
function IconPlay(): JSX.Element {
  return (
    <svg viewBox="0 0 12 12" width="11" height="11" fill="currentColor" aria-hidden="true">
      <path d="M3 2 L10 6 L3 10 Z" />
    </svg>
  );
}
function IconPause(): JSX.Element {
  return (
    <svg viewBox="0 0 12 12" width="11" height="11" fill="currentColor" aria-hidden="true">
      <rect x="3" y="2" width="2.4" height="8" rx="0.6" />
      <rect x="6.6" y="2" width="2.4" height="8" rx="0.6" />
    </svg>
  );
}
function IconGear(): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
    </svg>
  );
}
function IconStop(): JSX.Element {
  return (
    <svg viewBox="0 0 12 12" width="11" height="11" fill="currentColor" aria-hidden="true">
      <rect x="2.5" y="2.5" width="7" height="7" rx="0.8" />
    </svg>
  );
}
function IconEject(): JSX.Element {
  // Used for Close — eject is the natural "remove the media" sibling of
  // play/pause/stop, and reads as "take this out" instead of "delete."
  return (
    <svg viewBox="0 0 12 12" width="11" height="11" fill="currentColor" aria-hidden="true">
      <path d="M6 2 L10 8 L2 8 Z" />
      <rect x="2" y="9" width="8" height="1.6" rx="0.4" />
    </svg>
  );
}
function IconEdit(): JSX.Element {
  return (
    <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
      <path d="M2 9 L9 2 L11 4 L4 11 L2 11 Z" />
    </svg>
  );
}
function IconCopy(): JSX.Element {
  return (
    <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
      <rect x="3" y="3" width="7" height="8" rx="0.8" />
      <path d="M2 8 V2 a1 1 0 0 1 1 -1 H8" />
    </svg>
  );
}
function IconTrash(): JSX.Element {
  return (
    <svg viewBox="0 0 12 12" width="11" height="11" fill="currentColor" aria-hidden="true">
      <path d="M4 1 H8 V2 H11 V3 H1 V2 H4 Z M2 4 H10 L9 11 H3 Z" />
    </svg>
  );
}

/**
 * Compute the screen-coordinate position of the menu, anchored to the
 * trigger button's bottom-right corner. Clamps so the menu can't overflow
 * the viewport on the right edge.
 */
function menuPositionFor(triggerEl: HTMLElement): { top: number; right: number } {
  const rect = triggerEl.getBoundingClientRect();
  const right = Math.max(8, window.innerWidth - rect.right);
  const top = rect.bottom + 4;
  return { top, right };
}

interface MenuAnchor {
  for: string;
  top: number;
  right: number;
}

export function WorkspaceTabStrip({
  workspaces,
  summaries,
  busyByWorkspace,
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
  // Single open menu at a time. `for` = workspace id; top/right are
  // viewport coordinates for the portaled menu.
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  // Id of the chip currently being dragged (for reorder), null when idle.
  const [dragId, setDragId] = useState<string | null>(null);

  // Close the menu on any outside click, Escape, or layout disturbance
  // (scroll / resize) — the portal positions the menu in viewport coords,
  // so we can't easily follow the trigger when the page moves.
  useEffect(() => {
    if (menu === null) return;
    const close = (): void => setMenu(null);
    const escClose = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(null);
    };
    document.addEventListener('click', close);
    document.addEventListener('keydown', escClose);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', escClose);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [menu]);

  // Top strip = the "warm" fleet: running + paused only (instant switch).
  // "stopped" and "deleted" are the "cold" fleet — they live in the
  // workspace modal's Saved list and need a restart (#21).
  const live = workspaces.filter((w) => w.state === 'running' || w.state === 'paused');
  const menuWorkspace = menu ? live.find((w) => w.id === menu.for) ?? null : null;

  async function doAction(action: 'start' | 'pause' | 'stop', w: WorkspaceSummary): Promise<void> {
    setMenu(null);
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
        const busy = w.state === 'running' && busyByWorkspace[w.id] === true;
        return (
        <div
          key={w.id}
          className={`ws-chip-group ${w.id === selectedId ? 'active' : ''} ${
            dragId === w.id ? 'dragging' : ''
          }`}
          style={{ ['--hue' as never]: colorFor(w) }}
          draggable
          onDragStart={(e) => {
            setDragId(w.id);
            e.dataTransfer.effectAllowed = 'move';
            // Tell the window-level file-ingestion handlers to stay out of this
            // internal drag — otherwise its dragover forces dropEffect='copy'
            // over our 'move' and cancels the reorder drop (#177).
            setInternalDragActive(true);
          }}
          onDragOver={(e) => {
            if (dragId && dragId !== w.id) e.preventDefault(); // allow drop
          }}
          onDrop={(e) => {
            e.preventDefault();
            if (dragId && dragId !== w.id) onReorderWorkspace(dragId, w.id);
            setDragId(null);
            setInternalDragActive(false);
          }}
          onDragEnd={() => {
            setDragId(null);
            // dragend always fires (drop or cancel), so this is the guaranteed
            // clear; the onDrop clear above just frees it a beat earlier.
            setInternalDragActive(false);
          }}
        >
          <button
            className="ws-chip"
            onClick={() => onSelect(w.id)}
            title={busy ? 'Claude is working…' : w.status}
          >
            <ChipDot state={w.state} busy={busy} />
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
              <span className={`ws-chip-sub ${busy ? 'busy' : ''}`}>
                {busy ? 'working…' : chipActivityText(summaries[w.id]) ?? ' '}
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
          <button
            className="ws-chip-menu-trigger"
            aria-label={`Actions for ${w.name}`}
            aria-haspopup="menu"
            aria-expanded={menu?.for === w.id}
            onClick={(e) => {
              e.stopPropagation();
              if (menu?.for === w.id) {
                setMenu(null);
                return;
              }
              const pos = menuPositionFor(e.currentTarget);
              setMenu({ for: w.id, ...pos });
            }}
            title="Workspace actions"
          >
            ⋮
          </button>
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
                <button role="menuitem" onClick={() => doAction('pause', menuWorkspace)}>
                  <IconPause />
                  <span>Pause</span>
                </button>
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
                setMenu(null);
                onEditWorkspace(menuWorkspace);
              }}
            >
              <IconEdit />
              <span>Edit…</span>
            </button>
            <button
              role="menuitem"
              onClick={() => {
                setMenu(null);
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
                setMenu(null);
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
                setMenu(null);
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
