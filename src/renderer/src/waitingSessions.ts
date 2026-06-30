// Helpers for distributing input-wait state (AskUserQuestion) from App down
// to the Sessions list and workspace chip.

/**
 * Union of all workspaces' waiting claude-session UUIDs.
 * Used by the Sessions list (keyed by claude UUID) and the terminal pane.
 */
export function mergeWaitingSessionIds(byWorkspace: Map<string, Set<string>>): Set<string> {
  const out = new Set<string>();
  for (const set of byWorkspace.values()) {
    for (const id of set) out.add(id);
  }
  return out;
}

/**
 * Per-workspace boolean: true when the workspace has at least one session
 * blocked on AskUserQuestion. Used to drive the workspace chip's waiting dot.
 */
export function waitingFlags(byWorkspace: Map<string, Set<string>>): Record<string, boolean> {
  const rec: Record<string, boolean> = {};
  for (const [wsId, set] of byWorkspace) {
    rec[wsId] = set.size > 0;
  }
  return rec;
}
