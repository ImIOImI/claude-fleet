import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { WorkspaceObservabilitySummary } from '../../../preload';
import type { WorkspaceSummary } from '../App';

interface Props {
  workspaces: WorkspaceSummary[];
  /** Per-workspace observability summary, keyed by name. Optional values when no data yet. */
  summaries: Record<string, WorkspaceObservabilitySummary | null>;
  selectedId: string | null;
  backendReady: boolean | null;
  vaultAvailable: boolean | null;
  mockMode: boolean;
  onSelect: (id: string) => void;
  onNewWorkspace: () => void;
  onOpenProfiles: () => void;
  /** Open the CloseWorkspaceModal for the given workspace (full close UX). */
  onCloseWorkspace: (workspace: WorkspaceSummary) => void;
  /** Re-pull workspace:list — called after a chip-menu action mutates state. */
  onRefresh: () => void;
}

/** "active 2m ago" / "idle 1h ago" / null when no events. */
function chipActivityText(s: WorkspaceObservabilitySummary | null | undefined): string | null {
  if (!s || s.lastActiveAt == null) return null;
  const delta = Date.now() - s.lastActiveAt;
  const verb = delta < 5 * 60_000 ? 'active' : 'idle';
  if (delta < 60_000) return `${verb} just now`;
  if (delta < 3_600_000) return `${verb} ${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${verb} ${Math.round(delta / 3_600_000)}h ago`;
  return `${verb} ${Math.round(delta / 86_400_000)}d ago`;
}

// Deterministic hue assignment by workspace name. Six rotating CSS vars
// defined in styles.css — same name always gets the same color, no random
// churn between renders.
function hueFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `var(--hue-${(h % 6) + 1})`;
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
  vaultAvailable,
  mockMode,
  onSelect,
  onNewWorkspace,
  onOpenProfiles,
  onCloseWorkspace,
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
        await window.api.workspace.start(w.name);
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
        claude-fleet
        <span className="meta">
          {live.length} workspace{live.length === 1 ? '' : 's'}
        </span>
      </div>

      {live.map((w) => (
        <div
          key={w.id}
          className={`ws-chip-group ${w.id === selectedId ? 'active' : ''}`}
          style={{ ['--hue' as never]: hueFor(w.name) }}
        >
          <button
            className="ws-chip"
            onClick={() => onSelect(w.id)}
            title={w.status}
          >
            <span className={`dot ${w.state}`} />
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
              {(() => {
                const sub = chipActivityText(summaries[w.name]);
                return sub ? <span className="ws-chip-sub">{sub}</span> : null;
              })()}
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
      ))}

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
        <span className="daemon-status">
          <span className={`dot ${backendReady === false ? 'unreachable' : ''}`} />
          {backendReady === false ? 'disconnected' : 'docker'}
        </span>
        {vaultAvailable !== false && (
          <button className="btn" onClick={onOpenProfiles}>
            Profiles…
          </button>
        )}
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
              className="danger"
              onClick={() => {
                setMenu(null);
                onCloseWorkspace(menuWorkspace);
              }}
            >
              <IconEject />
              <span>Close…</span>
            </button>
          </div>,
          document.body
        )}
    </div>
  );
}
