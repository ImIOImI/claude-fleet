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

      <div className="library-cards">
        {filtered.length === 0 && <div className="pane-placeholder subdued">No loadouts match.</div>}
        {filtered.map((l) => {
          const inst = installedIds.has(l.id);
          return (
            <div
              key={l.id}
              className={`loadout-card ${inst ? 'installed' : ''}`}
              onClick={() => setReviewId(l.id)}
            >
              <div className="lc-top">
                <div className="lc-title">{l.title}</div>
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
              {l.description && <div className="lc-desc">{l.description}</div>}
              {l.tags.length > 0 && (
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
