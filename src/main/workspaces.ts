// Workspace persistence + listing across runs.
//
// A "workspace" is the user-level concept: a named place where a Claude
// session runs. Today the only backend is a Docker container, but the
// spec is host-stored on disk so the workspace survives the container's
// lifecycle (deletion, recreation) and so future non-container backends
// can plug in without changing the on-disk shape.
//
// On-disk: <userData>/state/<name>/workspace.json
// Sensitive material (API keys) is NOT persisted here — only the profile
// *name*, which is resolved against the vault at start time.

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { workspaceManifestPath, workspaceStateDir, stateRoot } from './paths.js';

export type WorkspaceState = 'running' | 'stopped' | 'deleted';

/**
 * Today: 'container' is a Docker container backend; 'local' is a planned
 * host-process backend (no isolation, just spawn `claude` directly).
 * The selector exists in the UI; the 'local' implementation is deferred.
 */
export type WorkspaceKind = 'container' | 'local';

export interface WorkspaceSpec {
  name: string;
  workspaceRoot: string;
  workspaceSubdir: string;
  profile: string; // vault profile name, or 'oauth'
  kind: WorkspaceKind;
  image?: string; // image reference for kind='container'; undefined for 'local'
  createdAt: number;
  lastUsedAt: number;
}

export interface Workspace extends WorkspaceSpec {
  state: WorkspaceState;
  // Present iff there's a live backend (container) for this workspace.
  containerId?: string;
  status?: string;
}

export async function readWorkspaceManifest(name: string): Promise<WorkspaceSpec | null> {
  try {
    const raw = await readFile(workspaceManifestPath(name), 'utf8');
    const parsed = JSON.parse(raw) as Partial<WorkspaceSpec>;
    if (
      typeof parsed.name !== 'string' ||
      typeof parsed.workspaceRoot !== 'string' ||
      typeof parsed.profile !== 'string'
    ) {
      return null;
    }
    return {
      name: parsed.name,
      workspaceRoot: parsed.workspaceRoot,
      workspaceSubdir: parsed.workspaceSubdir ?? '',
      profile: parsed.profile,
      // Manifests written before the kind/image fields existed default
      // to the container backend with no recorded image.
      kind: parsed.kind ?? 'container',
      image: parsed.image,
      createdAt: parsed.createdAt ?? Date.now(),
      lastUsedAt: parsed.lastUsedAt ?? parsed.createdAt ?? Date.now()
    };
  } catch {
    return null;
  }
}

export async function writeWorkspaceManifest(spec: WorkspaceSpec): Promise<void> {
  await writeFile(workspaceManifestPath(spec.name), JSON.stringify(spec, null, 2) + '\n', 'utf8');
}

export async function touchWorkspaceUsed(name: string): Promise<void> {
  const existing = await readWorkspaceManifest(name);
  if (!existing) return;
  await writeWorkspaceManifest({ ...existing, lastUsedAt: Date.now() });
}

/**
 * Names of every workspace whose state-dir on disk contains a workspace.json.
 * State dirs without a manifest (e.g., pre-rename Docker containers) are
 * invisible to this list — they only surface via the live-container list.
 */
export async function listWorkspaceManifests(): Promise<WorkspaceSpec[]> {
  let entries: string[];
  try {
    entries = await readdir(stateRoot());
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'ENOENT') return [];
    throw err;
  }
  const specs = await Promise.all(entries.map((name) => readWorkspaceManifest(name)));
  return specs.filter((s): s is WorkspaceSpec => s !== null);
}

/**
 * Path of the workspace's state dir (exposed so callers don't need to
 * import paths.ts directly).
 */
export function stateDirOf(name: string): string {
  return workspaceStateDir(name);
}
