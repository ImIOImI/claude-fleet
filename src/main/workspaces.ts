// Workspace persistence + listing across runs.
//
// A "workspace" is the user-level concept: a named place where a Claude
// session runs. Today the only backend is a Docker container, but the
// spec is host-stored on disk so the workspace survives the container's
// lifecycle (deletion, recreation) and so future non-container backends
// can plug in without changing the on-disk shape.
//
// Identity is a ULID (the immutable `id` field). The user-facing
// `name` is a mutable label, validated to be unique across the fleet.
// State dirs are keyed by id (`<userData>/state/<id>/`) so renames are
// free — the host paths and Docker container labels don't move.
//
// On-disk: <userData>/state/<id>/workspace.json
// Sensitive material (env-var secrets) is NOT persisted here — only the
// list of secret keys; values live in keytar.

import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { workspaceManifestPath, stateRoot } from './paths.js';
import type { WorkspaceLauncher } from './localLauncher.js';

export type WorkspaceState = 'running' | 'paused' | 'stopped' | 'deleted';

/**
 * Today: 'container' is a Docker container backend; 'local' is a planned
 * host-process backend (no isolation, just spawn `claude` directly).
 * The selector exists in the UI; the 'local' implementation is deferred.
 */
export type WorkspaceKind = 'container' | 'local';

/** Authentication mode for the workspace's `claude` invocation. */
export type AuthMode = 'oauth' | 'apikey' | 'endpoint';

/**
 * Per-workspace environment variables. `plain` values live in the
 * manifest on disk; `secretKeys` lists the keys whose values are
 * stored in keytar at `<id>:<key>` (resolved at container-start time).
 */
export interface WorkspaceEnv {
  plain: Record<string, string>;
  secretKeys: string[];
}

/** Optional Docker resource limits. */
export interface WorkspaceResources {
  cpus?: number;
  memoryMb?: number;
}

/** Color identity (single hue from the preset palette; falls back to random when unset). */
export interface WorkspaceColor {
  hue: number;
}

export type MirrorSetting = 'on' | 'off';
export type CleanupSetting = 'delete' | 'preserve';

/**
 * Durable-transcript-mirror defaults for a workspace.
 * - `default`: whether new sessions in this workspace are mirrored unless
 *   overridden per-session at attach time.
 * - `cleanup`: the pre-selected option in the close-time delete/preserve modal.
 * Factory values (applied to legacy manifests with no `mirror` block):
 * `default: 'on'`, `cleanup: 'delete'`.
 */
export interface WorkspaceMirror {
  default: MirrorSetting;
  cleanup: CleanupSetting;
}

export const FACTORY_MIRROR: WorkspaceMirror = { default: 'on', cleanup: 'delete' };

/**
 * Cross-workspace committee control (#116/#117/#118).
 *
 * `read`  — query the target's sessions/events/cost.
 * `post`  — inject input into the target's live session (a manager keystroke).
 * `pause` — pause/unpause (and cold-start) the target container.
 *
 * Authority is **host-private** — these grants live only in the manifest under
 * `<userData>/state/<id>/`, never bind-mounted into a container, so a workspace
 * cannot read or edit its own grants. Enforcement is `control.ts:assertControl`,
 * which re-reads both manifests fresh on every call (instant revocation).
 */
export type CommitteeVerb = 'read' | 'post' | 'pause';
export const COMMITTEE_VERBS: readonly CommitteeVerb[] = ['read', 'post', 'pause'];

/** One outbound grant: the verbs this workspace may exercise on target `id`. */
export interface ControlGrant {
  id: string;
  verbs: CommitteeVerb[];
}

/** Outbound side: what this workspace (a manager) is allowed to do to others. */
export interface ControlConfig {
  canControl?: ControlGrant[];
}

/**
 * Inbound side: this workspace's opt-in to being controlled (default-deny — a
 * workspace is unreachable until it sets `reachable: true`).
 * - `acceptFrom`: if non-empty, only these caller ids may control it; empty/absent
 *   means any caller holding a grant (still gated by the outbound grant).
 * - `roleHint`: free-text lens label surfaced to a manager (e.g. "security").
 */
