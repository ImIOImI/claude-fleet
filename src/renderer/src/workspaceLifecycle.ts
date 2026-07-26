// Orchestration for applying a container-level edit (image/env/resources/
// authMode) to a *live* workspace, extracted from App so it can be unit-tested
// with an injected api. Kept dependency-free (no window.api, no React).

/** Saved workspace manifest — the subset needed to recreate a container. */
export interface WorkspaceManifest {
  id: string;
  name: string;
  description?: string;
  labels: string[];
  color?: string;
  workspaceSubdir: string;
  kind: 'container' | 'local';
  workspaceRoot: string;
  image?: string;
  authMode: string;
  env: unknown;
  resources?: unknown;
  mirror: unknown;
}

/** The workspace lifecycle calls this orchestration needs (injected for tests). */
export interface WorkspaceLifecycleApi {
  getManifest(id: string): Promise<WorkspaceManifest | null>;
  ensureImage(onProgress: (p: { message: string }) => void, image?: string): Promise<void>;
  stop(containerId: string): Promise<void>;
  start(id: string): Promise<unknown>;
  remove(containerId: string, opts?: { deleteState?: boolean; id?: string }): Promise<void>;
  create(input: unknown): Promise<unknown>;
}

/**
 * Apply a container-level edit (image/env/resources/authMode) to a live
 * workspace after the restart-to-apply banner's "Restart now".
 *
 * These fields are fixed at container-**create** time, so a stop→start would
 * silently reuse the old spec (the bug this replaces). We instead **recreate**
 * from the saved manifest (already updated by the edit): pull the possibly-new
 * image, then stop → remove → create. The container is removed with
 * `deleteState: false` and recreated with the same `id`, so the workspace's
 * private state dir + vault history stay attached.
 */
export async function applyContainerEdit(
  api: WorkspaceLifecycleApi,
  ids: { id: string; containerId: string },
  onProgress: (message: string) => void = () => {}
): Promise<void> {
  const spec = await api.getManifest(ids.id);
  if (!spec) throw new Error(`No saved manifest for workspace ${ids.id}; cannot recreate.`);

  // Pull the (possibly new) image first so the container is down for the least
  // time. Local workspaces have no image to fetch.
  if (spec.kind === 'container') {
    await api.ensureImage(({ message }) => onProgress(message), spec.image);
  }

  await api.stop(ids.containerId);
  await api.remove(ids.containerId, { deleteState: false, id: ids.id });
  await api.create({
    id: spec.id,
    name: spec.name,
    description: spec.description,
    labels: spec.labels,
    color: spec.color,
    workspaceSubdir: spec.workspaceSubdir,
    kind: spec.kind,
    workspaceRoot: spec.workspaceRoot,
    image: spec.image,
    authMode: spec.authMode,
    env: spec.env,
    resources: spec.resources,
    mirror: spec.mirror
  });
}
