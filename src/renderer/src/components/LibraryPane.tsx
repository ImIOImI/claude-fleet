// Loadout Library pane (#16-followup) — the body of the left-rail "Library"
// accordion section. Browse / search / tag-filter loadouts and install them
// into the selected workspace. Clicking a card opens the review modal; an
// installed card offers a ⋮ → Uninstall shortcut.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { WorkspaceSummary } from '../App';
import { LoadoutReviewModal } from './LoadoutReviewModal';

type Entry = Awaited<ReturnType<typeof window.api.loadouts.catalog>>[number];

/** localStorage key for the set of collapsed loadout ids (default: expanded). */
const COLLAPSE_KEY = 'loadoutLibraryCollapsed';

interface Props {
  selectedWorkspace: WorkspaceSummary | null;
  /** Refresh the workspace list so installed-state updates. */
  onChanged: () => void;
  /** A loadout finished installing into this workspace (#16 auto-reload). */
  onInstalled?: (workspaceId: string) => void;
  /** Open the browse-all / OCI registry browser (wired in Task 6). */
  onBrowse?: () => void;
}

export function LibraryPane({ selectedWorkspace, onChanged, onInstalled, onBrowse }: Props) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [query, setQuery] = useState('');
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [tagMenu, setTagMenu] = useState(false);
  const [favOnly, setFavOnly] = useState(false);
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

  const reload = useCallback(async () => {
    try {
      setEntries(await window.api.loadouts.catalog(selectedWorkspace?.id));
    } catch {
      setEntries([]);
    }
  }, [selectedWorkspace?.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const installedIds = useMemo(
    () => new Set(entries.filter((e) => e.installed).map((e) => e.id)),
    [entries]
  );
  const installable =
    !!selectedWorkspace &&
    selectedWorkspace.kind === 'container' &&
    (selectedWorkspace.state === 'running' || selectedWorkspace.state === 'paused') &&
    !!selectedWorkspace.containerId;

  const allTags = useMemo(() => {
    const c = new Map<string, number>();
    for (const e of entries) for (const t of e.tags) c.set(t, (c.get(t) ?? 0) + 1);
    return [...c.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [entries]);

  const toggleTag = (t: string): void =>
    setActiveTags((p) => (p.includes(t) ? p.filter((x) => x !== t) : [...p, t]));

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((e) => {
      if (favOnly && !e.favorited) return false;
      const matchesQ =
        !q || e.title.toLowerCase().includes(q) || e.description.toLowerCase().includes(q);
      const matchesTags = activeTags.length === 0 || activeTags.some((t) => e.tags.includes(t));
      return matchesQ && matchesTags;
    });
  }, [entries, query, activeTags, favOnly]);

  // Header toggle, scoped to the visible (filtered) cards: collapse them all
  // when most are open, otherwise expand them all.
  const visibleIds = filtered.map((e) => e.id);
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
    void reload();
  };
  const doUninstall = async (id: string): Promise<void> => {
    if (!selectedWorkspace) return;
    await window.api.loadouts.uninstall(selectedWorkspace.id, id);
    onChanged();
    void reload();
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
        <button type="button" className="btn btn-sm lib-browse" onClick={() => onBrowse?.()}>
          Browse all
        </button>
      </div>

      <div className="library-filter">
        <button
          className={`tag-dd ${tagMenu ? 'open' : ''}`}
          onClick={() => setTagMenu((o) => !o)}
          disabled={allTags.length === 0}
        >
          Tags ▾
        </button>
        <button
          type="button"
          className={`fav-filter ${favOnly ? 'on' : ''}`}
          aria-pressed={favOnly}
          title="Show favorites only"
          onClick={() => setFavOnly((v) => !v)}
        >
          {favOnly ? '★' : '☆'}
        </button>
        {activeTags.map((t) => (
          <button key={t} className="pill" onClick={() => toggleTag(t)} title="Remove filter">
            {t} ✕
          </button>
        ))}
        <span className="nofm">
          {filtered.length} of {entries.length}
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
        {filtered.map((e) => {
          const inst = installedIds.has(e.id);
          const isCollapsed = collapsed.has(e.id);
          return (
            <div
              key={e.id}
              className={`loadout-card ${inst ? 'installed' : ''} ${isCollapsed ? 'collapsed' : ''}`}
              onClick={() => setReviewId(e.id)}
            >
              <div className="lc-top">
                <div className="lc-title">
                  <button
                    type="button"
                    className="lc-chevron"
                    aria-label={isCollapsed ? `Expand ${e.title}` : `Collapse ${e.title}`}
                    aria-expanded={!isCollapsed}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      toggleCollapse(e.id);
                    }}
                  >
                    <ChevronIcon />
                  </button>
                  <span className="lc-title-text">{e.title}</span>
                </div>
                <div className="lc-actions" onClick={(ev) => ev.stopPropagation()}>
                  {inst ? (
                    <>
                      <button className="btn installed btn-sm" onClick={() => setReviewId(e.id)}>
                        ✓ Installed
                      </button>
                      {e.updateAvailable && (
                        <button
                          className="btn update btn-sm"
                          title={`Update to ${e.remoteVersion}`}
                          disabled={!installable}
                          onClick={async () => {
                            const source = e.sources[0];
                            if (!source) return;
                            await window.api.loadouts.install(selectedWorkspace!.id, e.id, {
                              source,
                              version: e.remoteVersion,
                              force: true,
                            });
                            onChanged();
                            void reload();
                          }}
                        >
                          Update ↑
                        </button>
                      )}
                      <button
                        className="lc-menu-trigger"
                        aria-label="Loadout actions"
                        onClick={() => setMenuId((m) => (m === e.id ? null : e.id))}
                      >
                        ⋮
                      </button>
                      {menuId === e.id && (
                        <div className="lc-menu" onMouseLeave={() => setMenuId(null)}>
                          <button
                            onClick={() => {
                              setMenuId(null);
                              setReviewId(e.id);
                            }}
                          >
                            Review
                          </button>
                          <button
                            className="danger"
                            onClick={() => {
                              setMenuId(null);
                              void doUninstall(e.id);
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
                      onClick={() => void doInstall(e.id)}
                    >
                      + Install
                    </button>
                  )}
                </div>
              </div>
              {!isCollapsed && e.description && <div className="lc-desc">{e.description}</div>}
              {!isCollapsed && e.tags.length > 0 && (
                <div className="tags">
                  {e.tags.map((t) => (
                    <span className="tag" key={t}>
                      {t}
                    </span>
                  ))}
                </div>
              )}
              {!isCollapsed && (
                <button
                  type="button"
                  className={`lc-fav ${e.favorited ? 'on' : ''}`}
                  onClick={async (ev) => {
                    ev.stopPropagation();
                    await window.api.loadouts.setFavorite(e.id, !e.favorited);
                    void reload();
                  }}
                >
                  {e.favorited ? '★ Favorited' : '☆ Favorite'}
                </button>
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
            void reload();
          }}
          onUninstalled={() => {
            onChanged();
            void reload();
          }}
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
