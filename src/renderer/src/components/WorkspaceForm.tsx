// Mode-aware workspace form. Same component renders inside the New tab
// (mode='create') and inside an expanded Saved-tab row (mode='edit'). The
// form owns its own field state + validation + footer rendering; the
// parent only passes initial values + an `onSubmit` callback. For
// create-mode callers, leaving `initial.id` unset means the parent gets
// `submit.id === undefined` and is expected to mint a fresh ULID itself
// (App.tsx does this so the workspace identity is generated in one
// place).

import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import type {
  AuthMode,
  WorkspaceColor,
  WorkspaceResources,
  WorkspaceSummary
} from '../App';

export type WorkspaceKind = 'container' | 'local';

export interface WorkspaceFormSubmit {
  /** Present iff editing an existing workspace; create flows leave it undefined and the parent mints one. */
  id?: string;
  name: string;
  description?: string;
  labels: string[];
  color?: WorkspaceColor;
  workspaceRoot: string;
  workspaceSubdir: string;
  kind: WorkspaceKind;
  image?: string;
  authMode: AuthMode;
  plainEnv: Record<string, string>;
  /**
   * Full list of every secret-env-var key the workspace will have after
   * this submit lands. Lands directly in `manifest.env.secretKeys` — the
   * parent doesn't need to derive it from `secrets`. Pre-existing secret
   * keys the user didn't touch in edit mode are here even though they
   * aren't in `secrets`.
   */
  secretKeys: string[];
  /**
   * Map of newly-typed secret values that need to be (re)written to the
   * vault. Subset of `secretKeys` — keys without a new value are
   * already in keytar and shouldn't be touched.
   */
  secrets: Record<string, string>;
  resources?: WorkspaceResources;
}

interface ImageEntry {
  ref: string;
  digest?: string;
  labels: Record<string, string>;
  firstUsedAt: number;
  lastUsedAt: number;
  useCount: number;
}

const DEFAULT_RUNNER_IMAGE = 'ghcr.io/imioimi/claude-fleet/runner:latest';

// 14 evenly-spaced hues at OKLCH L=72% C=0.14 — palette from the
// workspace-modal design doc.
const PRESET_HUES = Array.from({ length: 14 }, (_, i) => Math.round((i * 360) / 14));

const ADJECTIVES = [
  'happy', 'calm', 'bold', 'quiet', 'swift', 'lucky', 'brave', 'clever',
  'eager', 'gentle', 'jolly', 'kind', 'merry', 'nimble', 'plucky', 'witty'
];
const ANIMALS = [
  'llama', 'otter', 'fox', 'panda', 'lemur', 'koala', 'bunny', 'finch',
  'gecko', 'owl', 'wren', 'seal', 'mouse', 'hare', 'frog', 'crane'
];
function petName(): string {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const n = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  return `${a}-${n}`;
}

const LAST_WORKSPACE_ROOT_KEY = 'claude-fleet:lastWorkspaceRoot';

function loadLastWorkspaceRoot(): string {
  try {
    return localStorage.getItem(LAST_WORKSPACE_ROOT_KEY) ?? '';
  } catch {
    return '';
  }
}

function saveLastWorkspaceRoot(path: string): void {
  try {
    localStorage.setItem(LAST_WORKSPACE_ROOT_KEY, path);
  } catch {
    // localStorage may be unavailable in odd sandbox modes; persistence
    // is a nice-to-have so swallow.
  }
}

interface EnvRow {
  key: string;
  value: string;
  secret: boolean;
  /** Pre-existing secret keys in edit mode show as a placeholder "•••••" until the user types. */
  preExisting?: boolean;
}

interface Props {
  mode: 'create' | 'edit';
  initial?: Partial<WorkspaceFormSubmit & { id: string }>;
  workspaces: WorkspaceSummary[];
  vaultAvailable: boolean | null;
  onSubmit: (values: WorkspaceFormSubmit, setStatus: (s: string | null) => void) => Promise<void>;
  onCancel: () => void;
  /** Optional slot for extra footer buttons (Clone / Delete in PR-B edit mode). */
  extraFooterLeft?: ReactNode;
}

