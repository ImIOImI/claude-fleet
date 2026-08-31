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
  WorkspaceMirror,
  MirrorSetting,
  CleanupSetting,
  AccessibilityConfig,
  WorkspaceSummary
} from '../App';
import { AdvancedImageSearchModal, IconSearch } from './AdvancedImageSearchModal';
import { buildWslLauncherPayload } from './wslLauncherPayload';
import { eligibleAcceptFromManagers, ManagerGlyph } from './committee';
import { ModelCombobox, type EndpointEntry } from './ModelCombobox';
import {
  claudeAuthFromInitial,
  deriveAuthFields,
  modelFromInitial,
  type ClaudeAuth,
  type ModelSelection
} from './modelPicker';

export type WorkspaceKind = 'container' | 'local';

export interface WorkspaceFormSubmit {
  /** Present iff editing an existing workspace; create flows leave it undefined and the parent mints one. */
  id?: string;
  name: string;
  description?: string;
  labels: string[];
  color?: WorkspaceColor;
  workspaceSubdir: string;
  kind: WorkspaceKind;
  /** Local workspaces only (#16): the host directory `claude` runs in. */
  workspaceRoot?: string;
  /** Local workspaces only (#253): how claude is invoked. undefined ⇒ native. */
  launcher?:
    | { mode: 'native' }
    | {
        mode: 'wsl';
        distro: string;
        shell: string;
        home: string;
        claudePath: string;
        interopEnabled?: boolean;
        /** "Keep" suppression from the claude-update toast (#336) — owned by
         *  the manifest; the form only round-trips it (#339). */
        ignoreClaudeVersion?: string;
      }
    | { mode: 'custom'; command: string };
  /** Per-workspace xterm renderer (#268). undefined ⇒ inherit the app-level
   *  default from Settings. */
  terminalRenderer?: 'dom' | 'canvas' | 'webgl';
  image?: string;
  authMode: AuthMode;
  /** authMode 'endpoint' only — registry reference (#250). */
  endpointId?: string;
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
  /** Durable-transcript-mirror defaults for this workspace. */
  mirror: WorkspaceMirror;
  /**
   * Inbound committee opt-in (#118), edit-mode only. `undefined` means "not
   * reachable" — the parent passes it straight to the manifest, where the
   * writeManifest handler treats an explicit value as authoritative (so
   * toggling reachability off clears it). Outbound grants (`control`) are NOT
   * here — those are edited in the Committee rail, not this form.
   */
  accessibility?: AccessibilityConfig;
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
  /**
   * Whether Docker is reachable. When `false`, the container radio is
   * disabled and the submit button is blocked for container-kind forms.
   * `undefined` (default) behaves as `true` so other callsites are unchanged.
   */
  dockerUp?: boolean;
  onSubmit: (values: WorkspaceFormSubmit, setStatus: (s: string | null) => void) => Promise<void>;
  onCancel: () => void;
  /**
   * Optional Clone action — only meaningful in `mode='edit'`. When set,
   * a Clone button appears between Cancel and Resume in the footer; on
   * click the form validates + bubbles the current values via this
   * callback (the parent re-opens the modal in clone-prefilled state).
   */
  onClone?: (values: WorkspaceFormSubmit) => Promise<void>;
  /**
   * Optional Delete action — only meaningful in `mode='edit'`. When set,
   * a Delete button appears on the far left of the footer. The parent
   * is responsible for confirming + purging state.
   */
  onDelete?: (id: string) => Promise<void>;
  /** Override the primary button label (e.g. "Save" instead of "Resume"). */
  primaryLabel?: string;
  /** Optional slot for extra footer buttons. */
  extraFooterLeft?: ReactNode;
  /** Opens the app Settings modal on a tab — used by "＋ Add endpoint…" and
   *  the endpoint auth note's "edit" link. Threaded from App.tsx. */
  onOpenSettings?: (tab: 'endpoints') => void;
}

