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

/** The fields the pane's text search + tag filter read. Matches the
 *  SessionListItem subset so the helpers stay IPC-shape-agnostic. */
export interface SessionFilterable {
  workspaceName: string;
  tags: string[];
  userSetName: string | null;
  aiTitle: string | null;
  firstUserMessage: string | null;
}

/** Text query (case-insensitive substring over display title + workspace
 *  name + all tag text) AND tag filter (OR across activeTags, exact tag
 *  membership — LibraryPane semantics). Empty query/tags = pass. */
export function filterSessions<T extends SessionFilterable>(
  items: readonly T[],
  query: string,
  activeTags: readonly string[]
): T[] {
  const q = query.trim().toLowerCase();
  return items.filter((s) => {
    if (activeTags.length > 0 && !activeTags.some((t) => s.tags.includes(t))) return false;
    if (!q) return true;
    const title = s.userSetName || s.aiTitle || s.firstUserMessage || '';
    return (
      title.toLowerCase().includes(q) ||
      s.workspaceName.toLowerCase().includes(q) ||
      s.tags.some((t) => t.toLowerCase().includes(q))
    );
  });
}

/** Split into open (id ∈ openIds) and recent, preserving input order —
 *  the caller feeds last-active-descending rows, both groups keep it. */
export function partitionByOpen<T extends { id: string }>(
  items: readonly T[],
  openIds: ReadonlySet<string>
): { open: T[]; recent: T[] } {
  const open: T[] = [];
  const recent: T[] = [];
  for (const s of items) (openIds.has(s.id) ? open : recent).push(s);
  return { open, recent };
}

/** Distinct tags with session counts for the Tags ▾ menu, most-used first,
 *  alphabetical within a count. */
export function tagCounts(items: ReadonlyArray<{ tags: string[] }>): Array<[string, number]> {
  const c = new Map<string, number>();
  for (const s of items) for (const t of s.tags) c.set(t, (c.get(t) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
}

/** Display-prefs trim for the Recent group (uiPrefs.maxSessions /
 *  maxSessionAgeDays; 0 = unlimited). Age filter first (rows exactly at the
 *  cutoff stay; null lastActiveAt passes — age unknown ⇒ keep), then the
 *  newest-N cap — items arrive last-active-descending (db.ts listSessions),
 *  so a plain slice IS "newest N". `now` is injected for testability. */
export function limitSessions<T extends { lastActiveAt: number | null }>(
  items: readonly T[],
  opts: { maxCount: number; maxAgeDays: number },
  now: number
): T[] {
  let out = [...items];
  if (opts.maxAgeDays > 0) {
    const cutoff = now - opts.maxAgeDays * 86_400_000;
    out = out.filter((s) => s.lastActiveAt == null || s.lastActiveAt >= cutoff);
  }
  if (opts.maxCount > 0) out = out.slice(0, opts.maxCount);
  return out;
}
