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
  workspaceSummary: T | null
): T | null {
  // Match the rail exactly: the selected pane reflects the active tab (which may
  // be null for a fresh/unmapped tab — the bar then renders its empty/identity
  // state, same as the rail), never the workspace-level number.
  return isSelected ? activeTabSummary : workspaceSummary;
}