export function WorkspaceForm({
  mode,
  initial,
  workspaces,
  vaultAvailable,
  dockerUp,
  onSubmit,
  onCancel,
  onClone,
  onDelete,
  primaryLabel: primaryLabelOverride,
  extraFooterLeft,
  onOpenSettings
}: Props) {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [labelInput, setLabelInput] = useState('');
  const [labels, setLabels] = useState<string[]>(initial?.labels ?? []);
  const [hue, setHue] = useState<number | null>(initial?.color?.hue ?? null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [workspaceSubdir, setWorkspaceSubdir] = useState(initial?.workspaceSubdir ?? '');
  const [model, setModel] = useState<ModelSelection>(() =>
    modelFromInitial(initial?.authMode, initial?.endpointId)
  );
  const [claudeAuth, setClaudeAuth] = useState<ClaudeAuth>(() =>
    claudeAuthFromInitial(initial?.authMode)
  );
  const [endpoints, setEndpoints] = useState<EndpointEntry[]>([]);
  const [endpointsLoaded, setEndpointsLoaded] = useState(false);
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

  const [mirrorDefault, setMirrorDefault] = useState<MirrorSetting>(
    initial?.mirror?.default ?? 'on'
  );
  const [cleanupDefault, setCleanupDefault] = useState<CleanupSetting>(
    initial?.mirror?.cleanup ?? 'delete'
  );
  const [envOpen, setEnvOpen] = useState(envRows.length > 0);
  // Committee opt-in (#118) — inbound "reachable by managers". Edit-mode only.
  const [reachable, setReachable] = useState<boolean>(initial?.accessibility?.reachable ?? false);
  const [roleHint, setRoleHint] = useState<string>(initial?.accessibility?.roleHint ?? '');
  // Inbound acceptFrom whitelist as a set of manager workspace ids (#164).
  // Empty ⇒ "any granted manager". Edited via a manager checkbox list below.
  const [acceptFrom, setAcceptFrom] = useState<string[]>(initial?.accessibility?.acceptFrom ?? []);
  const [committeeOpen, setCommitteeOpen] = useState(initial?.accessibility?.reachable ?? false);
  // Manager workspaces eligible for the acceptFrom list (other container managers).
  const managerOptions = useMemo(
    () => eligibleAcceptFromManagers(workspaces, initial?.id ?? ''),
    [workspaces, initial?.id]
  );
  const toggleAcceptFrom = (id: string): void =>
    setAcceptFrom((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const [kind, setKind] = useState<WorkspaceKind>(initial?.kind ?? (dockerUp === false ? 'local' : 'container'));
  // Local workspaces only: the host directory `claude` runs in (#16).
  const [workspaceRoot, setWorkspaceRoot] = useState<string>(initial?.workspaceRoot ?? '');
  const initialLauncher = initial?.launcher;
  // '' means "inherit the app-level default" (#268).
  const [terminalRenderer, setTerminalRenderer] = useState<'' | 'dom' | 'canvas' | 'webgl'>(
    initial?.terminalRenderer ?? ''
  );
  const [launcherMode, setLauncherMode] = useState<'native' | 'wsl' | 'custom'>(
    initialLauncher?.mode ?? 'native'
  );
  const [platform, setPlatform] = useState<string>('');
  const [wslDistros, setWslDistros] = useState<{ distros: string[]; defaultDistro: string | null }>({ distros: [], defaultDistro: null });
  const [wslDistro, setWslDistro] = useState<string>(
    initialLauncher?.mode === 'wsl' ? initialLauncher.distro : ''
  );
  const [wslProbe, setWslProbe] = useState<
    | { state: 'idle' }
    | { state: 'probing' }
    | { state: 'done'; shells: string[]; loginShell: string; home: string; claudePath: string | null; interopEnabled: boolean }
    | { state: 'error'; message: string }
  >({ state: 'idle' });
  const [wslShell, setWslShell] = useState<string>(
    initialLauncher?.mode === 'wsl' ? initialLauncher.shell : ''
  );
  const [customCommand, setCustomCommand] = useState<string>(
    initialLauncher?.mode === 'custom' ? initialLauncher.command : ''
  );
  const [image, setImage] = useState<string>(initial?.image ?? '');
  const [libraryImages, setLibraryImages] = useState<ImageEntry[]>([]);
  const [imageSearchOpen, setImageSearchOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [namePlaceholder] = useState<string>(petName);

  // Fetch image library and endpoint registry on mount. Auto-default the
  // image input only in create mode — edit mode preserves whatever the
  // manifest had, including an empty value, so containerLevelChanged
  // doesn't see a spurious diff when the user opens-and-saves an edit
  // with no image change.
  const refreshEndpoints = (): void => {
    (window.api.endpoints.list() as Promise<EndpointEntry[]>).then((list) => {
      setEndpoints(list);
      setEndpointsLoaded(true);
    });
  };

  useEffect(() => {
    window.api.images.list().then((entries: ImageEntry[]) => {
      setLibraryImages(entries);
      if (mode === 'create' && !image) {
        const recent = [...entries].sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0];
        setImage(recent?.ref ?? DEFAULT_RUNNER_IMAGE);
      }
    });
    refreshEndpoints();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    void window.api.app.platform().then(setPlatform);
  }, []);
  // Load distros once when local kind is active on Windows.
  useEffect(() => {
    if (kind !== 'local' || platform !== 'win32') return;
    void window.api.local.listWslDistros().then(setWslDistros);
  }, [kind, platform]);
  // Probe on distro change.
  useEffect(() => {
    if (launcherMode !== 'wsl' || !wslDistro) return;
    setWslProbe({ state: 'probing' });
    window.api.local.probeWslDistro(wslDistro).then(
      (p) => {
        setWslProbe({ state: 'done', ...p });
        setWslShell((s) => (s && p.shells.includes(s) ? s : p.loginShell));
      },
      (err: Error) => setWslProbe({ state: 'error', message: err.message })
    );
  }, [launcherMode, wslDistro]);

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

  /**
   * Validate the form and assemble a `WorkspaceFormSubmit`. Returns null
   * when validation failed (the error state is set in that case).
   * Shared by `submit` (primary action) and `clone` (Clone button).
   * `skipNameClash` lets the Clone path defer the name-uniqueness check
   * to the parent's auto-increment of `<source>-2`.
   */
  const buildPayload = (
    opts: { skipNameClash?: boolean } = {}
  ): WorkspaceFormSubmit | null => {
    if (!nameOk) {
      setError('Workspace name must be 1–80 chars with no control characters.');
      return null;
    }
    if (kind === 'local' && !workspaceRoot.trim()) {
      setError('Pick a working directory for the local workspace.');
      return null;
    }
    if (kind === 'local' && launcherMode === 'wsl') {
      if (!wslDistro) { setError('Pick a WSL distro.'); return null; }
      if (wslProbe.state !== 'done' || !wslProbe.claudePath) {
        setError('WSL probe must succeed (claude found in the distro) before saving.');
        return null;
      }
    }
    if (kind === 'local' && launcherMode === 'custom' && !customCommand.trim()) {
      setError('Enter a launch command.');
      return null;
    }
    if (!opts.skipNameClash) {
      const nameClash = workspaces.some(
        (w) => w.name === effectiveName && w.state !== 'deleted' && w.id !== initial?.id
      );
      if (nameClash) {
        setError(`A workspace named "${effectiveName}" already exists.`);
        return null;
      }
    }
    if (kind === 'container' && !image.trim()) {
      setError('Image reference is required for a container workspace.');
      return null;
    }
    const { authMode, endpointId } = deriveAuthFields(model, claudeAuth);
    if (
      model.kind === 'endpoint' &&
      endpointsLoaded &&
      !endpoints.some((e) => e.id === model.endpointId)
    ) {
      setError("This workspace's model endpoint was deleted — pick another model.");
      return null;
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
        return null;
      }
      if (seen.has(k)) {
        setError(`Duplicate env var "${k}".`);
        return null;
      }
      seen.add(k);
      if (row.secret) {
        if (vaultAvailable === false && !row.preExisting) {
          setError(
            `Secret env "${k}" requires the OS keychain, which isn't reachable. ` +
              `Switch the row to plain or install libsecret.`
          );
          return null;
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

    // Inbound committee opt-in. Only meaningful in edit mode; `undefined` when
    // off so the manifest's accessibility block is cleared on save. The list is
    // pruned to workspaces that are CURRENTLY managers — a previously-saved id
    // that is no longer a manager has no checkbox and drops on save (#164).
    const managerIds = new Set(managerOptions.map((m) => m.id));
    const acceptFromList = acceptFrom.filter((id) => managerIds.has(id));
    const accessibility: AccessibilityConfig | undefined =
      mode === 'edit' && reachable
        ? {
            reachable: true,
            ...(acceptFromList.length ? { acceptFrom: acceptFromList } : {}),
            ...(roleHint.trim() ? { roleHint: roleHint.trim() } : {})
          }
        : undefined;

    return {
      id: initial?.id,
      name: effectiveName,
      description: description.trim() || undefined,
      labels,
      color: hue !== null ? { hue } : undefined,
      workspaceSubdir: workspaceSubdir.trim(),
      kind,
      workspaceRoot: kind === 'local' ? workspaceRoot.trim() : undefined,
      launcher:
        kind !== 'local' || launcherMode === 'native'
          ? undefined
          : launcherMode === 'custom'
            ? { mode: 'custom' as const, command: customCommand.trim() }
            : // Same distro ⇒ the manifest owns claudePath/ignoreClaudeVersion
              // (the claude-update toast changes them, #339); the probe only
              // refreshes home/interopEnabled (#259 tri-state preserved).
              buildWslLauncherPayload(
                initialLauncher,
                wslDistro,
                wslShell,
                wslProbe.state === 'done' ? wslProbe : null
              ),
      terminalRenderer: terminalRenderer === '' ? undefined : terminalRenderer,
      image: kind === 'container' ? image.trim() : undefined,
      authMode,
      endpointId,
      plainEnv,
      secretKeys,
      secrets,
      resources,
      mirror: { default: mirrorDefault, cleanup: cleanupDefault },
      accessibility
    };
  };

  const submit = async () => {
    if (busy) return;
    const payload = buildPayload();
    if (!payload) return;
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      // The workspace's private folder (and the shared folder) are created
      // by the backend under the app-level fleet root — nothing to pick or
      // pre-create here.
      await onSubmit(payload, setStatus);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
      setStatus(null);
    }
  };

  const clone = async () => {
    if (busy || !onClone) return;
    // Clone defers the name-clash check to the parent's auto-incrementor
    // (`<source>-2`, `-3`, …) — the user's current name will collide
    // with the source workspace until the suffix lands.
    const payload = buildPayload({ skipNameClash: true });
    if (!payload) return;
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      await onClone(payload);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
      setStatus(null);
    }
  };

  const handleDelete = async () => {
    if (busy || !onDelete || !initial?.id) return;
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      await onDelete(initial.id);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
      setStatus(null);
    }
  };

  const swatchStyle = hue !== null ? { background: `oklch(72% 0.14 ${hue})` } : undefined;
  const primaryLabel = primaryLabelOverride ?? (mode === 'create' ? 'Create & start' : 'Resume');

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
              disabled={busy || dockerUp === false}
            />
            <span>Container</span>
            <span className="kind-help">isolated Docker runner</span>
            {dockerUp === false && <span className="kind-hint">needs Docker — daemon unreachable</span>}
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
            <span className="kind-help">runs claude on this host</span>
          </label>
        </div>
      </div>

      {kind === 'local' && (
        <>
          <div className="form-row" aria-label="Run claude in">
            <label>Run claude in</label>
            <div className="kind-radios" role="radiogroup">
              <label className={`kind-radio ${launcherMode === 'native' ? 'active' : ''}`}>
                <input
                  type="radio"
                  name="launcher-mode"
                  value="native"
                  checked={launcherMode === 'native'}
                  onChange={() => setLauncherMode('native')}
                  disabled={busy}
                />
                This computer
                <span className="kind-help">spawn claude directly</span>
              </label>
              {platform === 'win32' && wslDistros.distros.length > 0 && (
                <label className={`kind-radio ${launcherMode === 'wsl' ? 'active' : ''}`}>
                  <input
                    type="radio"
                    name="launcher-mode"
                    value="wsl"
                    checked={launcherMode === 'wsl'}
                    onChange={() => {
                      setLauncherMode('wsl');
                      if (!wslDistro) setWslDistro(wslDistros.defaultDistro ?? wslDistros.distros[0]);
                    }}
                    disabled={busy}
                  />
                  WSL
                  <span className="kind-help">inside a WSL distro, via your login shell</span>
                </label>
              )}
              <label className={`kind-radio ${launcherMode === 'custom' ? 'active' : ''}`}>
                <input
                  type="radio"
                  name="launcher-mode"
                  value="custom"
                  checked={launcherMode === 'custom'}
                  onChange={() => setLauncherMode('custom')}
                  disabled={busy}
                />
                Custom command
                <span className="kind-help">advanced: your own wrapper</span>
              </label>
            </div>
          </div>

          {launcherMode === 'wsl' && (
            <div className="form-row">
              <label>WSL distro</label>
              <select
                aria-label="WSL distro"
                value={wslDistro}
                onChange={(e) => setWslDistro(e.target.value)}
                disabled={busy}
              >
                {wslDistros.distros.map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
              <label>Shell</label>
              <select
                aria-label="WSL shell"
                value={wslShell}
                onChange={(e) => setWslShell(e.target.value)}
                disabled={busy || wslProbe.state !== 'done'}
              >
                {(wslProbe.state === 'done' ? wslProbe.shells : wslShell ? [wslShell] : []).map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              {wslProbe.state === 'probing' && <p className="form-hint">Probing {wslDistro}…</p>}
              {wslProbe.state === 'error' && <p className="form-hint error-text">Probe failed: {wslProbe.message}</p>}
              {wslProbe.state === 'done' && wslProbe.claudePath && (
                <p className="form-hint">&#10003; claude found at <code>{wslProbe.claudePath}</code></p>
              )}
              {wslProbe.state === 'done' && !wslProbe.claudePath && (
                <p className="form-hint error-text">
                  claude not found in {wslDistro} — install it there or pick another distro.
                </p>
              )}
              {wslProbe.state === 'done' && !wslProbe.interopEnabled && (
                <p className="form-hint">
                  Windows interop is disabled in this distro — fleet tools (claude-fleet-state MCP)
                  will be unavailable in its sessions.
                </p>
              )}
            </div>
          )}

          {launcherMode === 'custom' && (
            <div className="form-row">
              <label>Launch command</label>
              <input
                aria-label="Custom launch command"
                value={customCommand}
                placeholder="my-wrapper {claude} {args}"
                onChange={(e) => setCustomCommand(e.target.value)}
                disabled={busy}
              />
              <p className="form-hint">
                Runs via your platform shell. <code>{'{claude}'}</code> = resolved claude binary,{' '}
                <code>{'{args}'}</code> = fleet flags (appended if omitted — resume and fleet tools
                depend on them). If your command moves claude off this host, session history/cost
                tracking may not see its transcripts. You own quoting.
              </p>
            </div>
          )}

          <div className="form-row">
            <label htmlFor="ws-terminal-renderer">Terminal renderer</label>
            <select
              id="ws-terminal-renderer"
              aria-label="Terminal renderer"
              value={terminalRenderer}
              onChange={(e) =>
                setTerminalRenderer(e.target.value as '' | 'dom' | 'canvas' | 'webgl')
              }
              disabled={busy}
            >
              <option value="">Default (from Settings)</option>
              <option value="dom">dom</option>
              <option value="canvas">canvas</option>
              <option value="webgl">webgl</option>
            </select>
            <p className="form-hint">
              <code>dom</code> is the default and the only renderer with per-glyph font fallback
              for Claude&apos;s symbol glyphs. <code>canvas</code> / <code>webgl</code> paint the
              grid as one element, which avoids stray characters left behind at the left edge when
              scrolling (#268) — reported on local workspaces. Applies to terminals opened after
              saving; <code>webgl</code> falls back to <code>dom</code> if the GPU refuses a
              context.
            </p>
          </div>

          <div className="form-row">
            <label>Working directory</label>
            <div className="input-with-button">
              <input
                aria-label="Working directory"
                value={workspaceRoot}
                placeholder={launcherMode === 'wsl' ? '/home/you/projects/your-repo' : '/home/you/repos/your-project'}
                onChange={(e) => setWorkspaceRoot(e.target.value)}
                disabled={busy}
              />
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={async () => {
                  let picked: string | null;
                  if (launcherMode === 'wsl' && wslDistro) {
                    picked = await window.api.dialog.pickDirectory(`\\\\wsl.localhost\\${wslDistro}\\`);
                    if (picked && /^\\\\wsl/i.test(picked)) {
                      picked = picked.replace(/^\\\\wsl(?:\.localhost|\$)\\[^\\]+/i, '').replace(/\\/g, '/') || '/';
                    }
                  } else {
                    picked = await window.api.dialog.pickDirectory(workspaceRoot || undefined);
                  }
                  if (picked) setWorkspaceRoot(picked);
                }}
              >
                Browse…
              </button>
            </div>
            <p className="form-hint">
              {launcherMode === 'wsl'
                ? <>Runs <code>claude</code> inside <strong>{wslDistro || 'the selected distro'}</strong>; the directory is a path in the distro&apos;s filesystem.</>
                : launcherMode === 'custom'
                  ? 'The directory your launch command runs in.'
                  : <>Runs <code>claude</code> directly on this host (no container) — requires Claude Code installed on your PATH.</>}
            </p>
          </div>
        </>
      )}

      {kind === 'container' && (
        <div className="form-row">
          <label>Image</label>
          <div className="input-with-button">
            <input
              aria-label="Image reference"
              value={image}
              onChange={(e) => setImage(e.target.value)}
              placeholder={DEFAULT_RUNNER_IMAGE}
              disabled={busy}
            />
            <button
              type="button"
              className="image-search-trigger"
              aria-label="Open advanced image search"
              title="Search past images"
              onClick={() => setImageSearchOpen(true)}
              disabled={busy}
            >
              <IconSearch />
            </button>
          </div>
          <ImagePicker
            library={libraryImages}
            filter={image}
            onPick={setImage}
            busy={busy}
          />
          <AdvancedImageSearchModal
            open={imageSearchOpen}
            library={libraryImages}
            workspaces={workspaces}
            currentImage={image}
            onPick={setImage}
            onClose={() => setImageSearchOpen(false)}
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
        <label>Subfolder in /workspace</label>
        <input
          value={workspaceSubdir}
          onChange={(e) => setWorkspaceSubdir(e.target.value)}
          placeholder="(optional) working subdir inside this container's private folder"
          disabled={busy}
        />
      </div>

      <div className="form-row" aria-label="Model">
        <label>Model</label>
        <ModelCombobox
          value={model}
          endpoints={endpoints}
          endpointsLoaded={endpointsLoaded}
          disabled={busy}
          onChange={setModel}
          onOpen={refreshEndpoints}
          onAddEndpoint={onOpenSettings ? () => onOpenSettings('endpoints') : undefined}
        />
      </div>

      {model.kind === 'claude' ? (
        <div className="form-row" aria-label="Auth mode">
          <label>Auth</label>
          <div className="kind-radios" role="radiogroup">
            <label className={`kind-radio ${claudeAuth === 'oauth' ? 'active' : ''}`}>
              <input
                type="radio"
                name="auth-mode"
                value="oauth"
                checked={claudeAuth === 'oauth'}
                onChange={() => setClaudeAuth('oauth')}
                disabled={busy}
              />
              <span>OAuth</span>
              <span className="kind-help">log in via Claude.ai</span>
            </label>
            <label
              className={`kind-radio ${claudeAuth === 'apikey' ? 'active' : ''} ${apiKeyAvailable ? '' : 'disabled'}`}
              title={apiKeyAvailable ? '' : 'Add ANTHROPIC_API_KEY in Env vars to enable'}
            >
              <input
                type="radio"
                name="auth-mode"
                value="apikey"
                checked={claudeAuth === 'apikey'}
                onChange={() => setClaudeAuth('apikey')}
                disabled={busy || !apiKeyAvailable}
              />
              <span>API key {!apiKeyAvailable && '🔒'}</span>
              <span className="kind-help">
                {apiKeyAvailable ? 'ANTHROPIC_API_KEY in env' : 'set ANTHROPIC_API_KEY below'}
              </span>
            </label>
          </div>
        </div>
      ) : (
        <div className="form-row" aria-label="Auth mode">
          <label>Auth</label>
          <div className="auth-note">
            🔑{' '}
            <span>
              <b>{endpoints.find((e) => e.id === model.endpointId)?.name ?? '(deleted endpoint)'}</b>{' '}
              — key from endpoint registry (none stored → placeholder token)
              {onOpenSettings && (
                <>
                  {' · '}
                  <a className="auth-note-edit" onClick={() => onOpenSettings('endpoints')}>
                    edit
                  </a>
                </>
              )}
            </span>
          </div>
        </div>
      )}

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

      <details className="form-disclosure">
        <summary>
          Transcript mirror{' '}
          <span className="form-hint">
            {mirrorDefault === 'on' ? 'on' : 'off'} · {cleanupDefault} on close
          </span>
        </summary>
        <p className="form-hint">
          A durable, compaction-proof copy of each session&apos;s transcript, kept host-side
          (never inside the container). New sessions follow this default; you can override it
          per session before it starts.
        </p>
        <div className="resources-grid">
          <label>
            New sessions
            <select
              value={mirrorDefault}
              onChange={(e) => setMirrorDefault(e.target.value as MirrorSetting)}
              disabled={busy}
            >
              <option value="on">Mirror on</option>
              <option value="off">Mirror off</option>
            </select>
          </label>
          <label>
            On close, default to
            <select
              value={cleanupDefault}
              onChange={(e) => setCleanupDefault(e.target.value as CleanupSetting)}
              disabled={busy}
            >
              <option value="delete">Delete mirror</option>
              <option value="preserve">Keep mirror</option>
            </select>
          </label>
        </div>
      </details>

      {mode === 'edit' && (
        <details
          className="form-disclosure"
          open={committeeOpen}
          onToggle={(e) => setCommitteeOpen((e.target as HTMLDetailsElement).open)}
        >
          <summary>
            Committee access{' '}
            <span className="form-hint">{reachable ? 'reachable' : 'private'}</span>
          </summary>
          <label className="committee-reachable-row">
            <input
              type="checkbox"
              checked={reachable}
              onChange={(e) => setReachable(e.target.checked)}
              disabled={busy}
            />
            <span>Reachable by managers</span>
          </label>
          {reachable && (
            <>
              <div className="committee-warning" role="note">
                <svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true">
                  <path d="M8 1.5L1 14h14L8 1.5z" stroke="currentColor" strokeWidth="1.3" />
                  <path d="M8 6v4M8 11.4v.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                </svg>
                <span>
                  Granted managers can <strong>read this session, type into it, and pause it.</strong>
                </span>
              </div>
              <label>
                Role hint
                <input
                  value={roleHint}
                  onChange={(e) => setRoleHint(e.target.value)}
                  placeholder="e.g. security"
                  disabled={busy}
                />
              </label>
              <div className="committee-acceptfrom">
                <span className="committee-acceptfrom-label">Accept from</span>
                {managerOptions.length === 0 ? (
                  <p className="form-hint">
                    No manager workspaces yet — grant a workspace control over an expert in the Committee
                    rail first.
                  </p>
                ) : (
                  <div className="committee-acceptfrom-list" role="group" aria-label="Accept from managers">
                    {managerOptions.map((m) => (
                      <label key={m.id} className="committee-acceptfrom-row" title={m.id}>
                        <input
                          type="checkbox"
                          checked={acceptFrom.includes(m.id)}
                          onChange={() => toggleAcceptFrom(m.id)}
                          disabled={busy}
                        />
                        <ManagerGlyph size={12} />
                        <span className="committee-acceptfrom-name">{m.name}</span>
                      </label>
                    ))}
                  </div>
                )}
                <p className="form-hint">
                  None selected = any granted manager may control this workspace.
                </p>
              </div>
            </>
          )}
        </details>
      )}

      {status && <div className="form-status">{status}</div>}
      {error && <div className="form-hint error-text">{error}</div>}
      <div className="modal-footer">
        {extraFooterLeft}
        {mode === 'edit' && onDelete && initial?.id && (
          <button
            type="button"
            className="btn danger"
            onClick={handleDelete}
            disabled={busy}
            title="Permanently delete this workspace"
          >
            <IconTrash /> Delete
          </button>
        )}
        <span className="modal-footer-spacer" />
        <button className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        {mode === 'edit' && onClone && (
          <button
            type="button"
            className="btn"
            onClick={clone}
            disabled={busy}
            title="Clone this workspace into a new one"
          >
            <IconCopy /> Clone
          </button>
        )}
        <button
          className="btn primary"
          onClick={submit}
          disabled={busy || (kind === 'container' && dockerUp === false)}
          title={kind === 'container' && dockerUp === false ? 'Docker daemon unreachable' : undefined}
        >
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

function IconTrash(): JSX.Element {
  return (
    <svg viewBox="0 0 12 12" width="11" height="11" fill="currentColor" aria-hidden="true">
      <path d="M4 1 H8 V2 H11 V3 H1 V2 H4 Z M2 4 H10 L9 11 H3 Z" />
    </svg>
  );
}

function IconCopy(): JSX.Element {
  return (
    <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
      <rect x="3" y="3" width="7" height="8" rx="0.8" />
      <path d="M2 8 V2 a1 1 0 0 1 1 -1 H8" />
    </svg>
  );
}