export function WorkspaceForm({
  mode,
  initial,
  workspaces,
  vaultAvailable,
  onSubmit,
  onCancel,
  extraFooterLeft
}: Props) {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [labelInput, setLabelInput] = useState('');
  const [labels, setLabels] = useState<string[]>(initial?.labels ?? []);
  const [hue, setHue] = useState<number | null>(initial?.color?.hue ?? null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [workspaceRoot, setWorkspaceRoot] = useState<string>(
    initial?.workspaceRoot ?? (mode === 'create' ? loadLastWorkspaceRoot() : '')
  );
  const [workspaceSubdir, setWorkspaceSubdir] = useState(initial?.workspaceSubdir ?? '');
  const [authMode, setAuthMode] = useState<AuthMode>(initial?.authMode ?? 'oauth');
  const [envRows, setEnvRows] = useState<EnvRow[]>(() => {
    const rows: EnvRow[] = [];
    if (initial?.plainEnv) {
      for (const [key, value] of Object.entries(initial.plainEnv)) {
        rows.push({ key, value, secret: false });
      }
    }
    // Initial secret rows: we know the keys from the manifest but never
    // the values. Mark them preExisting so the input renders a "•••••"
    // placeholder until the user types a replacement.
    const existingSecretKeys = (initial as unknown as { secretKeys?: string[] })?.secretKeys ?? [];
    for (const key of existingSecretKeys) {
      rows.push({ key, value: '', secret: true, preExisting: true });
    }
    return rows;
  });
  const [cpus, setCpus] = useState<string>(
    initial?.resources?.cpus != null ? String(initial.resources.cpus) : ''
  );
  const [memoryMb, setMemoryMb] = useState<string>(
    initial?.resources?.memoryMb != null ? String(initial.resources.memoryMb) : ''
  );
  const [resourcesOpen, setResourcesOpen] = useState(false);
  const [envOpen, setEnvOpen] = useState(envRows.length > 0);
  const [kind, setKind] = useState<WorkspaceKind>(initial?.kind ?? 'container');
  const [image, setImage] = useState<string>(initial?.image ?? '');
  const [libraryImages, setLibraryImages] = useState<ImageEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [namePlaceholder] = useState<string>(petName);

  // Fetch image library + default the image input on mount.
  useEffect(() => {
    window.api.images.list().then((entries: ImageEntry[]) => {
      setLibraryImages(entries);
      if (!image) {
        const recent = [...entries].sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0];
        setImage(recent?.ref ?? DEFAULT_RUNNER_IMAGE);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const apiKeyAvailable = useMemo(
    () =>
      envRows.some(
        (r) => r.key === 'ANTHROPIC_API_KEY' && (r.value.length > 0 || r.preExisting)
      ),
    [envRows]
  );

  const allKnownLabels = useMemo(() => {
    const set = new Set<string>();
    for (const w of workspaces) for (const l of w.labels ?? []) set.add(l);
    return Array.from(set).sort();
  }, [workspaces]);

  const effectiveName = name.trim() || (mode === 'create' ? namePlaceholder : '');
  const nameOk = effectiveName.length > 0 && effectiveName.length <= 80 && !/[\x00-\x1f\x7f]/.test(effectiveName);

  const browse = async () => {
    const picked = await window.api.dialog.pickDirectory(workspaceRoot.trim() || undefined);
    if (picked) setWorkspaceRoot(picked);
  };

  const commitLabel = () => {
    const v = labelInput.trim();
    if (!v) return;
    if (!labels.includes(v)) setLabels((prev) => [...prev, v]);
    setLabelInput('');
  };

  const removeLabel = (l: string) => setLabels((prev) => prev.filter((x) => x !== l));

  const addEnvRow = () =>
    setEnvRows((prev) => [...prev, { key: '', value: '', secret: false }]);
  const updateEnvRow = (i: number, patch: Partial<EnvRow>) =>
    setEnvRows((prev) =>
      prev.map((r, idx) => {
        if (idx !== i) return r;
        // Typing into a preExisting row replaces the secret — clear that flag.
        const next: EnvRow = { ...r, ...patch };
        if ('value' in patch && patch.value && next.preExisting) next.preExisting = false;
        return next;
      })
    );
  const removeEnvRow = (i: number) =>
    setEnvRows((prev) => prev.filter((_, idx) => idx !== i));

  const submit = async () => {
    if (busy) return;
    if (kind === 'local') {
      setError("Local workspaces aren't implemented yet. Pick 'Container' for now.");
      return;
    }
    if (!nameOk) {
      setError('Workspace name must be 1–80 chars with no control characters.');
      return;
    }
    const nameClash = workspaces.some(
      (w) => w.name === effectiveName && w.state !== 'deleted' && w.id !== initial?.id
    );
    if (nameClash) {
      setError(`A workspace named "${effectiveName}" already exists.`);
      return;
    }
    if (!workspaceRoot.trim()) {
      setError('Workspace root is required.');
      return;
    }
    if (kind === 'container' && !image.trim()) {
      setError('Image reference is required for a container workspace.');
      return;
    }

    const seen = new Set<string>();
    const plainEnv: Record<string, string> = {};
    const secrets: Record<string, string> = {};
    const secretKeys: string[] = [];
    for (const row of envRows) {
      const k = row.key.trim();
      if (!k) continue;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
        setError(`Invalid env var name "${k}" — must match [A-Z_][A-Z0-9_]+ (POSIX style).`);
        return;
      }
      if (seen.has(k)) {
        setError(`Duplicate env var "${k}".`);
        return;
      }
      seen.add(k);
      if (row.secret) {
        if (vaultAvailable === false && !row.preExisting) {
          setError(
            `Secret env "${k}" requires the OS keychain, which isn't reachable. ` +
              `Switch the row to plain or install libsecret.`
          );
          return;
        }
        secretKeys.push(k);
        // preExisting + empty value = user didn't change it; leave the
        // keytar entry intact by *not* including it in the `secrets`
        // map. App-side: just doesn't call setSecret. The key still
        // appears in `secretKeys` so the manifest stays consistent.
        if (row.value || !row.preExisting) {
          secrets[k] = row.value;
        }
      } else {
        plainEnv[k] = row.value;
      }
    }

    let resources: WorkspaceResources | undefined;
    const cpusNum = cpus.trim() ? Number(cpus) : NaN;
    const memNum = memoryMb.trim() ? Number(memoryMb) : NaN;
    if (Number.isFinite(cpusNum) && cpusNum > 0) resources = { ...(resources ?? {}), cpus: cpusNum };
    if (Number.isFinite(memNum) && memNum > 0) resources = { ...(resources ?? {}), memoryMb: memNum };

    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      if (mode === 'create') {
        const ws = workspaceRoot.trim();
        const exists = await window.api.fs.isDirectory(ws);
        if (!exists) {
          const ok = window.confirm(`Workspace folder "${ws}" does not exist. Create it?`);
          if (!ok) return;
          setStatus(`Creating ${ws}…`);
          await window.api.fs.mkdirp(ws);
        }
        saveLastWorkspaceRoot(ws);
      }

      await onSubmit(
        {
          id: initial?.id,
          name: effectiveName,
          description: description.trim() || undefined,
          labels,
          color: hue !== null ? { hue } : undefined,
          workspaceRoot: workspaceRoot.trim(),
          workspaceSubdir: workspaceSubdir.trim(),
          kind,
          image: kind === 'container' ? image.trim() : undefined,
          authMode,
          plainEnv,
          secretKeys,
          secrets,
          resources
        },
        setStatus
      );
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
      setStatus(null);
    }
  };

  const swatchStyle = hue !== null ? { background: `oklch(72% 0.14 ${hue})` } : undefined;
  const primaryLabel = mode === 'create' ? 'Create & start' : 'Resume';

  return (
    <div className="workspace-form">
      <div className="form-row" aria-label="Workspace kind">
        <label>Type</label>
        <div className="kind-radios" role="radiogroup">
          <label className={`kind-radio ${kind === 'container' ? 'active' : ''}`}>
            <input
              type="radio"
              name="workspace-kind"
              value="container"
              checked={kind === 'container'}
              onChange={() => setKind('container')}
              disabled={busy}
            />
            <span>Container</span>
            <span className="kind-help">isolated Docker runner</span>
          </label>
          <label className={`kind-radio ${kind === 'local' ? 'active' : ''}`}>
            <input
              type="radio"
              name="workspace-kind"
              value="local"
              checked={kind === 'local'}
              onChange={() => setKind('local')}
              disabled={busy}
            />
            <span>Local</span>
            <span className="kind-help">runs on this host · coming soon</span>
          </label>
        </div>
      </div>

      {kind === 'container' && (
        <div className="form-row">
          <label>Image</label>
          <input
            aria-label="Image reference"
            value={image}
            onChange={(e) => setImage(e.target.value)}
            placeholder={DEFAULT_RUNNER_IMAGE}
            disabled={busy}
          />
          <ImagePicker
            library={libraryImages}
            filter={image}
            onPick={setImage}
            busy={busy}
          />
        </div>
      )}

      <div className="form-row">
        <label>Name</label>
        <div className="name-row">
          <button
            type="button"
            className={`color-swatch ${hue === null ? 'unset' : ''}`}
            style={swatchStyle}
            aria-label="Workspace color"
            aria-expanded={pickerOpen}
            onClick={(e) => {
              e.stopPropagation();
              setPickerOpen((v) => !v);
            }}
            disabled={busy}
          />
          <input
            aria-label="Workspace name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={mode === 'create' ? namePlaceholder : initial?.name ?? ''}
            disabled={busy}
            autoFocus={mode === 'create'}
          />
          {pickerOpen && (
            <ColorPicker
              value={hue}
              onPick={(h) => {
                setHue(h);
                setPickerOpen(false);
              }}
              onClose={() => setPickerOpen(false)}
            />
          )}
        </div>
        {name && !nameOk && (
          <span className="form-hint error-text">
            Name must be 1–80 chars and contain no control characters.
          </span>
        )}
      </div>

      <div className="form-row">
        <label>Description</label>
        <textarea
          aria-label="Workspace description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="(optional) what this workspace is for"
          disabled={busy}
          rows={2}
        />
      </div>

      <div className="form-row">
        <label>Labels</label>
        <div className="label-chip-input" role="group">
          {labels.map((l) => (
            <span key={l} className="label-chip">
              {l}
              <button
                type="button"
                className="label-chip-remove"
                aria-label={`Remove ${l}`}
                onClick={() => removeLabel(l)}
                disabled={busy}
              >
                ×
              </button>
            </span>
          ))}
          <input
            aria-label="Add label"
            value={labelInput}
            list="known-labels"
            onChange={(e) => setLabelInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                commitLabel();
              } else if (e.key === 'Backspace' && labelInput === '' && labels.length > 0) {
                removeLabel(labels[labels.length - 1]);
              }
            }}
            onBlur={commitLabel}
            placeholder={labels.length === 0 ? 'add labels (Enter / comma to commit)' : ''}
            disabled={busy}
          />
          <datalist id="known-labels">
            {allKnownLabels
              .filter((l) => !labels.includes(l))
              .map((l) => (
                <option key={l} value={l} />
              ))}
          </datalist>
        </div>
      </div>

      <div className="form-row">
        <label>Workspace root (host path)</label>
        <div className="input-with-button">
          <input
            value={workspaceRoot}
            onChange={(e) => setWorkspaceRoot(e.target.value)}
            placeholder="/home/troy/repos"
            disabled={busy}
          />
          <button type="button" onClick={browse} disabled={busy}>
            Browse…
          </button>
        </div>
      </div>
      <div className="form-row">
        <label>Subdir inside workspace</label>
        <input
          value={workspaceSubdir}
          onChange={(e) => setWorkspaceSubdir(e.target.value)}
          placeholder="(optional)"
          disabled={busy}
        />
      </div>

      <div className="form-row" aria-label="Auth mode">
        <label>Auth</label>
        <div className="kind-radios" role="radiogroup">
          <label className={`kind-radio ${authMode === 'oauth' ? 'active' : ''}`}>
            <input
              type="radio"
              name="auth-mode"
              value="oauth"
              checked={authMode === 'oauth'}
              onChange={() => setAuthMode('oauth')}
              disabled={busy}
            />
            <span>OAuth</span>
            <span className="kind-help">log in via Claude.ai</span>
          </label>
          <label
            className={`kind-radio ${authMode === 'apikey' ? 'active' : ''} ${apiKeyAvailable ? '' : 'disabled'}`}
            title={apiKeyAvailable ? '' : 'Add ANTHROPIC_API_KEY in Env vars to enable'}
          >
            <input
              type="radio"
              name="auth-mode"
              value="apikey"
              checked={authMode === 'apikey'}
              onChange={() => setAuthMode('apikey')}
              disabled={busy || !apiKeyAvailable}
            />
            <span>API key {!apiKeyAvailable && '🔒'}</span>
            <span className="kind-help">
              {apiKeyAvailable ? 'ANTHROPIC_API_KEY in env' : 'set ANTHROPIC_API_KEY below'}
            </span>
          </label>
        </div>
      </div>

      <details
        className="form-disclosure"
        open={envOpen}
        onToggle={(e) => setEnvOpen((e.target as HTMLDetailsElement).open)}
      >
        <summary>
          Env vars{' '}
          <span className="form-hint">
            {envRows.length === 0
              ? '(none)'
              : `${envRows.length} entr${envRows.length === 1 ? 'y' : 'ies'}`}
          </span>
        </summary>
        <div className="env-editor">
          {envRows.map((row, i) => (
            <div className="env-row" key={i}>
              <input
                aria-label={`Env key ${i + 1}`}
                className="env-key"
                value={row.key}
                onChange={(e) => updateEnvRow(i, { key: e.target.value.toUpperCase() })}
                placeholder="NAME"
                disabled={busy}
              />
              <input
                aria-label={`Env value ${i + 1}`}
                className="env-value"
                value={row.value}
                onChange={(e) => updateEnvRow(i, { value: e.target.value })}
                placeholder={row.preExisting ? '••••• (set; type to replace)' : row.secret ? '••••• (stored in keychain)' : 'value'}
                type={row.secret ? 'password' : 'text'}
                disabled={busy}
              />
              <label
                className="env-secret-toggle"
                title={
                  vaultAvailable === false
                    ? 'OS keychain unavailable — secrets disabled'
                    : 'Store value in the OS keychain instead of the manifest'
                }
              >
                <input
                  type="checkbox"
                  checked={row.secret}
                  onChange={(e) => updateEnvRow(i, { secret: e.target.checked })}
                  disabled={busy || vaultAvailable === false || row.preExisting}
                />
                <span>secret</span>
              </label>
              <button
                type="button"
                className="env-row-remove"
                aria-label="Remove env var"
                onClick={() => removeEnvRow(i)}
                disabled={busy}
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn"
            onClick={addEnvRow}
            disabled={busy}
          >
            + Add env var
          </button>
        </div>
      </details>

      {kind === 'container' && (
        <details
          className="form-disclosure"
          open={resourcesOpen}
          onToggle={(e) => setResourcesOpen((e.target as HTMLDetailsElement).open)}
        >
          <summary>
            Resource caps{' '}
            <span className="form-hint">
              {cpus || memoryMb
                ? `${cpus || '—'} cpu · ${memoryMb ? `${memoryMb} MB` : '—'}`
                : '(host defaults)'}
            </span>
          </summary>
          <div className="resources-grid">
            <label>
              CPUs
              <input
                type="number"
                step="0.1"
                min="0"
                value={cpus}
                onChange={(e) => setCpus(e.target.value)}
                placeholder="cores"
                disabled={busy}
              />
            </label>
            <label>
              Memory
              <input
                type="number"
                step="64"
                min="0"
                value={memoryMb}
                onChange={(e) => setMemoryMb(e.target.value)}
                placeholder="MB"
                disabled={busy}
              />
            </label>
          </div>
        </details>
      )}

      {status && <div className="form-status">{status}</div>}
      {error && <div className="form-hint error-text">{error}</div>}
      <div className="modal-footer">
        {extraFooterLeft}
        <button className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button className="btn primary" onClick={submit} disabled={busy}>
          {busy ? 'Working…' : primaryLabel}
        </button>
      </div>
    </div>
  );
}

interface ColorPickerProps {
  value: number | null;
  onPick: (hue: number | null) => void;
  onClose: () => void;
}

function ColorPicker({ value, onPick, onClose }: ColorPickerProps) {
  useEffect(() => {
    const close = (e: MouseEvent | KeyboardEvent): void => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      onClose();
    };
    document.addEventListener('click', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', close);
    };
  }, [onClose]);

  return (
    <div className="color-picker" role="dialog" onClick={(e) => e.stopPropagation()}>
      <div className="color-grid">
        {PRESET_HUES.map((h) => (
          <button
            key={h}
            type="button"
            className={`color-chip ${value === h ? 'active' : ''}`}
            style={{ background: `oklch(72% 0.14 ${h})` }}
            aria-label={`Hue ${h}`}
            onClick={() => onPick(h)}
          />
        ))}
      </div>
      <button
        type="button"
        className="color-random"
        onClick={() => onPick(PRESET_HUES[Math.floor(Math.random() * PRESET_HUES.length)])}
      >
        Random
      </button>
      {value !== null && (
        <button type="button" className="color-clear" onClick={() => onPick(null)}>
          Clear
        </button>
      )}
    </div>
  );
}

interface ImagePickerProps {
  library: ImageEntry[];
  filter: string;
  onPick: (ref: string) => void;
  busy: boolean;
}

function ImagePicker({ library, filter, onPick, busy }: ImagePickerProps) {
  if (library.length === 0) return null;

  const needle = filter.trim().toLowerCase();
  const filtered = needle
    ? library.filter((img) => {
        if (img.ref.toLowerCase().includes(needle)) return true;
        for (const [key, value] of Object.entries(img.labels)) {
          if (key.toLowerCase().includes(needle)) return true;
          if (String(value).toLowerCase().includes(needle)) return true;
        }
        return false;
      })
    : library;

  const sorted = [...filtered].sort((a, b) => b.lastUsedAt - a.lastUsedAt);

  return (
    <div className="image-library" aria-label="Image library">
      <div className="image-library-header">
        {needle
          ? `${sorted.length} of ${library.length} match "${filter.trim()}"`
          : `${library.length} known image${library.length === 1 ? '' : 's'}`}
      </div>
      {sorted.length === 0 ? (
        <div className="image-library-empty">
          No library image matches. The reference will be added when this workspace is created.
        </div>
      ) : (
        <ul className="image-library-list">
          {sorted.slice(0, 8).map((img) => {
            const labelEntries = Object.entries(img.labels).slice(0, 3);
            return (
              <li key={img.ref}>
                <button
                  type="button"
                  className="image-row"
                  onClick={() => onPick(img.ref)}
                  disabled={busy}
                  title={img.ref}
                >
                  <span className="image-ref">{img.ref}</span>
                  {labelEntries.length > 0 && (
                    <span className="image-labels">
                      {labelEntries.map(([k, v]) => (
                        <span key={k} className="image-label">
                          <span className="image-label-key">{k}</span>
                          <span className="image-label-eq">=</span>
                          <span className="image-label-value">{v}</span>
                        </span>
                      ))}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
