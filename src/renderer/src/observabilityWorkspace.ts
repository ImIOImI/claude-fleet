// Pure helpers for the observability rail's Workspace block. Kept out of the
// React component so they can be unit-tested without pulling in the renderer
// (App.tsx, window globals, etc.).

/** Minimal shape the Workspace block reads — a subset of WorkspaceSummary. */
export interface WorkspacePathInfo {
  workspaceRoot: string;
  workspaceSubdir: string;
  resources?: { cpus?: number; memoryMb?: number };
}

function trimSubdir(subdir: string): string {
  return (subdir ?? '').replace(/^\/+|\/+$/g, '');
}

/**
 * Absolute host path of the workspace's working directory — `workspaceRoot`
 * (bind-mounted at /workspace) joined with `workspaceSubdir`. This is what
 * `fs.openPath` reveals in the OS file manager. No trailing slash.
 */
export function workspaceHostPath(ws: WorkspacePathInfo): string {
  const root = (ws.workspaceRoot ?? '').replace(/\/+$/, '');
  const sub = trimSubdir(ws.workspaceSubdir);
  return sub ? `${root}/${sub}` : root;
}

/**
 * Compact value shown in the Path row. Mirrors the design: the subdir with a
 * leading slash (e.g. `/services/api`). With no subdir, fall back to the full
 * root so the row is never blank.
 */
export function workspacePathLabel(ws: WorkspacePathInfo): string {
  const sub = trimSubdir(ws.workspaceSubdir);
  return sub ? `/${sub}` : ws.workspaceRoot || '/';
}

/** "2 cpu · 4096 MB", or null when no limits are configured. */
export function formatResourceLimits(
  resources: { cpus?: number; memoryMb?: number } | undefined
): string | null {
  if (!resources) return null;
  const parts: string[] = [];
  if (resources.cpus != null) parts.push(`${resources.cpus} cpu`);
  if (resources.memoryMb != null) parts.push(`${resources.memoryMb} MB`);
  return parts.length > 0 ? parts.join(' · ') : null;
}
