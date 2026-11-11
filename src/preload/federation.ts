// Federated reads: origin identity, keyset cursors and the cross-source merge.
// Pure; main, the host and the renderer import it.

export const LOCAL_ORIGIN = 'local';
export type Origin = string;

/** listSessions' order: COALESCE(last_active_at, 0) DESC, then id in byte order. */
export interface SessionKey { lastActiveAt: number | null; id: string }
export interface SessionCursor { lastActiveAt: number; id: string }

/** UTF-8 byte order, as `COLLATE "C"` and SQLite compare. */
export function compareBytes(a: string, b: string): number {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x !== y) return codeUnitRank(x) - codeUnitRank(y);
  }
  return a.length - b.length;
}

// Surrogates (code points above U+FFFF) rank after U+E000–U+FFFF.
function codeUnitRank(c: number): number {
  if (c < 0xd800) return c;
  return c < 0xe000 ? c + 0x2000 : c - 0x800;
}

export function compareSessionKey(a: SessionKey, b: SessionKey): number {
  return (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0) || compareBytes(a.id, b.id);
}

export function cursorOf(k: SessionKey): SessionCursor {
  return { lastActiveAt: k.lastActiveAt ?? 0, id: k.id };
}

/** One source's newest-first page. `next` null: the source has nothing older. */
export interface SourcePage<T> { origin: Origin; rows: T[]; next: SessionCursor | null }

export type WithOrigin<T> = T & { origin: Origin };

export interface MergedSessions<T> {
  rows: WithOrigin<T>[];
  /** Per incomplete source: rows after this key are not loaded yet. */
  more: { origin: Origin; after: SessionCursor }[];
}

export type UnavailableReason =
  | 'unreachable' | 'checking' | 'timeout' | 'unauthorized' | 'forbidden' | 'standby' | 'not-signed-in' | 'protocol' | 'model' | 'disabled';

export interface UnavailableSource { origin: Origin; name: string; reason: UnavailableReason }

export interface RemoteSessionsResult<T> { pages: SourcePage<T>[]; unavailable: UnavailableSource[] }

type Keyed = SessionKey & { workspaceId: string };

function compareOrigins(a: Origin, b: Origin): number {
  return a === b ? 0 : a === LOCAL_ORIGIN ? -1 : b === LOCAL_ORIGIN ? 1 : compareBytes(a, b);
}

// Internal: the per-source pages a merge was built from, dedup-shadowed rows
// included. A symbol key keeps it off `rows`/`more`, the public shape, and
// out of JSON/Object.keys. pagesOf is the only reader.
const SOURCE_PAGES = Symbol('federation.sourcePages');

function withSourcePages<T extends Keyed>(
  rows: WithOrigin<T>[], more: MergedSessions<T>['more'], pages: SourcePage<T>[]
): MergedSessions<T> {
  const merged = { rows, more } as MergedSessions<T> & { [SOURCE_PAGES]: SourcePage<T>[] };
  Object.defineProperty(merged, SOURCE_PAGES, { value: pages.map((p) => ({ origin: p.origin, rows: [...p.rows], next: p.next })), enumerable: false });
  return merged;
}

/** Merges pages from different sources. Each source's rows must be a prefix of
 *  that source's order. A (workspaceId, id) held by several origins keeps the
 *  local row, else the byte-smallest origin's. */
export function mergeSessionPages<T extends Keyed>(pages: SourcePage<T>[]): MergedSessions<T> {
  const ordered = [...pages].sort((a, b) => compareOrigins(a.origin, b.origin));
  const seen = new Set<string>();
  const rows: WithOrigin<T>[] = [];
  for (const p of ordered) {
    for (const r of p.rows) {
      const key = `${r.workspaceId}\u0000${r.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ ...r, origin: p.origin });
    }
  }
  rows.sort((a, b) => compareSessionKey(a, b) || compareOrigins(a.origin, b.origin));
  const more = ordered.flatMap((p) => (p.next ? [{ origin: p.origin, after: p.next }] : []));
  return withSourcePages(rows, more, pages);
}

/** The per-source pages a merge was built from, dedup-shadowed rows included
 *  (a row a `replace` later drops can reappear from another source). */
export function pagesOf<T extends Keyed>(m: MergedSessions<T>): SourcePage<T>[] {
  const raw = (m as unknown as { [SOURCE_PAGES]: SourcePage<T>[] })[SOURCE_PAGES];
  return raw.map((p) => ({ origin: p.origin, rows: [...p.rows], next: p.next }));
}

/** Adds a source's next page, fetched with that source's `more.after`. */
export function appendSessionPage<T extends Keyed>(cur: MergedSessions<T>, page: SourcePage<T>): MergedSessions<T> {
  const pages = pagesOf(cur);
  const prev = pages.find((p) => p.origin === page.origin);
  const rest = pages.filter((p) => p.origin !== page.origin);
  return mergeSessionPages([...rest, { origin: page.origin, rows: [...(prev?.rows ?? []), ...page.rows], next: page.next }]);
}

/** Replaces everything loaded from one source with its fresh first page. */
export function replaceSessionPage<T extends Keyed>(cur: MergedSessions<T>, page: SourcePage<T>): MergedSessions<T> {
  return mergeSessionPages([...pagesOf(cur).filter((p) => p.origin !== page.origin), page]);
}

/** Puts a source's fresh first page on top of what is loaded from it. Rows
 *  already loaded past the page's `next` stay, with their cursor, so a refresh
 *  doesn't undo "load older"; a row the page also holds keeps the fresh copy. */
export function refreshSessionPage<T extends Keyed>(cur: MergedSessions<T>, page: SourcePage<T>): MergedSessions<T> {
  const pages = pagesOf(cur);
  const prev = pages.find((p) => p.origin === page.origin);
  const rest = pages.filter((p) => p.origin !== page.origin);
  const edge = page.next;
  if (!prev || !edge || (prev.next && compareSessionKey(prev.next, edge) <= 0)) return mergeSessionPages([...rest, page]);
  const fresh = new Set(page.rows.map((r) => `${r.workspaceId}\u0000${r.id}`));
  const older = prev.rows.filter((r) => compareSessionKey(r, edge) > 0 && !fresh.has(`${r.workspaceId}\u0000${r.id}`));
  return mergeSessionPages([...rest, { origin: page.origin, rows: [...page.rows, ...older], next: prev.next }]);
}

/** history:search's 503 body when the host's embedder is off (D79). */
export const SEARCH_UNAVAILABLE = 'search unavailable';

export interface SearchHitItem {
  origin: Origin;
  sessionId: string;
  workspaceId: string;
  workspaceName: string;
  kind: 'turn' | 'summary';
  ts: number | null;
  text: string;
  score: number;
}
export interface FederatedSearchResult { hits: SearchHitItem[]; unavailable: UnavailableSource[] }
