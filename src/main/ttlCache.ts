/**
 * Tiny promise cache for one expensive async fetch (no keys, no eviction).
 *
 * Semantics chosen for `listAllWorkspaces()` (the hot merged docker+WSL+manifest
 * list behind `workspace:list` and half a dozen internal callers):
 * - Concurrent gets share one in-flight fetch — the renderer's poll bursts
 *   collapse to a single backend round-trip.
 * - The freshness window starts when the fetch RESOLVES. An in-flight fetch is
 *   never considered stale, so a fetch that outlives the TTL (event-loop stall,
 *   slow docker daemon) can't stampede into parallel refetches.
 * - Rejections are never cached; the next get retries.
 * - `invalidate()` drops the entry — including one still in flight, which may
 *   carry pre-mutation state — so mutators can force the next read fresh.
 */
export interface TtlCache<T> {
  get(): Promise<T>;
  invalidate(): void;
}

export function ttlCache<T>(
  fetch: () => Promise<T>,
  ttlMs: number,
  now: () => number = Date.now
): TtlCache<T> {
  // resolvedAt is null while the fetch is in flight.
  let entry: { resolvedAt: number | null; promise: Promise<T> } | null = null;
  return {
    get(): Promise<T> {
      if (entry && (entry.resolvedAt === null || now() - entry.resolvedAt < ttlMs)) {
        return entry.promise;
      }
      const e: { resolvedAt: number | null; promise: Promise<T> } = {
        resolvedAt: null,
        promise: fetch()
      };
      entry = e;
      e.promise.then(
        () => {
          e.resolvedAt = now(); // stamps a dead object if invalidated meanwhile — harmless
        },
        () => {
          if (entry === e) entry = null;
        }
      );
      return e.promise;
    },
    invalidate(): void {
      entry = null;
    }
  };
}
