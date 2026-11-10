// Pure view helpers for the left-rail Sessions list (#3, #149).
//
// The Sessions pane loads the full session list once and derives what each
// scope shows from it. Keeping the scope selection pure makes the "All · N"
// badge provably a *session* count (the rows the All view lists) rather than a
// workspace count — the #149 regression.

import type { SessionListItem } from '../../preload';
import {
  LOCAL_ORIGIN,
  appendSessionPage,
  mergeSessionPages,
  pagesOf,
  refreshSessionPage,
  type MergedSessions,
  type RemoteSessionsResult,
  type SessionCursor,
  type UnavailableReason,
  type UnavailableSource
} from '../../preload/federation';

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
  id: string;
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
      s.id === query.trim() ||
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

/** Pull automation-run (headless) sessions out of the Recent rows, keeping
 *  input order in both. They churn — every run lands a new transcript at the
 *  top of a last-active list — so they get their own collapsed group instead
 *  of shoving the user's own sessions down. */
export function splitHeadless<T extends { headless?: boolean }>(
  rows: readonly T[]
): { headless: T[]; rest: T[] } {
  const headless: T[] = [];
  const rest: T[] = [];
  for (const s of rows) (s.headless ? headless : rest).push(s);
  return { headless, rest };
}

/** Pull knowledge-capture forks (#483) out of the Recent rows into their own
 *  collapsed group, like automation runs. */
export function splitCapture<T extends { capture?: boolean }>(rows: readonly T[]): { capture: T[]; rest: T[] } {
  const capture: T[] = [];
  const rest: T[] = [];
  for (const s of rows) (s.capture ? capture : rest).push(s);
  return { capture, rest };
}

export const RECENCY_BUCKET_MS = 30 * 60_000;

/** Newest-first at coarse resolution: last-active is floored to `bucketMs`,
 *  ties broken by start time (newest first) then id. A busy session moves up
 *  at most once per bucket boundary instead of on every transcript write. */
export function orderByRecencyBucket<
  T extends { id: string; startedAt: number | null; lastActiveAt: number | null }
