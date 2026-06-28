/**
 * Which pending-refresh session ids may fire right now: those that are not
 * busy (interrupting a working claude is destructive), not ended (nothing to
 * resume in place), and still present in the tab list (not closed mid-wait).
 * Pure so the busy-defer rule is unit-testable without Electron.
 */
export function readyToRefresh(
  pending: Set<string>,
  busy: Set<string>,
  ended: Set<string>,
  existing: Set<string>
): string[] {
  return [...pending].filter((id) => !busy.has(id) && !ended.has(id) && existing.has(id));
}
