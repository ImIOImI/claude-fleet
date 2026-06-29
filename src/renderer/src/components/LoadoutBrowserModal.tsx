// Full-catalog browse modal (#16 Phase 1). Facet sidebar (tag cloud + search)
// + results list with install / favorite actions. Phase 2 adds source
// checkboxes (Task 5) and the Update ↑ affordance (Task 6).

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
  const [sources, setSources] = useState<string[]>([]);
  const [selectedSources, setSelectedSources] = useState<string[]>([]);
  const [addingSource, setAddingSource] = useState('');
  const [sourceError, setSourceError] = useState<string | null>(null);

  const installable =
    !!workspace &&
    workspace.kind === 'container' &&
    (workspace.state === 'running' || workspace.state === 'paused') &&
    !!workspace.containerId;

  const reload = useCallback(async () => {
    setEntries(await window.api.loadouts.catalog(workspace?.id));
  }, [workspace?.id]);
  useEffect(() => { void reload(); }, [reload]);

  const reloadSources = useCallback(async () => {
    setSources(await window.api.loadouts.listSources());
  }, []);
  useEffect(() => { void reloadSources(); }, [reloadSources]);

  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) for (const t of e.tags) set.add(t);
    return [...set].sort();
  }, [entries]);

  const filtered = entries.filter((e) => {
    if (selectedSources.length && !e.present && !e.sources.some((s) => selectedSources.includes(s))) return false;
    if (activeTags.length && !activeTags.every((t) => e.tags.includes(t))) return false;
    if (query && !`${e.title} ${e.description}`.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  });

  const toggleTag = (t: string): void =>
    setActiveTags((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));

  const addSource = async (): Promise<void> => {
    const base = addingSource.trim();
    if (!base) return;
    setSourceError(null);
    try {
      await window.api.loadouts.addSource(base);
      setAddingSource('');
      await reloadSources();
      await reload();
    } catch (err) {
      setSourceError((err as Error).message);
    }
  };

  const onInstall = async (e: Entry): Promise<void> => {
    if (!workspace) return;
    const source = e.sources[0];
    const r = await window.api.loadouts.install(workspace.id, e.id, source ? { source, version: e.remoteVersion } : undefined);
    if (r && (r as { status?: string }).status === 'needs-confirm') {
      if (!window.confirm(`"${e.id}" already exists locally. Overwrite with the downloaded copy?`)) return;
      if (!source) return;
      await window.api.loadouts.install(workspace.id, e.id, { source, version: e.remoteVersion, force: true });
    }
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
            <div className="lb-sources">
              <div className="lb-sources-head">Sources</div>
              {sources.map((s) => (
                <label key={s} className="lb-source-row" title={s}>
                  <input
                    type="checkbox"
                    checked={selectedSources.includes(s)}
                    onChange={() =>
                      setSelectedSources((p) => (p.includes(s) ? p.filter((x) => x !== s) : [...p, s]))
                    }
                  />
                  <span className="lb-source-name">{s.replace(/^ghcr\.io\//, '')}</span>
                  <button
                    type="button"
                    className="lb-source-remove"
                    aria-label={`Remove ${s}`}
                    onClick={async (ev) => {
                      ev.stopPropagation();
                      ev.preventDefault();
                      await window.api.loadouts.removeSource(s);
                      await reloadSources();
                      await reload();
                    }}
                  >
                    ×
                  </button>
                </label>
              ))}
              <div className="lb-add-source">
                <input
                  placeholder="ghcr.io/owner/repo"
                  value={addingSource}
                  onChange={(e) => setAddingSource(e.target.value)}
                />
                <button type="button" onClick={() => void addSource()}>+ Add</button>
              </div>
              {sourceError && <div className="lb-source-error">{sourceError}</div>}
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
                      onClick={() => void onInstall(e)}
                    >
                      {e.present ? '+ Install' : '↓ Install'}
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
