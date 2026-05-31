// Unified workspace modal — tabbed shell with Saved + New tabs.
//
// Replaces the legacy `CreateWorkspaceModal` (past-workspaces list + create
// form in a single scroll). The Saved tab is the canonical surface for
// resuming a stopped workspace: each row expands inline into the same
// `WorkspaceForm` the New tab renders, just with mode='edit' and the
// workspace's persisted spec pre-filled. The Resume action writes the
// (possibly edited) manifest back and starts the container.
//
// Variant-B label search (text input matches name + description + labels
// dropdown checkbox list of fleet-wide labels, OR-filter) lives at the
// top of the Saved tab. Active filters surface as removable pills below
// the bar plus a "N of M" count on the far right.

import { useEffect, useMemo, useRef, useState } from 'react';
import { ulid } from 'ulid';
import { colorFor, type WorkspaceSummary } from '../App';
import {
  WorkspaceForm,
  type WorkspaceFormSubmit
} from './WorkspaceForm';

interface Props {
  open: boolean;
  workspaces: WorkspaceSummary[];
  vaultAvailable: boolean | null;
  onClose: () => void;
  onCreate: (submit: WorkspaceFormSubmit, setStatus: (msg: string | null) => void) => Promise<void>;
  onResume: (submit: WorkspaceFormSubmit, setStatus: (msg: string | null) => void) => Promise<void>;
}

type TabKey = 'saved' | 'new';

function relativeTime(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 60_000) return 'just now';
  const m = Math.floor(delta / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  return `${mo}mo ago`;
}

