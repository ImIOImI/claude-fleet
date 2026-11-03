// Full-catalog browse modal (#16 Phase 1). Facet sidebar (tag cloud + search)
// + results list with install / favorite actions. Phase 2 adds source
// checkboxes and the Update ↑ affordance; #444 adds private-source tokens
// (token prompt on a needs-credential add, 🔒 badge, Change/Remove token).

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { WorkspaceSummary } from '../App';
import { ModalBackdrop } from './ModalBackdrop';
import { Markdown } from './Markdown';
import { parseSourceError, SOURCE_PRIVATE_PROMPT } from '../sourceErrors';

type Entry = Awaited<ReturnType<typeof window.api.loadouts.catalog>>[number];
type SourceInfo = Awaited<ReturnType<typeof window.api.loadouts.listSources>>[number];

const shortBase = (s: string): string => s.replace(/^ghcr\.io\//, '');

interface Props {
  workspace: WorkspaceSummary | null;
  onClose: () => void;
  onChanged: () => void;
}

export default function LoadoutBrowserModal({ workspace, onClose, onChanged }: Props): React.JSX.Element {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [query, setQuery] = useState('');
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [selectedSources, setSelectedSources] = useState<string[]>([]);
  const [addingSource, setAddingSource] = useState('');
  const [sourceError, setSourceError] = useState<string | null>(null);
  // Token prompt (#444): 'add' after a needs-credential add, 'change' from a row.
  const [credPrompt, setCredPrompt] = useState<{ base: string; mode: 'add' | 'change' } | null>(null);
  const [credToken, setCredToken] = useState('');
  const [credUser, setCredUser] = useState('');
  const [credError, setCredError] = useState<string | null>(null);

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

  const closeCred = (): void => {
    setCredPrompt(null);
    setCredToken('');
    setCredUser('');
    setCredError(null);
  };

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
      const e = parseSourceError(err);
      if (e.kind === 'needs-credential') {
        closeCred();
        setCredPrompt({ base, mode: 'add' });
        return;
      }
      setSourceError(e.message);
    }
  };

  const submitCredential = async (): Promise<void> => {
    if (!credPrompt || !credToken.trim()) return;
    setCredError(null);
    const cred = credUser.trim() ? { token: credToken, username: credUser.trim() } : { token: credToken };
    try {
      if (credPrompt.mode === 'add') await window.api.loadouts.addSource(credPrompt.base, cred);
      else await window.api.loadouts.setSourceCredential(credPrompt.base, cred);
      if (credPrompt.mode === 'add') setAddingSource('');
      closeCred();
      await reloadSources();
      await reload();
    } catch (err) {
      setCredError(parseSourceError(err).message);
    }
  };

  const removeToken = async (base: string): Promise<void> => {
    setSourceError(null);
    try {
      await window.api.loadouts.setSourceCredential(base, null);
    } catch (err) {
      // A private source that now has no token just stops listing; that's expected.
      const e = parseSourceError(err);
      if (e.kind !== 'needs-credential') setSourceError(e.message);
    }
    await reloadSources();
    await reload();
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
    <ModalBackdrop onClose={onClose}>
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
                <div key={s.base} className="lb-source-item">
                  <label className="lb-source-row" title={s.base}>
                    <input
                      type="checkbox"
                      checked={selectedSources.includes(s.base)}
                      onChange={() =>
                        setSelectedSources((p) => (p.includes(s.base) ? p.filter((x) => x !== s.base) : [...p, s.base]))
                      }
                    />
                    <span className="lb-source-name">{shortBase(s.base)}</span>
                    {s.hasCredential && (
                      <span className="lb-source-lock" title="Has a token" aria-label="Has a token">🔒</span>
                    )}
                    <button
                      type="button"
                      className="lb-source-remove"
                      aria-label={`Remove ${s.base}`}
                      onClick={async (ev) => {
                        ev.stopPropagation();
                        ev.preventDefault();
                        await window.api.loadouts.removeSource(s.base);
                        await reloadSources();
                        await reload();
                      }}
                    >
                      ×
                    </button>
                  </label>
                  {s.hasCredential && (
                    <div className="lb-source-cred-actions">
                      <button
                        type="button"
                        onClick={() => {
                          closeCred();
                          setCredUser(s.username ?? '');
                          setCredPrompt({ base: s.base, mode: 'change' });
                        }}
                      >
                        Change token…
                      </button>
                      <button type="button" onClick={() => void removeToken(s.base)}>
                        Remove token
                      </button>
                    </div>
                  )}
                </div>
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
              {credPrompt && (
                <form
                  className="lb-cred"
                  onSubmit={(ev) => {
                    ev.preventDefault();
                    void submitCredential();
                  }}
                >
                  <div className="lb-cred-head">
                    {credPrompt.mode === 'add' ? SOURCE_PRIVATE_PROMPT : `Change token for ${shortBase(credPrompt.base)}:`}
                  </div>
                  <input
                    type="password"
                    aria-label="Source token"
                    placeholder="Token"
                    autoComplete="off"
                    value={credToken}
                    onChange={(e) => setCredToken(e.target.value)}
                  />
                  <input
                    aria-label="Source username (optional)"
                    placeholder="Username (optional)"
                    autoComplete="off"
                    value={credUser}
                    onChange={(e) => setCredUser(e.target.value)}
                  />
                  <div className="lb-cred-actions">
                    <button type="submit" className="btn btn-sm primary" disabled={!credToken.trim()}>
                      Save token
                    </button>
                    <button type="button" className="btn btn-sm" onClick={closeCred}>
                      Cancel
                    </button>
                  </div>
                  {credError && <div className="lb-source-error">{credError}</div>}
                </form>
              )}
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
                  {e.description && <span className="lb-row-desc"><Markdown text={e.description} inline /></span>}
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
    </ModalBackdrop>
  );
}