export interface AccessibilityConfig {
  reachable: boolean;
  acceptFrom?: string[];
  roleHint?: string;
}

/**
 * Record of one loadout installed into a workspace (#16-followup). Tracks the
 * exact things applied so uninstall reverts precisely: dropped files (deleted),
 * and merges (the CLAUDE.md block, the settings.json keys, the .mcp.json server
 * names, the hook ids we added). `merges` is reserved for the PR2 merge layer;
 * PR1 only writes `files` + `merges.claudeMd`.
 */
export interface InstalledLoadout {
  id: string;
  title: string;
  /** Workspace-relative paths this loadout dropped (deleted on uninstall). */
  files: string[];
  merges?: {
    /** Appended a marked block to the workspace CLAUDE.md. */
    claudeMd?: boolean;
    /** Top-level keys added to .claude/settings.json. */
    settingsKeys?: string[];
    /** Server names added to .mcp.json's mcpServers. */
    mcpServers?: string[];
    /** Hook entries appended to settings.hooks, tracked by event + value for
     *  exact removal on uninstall. */
    hooks?: { event: string; entry: unknown }[];
  };
  installedAt: number;
}

export interface WorkspaceSpec {
  /** ULID; identity, immutable. */
  id: string;
  /** Mutable user-facing label; unique across the fleet (validated on save). */
  name: string;
  description?: string;
  labels: string[];
  color?: WorkspaceColor;
  workspaceRoot: string;
  workspaceSubdir: string;
  kind: WorkspaceKind;
  /** Image reference for kind='container'; undefined for 'local'. */
  image?: string;
  authMode: AuthMode;
  /** authMode 'endpoint' only: id into the app-level model-endpoint registry
   *  (<userData>/endpoints.json). A REFERENCE — resolved live at container
   *  create / local spawn, so registry edits apply on next start (#250). */
  endpointId?: string;
  /** Local workspaces only (#253): how `claude` is invoked. Absent ⇒ native
   *  direct spawn. 'wsl' is win32-only (validated by sanitizeLauncher). */
  launcher?: WorkspaceLauncher;
  env: WorkspaceEnv;
  resources?: WorkspaceResources;
  /** Durable-transcript-mirror defaults. Factory `on`/`delete` when absent. */
  mirror: WorkspaceMirror;
  /** Loadouts installed into this workspace (#16-followup). Absent ⇒ none. */
  installedLoadouts?: InstalledLoadout[];
  /** Outbound committee control grants (#118). Absent ⇒ holds no grants. */
  control?: ControlConfig;
  /** Inbound committee opt-in (#118). Absent ⇒ unreachable (default-deny). */
  accessibility?: AccessibilityConfig;
  createdAt: number;
  lastUsedAt: number;
}

/** Drop anything that isn't a well-formed control grant — the manifest parser
 *  is a strict allowlist, so unsanitized fields would silently vanish on the
 *  next read/write round-trip. Returns undefined when no valid grant survives. */
function sanitizeControl(c: unknown): ControlConfig | undefined {
  if (!c || typeof c !== 'object') return undefined;
  const canControl = (c as ControlConfig).canControl;
  if (!Array.isArray(canControl)) return undefined;
  const grants: ControlGrant[] = canControl
    .filter(
      (g): g is ControlGrant =>
        !!g && typeof (g as ControlGrant).id === 'string' && Array.isArray((g as ControlGrant).verbs)
    )
    .map((g) => ({
      id: g.id,
      verbs: g.verbs.filter((v): v is CommitteeVerb => COMMITTEE_VERBS.includes(v as CommitteeVerb))
    }))
    .filter((g) => g.verbs.length > 0);
  return grants.length ? { canControl: grants } : undefined;
}

/** Validate the inbound opt-in block. `reachable` must be an explicit boolean;
 *  anything malformed is dropped (⇒ default-deny). */