export function WorkspaceModal({
  open,
  workspaces,
  vaultAvailable,
  onClose,
  onCreate,
  onResume
}: Props) {
  // Saved tab shows non-running workspaces (stopped + paused + deleted).
  // Running workspaces are edited from the chip ⋮ menu in PR-B.
  const saved = useMemo(
    () => workspaces.filter((w) => w.state !== 'running'),
    [workspaces]
  );

  // Default tab: Saved when there are saved workspaces, else New.
  // Re-pick the default each time the modal opens so an emptied-out Saved
  // tab doesn't keep showing as the default after every row was started.
  const [tab, setTab] = useState<TabKey>(saved.length > 0 ? 'saved' : 'new');
  const lastOpen = useRef(open);
  useEffect(() => {
    if (open && !lastOpen.current) {
      setTab(saved.length > 0 ? 'saved' : 'new');
    }
    lastOpen.current = open;
  }, [open, saved.length]);

  // Search state — Saved tab only.
  const [searchText, setSearchText] = useState('');
  const [selectedLabels, setSelectedLabels] = useState<string[]>([]);
  const [labelsDropdownOpen, setLabelsDropdownOpen] = useState(false);

  // Inline-expanded row.
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Build fleet-wide label list (every saved + live workspace) with usage counts.
  const labelCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const w of workspaces) {
      for (const l of w.labels ?? []) counts.set(l, (counts.get(l) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [workspaces]);

  // Apply search filter to the saved list.
  const filteredSaved = useMemo(() => {
    const needle = searchText.trim().toLowerCase();
    return saved.filter((w) => {
      if (needle) {
        const hay = `${w.name} ${w.description ?? ''}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      if (selectedLabels.length > 0) {
        const wsLabels = w.labels ?? [];
        // OR semantics — match if any selected label is on the workspace.
        if (!selectedLabels.some((l) => wsLabels.includes(l))) return false;
      }
      return true;
    });
  }, [saved, searchText, selectedLabels]);

  // Close the labels dropdown on outside-click / Escape.
  useEffect(() => {
    if (!labelsDropdownOpen) return;
    const close = (e: MouseEvent | KeyboardEvent): void => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      setLabelsDropdownOpen(false);
    };
    document.addEventListener('click', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', close);
    };
  }, [labelsDropdownOpen]);

  if (!open) return null;

  const toggleLabel = (l: string): void =>
    setSelectedLabels((prev) =>
      prev.includes(l) ? prev.filter((x) => x !== l) : [...prev, l]
    );

  // Create-mode submit. App.handleCreate mints the ULID + writes secrets +
  // calls workspace:create.
  const handleCreate = async (
    submit: WorkspaceFormSubmit,
    setStatus: (msg: string | null) => void
  ): Promise<void> => {
    await onCreate({ ...submit, id: submit.id ?? ulid() }, setStatus);
    onClose();
  };

  // Edit-mode submit (Resume). Parent writes the manifest back and starts
  // the container. Pass-through; modal just closes on success.
  const handleResume = async (
    submit: WorkspaceFormSubmit,
    setStatus: (msg: string | null) => void
  ): Promise<void> => {
    await onResume(submit, setStatus);
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-tabbed" onClick={(e) => e.stopPropagation()}>
        <div className="modal-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={tab === 'saved'}
            className={`modal-tab ${tab === 'saved' ? 'active' : ''}`}
            onClick={() => setTab('saved')}
          >
            Saved
            {saved.length > 0 && <span className="modal-tab-count">{saved.length}</span>}
          </button>
          <button
            role="tab"
            aria-selected={tab === 'new'}
            className={`modal-tab ${tab === 'new' ? 'active' : ''}`}
            onClick={() => setTab('new')}
          >
            New
          </button>
        </div>

        {tab === 'saved' ? (
          <div className="saved-tab" role="tabpanel">
            {saved.length === 0 ? (
              <div className="saved-empty">
                <p>No saved workspaces yet.</p>
                <button className="btn primary" onClick={() => setTab('new')}>
                  Create your first
                </button>
              </div>
            ) : (
              <>
                <div className="saved-search">
                  <input
                    type="text"
                    aria-label="Search by name or description"
                    placeholder="Search by name or description…"
                    value={searchText}
                    onChange={(e) => setSearchText(e.target.value)}
                  />
                  <div className="labels-filter">
                    <button
                      type="button"
                      className={`btn labels-button ${selectedLabels.length ? 'active' : ''}`}
                      aria-expanded={labelsDropdownOpen}
                      aria-haspopup="menu"
                      onClick={(e) => {
                        e.stopPropagation();
                        setLabelsDropdownOpen((v) => !v);
                      }}
                      disabled={labelCounts.length === 0}
                      title={labelCounts.length === 0 ? 'No labels in the fleet yet' : 'Filter by labels'}
                    >
                      Labels
                      {selectedLabels.length > 0 && (
                        <span className="labels-count">{selectedLabels.length}</span>
                      )}
                    </button>
                    {labelsDropdownOpen && (
                      <div
                        className="labels-dropdown"
                        role="menu"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {labelCounts.map(([label, count]) => (
                          <label key={label} className="labels-dropdown-row">
                            <input
                              type="checkbox"
                              checked={selectedLabels.includes(label)}
                              onChange={() => toggleLabel(label)}
                            />
                            <span className="labels-dropdown-name">{label}</span>
                            <span className="labels-dropdown-count">{count}</span>
                          </label>
                        ))}
                        {selectedLabels.length > 0 && (
                          <div className="labels-dropdown-footer">
                            <button
                              type="button"
                              className="labels-dropdown-clear"
                              onClick={() => setSelectedLabels([])}
                            >
                              Clear all
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {(selectedLabels.length > 0 || filteredSaved.length !== saved.length) && (
                  <div className="saved-active-filters">
                    {selectedLabels.map((l) => (
                      <span key={l} className="filter-pill">
                        {l}
                        <button
                          type="button"
                          aria-label={`Remove filter ${l}`}
                          onClick={() => toggleLabel(l)}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                    <span className="saved-count">
                      {filteredSaved.length} of {saved.length}
                    </span>
                  </div>
                )}

                <ul className="saved-list">
                  {filteredSaved.map((w) => {
                    const expanded = expandedId === w.id;
                    return (
                      <li
                        key={w.id}
                        className={`saved-row ${expanded ? 'expanded' : ''}`}
                      >
                        <button
                          type="button"
                          className="saved-row-header"
                          aria-expanded={expanded}
                          onClick={() =>
                            setExpandedId((prev) => (prev === w.id ? null : w.id))
                          }
                        >
                          <span
                            className="saved-row-color"
                            style={{ background: colorFor(w) }}
                            aria-hidden="true"
                          />
                          <span className="saved-row-text">
                            <span className="saved-row-name">{w.name}</span>
                            {w.description && (
                              <span className="saved-row-desc">{w.description}</span>
                            )}
                          </span>
                          <span className="saved-row-meta">
                            <span className={`ws-state ${w.state}`}>{w.state}</span>
                            <span className="saved-row-when">{relativeTime(w.lastUsedAt)}</span>
                          </span>
                          <span
                            className={`saved-row-chevron ${expanded ? 'open' : ''}`}
                            aria-hidden="true"
                          >
                            ▾
                          </span>
                        </button>
                        <div className={`saved-row-body ${expanded ? 'open' : ''}`}>
                          <div className="saved-row-body-inner">
                            {expanded && (
                              <WorkspaceForm
                                mode="edit"
                                initial={savedToInitial(w)}
                                workspaces={workspaces}
                                vaultAvailable={vaultAvailable}
                                onSubmit={handleResume}
                                onCancel={() => setExpandedId(null)}
                              />
                            )}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </div>
        ) : (
          <div className="new-tab" role="tabpanel">
            <WorkspaceForm
              mode="create"
              workspaces={workspaces}
              vaultAvailable={vaultAvailable}
              onSubmit={handleCreate}
              onCancel={onClose}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Map a WorkspaceSummary to the form's initial-value shape. The form's
 * `WorkspaceFormSubmit` type doesn't have a `secretKeys` field (secrets
 * are an output-only concept on submit), but the initial-value reader
 * looks for it via the `as unknown` cast in WorkspaceForm so the edit
 * surface can show pre-existing secret keys with a "•••••" placeholder.
 */
function savedToInitial(w: WorkspaceSummary): Record<string, unknown> {
  return {
    id: w.id,
    name: w.name,
    description: w.description,
    labels: w.labels,
    color: w.color,
    workspaceRoot: w.workspaceRoot,
    workspaceSubdir: w.workspaceSubdir,
    kind: w.kind,
    image: w.image,
    authMode: w.authMode,
    plainEnv: w.env.plain,
    secretKeys: w.env.secretKeys,
    resources: w.resources
  };
}
