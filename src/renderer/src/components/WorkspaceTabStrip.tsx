import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { WorkspaceObservabilitySummary } from '../../../preload';
import { colorFor, type WorkspaceSummary } from '../App';

interface Props {
  workspaces: WorkspaceSummary[];
  /**
   * Per-workspace observability summary, keyed by workspace id (ULID).
   * Values are `null` while the IPC poll hasn't returned yet or the
   * workspace has no events ingested. Drives the chip's secondary
   * "active …" / "idle …" line.
   */
  summaries: Record<string, WorkspaceObservabilitySummary | null>;
  selectedId: string | null;
  backendReady: boolean | null;
  mockMode: boolean;
  onSelect: (id: string) => void;
  onNewWorkspace: () => void;
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
  selectedId,
  backendReady,
  mockMode,
  onSelect,
  onNewWorkspace,
  onCloseWorkspace,
  onEditWorkspace,
  onCloneWorkspace,
  onDeleteWorkspace,
  onRefresh
}: Props) {
  // Single open menu at a time. `for` = workspace id; top/right are
  // viewport coordinates for the portaled menu.
  const [menu, setMenu] = useState<MenuAnchor | null>(null);

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

  // Top strip only shows workspaces that have a live backend (running,
  // paused, or stopped). "deleted" workspaces show up in the new-workspace
  // modal's past-workspaces list instead.
  const live = workspaces.filter((w) => w.state !== 'deleted');
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
        // "Needs input": Claude is waiting on the user (unresolved
        // AskUserQuestion/ExitPlanMode) in a running workspace. Drives a
        // pulsing red pip + danger-toned status line.
        const needsInput = w.state === 'running' && summaries[w.id]?.pendingPrompt === true;
        return (
        <div
          key={w.id}
          className={`ws-chip-group ${w.id === selectedId ? 'active' : ''}`}
          style={{ ['--hue' as never]: colorFor(w) }}
        >
          <button
            className="ws-chip"
            onClick={() => onSelect(w.id)}
            title={needsInput ? 'Claude is waiting for your input' : w.status}
          >
            <span className={`dot ${w.state} ${needsInput ? 'needs-input' : ''}`} />
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
              <span className={`ws-chip-sub ${needsInput ? 'attention' : ''}`}>
                {needsInput ? 'needs your input' : chipActivityText(summaries[w.id]) ?? ' '}
              </span>
            </span>
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
        className="btn"
        onClick={onNewWorkspace}
        disabled={backendReady === false}
        title={
          backendReady === false ? 'Docker daemon unreachable' : 'Create a new workspace'
        }
      >
        + New workspace
      </button>

      <div className="top-strip-actions">
        {mockMode && (
          <span className="mock-chip" title="CLAUDE_FLEET_MOCK=1 — Docker + PTY are simulated">
            MOCK MODE
          </span>
        )}
        <span className={`daemon-status ${backendReady === false ? 'down' : ''}`}>
          <span className={`dot ${backendReady === false ? 'unreachable' : ''}`} />
          {backendReady === false ? 'No daemon' : 'Docker'}
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
