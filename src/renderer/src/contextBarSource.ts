// Which observability summary drives a TerminalPane's context bar (#148).
//
// App distributes a workspace-level summary (most-recently-active session) to
// every pane, but it ALSO computes a per-active-tab summary for the selected
// workspace (`activeTabSummary`, fed to the observability rail). The terminal's
// context bar must use that per-tab value for the workspace the user is looking
// at, or every session tab shows the same workspace-level fill regardless of
// which tab is active. Off-screen panes (not selected) have no active-tab
// summary computed, so they keep the workspace summary.
//
// Pure so the selection is unit-tested directly, independent of React.

export function contextBarSummary<T>(
  isSelected: boolean,
  activeTabSummary: T | null,
  workspaceSummary: T | null,
  activeTabIsFresh: boolean
): T | null {
  // Off-screen panes have no active-tab summary computed — keep the workspace one.
  if (!isSelected) return workspaceSummary;
  // The selected pane reflects its active tab when that summary has resolved.
  if (activeTabSummary) return activeTabSummary;
  // No per-tab summary yet. Mirror the rail's fallback (SPEC §6): a fresh
  // (+-created) tab legitimately has no data → show the empty/identity state
  // rather than another session's numbers; an inventory/loaded tab whose
  // broker_sessions mapping hasn't been learned yet falls back to the workspace
  // summary so the bar still surfaces activity until the mapping catches up.
  return activeTabIsFresh ? null : workspaceSummary;
}
