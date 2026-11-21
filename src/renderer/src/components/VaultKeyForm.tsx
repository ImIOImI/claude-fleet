// Inline add/edit form for a vault key (Settings → Vault).
import { useId, useState } from 'react';
import { FLEET_KEYS } from '../../../preload/fleetKeys';
import type { VaultEntry } from '../../../preload/vaultTypes';
import { inheritCount, isValidKeyName, parseTagInput, tagSuggestions } from '../vaultView';

const MAX_TAGS = 16;

export interface VaultKeySubmit {
  key: string;
  secret: boolean;
  tags: string[];
  /** null clears the root value; absent keeps it. */
  rootValue?: string | null;
  rename?: string;
}

interface Props {
  /** Absent ⇒ add mode. */
  entry?: VaultEntry;
  tagOptions: string[];
  /** Rejects to keep the form open; the caller surfaces the error. */
  onSubmit: (a: VaultKeySubmit) => Promise<void>;
  onCancel: () => void;
}

export function VaultKeyForm({ entry, tagOptions, onSubmit, onCancel }: Props) {
  const listId = useId();
  const [name, setName] = useState(entry?.key ?? '');
  const [value, setValue] = useState(entry && !entry.secret ? entry.root.value ?? '' : '');
  const [tagsText, setTagsText] = useState(entry?.tags.join(', ') ?? '');
  const [secret, setSecret] = useState(entry?.secret ?? true);
  const [cleared, setCleared] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const losing = entry ? inheritCount(entry) : 0;
  const fleetSecret = FLEET_KEYS.find((k) => k.key === name.trim())?.secret;

  const submit = async (confirmed: boolean): Promise<void> => {
    const key = name.trim();
    if (!isValidKeyName(key)) return setProblem('Name must be letters, digits and _ (not starting with a digit).');
    const { tags, invalid } = parseTagInput(tagsText);
    if (invalid.length) return setProblem(`Invalid tags: ${invalid.join(', ')} (lowercase a-z, 0-9, -; max 32).`);
    if (tags.length > MAX_TAGS) return setProblem(`At most ${MAX_TAGS} tags.`);
    setProblem(null);

    let rootValue: string | null | undefined;
    if (cleared) rootValue = null;
    else if (value !== '' && value !== (entry?.root.value ?? '')) rootValue = value;
    if (rootValue === null && losing > 0 && !confirmed) return setConfirmClear(true);

    const a: VaultKeySubmit = { key: entry?.key ?? key, secret: fleetSecret ?? secret, tags };
    if (rootValue !== undefined) a.rootValue = rootValue;
    if (entry && key !== entry.key) a.rename = key;
    setBusy(true);
    try {
      await onSubmit(a);
      onCancel();
    } catch {
      setConfirmClear(false);
    } finally {
      setBusy(false);
    }
  };

  const valuePlaceholder = cleared
    ? 'root value will be cleared'
    : entry?.root.set && entry.secret
      ? 'unchanged — type to replace'
      : entry
        ? 'no root value'
        : 'value (optional)';

  return (
    <form
      className="vault-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit(false);
      }}
    >
      <div className="vault-form-row">
        <input
          className="vault-form-name"
          aria-label="Key name"
          placeholder="KEY_NAME"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={busy || entry?.fleet}
          title={entry?.fleet ? 'Fleet keys cannot be renamed' : undefined}
          autoFocus={!entry}
          spellCheck={false}
          autoComplete="off"
        />
        <input
          className="vault-form-value"
          aria-label="Root value"
          type={(fleetSecret ?? secret) ? 'password' : 'text'}
          placeholder={valuePlaceholder}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setCleared(false);
          }}
          disabled={busy || cleared}
          spellCheck={false}
          autoComplete="off"
        />
      </div>
      <div className="vault-form-row">
        <input
          className="vault-form-tags"
          aria-label="Tags"
          placeholder="tags, comma or space separated"
          list={listId}
          value={tagsText}
          onChange={(e) => setTagsText(e.target.value)}
          disabled={busy}
          spellCheck={false}
          autoComplete="off"
        />
        <datalist id={listId}>
          {tagSuggestions(tagsText, tagOptions).map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        {!entry && (
          <label className="vault-form-secret">
            <input
              type="checkbox"
              checked={fleetSecret ?? secret}
              onChange={(e) => setSecret(e.target.checked)}
              disabled={busy || fleetSecret !== undefined}
            />
            <span>secret</span>
          </label>
        )}
        {entry?.root.set && (
          <button
            type="button"
            className="vault-link"
            onClick={() => {
              setCleared(!cleared);
              setValue(cleared && !entry.secret ? entry.root.value ?? '' : '');
            }}
            disabled={busy}
          >
            {cleared ? 'undo clear' : 'clear root value'}
          </button>
        )}
        <span className="vault-spacer" />
        <button type="button" className="btn-mini" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="btn-mini primary" disabled={busy || !name.trim()}>
          {entry ? 'Save' : 'Add key'}
        </button>
      </div>
      {problem && <div className="vault-note err" role="alert">{problem}</div>}
      {confirmClear && (
        <div className="vault-confirm" role="group" aria-label="Confirm clearing root value">
          <span>
            {losing} workspace{losing === 1 ? '' : 's'} inherit{losing === 1 ? 's' : ''} this; they'll lose it.
          </span>
          <button type="button" className="btn-mini danger" onClick={() => void submit(true)} disabled={busy}>
            Clear anyway
          </button>
          <button type="button" className="btn-mini" onClick={() => setConfirmClear(false)} disabled={busy}>
            Keep
          </button>
        </div>
      )}
    </form>
  );
}
