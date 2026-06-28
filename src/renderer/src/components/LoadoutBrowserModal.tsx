// Full-catalog browse modal (#16 Phase 1). Facet sidebar (tag cloud + search)
// + results list with install / favorite actions. Phase 2 will add source
// checkboxes and the Update ↑ affordance — those are deliberately omitted here.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { WorkspaceSummary } from '../App';

type Entry = Awaited<ReturnType<typeof window.api.loadouts.catalog>>[number];

interface Props {
  workspace: WorkspaceSummary | null;
  onClose: () => void;
  onChanged: () => void;
}

export default function LoadoutBrowserModal({ workspace, onClose, onChanged }: Props): React.JSX.Element {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [query, setQuery] = useState('');
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const installable =
    !!workspace &&
    workspace.kind === 'container' &&
    (workspace.state === 'running' || workspace.state === 'paused') &&
    !!workspace.containerId;

  const reload = useCallback(async () => {
    setEntries(await window.api.loadouts.catalog(workspace?.id));
  }, [workspace?.id]);
  useEffect(() => { void reload(); }, [reload]);

  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) for (const t of e.tags) set.add(t);
    return [...set].sort();
  }, [entries]);

  const filtered = entries.filter((e) => {
    if (activeTags.length && !activeTags.every((t) => e.tags.includes(t))) return false;
    if (query && !`${e.title} ${e.description}`.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  });

  const toggleTag = (t: string): void =>
    setActiveTags((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));

  const onInstall = async (id: string): Promise<void> => {
    if (!workspace) return;
    await window.api.loadouts.install(workspace.id, id);
    onChanged();
    void reload();
  };
  const onFav = async (e: Entry): Promise<void> => {
    await window.api.loadouts.setFavorite(e.id, !e.favorited);
    void reload();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal loadout-browser" onClick={(ev) => ev.stopPropagation()}>
        <div className="lb-head">
          <span className="eyebrow">Loadouts · browse</span>
          <button className="btn btn-sm" onClick={onClose}>Close</button>
        </div>
        <div className="lb-body">
          <aside className="lb-facets">
            <input
              className="lb-search"
              placeholder="Search loadouts…"
              value={query}
              onChange={(ev) => setQuery(ev.target.value)}
            />
            <div className="lb-tagcloud">
              {allTags.map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`lb-tag ${activeTags.includes(t) ? 'on' : ''}`}
                  onClick={() => toggleTag(t)}
                >
                  {t}
                </button>
              ))}
            </div>
          </aside>
          <ul className="lb-results">
            {filtered.map((e) => (
              <li key={e.id} className="lb-row">
                <div className="lb-row-main">
                  <span className="lb-row-title">{e.title}</span>
                  {e.tags.length > 0 && (
                    <span className="tags">
                      {e.tags.map((t) => <span className="tag" key={t}>{t}</span>)}
                    </span>
                  )}
                  {e.description && <span className="lb-row-desc">{e.description}</span>}
                </div>
                <div className="lb-row-actions">
                  <button
                    type="button"
                    className={`lc-fav ${e.favorited ? 'on' : ''}`}
                    title="Favorite"
                    onClick={() => void onFav(e)}
                  >
                    {e.favorited ? '★' : '☆'}
                  </button>
                  {e.installed ? (
                    <button className="btn installed btn-sm" disabled>✓ Installed</button>
                  ) : (
                    <button
                      className="btn primary btn-sm"
                      disabled={!installable}
                      onClick={() => void onInstall(e.id)}
                    >
                      + Install
                    </button>
                  )}
                </div>
              </li>
            ))}
            {filtered.length === 0 && <li className="lb-empty">No loadouts match.</li>}
          </ul>
        </div>
      </div>
    </div>
  );
}
