// Local (non-container) workspace backend (#16): runs `claude` as a host child
// process (node-pty) against a host directory, no Docker layer.
//
// PR1 (backend interface + router) ships this as a STUB: `listLiveWorkspaces`
// returns nothing and every mutation throws. The renderer + `workspace:create`
// still block `kind:'local'`, so the router never actually reaches these
// mutations yet — this exists so `ipc.ts` can wire the dispatcher against a
// real module. PR2 implements the session manager, spawn/attach, and lifecycle.

import type { Backend } from './backend.js';
import type { Workspace } from './workspaces.js';
import type {
  CreateWorkspaceInput,
  ImageInspectResult,
  PullProgress,
  PtyHandle,
  RemoveWorkspaceOpts
} from './docker.js';

const NOT_IMPLEMENTED = 'local backend not implemented yet (#16, PR2)';

export async function ping(): Promise<boolean> {
  // Real readiness (`which claude`) lands in PR2; the daemon indicator (#23)
  // still probes the Docker backend, so this isn't consulted yet.
  return false;
}

export async function ensureImage(_onProgress: (p: PullProgress) => void): Promise<void> {
  // No image to pull for a host process.
}

export async function listLiveWorkspaces(): Promise<Workspace[]> {
  return [];
}

export async function createWorkspace(_spec: CreateWorkspaceInput): Promise<Workspace> {
  throw new Error(NOT_IMPLEMENTED);
}

export async function inspectImage(_ref: string): Promise<ImageInspectResult> {
  throw new Error('local workspaces have no image to inspect');
}

export async function startWorkspace(_id: string): Promise<string | null> {
  throw new Error(NOT_IMPLEMENTED);
}

export async function pauseWorkspace(_containerId: string): Promise<void> {
  throw new Error(NOT_IMPLEMENTED);
}

export async function stopWorkspace(_containerId: string): Promise<void> {
  throw new Error(NOT_IMPLEMENTED);
}

export async function removeWorkspace(
  _containerId: string,
  _opts?: RemoveWorkspaceOpts
): Promise<void> {
  throw new Error(NOT_IMPLEMENTED);
}

export async function attachPty(
  _containerId: string,
  _sessionId: string,
  _cols: number,
  _rows: number,
  _resumeOf?: string
): Promise<PtyHandle> {
  throw new Error(NOT_IMPLEMENTED);
}

export async function getBrokerLogs(_containerId: string, _tailLines?: number): Promise<string> {
  return '';
}

// Compile-time assertion that this module satisfies the Backend contract.
// (A namespace import of this file is assigned to `Backend` in ipc.ts; this
// makes a mismatch fail here, at the source, with a clearer error.)
const _assertBackend: Backend = {
  ping,
  ensureImage,
  listLiveWorkspaces,
  createWorkspace,
  inspectImage,
  startWorkspace,
  pauseWorkspace,
  stopWorkspace,
  removeWorkspace,
  attachPty,
  getBrokerLogs
};
void _assertBackend;
