// Settings → Vault: every vault key, its root value and per-workspace lines.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { VaultEntry } from '../../../preload/vaultTypes';
import { allTags, filterEntries, groupEntries } from '../vaultView';
import { VaultKeyForm, type VaultKeySubmit } from './VaultKeyForm';
import { VaultKeyRow } from './VaultKeyRow';

type Kind = 'container' | 'local' | 'remote';

interface Props {
  workspaces: { id: string; name: string; kind: Kind }[];
  focusKey?: string;
}

function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

export function VaultSettings({ workspaces, focusKey }: Props) {
  const vault = window.api.vault;
  const [entries, setEntries] = useState<VaultEntry[] | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const focused = useRef(false);

  const names = useMemo(() => Object.fromEntries(workspaces.map((w) => [w.id, w.name])), [workspaces]);
  const kinds = useMemo(() => Object.fromEntries(workspaces.map((w) => [w.id, w.kind])) as Record<string, Kind>, [workspaces]);

  const reload = useCallback(async () => {
    try {
      setEntries(await vault.list());
    } catch (err) {
      setError(errorText(err));
    }
  }, [vault]);

  useEffect(() => {
    vault.available().then(setAvailable, () => setAvailable(false));
    void reload();
  }, [vault, reload]);

  useEffect(() => {
    if (!entries || !focusKey || focused.current) return;
    focused.current = true;
    const row = listRef.current?.querySelector(`[data-vault-key="${CSS.escape(focusKey)}"]`);
    row?.scrollIntoView({ block: 'center' });
  }, [entries, focusKey]);

  const mutate = async (fn: () => Promise<void>): Promise<void> => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
      throw err;
    } finally {
      await reload();
    }
  };

  const readOnly = available !== true;
  const list = entries ?? [];
  const tags = useMemo(() => allTags(list, names), [list, names]);
  const userTags = useMemo(() => [...new Set(list.flatMap((e) => e.tags))].sort(), [list]);
  const { fleet, keys } = groupEntries(filterEntries(list, names, { text, tags: selected }));

  const addKey = (a: VaultKeySubmit): Promise<void> =>
    mutate(async () => {
      const existing = list.find((e) => e.key === a.key);
      if (existing && (!existing.fleet || existing.root.set)) throw new Error(`${a.key} already exists — edit it instead.`);
      await vault.putKey({ key: a.key, secret: a.secret, tags: a.tags, rootValue: a.rootValue });
    });

  const editKey = (a: VaultKeySubmit): Promise<void> =>
    mutate(async () => {
      if (a.rename) await vault.renameKey(a.key, a.rename);
      const put: { key: string; secret: boolean; tags: string[]; rootValue?: string | null } = {
        key: a.rename ?? a.key,
        secret: a.secret,
        tags: a.tags
      };
      if (a.rootValue !== undefined) put.rootValue = a.rootValue;
      await vault.putKey(put);
    });

  const row = (e: VaultEntry) => (
    <VaultKeyRow
      key={e.key}
      entry={e}
      names={names}
      kinds={kinds}
      workspaces={workspaces}
      readOnly={readOnly}
      defaultOpen={e.key === focusKey}
      tagOptions={userTags}
      reveal={(k, ws) => vault.reveal(k, ws)}
      onEditKey={readOnly ? undefined : editKey}
      onDeleteKey={readOnly || (e.fleet && !e.root.set && !e.lines.length) ? undefined : () => mutate(() => vault.deleteKey(e.key))}
      onSetLine={(ws, line) => mutate(() => vault.setLine(e.key, ws, line))}
      onRemoveLine={(ws) => mutate(() => vault.removeLine(e.key, ws))}
    />
  );

  return (
    <div className="new-tab vault-tab" role="tabpanel">
      {error && (
        <div className="vault-error" role="alert">
          {error}
          <button type="button" className="vault-icon-btn" aria-label="Dismiss" onClick={() => setError(null)}>✕</button>
        </div>
      )}
      {available === false && (
        <div className="account-notice vault-degraded">OS keychain unavailable · env-var fallback active</div>
      )}
      <div className="vault-header">
        <input
          className="vault-search"
          type="search"
          placeholder="Filter keys…"
          aria-label="Filter keys"
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
        />
        <div className="vault-chips" role="group" aria-label="Filter by tag">
          {tags.map(({ tag, derived }) => {
            const on = selected.includes(tag);
            return (
              <button
                key={tag}
                type="button"
                className={`vault-chip${derived ? ' derived' : ''}${on ? ' on' : ''}`}
                aria-pressed={on}
                onClick={() => setSelected(on ? selected.filter((t) => t !== tag) : [...selected, tag])}
              >
                {tag}
              </button>
            );
          })}
        </div>
        <button type="button" className="btn" onClick={() => setAdding(true)} disabled={readOnly || adding}>
          + Add key
        </button>
      </div>
      {adding && (
        <VaultKeyForm tagOptions={userTags} onSubmit={addKey} onCancel={() => setAdding(false)} />
      )}
      <div className="vault-list" ref={listRef}>
        {!entries ? (
          <p className="setting-desc">Loading…</p>
        ) : (
          <>
            {fleet.length > 0 && (
              <>
                <div className="vault-section">Fleet</div>
                {fleet.map(row)}
              </>
            )}
            <div className="vault-section">Keys</div>
            {keys.map(row)}
            {!keys.length && (
              <p className="setting-desc">
                {list.some((e) => !e.fleet) ? 'No keys match the filter.' : 'No keys yet.'}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
