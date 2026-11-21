// Workspace form env section: the vault scoped to one workspace. Edits are
// staged by the form and applied on submit, so nothing here writes to the vault.
import { useEffect, useId, useMemo, useState } from 'react';
import type { VaultEntry, VaultWorkspaceEdit } from '../../../preload/vaultTypes';
import {
  allTags,
  entriesForWorkspace,
  filterEntries,
  groupEntries,
  isValidKeyName,
  parseTagInput,
  tagSuggestions,
  workspaceTag
} from '../vaultView';
import { previewEntries, rekeyLines, resolvesNonEmpty, type StagedState } from '../workspaceVaultEdits';
import { VaultKeyRow } from './VaultKeyRow';

type Kind = 'container' | 'local' | 'remote';

/** Stand-in line owner while the workspace has no id yet. */
export const NEW_WORKSPACE_ID = '__new__';

interface Props {
  /** null in create/clone mode. */
  workspaceId: string | null;
  names: Record<string, string>;
  kinds: Record<string, Kind>;
  workspaces: { id: string; name: string; kind: string }[];
  readOnly: boolean;
  staged: StagedState;
  onStage: (edit: VaultWorkspaceEdit) => void;
  /** Drops every staged edit for a key. */
  onDiscard: (key: string) => void;
  /** Saved workspace whose lines a clone will copy (display only; copied via vault:copyWorkspace). */
  cloneFrom?: string;
  /** Keys that will resolve non-empty here once staged edits apply. */
  onResolvedKeysChange?: (keys: string[]) => void;
}

/** A value typed into this form, which the vault doesn't have yet. */
function stagedValue(staged: StagedState, key: string, root: boolean): string | null {
  const mine = staged.edits.filter((e) => e.key === key);
  const create = mine.find((e) => e.op === 'create');
  if (root) return create?.op === 'create' && create.asRoot ? create.value : null;
  const override = mine.find((e) => e.op === 'override');
  if (override?.op === 'override') return override.value;
  return create?.op === 'create' && !create.asRoot ? create.value : null;
}

