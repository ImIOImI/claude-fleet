// Left rail (#16-followup): an accordion holding the Sessions list and the
// Loadout Library as independently-collapsible sections. Replaces the bare
// SessionsPane in the left grid column; open/closed state persists.

import { useState } from 'react';
import { SessionsPane } from './SessionsPane';
import { LibraryPane } from './LibraryPane';
import { CommitteePane } from './CommitteePane';
import type { WorkspaceSummary } from '../App';
import type { SessionListItem } from '../../../preload';

interface Props {
  workspaces: WorkspaceSummary[];
  selectedWorkspaceId: string | null;
  selectedWorkspace: WorkspaceSummary | null;
  onResume: (item: SessionListItem) => void;
  /** Refresh workspaces (installed-loadout state). */
  onChanged: () => void;
  /** A loadout was installed into this workspace — App may auto-reload it (#16). */
  onLoadoutInstalled?: (workspaceId: string) => void;
  /** Whether the rail is minimized to a thin reopen strip (#4). */
  collapsed: boolean;
  /** Toggle the collapsed state (persisted by App.tsx). */
  onToggleCollapse: () => void;
}

interface OpenState {
  sessions: boolean;
  library: boolean;
  committee: boolean;
}

function loadOpen(): OpenState {
  try {
    const v = JSON.parse(localStorage.getItem('leftRailOpen') ?? '');
    if (v && typeof v.sessions === 'boolean' && typeof v.library === 'boolean') {
      // `committee` (#118) was added later — default it on for older saved state.
      return { committee: typeof v.committee === 'boolean' ? v.committee : true, ...v };
    }
  } catch {
    /* fall through */
  }
  return { sessions: true, library: true, committee: true };
}

export function LeftRail({
  workspaces,
  selectedWorkspaceId,
  selectedWorkspace,
  onResume,
  onChanged,
  onLoadoutInstalled,
  collapsed,
  onToggleCollapse
}: Props) {
  const [open, setOpen] = useState<OpenState>(loadOpen);
  const toggle = (k: keyof OpenState): void =>
    setOpen((prev) => {
      const next = { ...prev, [k]: !prev[k] };
      localStorage.setItem('leftRailOpen', JSON.stringify(next));
      return next;
    });

  if (collapsed) {
    return (
      <aside className="pane sidebar-left left-rail left-rail-collapsed">
        <button
          type="button"
          className="obs-rail-toggle obs-rail-expand"
          onClick={onToggleCollapse}
          title="Show sessions & library"
          aria-label="Show sessions & library"
        >
          ›
        </button>
      </aside>
    );
  }

  return (
    <aside className="pane sidebar-left left-rail">
      <div className="left-rail-head">
        <span className="left-rail-title">Fleet</span>
        <button
          type="button"
          className="obs-rail-toggle"
          onClick={onToggleCollapse}
          title="Hide sessions & library"
          aria-label="Hide sessions & library"
        >
          ‹
        </button>
      </div>
      <section className={`acc ${open.sessions ? 'open' : ''}`}>
        <button
          className="acc-header"
          aria-expanded={open.sessions}
          onClick={() => toggle('sessions')}
        >
          <span className={`acc-chev ${open.sessions ? 'open' : ''}`} aria-hidden>
            ▾
          </span>
          <span>Sessions</span>
        </button>
        {open.sessions && (
          <SessionsPane
            embedded
            workspaces={workspaces}
            selectedWorkspaceId={selectedWorkspaceId}
            onResume={onResume}
          />
        )}
      </section>

      <section className={`acc ${open.library ? 'open' : ''}`}>
        <button
          className="acc-header"
          aria-expanded={open.library}
          onClick={() => toggle('library')}
        >
          <span className={`acc-chev ${open.library ? 'open' : ''}`} aria-hidden>
            ▾
          </span>
          <span>Library</span>
        </button>
        {open.library && (
          <LibraryPane
            selectedWorkspace={selectedWorkspace}
            onChanged={onChanged}
            onInstalled={onLoadoutInstalled}
          />
        )}
      </section>

      <section className={`acc ${open.committee ? 'open' : ''}`}>
        <button
          className="acc-header"
          aria-expanded={open.committee}
          onClick={() => toggle('committee')}
        >
          <span className={`acc-chev ${open.committee ? 'open' : ''}`} aria-hidden>
            ▾
          </span>
          <span>Committee</span>
        </button>
        {open.committee && (
          <CommitteePane
            selectedWorkspace={selectedWorkspace}
            workspaces={workspaces}
            onChanged={onChanged}
          />
        )}
      </section>
    </aside>
  );
}
