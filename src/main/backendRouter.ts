// Per-workspace backend routing (#16). Kept separate from `ipc.ts` so the
// disk-reading routing decision is unit-testable without importing the heavy
// ipc graph (dockerode, better-sqlite3) that can't load under vitest.

import { readWorkspaceManifest, type WorkspaceKind } from './workspaces.js';

/**
 * Resolve a workspace's kind from its on-disk manifest.
 *
 * Safe for every channel's identifier:
 *  - id-keyed ops (start/create) pass the ULID directly → manifest found.
 *  - containerId-keyed ops (stop/pause/remove/attach) work because a *local*
 *    workspace's containerId surrogate equals its id, so the manifest is found;
 *    a real Docker container id (64-hex) has no manifest at that path, so this
 *    returns the `'container'` default — exactly the right backend.
 */
export async function resolveKind(idOrContainerId: string): Promise<WorkspaceKind> {
  const m = await readWorkspaceManifest(idOrContainerId);
  return m?.kind ?? 'container';
}

/** workspace:remove routes by `optsId` but acts on `containerId`; refuse when they name different kinds. */
export async function resolveRemoveKind(containerId: string, optsId?: string): Promise<WorkspaceKind> {
  const kind = await resolveKind(optsId ?? containerId);
  if (optsId && containerId && optsId !== containerId && (await resolveKind(containerId)) !== kind) {
    throw new Error('workspace:remove: the container id belongs to a different workspace');
  }
  return kind;
}