>(rows: readonly T[], bucketMs = RECENCY_BUCKET_MS): T[] {
  const bucket = (s: T): number =>
    s.lastActiveAt == null ? -Infinity : Math.floor(s.lastActiveAt / bucketMs);
  return [...rows].sort(
    (a, b) =>
      bucket(b) - bucket(a) ||
      (b.startedAt ?? -Infinity) - (a.startedAt ?? -Infinity) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
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

// Remote rows (remote-workspaces (d)). A MergedSessions carries its source
// pages on a non-enumerable symbol: never spread or clone it, only pass it to
// the federation.ts helpers.

type Remote = MergedSessions<SessionListItem>;
type RemoteResult = RemoteSessionsResult<SessionListItem>;

export function withRemote(local: SessionListItem[], remote: Remote | null): SessionListItem[] {
  if (!remote || remote.rows.length === 0) return local;
  return mergeSessionPages([{ origin: LOCAL_ORIGIN, rows: local, next: null }, ...pagesOf(remote)]).rows;
}

export const isRemoteRow = (s: SessionListItem): boolean => s.origin !== undefined && s.origin !== LOCAL_ORIGIN;

export function unavailableText(u: UnavailableSource[]): string | null {
  if (u.length === 0) return null;
  return `${u.length} source${u.length === 1 ? '' : 's'} unavailable: ${u.map((x) => x.name).join(', ')}`;
}

function withoutOrigin(cur: Remote, origin: string): Remote | null {
  const rest = pagesOf(cur).filter((p) => p.origin !== origin);
  return rest.length ? mergeSessionPages(rest) : null;
}

/** One origin's fresh first page, over the older pages loaded from it; an
 *  origin missing from `r.pages` (unavailable or unbookmarked) drops out, since
 *  remote data is live-only. */
export function refreshedRemote(cur: Remote | null, r: RemoteResult, origin: string): Remote | null {
  const page = r.pages.find((p) => p.origin === origin);
  if (page) return cur ? refreshSessionPage(cur, page) : mergeSessionPages([page]);
  return cur ? withoutOrigin(cur, origin) : null;
}

/** refreshedRemote for every origin of a full fan-out. */
export function reloadedRemote(cur: Remote | null, r: RemoteResult): Remote | null {
  let m = cur;
  const fresh = new Set(r.pages.map((p) => p.origin));
  for (const p of cur ? pagesOf(cur) : []) if (m && !fresh.has(p.origin)) m = withoutOrigin(m, p.origin);
  for (const page of r.pages) m = m ? refreshSessionPage(m, page) : mergeSessionPages([page]);
  return m;
}

/** Remote origins are workspace ids, so "This workspace" shows only its own. */
export function remoteForScope<T extends { origin: string }>(xs: readonly T[], scope: 'workspace' | 'all', selectedWorkspaceId: string | null): T[] {
  return scope === 'all' ? [...xs] : xs.filter((x) => x.origin === selectedWorkspaceId);
}

/** Appends a load-more reply. A reply whose cursor is no longer the origin's
 *  horizon (a refresh landed first) is ignored; a failed source drops out. */
export function loadedMoreRemote(cur: Remote | null, r: RemoteResult | null, origin: string, after: SessionCursor): Remote | null {
  if (!cur || !r) return cur;
  if (!cur.more.some((m) => m.origin === origin && m.after.id === after.id && m.after.lastActiveAt === after.lastActiveAt)) return cur;
  const page = r.pages.find((p) => p.origin === origin);
  return page ? appendSessionPage(cur, page) : withoutOrigin(cur, origin);
}

export function mergeUnavailable(u: UnavailableSource[], r: RemoteResult, origin: string): UnavailableSource[] {
  return [...u.filter((x) => x.origin !== origin), ...r.unavailable.filter((x) => x.origin === origin)];
}

export interface RemoteResumeInfo { tier: string | null; running: boolean }

export function remoteResumeMap(
  workspaces: ReadonlyArray<{ id: string; kind: string; state: string; remote?: { tier: string | null } }>
): Record<string, RemoteResumeInfo> {
  const out: Record<string, RemoteResumeInfo> = {};
  for (const w of workspaces) {
    if (w.kind === 'remote') out[w.id] = { tier: w.remote?.tier ?? null, running: w.state === 'running' };
  }
  return out;
}

/** Display gate only; the host tier-checks the attach. */
export function canResumeHere(s: SessionListItem, remote: Record<string, RemoteResumeInfo> | undefined): boolean {
  if (!isRemoteRow(s)) return true;
  const b = remote?.[s.workspaceId];
  return b !== undefined && b.tier === 'session' && b.running;
}

/** The transcript-search scope and the line naming who receives the query (D67). */
export function searchTargets(
  scope: 'workspace' | 'all', selected: string | null, remoteNames: Record<string, string>, isLocal: (id: string) => boolean,
): { scope: 'all' | string; label: string } | null {
  if (scope === 'all') {
    const r = Object.values(remoteNames);
    return { scope: 'all', label: `Searching this desktop${r.length ? ` + ${r.join(', ')}` : ''}` };
  }
  if (!selected) return null;
  return { scope: selected, label: isLocal(selected) || !remoteNames[selected] ? 'Searching this desktop' : `Searching ${remoteNames[selected]}` };
}

const SEARCH_REASON: Partial<Record<UnavailableReason, string>> = { disabled: 'search off', model: 'different model' };

export function searchUnavailableText(u: UnavailableSource[]): string | null {
  if (u.length === 0) return null;
  const names = u.map((x) => (SEARCH_REASON[x.reason] ? `${x.name} (${SEARCH_REASON[x.reason]})` : x.name));
  return `${u.length} source${u.length === 1 ? '' : 's'} unavailable: ${names.join(', ')}`;
}

/** Remote bookmark id → display name. */
export function remoteNamesMap(workspaces: ReadonlyArray<{ id: string; kind: string; name: string }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const w of workspaces) if (w.kind === 'remote') out[w.id] = w.name;
  return out;
}

export function relativeTime(ms: number, now = Date.now()): string {
  const delta = now - ms;
  if (delta < 5_000) return 'just now';
  if (delta < 60_000) return `${Math.round(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  return `${Math.round(delta / 86_400_000)}d ago`;
}
