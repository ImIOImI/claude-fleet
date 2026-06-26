// Loadout Library pane (#16-followup) — the body of the left-rail "Library"
// accordion section. Browse / search / tag-filter loadouts and install them
// into the selected workspace. Clicking a card opens the review modal; an
// installed card offers a ⋮ → Uninstall shortcut.

import { useEffect, useMemo, useState } from 'react';
import type { WorkspaceSummary } from '../App';
import { LoadoutReviewModal } from './LoadoutReviewModal';

interface LoadoutSummary {
  id: string;
  title: string;
  description: string;
  tags: string[];
}

/** localStorage key for the set of collapsed loadout ids (default: expanded). */
const COLLAPSE_KEY = 'loadoutLibraryCollapsed';

interface Props {
  selectedWorkspace: WorkspaceSummary | null;
  /** Refresh the workspace list so installed-state updates. */
  onChanged: () => void;
  /** A loadout finished installing into this workspace (#16 auto-reload). */
  onInstalled?: (workspaceId: string) => void;
}

export function LibraryPane({ selectedWorkspace, onChanged, onInstalled }: Props) {
  const [loadouts, setLoadouts] = useState<LoadoutSummary[]>([]);
  const [query, setQuery] = useState('');
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [tagMenu, setTagMenu] = useState(false);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  // Per-card collapse — cards default expanded; the set holds collapsed ids,
  // persisted to localStorage (a pure UI preference, like the rail-collapse
  // state) so it survives restarts. The chevron toggles one card; the header
  // toggle collapses/expands all currently-visible (filtered) cards.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(COLLAPSE_KEY);
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set();
    }
  });
  const persistCollapsed = (s: Set<string>): void => {
    try {
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...s]));
    } catch {
      /* private mode / quota — preference just won't persist */
    }
  };
  const toggleCollapse = (id: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      persistCollapsed(next);
      return next;
    });

  useEffect(() => {
    window.api.loadouts
      .list()
      .then((l) => setLoadouts(l as LoadoutSummary[]))
      .catch(() => setLoadouts([]));
  }, []);

  const installedIds = useMemo(
    () => new Set((selectedWorkspace?.installedLoadouts ?? []).map((l) => l.id)),
    [selectedWorkspace]
  );
  const installable =
    !!selectedWorkspace &&
    selectedWorkspace.kind === 'container' &&
    (selectedWorkspace.state === 'running' || selectedWorkspace.state === 'paused') &&
    !!selectedWorkspace.containerId;

  const allTags = useMemo(() => {
    const c = new Map<string, number>();
    for (const l of loadouts) for (const t of l.tags) c.set(t, (c.get(t) ?? 0) + 1);
    return [...c.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [loadouts]);

  const toggleTag = (t: string): void =>
    setActiveTags((p) => (p.includes(t) ? p.filter((x) => x !== t) : [...p, t]));

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return loadouts.filter((l) => {
      const matchesQ =
        !q || l.title.toLowerCase().includes(q) || l.description.toLowerCase().includes(q);
      const matchesTags = activeTags.length === 0 || activeTags.some((t) => l.tags.includes(t));
      return matchesQ && matchesTags;
    });
  }, [loadouts, query, activeTags]);

  // Header toggle, scoped to the visible (filtered) cards: collapse them all
  // when most are open, otherwise expand them all.
  const visibleIds = filtered.map((l) => l.id);
  const mostlyExpanded =
    visibleIds.filter((id) => collapsed.has(id)).length <= visibleIds.length / 2;
  const bulkToggle = (): void =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (mostlyExpanded) visibleIds.forEach((id) => next.add(id));
      else visibleIds.forEach((id) => next.delete(id));
      persistCollapsed(next);
      return next;
    });

  const doInstall = async (id: string): Promise<void> => {
    if (!selectedWorkspace || !installable) return;
    await window.api.loadouts.install(selectedWorkspace.id, id);
    onChanged();
    onInstalled?.(selectedWorkspace.id);
  };
  const doUninstall = async (id: string): Promise<void> => {
    if (!selectedWorkspace) return;
    await window.api.loadouts.uninstall(selectedWorkspace.id, id);
    onChanged();
  };

  const note = !installable
    ? !selectedWorkspace
      ? 'Select a workspace to install loadouts.'
      : selectedWorkspace.kind === 'local'
        ? 'Loadouts install into container workspaces only.'
        : 'Start this workspace to install loadouts.'
    : null;

  return (
    <div className="pane-body library-body">
      <div className="search library-search">
        <span aria-hidden>⌕</span>
        <input
          type="search"
          placeholder="Search loadouts…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search loadouts"
        />
      </div>

      <div className="library-filter">
        <button
          className={`tag-dd ${tagMenu ? 'open' : ''}`}
          onClick={() => setTagMenu((o) => !o)}
          disabled={allTags.length === 0}
        >
          Tags ▾
        </button>
        {activeTags.map((t) => (
          <button key={t} className="pill" onClick={() => toggleTag(t)} title="Remove filter">
            {t} ✕
          </button>
        ))}
        <span className="nofm">
          {filtered.length} of {loadouts.length}
        </span>
        {tagMenu && (
          <div className="tag-menu" onMouseLeave={() => setTagMenu(false)}>
            {allTags.map(([t, n]) => (
              <label key={t} className="tag-menu-item">
                <input
                  type="checkbox"
                  checked={activeTags.includes(t)}
                  onChange={() => toggleTag(t)}
                />
                <span>{t}</span>
                <span className="tm-count">{n}</span>
              </label>
            ))}
          </div>
        )}
      </div>

      {note && <div className="library-note">{note}</div>}

      {filtered.length > 1 && (
        <div className="library-bulk">
          <button
            type="button"
            className="lib-bulk-btn"
            onClick={bulkToggle}
            aria-label={mostlyExpanded ? 'Collapse all loadouts' : 'Expand all loadouts'}
          >
            <ChevronIcon />
            {mostlyExpanded ? 'Collapse all' : 'Expand all'}
          </button>
        </div>
      )}

      <div className="library-cards">
        {filtered.length === 0 && <div className="pane-placeholder subdued">No loadouts match.</div>}
        {filtered.map((l) => {
          const inst = installedIds.has(l.id);
          const isCollapsed = collapsed.has(l.id);
          return (
            <div
              key={l.id}
              className={`loadout-card ${inst ? 'installed' : ''} ${isCollapsed ? 'collapsed' : ''}`}
              onClick={() => setReviewId(l.id)}
            >
              <div className="lc-top">
                <div className="lc-title">
                  <button
                    type="button"
                    className="lc-chevron"
                    aria-label={isCollapsed ? `Expand ${l.title}` : `Collapse ${l.title}`}
                    aria-expanded={!isCollapsed}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleCollapse(l.id);
                    }}
                  >
                    <ChevronIcon />
                  </button>
                  <span className="lc-title-text">{l.title}</span>
                </div>
                <div className="lc-actions" onClick={(e) => e.stopPropagation()}>
                  {inst ? (
                    <>
                      <button className="btn installed btn-sm" onClick={() => setReviewId(l.id)}>
                        ✓ Installed
                      </button>
                      <button
                        className="lc-menu-trigger"
                        aria-label="Loadout actions"
                        onClick={() => setMenuId((m) => (m === l.id ? null : l.id))}
                      >
                        ⋮
                      </button>
                      {menuId === l.id && (
                        <div className="lc-menu" onMouseLeave={() => setMenuId(null)}>
                          <button
                            onClick={() => {
                              setMenuId(null);
                              setReviewId(l.id);
                            }}
                          >
                            Review
                          </button>
                          <button
                            className="danger"
                            onClick={() => {
                              setMenuId(null);
                              void doUninstall(l.id);
                            }}
                          >
                            Uninstall
                          </button>
                        </div>
                      )}
                    </>
                  ) : (
                    <button
                      className="btn primary btn-sm"
                      disabled={!installable}
                      onClick={() => void doInstall(l.id)}
                    >
                      + Install
                    </button>
                  )}
                </div>
              </div>
              {!isCollapsed && l.description && <div className="lc-desc">{l.description}</div>}
              {!isCollapsed && l.tags.length > 0 && (
                <div className="tags">
                  {l.tags.map((t) => (
                    <span className="tag" key={t}>
                      {t}
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {reviewId && (
        <LoadoutReviewModal
          loadoutId={reviewId}
          workspaceId={selectedWorkspace?.id ?? null}
          workspaceName={selectedWorkspace?.name ?? null}
          installable={installable}
          installed={installedIds.has(reviewId)}
          onClose={() => setReviewId(null)}
          onInstalled={() => {
            onChanged();
            if (selectedWorkspace) onInstalled?.(selectedWorkspace.id);
          }}
          onUninstalled={onChanged}
        />
      )}
    </div>
  );
}

/** Disclosure chevron — points down when expanded, rotated to point right when
 *  collapsed (via the `.collapsed` parent / `.lib-bulk-btn` CSS). */
function ChevronIcon() {
  return (
    <svg
      className="lc-chevron-svg"
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}