function sanitizeAccessibility(a: unknown): AccessibilityConfig | undefined {
  if (!a || typeof a !== 'object') return undefined;
  const obj = a as AccessibilityConfig;
  if (typeof obj.reachable !== 'boolean') return undefined;
  const acceptFrom = Array.isArray(obj.acceptFrom)
    ? obj.acceptFrom.filter((s): s is string => typeof s === 'string')
    : undefined;
  const roleHint = typeof obj.roleHint === 'string' ? obj.roleHint : undefined;
  return {
    reachable: obj.reachable,
    ...(acceptFrom && acceptFrom.length ? { acceptFrom } : {}),
    ...(roleHint ? { roleHint } : {})
  };
}

/** Strict-allowlist launcher validation (#253). 'wsl' additionally requires
 *  win32 — a hand-edited manifest can't activate WSL mode elsewhere. */
export function sanitizeLauncher(
  l: unknown,
  platform: NodeJS.Platform = process.platform
): WorkspaceLauncher | undefined {
  if (!l || typeof l !== 'object') return undefined;
  const o = l as Record<string, unknown>;
  if (o.mode === 'native') return { mode: 'native' };
  if (o.mode === 'custom') {
    return typeof o.command === 'string' && o.command.trim()
      ? { mode: 'custom', command: o.command }
      : undefined;
  }
  if (o.mode === 'wsl') {
    if (platform !== 'win32') return undefined;
    const { distro, shell, home, claudePath, interopEnabled } = o as Record<string, unknown>;
    if ([distro, shell, home, claudePath].every((v) => typeof v === 'string' && v)) {
      return {
        mode: 'wsl',
        distro: distro as string,
        shell: shell as string,
        home: home as string,
        claudePath: claudePath as string,
        // Only a real boolean round-trips (#259). Missing or garbage stays
        // undefined = "not probed" = still wire MCP, which is what every
        // manifest written before this field existed must keep doing.
        ...(typeof interopEnabled === 'boolean' ? { interopEnabled } : {})
      };
    }
  }
  return undefined;
}

export interface Workspace extends WorkspaceSpec {
  state: WorkspaceState;
  // Present iff there's a live backend (container) for this workspace.
  containerId?: string;
  status?: string;
}

/**
 * Parse a stored manifest into a `WorkspaceSpec`. Returns `null` when
 * the file is missing/malformed/incompatible (missing required fields).
 *
 * Callers should treat null as "no manifest" and fall back to whatever
 * the live backend reports. The migration code (separate) is responsible
 * for upgrading legacy on-disk shapes to the current one.
 */
export async function readWorkspaceManifest(id: string): Promise<WorkspaceSpec | null> {
  try {
    const raw = await readFile(workspaceManifestPath(id), 'utf8');
    const parsed = JSON.parse(raw) as Partial<WorkspaceSpec>;
    if (
      typeof parsed.id !== 'string' ||
      typeof parsed.name !== 'string' ||
      typeof parsed.workspaceRoot !== 'string' ||
      typeof parsed.authMode !== 'string'
    ) {
      return null;
    }
    return {
      id: parsed.id,
      name: parsed.name,
      description: parsed.description,
      labels: Array.isArray(parsed.labels) ? parsed.labels.filter((l): l is string => typeof l === 'string') : [],
      color: parsed.color && typeof parsed.color.hue === 'number' ? { hue: parsed.color.hue } : undefined,
      workspaceRoot: parsed.workspaceRoot,
      workspaceSubdir: parsed.workspaceSubdir ?? '',
      kind: parsed.kind ?? 'container',
      image: parsed.image,
      authMode:
        parsed.authMode === 'apikey' ? 'apikey'
        : parsed.authMode === 'endpoint' ? 'endpoint'
        : 'oauth',
      endpointId: typeof parsed.endpointId === 'string' && parsed.endpointId ? parsed.endpointId : undefined,
      launcher: sanitizeLauncher(parsed.launcher),
      env: {
        plain: parsed.env?.plain && typeof parsed.env.plain === 'object' ? parsed.env.plain : {},
        secretKeys: Array.isArray(parsed.env?.secretKeys)
          ? parsed.env!.secretKeys.filter((k): k is string => typeof k === 'string')
          : []
      },
      resources: parsed.resources,
      mirror: {
        default: parsed.mirror?.default === 'off' ? 'off' : FACTORY_MIRROR.default,
        cleanup: parsed.mirror?.cleanup === 'preserve' ? 'preserve' : FACTORY_MIRROR.cleanup
      },
      installedLoadouts: Array.isArray(parsed.installedLoadouts) ? parsed.installedLoadouts : [],
      control: sanitizeControl(parsed.control),
      accessibility: sanitizeAccessibility(parsed.accessibility),
      createdAt: parsed.createdAt ?? Date.now(),
      lastUsedAt: parsed.lastUsedAt ?? parsed.createdAt ?? Date.now()
    };
  } catch {
    return null;
  }
}

