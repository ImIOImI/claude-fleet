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

export type WorkspaceState = 'running' | 'paused' | 'stopped' | 'deleted';

/**
 * Today: 'container' is a Docker container backend; 'local' is a planned
 * host-process backend (no isolation, just spawn `claude` directly).
 * The selector exists in the UI; the 'local' implementation is deferred.
 */
export type WorkspaceKind = 'container' | 'local';

/** Authentication mode for the workspace's `claude` invocation. */
export type AuthMode = 'oauth' | 'apikey';

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
  env: WorkspaceEnv;
  resources?: WorkspaceResources;
  /** Durable-transcript-mirror defaults. Factory `on`/`delete` when absent. */
  mirror: WorkspaceMirror;
  createdAt: number;
  lastUsedAt: number;
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
      authMode: parsed.authMode === 'apikey' ? 'apikey' : 'oauth',
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
      createdAt: parsed.createdAt ?? Date.now(),
      lastUsedAt: parsed.lastUsedAt ?? parsed.createdAt ?? Date.now()
    };
  } catch {
    return null;
  }
}

export async function writeWorkspaceManifest(spec: WorkspaceSpec): Promise<void> {
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
