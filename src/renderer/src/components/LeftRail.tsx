// Left rail (#16-followup): an accordion holding the Sessions list and the
// Loadout Library as independently-collapsible sections. Replaces the bare
// SessionsPane in the left grid column; open/closed state persists.

import { useState } from 'react';
import { SessionsPane } from './SessionsPane';
import { LibraryPane } from './LibraryPane';
import type { WorkspaceSummary } from '../App';
import type { SessionListItem } from '../../../preload';

interface Props {
  workspaces: WorkspaceSummary[];
  selectedWorkspaceId: string | null;
  selectedWorkspace: WorkspaceSummary | null;
  onResume: (item: SessionListItem) => void;
  /** Refresh workspaces (installed-loadout state). */
  onChanged: () => void;
  onNeedsRestart: (workspaceId: string) => void;
}

interface OpenState {
  sessions: boolean;
  library: boolean;
}

function loadOpen(): OpenState {
  try {
    const v = JSON.parse(localStorage.getItem('leftRailOpen') ?? '');
    if (v && typeof v.sessions === 'boolean' && typeof v.library === 'boolean') return v;
  } catch {
    /* fall through */
  }
  return { sessions: true, library: true };
}

export function LeftRail({
  workspaces,
  selectedWorkspaceId,
  selectedWorkspace,
  onResume,
  onChanged,
  onNeedsRestart
}: Props) {
  const [open, setOpen] = useState<OpenState>(loadOpen);
  const toggle = (k: keyof OpenState): void =>
    setOpen((prev) => {
      const next = { ...prev, [k]: !prev[k] };
      localStorage.setItem('leftRailOpen', JSON.stringify(next));
      return next;
    });

  return (
    <aside className="pane sidebar-left left-rail">
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
            onNeedsRestart={onNeedsRestart}
          />
        )}
      </section>
    </aside>
  );
}
