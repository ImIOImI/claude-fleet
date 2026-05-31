import { useEffect, useMemo, useState } from 'react';
import { ulid } from 'ulid';
import type {
  AuthMode,
  WorkspaceColor,
  WorkspaceResources,
  WorkspaceSummary
} from '../App';

export type WorkspaceKind = 'container' | 'local';

/**
 * The full payload the modal hands to App.handleCreate. The id is minted
 * here (so the modal can pre-write secrets to the vault if it ever needs
 * to; today App handles that). `plainEnv` lands in the manifest;
 * `secrets` is the modal-local map of secret key → value that App writes
 * to the vault before calling workspace:create.
 */
export interface CreateModalSubmit {
  id: string;
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
  secrets: Record<string, string>;
  resources?: WorkspaceResources;
}

interface Props {
  open: boolean;
  workspaces: WorkspaceSummary[];
  /** When false, secret env-vars are disabled (no keychain available). */
  vaultAvailable: boolean | null;
  onClose: () => void;
  onCreate: (submit: CreateModalSubmit, setStatus: (msg: string) => void) => Promise<void>;
  onRestart: (
    workspace: WorkspaceSummary,
    setStatus: (msg: string) => void
  ) => Promise<void>;
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

function relativeTime(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 60_000) return 'just now';
  const m = Math.floor(delta / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  return `${mo}mo ago`;
}

interface EnvRow {
  key: string;
  value: string;
  secret: boolean;
}

export function CreateWorkspaceModal({
  open,
  workspaces,
  vaultAvailable,
  onClose,
  onCreate,
  onRestart
}: Props) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [labelInput, setLabelInput] = useState('');
  const [labels, setLabels] = useState<string[]>([]);
  const [hue, setHue] = useState<number | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [workspaceRoot, setWorkspaceRoot] = useState<string>(loadLastWorkspaceRoot);
  const [workspaceSubdir, setWorkspaceSubdir] = useState('');
  const [authMode, setAuthMode] = useState<AuthMode>('oauth');
  const [envRows, setEnvRows] = useState<EnvRow[]>([]);
  const [cpus, setCpus] = useState<string>('');
  const [memoryMb, setMemoryMb] = useState<string>('');
  const [resourcesOpen, setResourcesOpen] = useState(false);
  const [envOpen, setEnvOpen] = useState(false);
  const [kind, setKind] = useState<WorkspaceKind>('container');
  const [image, setImage] = useState<string>('');
  const [libraryImages, setLibraryImages] = useState<ImageEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [namePlaceholder, setNamePlaceholder] = useState<string>(petName);

