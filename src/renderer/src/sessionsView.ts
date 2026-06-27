// Pure view helpers for the left-rail Sessions list (#3, #149).
//
// The Sessions pane loads the full session list once and derives what each
// scope shows from it. Keeping the scope selection pure makes the "All · N"
// badge provably a *session* count (the rows the All view lists) rather than a
// workspace count — the #149 regression.

/** Sessions to display for a scope.
 *  - 'all'       → every session across every workspace (what the badge counts).
 *  - 'workspace' → only the selected workspace's sessions; none when nothing is selected. */
export function sessionsForScope<T extends { workspaceId: string }>(
  all: readonly T[],
  scope: 'workspace' | 'all',
  selectedWorkspaceId: string | null
): T[] {
  if (scope === 'all') return [...all];
  if (!selectedWorkspaceId) return [];
  return all.filter((s) => s.workspaceId === selectedWorkspaceId);
}