/**
 * Manifest states that are supposed to be impossible. Returns a description of
 * the violation, or null when the spec is coherent. Pure — exported for tests
 * and for the startup sweep in index.ts.
 *
 * Today there is exactly one (#323): a `wsl` launcher with a non-Linux
 * `workspaceRoot`. Both writers run `normalizeAndValidateWslRoot`, which
 * rejects exactly that — and yet a live install had one. It cost ~6 days of
 * silent, total observability loss (#313): claude's in-distro cwd is the
 * `/mnt/<drive>` translation of that root, while the watcher derived its path
 * from the stored Windows string, and nothing anywhere said a word.
 */
export function manifestInvariant(spec: WorkspaceSpec): string | null {
  if (
    spec.kind === 'local' &&
    spec.launcher?.mode === 'wsl' &&
    spec.workspaceRoot &&
    !spec.workspaceRoot.startsWith('/')
  ) {
    return `wsl launcher with a non-Linux workspaceRoot: ${spec.workspaceRoot}`;
  }
  return null;
}

export async function writeWorkspaceManifest(spec: WorkspaceSpec): Promise<void> {
  // Every manifest write funnels through here — create, edit,
  // touchWorkspaceUsed, migration — which makes it the one place a violation
  // can't slip past, whichever caller produced it. The stack is the point:
  // #323 is open precisely because the bad state is visible on disk and we
  // cannot tell which code path wrote it.
  const violation = manifestInvariant(spec);
  if (violation) {
    try {
      // Lazily imported: errorLog pulls in electron, and this module is loaded
      // by unit tests that don't mock it. The happy path never reaches here.
      const { logError } = await import('./errorLog.js');
      logError({
        source: 'main',
        type: 'manifest-invariant',
        level: 'error',
        message: violation,
        workspaceId: spec.id,
        extra: {
          workspaceRoot: spec.workspaceRoot,
          launcher: spec.launcher,
          kind: spec.kind,
          // Who wrote it — the evidence #323 is missing.
          stack: new Error('manifest-invariant').stack
        }
      });
    } catch {
      /* logging must never break a manifest write */
    }
  }
  // Ensure the state dir exists. Real backends mkdir it during create, but the
  // mock backend doesn't, and edit/migration paths shouldn't assume it's there.
  const manifestPath = workspaceManifestPath(spec.id);
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, JSON.stringify(spec, null, 2) + '\n', 'utf8');
}

export async function touchWorkspaceUsed(id: string): Promise<void> {
  const existing = await readWorkspaceManifest(id);
  if (!existing) return;
  await writeWorkspaceManifest({ ...existing, lastUsedAt: Date.now() });
}

/**
 * Every workspace whose state-dir on disk contains a workspace.json.
 * State dirs without a manifest are invisible to this list — they only
 * surface via the live-container list (which the IPC layer joins in).
 */
export async function listWorkspaceManifests(): Promise<WorkspaceSpec[]> {
  let entries: string[];
  try {
    entries = await readdir(stateRoot());
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'ENOENT') return [];
    throw err;
  }
  const specs = await Promise.all(entries.map((id) => readWorkspaceManifest(id)));
  return specs.filter((s): s is WorkspaceSpec => s !== null);
}

/**
 * Find a workspace by its user-facing name. Returns null when no manifest
 * with that name exists. Useful for legacy code paths (CLI args, IPC by
 * name) and for the name-uniqueness validator.
 */
export async function findWorkspaceByName(name: string): Promise<WorkspaceSpec | null> {
  const all = await listWorkspaceManifests();
  return all.find((s) => s.name === name) ?? null;
}