export function WorkspaceVaultSection(p: Props) {
  const vault = window.api.vault;
  const listId = useId();
  const [list, setList] = useState<VaultEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const ownTag = p.workspaceId ? workspaceTag(p.names[p.workspaceId] ?? p.workspaceId) || workspaceTag(p.workspaceId) : '';
  const [selected, setSelected] = useState<string[]>(ownTag ? [ownTag] : []);
  const [adding, setAdding] = useState(false);
  const [newKey, setNewKey] = useState({ name: '', value: '', tags: '', secret: true, asRoot: false });
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    vault.list().then(setList, (err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [vault]);

  const id = p.workspaceId ?? NEW_WORKSPACE_ID;
  const names = useMemo(
    () => (p.workspaceId ? p.names : { ...p.names, [NEW_WORKSPACE_ID]: 'This workspace' }),
    [p.names, p.workspaceId]
  );
  const base = useMemo(() => {
    const l = list ?? [];
    return p.cloneFrom ? rekeyLines(l, p.cloneFrom, id) : l;
  }, [list, p.cloneFrom, id]);
  const preview = useMemo(() => previewEntries(base, id, p.staged), [base, id, p.staged]);
  const baseKeys = useMemo(() => new Set(base.map((e) => e.key)), [base]);
  const savedKeys = useMemo(() => new Set(entriesForWorkspace(base, id).map((e) => e.key)), [base, id]);
  const mine = useMemo(() => entriesForWorkspace(preview, id), [preview, id]);
  const unpublished = preview.filter((e) => !mine.includes(e));
  const tags = useMemo(() => allTags(mine, names), [mine, names]);
  const userTags = useMemo(() => [...new Set(preview.flatMap((e) => e.tags))].sort(), [preview]);
  const { fleet, keys } = groupEntries(filterEntries(mine, names, { text, tags: selected }));

  const [autoOpened, setAutoOpened] = useState(false);
  useEffect(() => {
    if (!list || autoOpened) return;
    setAutoOpened(true);
    if (mine.length) setOpen(true);
  }, [list, autoOpened, mine.length]);

  const keySignature = mine
    .filter((e) => resolvesNonEmpty(e, id, p.staged, baseKeys))
    .map((e) => e.key)
    .join('\n');
  const { onResolvedKeysChange } = p;
  useEffect(() => {
    onResolvedKeysChange?.(keySignature ? keySignature.split('\n') : []);
  }, [keySignature, onResolvedKeysChange]);

  const reveal = async (key: string, ws: string | null): Promise<string | null> => {
    // A create on an existing key never touches its root value.
    if (ws === null && list?.some((e) => e.key === key)) return vault.reveal(key, null);
    const typed = stagedValue(p.staged, key, ws === null);
    if (typed !== null) return typed;
    if (ws === null) return vault.reveal(key, null);
    if (p.workspaceId) return vault.reveal(key, p.workspaceId);
    return p.cloneFrom ? vault.reveal(key, p.cloneFrom) : null;
  };

  const addNewKey = (): void => {
    const key = newKey.name.trim();
    if (!isValidKeyName(key)) return setProblem('Name must be letters, digits and _ (not starting with a digit).');
    if (preview.some((e) => e.key === key)) return setProblem(`${key} is already in the vault — use Add from vault.`);
    const { tags: parsed, invalid } = parseTagInput(newKey.tags);
    if (invalid.length) return setProblem(`Invalid tags: ${invalid.join(', ')} (lowercase a-z, 0-9, -; max 32).`);
    setProblem(null);
    p.onStage({ key, op: 'create', secret: newKey.secret, tags: parsed, value: newKey.value, asRoot: newKey.asRoot });
    setNewKey({ name: '', value: '', tags: '', secret: true, asRoot: false });
    setAdding(false);
  };

  const row = (e: VaultEntry) => (
    <VaultKeyRow
      key={e.key}
      entry={e}
      names={names}
      kinds={p.kinds}
      workspaces={p.workspaces}
      scopeWorkspaceId={id}
      readOnly={p.readOnly}
      defaultOpen
      reveal={reveal}
      onSetLine={async (_ws, line) =>
        p.onStage(line.mode === 'inherit' ? { key: e.key, op: 'inherit' } : { key: e.key, op: 'override', value: line.value })
      }
      onRemoveLine={async () => (savedKeys.has(e.key) ? p.onStage({ key: e.key, op: 'remove' }) : p.onDiscard(e.key))}
    />
  );

  return (
    <details className="form-disclosure" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>
        Env vars{' '}
        <span className="form-hint">
          {mine.length === 0 ? '(none)' : `${mine.length} key${mine.length === 1 ? '' : 's'}`}
          {p.staged.edits.length > 0 && ' · unsaved changes'}
        </span>
      </summary>
      <div className="vault-tab workspace-vault">
        {error && <div className="vault-error" role="alert">{error}</div>}
        <div className="vault-header">
          <input
            className="vault-search"
            type="search"
            placeholder="Filter keys…"
            aria-label="Filter env keys"
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
          />
          <div className="vault-chips" role="group" aria-label="Filter env keys by tag">
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
        </div>
        <div className="vault-list">
          {!list && !error ? (
            <p className="setting-desc">Loading…</p>
          ) : (
            <>
              {fleet.map(row)}
              {keys.map(row)}
              {!fleet.length && !keys.length && (
                <p className="setting-desc">{mine.length ? 'No keys match the filter.' : 'No env vars on this workspace.'}</p>
              )}
            </>
          )}
        </div>
        <div className="vault-header">
          <select
            className="vault-publish"
            aria-label="Add from vault"
            value=""
            onChange={(e) => e.target.value && p.onStage({ key: e.target.value, op: 'inherit' })}
            disabled={p.readOnly || !unpublished.length}
          >
            <option value="">+ Add from vault…</option>
            {unpublished.map((e) => (
              <option key={e.key} value={e.key}>{e.key}</option>
            ))}
          </select>
          <button type="button" className="btn" onClick={() => setAdding(true)} disabled={p.readOnly || adding}>
            + New key
          </button>
        </div>
        {adding && (
          <form
            className="vault-form"
            aria-label="New env key"
            onSubmit={(e) => {
              e.preventDefault();
              addNewKey();
            }}
          >
            <div className="vault-form-row">
              <input
                className="vault-form-name"
                aria-label="New key name"
                placeholder="KEY_NAME"
                value={newKey.name}
                onChange={(e) => setNewKey({ ...newKey, name: e.target.value })}
                autoFocus
                spellCheck={false}
                autoComplete="off"
              />
              <input
                className="vault-form-value"
                aria-label="New key value"
                type={newKey.secret ? 'password' : 'text'}
                placeholder="value"
                value={newKey.value}
                onChange={(e) => setNewKey({ ...newKey, value: e.target.value })}
                spellCheck={false}
                autoComplete="off"
              />
            </div>
            <div className="vault-form-row">
              <input
                className="vault-form-tags"
                aria-label="New key tags"
                placeholder="tags, comma or space separated"
                list={listId}
                value={newKey.tags}
                onChange={(e) => setNewKey({ ...newKey, tags: e.target.value })}
                spellCheck={false}
                autoComplete="off"
              />
              <datalist id={listId}>
                {tagSuggestions(newKey.tags, userTags).map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
              <label className="vault-form-secret">
                <input type="checkbox" checked={newKey.secret} onChange={(e) => setNewKey({ ...newKey, secret: e.target.checked })} />
                <span>secret</span>
              </label>
              <label className="vault-form-secret" title="Store the value as the root value and inherit it here">
                <input type="checkbox" checked={newKey.asRoot} onChange={(e) => setNewKey({ ...newKey, asRoot: e.target.checked })} />
                <span>also set as root</span>
              </label>
              <span className="vault-spacer" />
              <button type="button" className="btn-mini" onClick={() => { setAdding(false); setProblem(null); }}>Cancel</button>
              <button type="submit" className="btn-mini primary" disabled={!newKey.name.trim()}>
                Add key
              </button>
            </div>
            {problem && <div className="vault-note err">{problem}</div>}
          </form>
        )}
      </div>
    </details>
  );
}