  // Reset transient state every time the modal opens.
  useEffect(() => {
    if (open) {
      setNamePlaceholder(petName());
      setWorkspaceRoot(loadLastWorkspaceRoot());
      setError(null);
      window.api.images.list().then((entries: ImageEntry[]) => {
        setLibraryImages(entries);
        if (!image) {
          const recent = [...entries].sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0];
          setImage(recent?.ref ?? DEFAULT_RUNNER_IMAGE);
        }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // The API-key radio unlocks once the user adds ANTHROPIC_API_KEY to env
  // (plain or secret). OAuth alone is always sufficient — that's the
  // default for first runs.
  const apiKeyAvailable = useMemo(
    () => envRows.some((r) => r.key === 'ANTHROPIC_API_KEY' && r.value.length > 0),
    [envRows]
  );

  // Autocomplete pool for label chips — dedup across all manifests.
  const allKnownLabels = useMemo(() => {
    const set = new Set<string>();
    for (const w of workspaces) for (const l of w.labels ?? []) set.add(l);
    return Array.from(set).sort();
  }, [workspaces]);

  if (!open) return null;

  const effectiveName = name.trim() || namePlaceholder;
  const nameOk = /^.{1,80}$/.test(effectiveName) && !/[\x00-\x1f\x7f]/.test(effectiveName);

  const pastWorkspaces = [...workspaces].sort((a, b) => b.lastUsedAt - a.lastUsedAt);

  const browse = async () => {
    const picked = await window.api.dialog.pickDirectory(workspaceRoot.trim() || undefined);
    if (picked) setWorkspaceRoot(picked);
  };

  const restart = async (workspace: WorkspaceSummary) => {
    if (busy) return;
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      await onRestart(workspace, setStatus);
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
      setStatus(null);
    }
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
    setEnvRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const removeEnvRow = (i: number) =>
    setEnvRows((prev) => prev.filter((_, idx) => idx !== i));

  const submit = async () => {
    if (busy) return;
    if (kind === 'local') {
      setError("Local workspaces aren't implemented yet. Pick 'Container' for now.");
      return;
    }
    if (!effectiveName) {
      setError('Workspace name is required.');
      return;
    }
    if (!nameOk) {
      setError('Workspace name must be 1–80 chars without control characters.');
      return;
    }
    const nameClash = workspaces.some(
      (w) => w.name === effectiveName && w.state !== 'deleted'
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

    // Validate env rows. Empty keys are silently dropped; duplicates fail.
    const seen = new Set<string>();
    const plainEnv: Record<string, string> = {};
    const secrets: Record<string, string> = {};
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
        if (vaultAvailable === false) {
          setError(
            `Secret env "${k}" requires the OS keychain, which isn't reachable. ` +
              `Switch the row to plain or install libsecret.`
          );
          return;
        }
        secrets[k] = row.value;
      } else {
        plainEnv[k] = row.value;
      }
    }

    // Resources: blank fields → undefined (no Docker limit).
    let resources: WorkspaceResources | undefined;
    const cpusNum = cpus.trim() ? Number(cpus) : NaN;
    const memNum = memoryMb.trim() ? Number(memoryMb) : NaN;
    if (Number.isFinite(cpusNum) && cpusNum > 0) resources = { ...(resources ?? {}), cpus: cpusNum };
    if (Number.isFinite(memNum) && memNum > 0) resources = { ...(resources ?? {}), memoryMb: memNum };

    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      const ws = workspaceRoot.trim();
      const exists = await window.api.fs.isDirectory(ws);
      if (!exists) {
        const ok = window.confirm(`Workspace folder "${ws}" does not exist. Create it?`);
        if (!ok) return;
        setStatus(`Creating ${ws}…`);
        await window.api.fs.mkdirp(ws);
      }

      await onCreate(
        {
          id: ulid(),
          name: effectiveName,
          description: description.trim() || undefined,
          labels,
          color: hue !== null ? { hue } : undefined,
          workspaceRoot: ws,
          workspaceSubdir: workspaceSubdir.trim(),
          kind,
          image: kind === 'container' ? image.trim() : undefined,
          authMode,
          plainEnv,
          secrets,
          resources
        },
        setStatus
      );
      saveLastWorkspaceRoot(ws);
      // Clear inputs but keep workspaceRoot (the user's persistent choice).
      setName('');
      setDescription('');
      setLabels([]);
      setLabelInput('');
      setHue(null);
      setEnvRows([]);
      setCpus('');
      setMemoryMb('');
      setAuthMode('oauth');
      setEnvOpen(false);
      setResourcesOpen(false);
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
      setStatus(null);
    }
  };

  const swatchStyle = hue !== null
    ? { background: `oklch(72% 0.14 ${hue})` }
    : undefined;

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>New workspace</h2>
        <p className="modal-eyebrow">restart a past workspace, or create a new one</p>

        {pastWorkspaces.length > 0 && (
          <div className="past-workspaces" aria-label="Past workspaces">
            <div className="past-workspaces-label">Past workspaces</div>
            <ul className="past-workspace-list">
              {pastWorkspaces.map((w) => (
                <li key={w.id}>
                  <button
                    type="button"
                    className="past-workspace-row"
                    onClick={() => restart(w)}
                    disabled={busy}
                    title={`Restart ${w.name}`}
                  >
                    <span className={`dot ${w.state}`} />
                    <span className="ws-name">{w.name}</span>
                    <span className="ws-path" title={w.workspaceRoot}>
                      {w.workspaceRoot || <em>(no path on record)</em>}
                    </span>
                    <span className="ws-meta">
                      <span className={`ws-state ${w.state}`}>{w.state}</span>
                      <span className="ws-when">{relativeTime(w.lastUsedAt)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="modal-section-label">Create a new workspace</div>

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
              placeholder={namePlaceholder}
              disabled={busy}
              autoFocus
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
              {envRows.length === 0 ? '(none)' : `${envRows.length} entr${envRows.length === 1 ? 'y' : 'ies'}`}
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
                  placeholder={row.secret ? '••••• (stored in keychain)' : 'value'}
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
                    disabled={busy || vaultAvailable === false}
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
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit} disabled={busy}>
            {busy ? 'Working…' : 'Create & start'}
          </button>
        </div>
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
