// Keyed synchronous cache for the better-sqlite3 observability reads
// (spec 2026-08-15-summary-read-caches-design.md). Hard invalidate() is the
// correctness mechanism for deletes/renames; markStale() is the hot-path
// debounce for frequent writes (#383); ttlMs is only a safety net against a
// missed invalidation path. Eviction is deliberately dumb: when an insert
// would exceed maxEntries, clear everything — recomputing a handful of
// summaries once is cheaper than LRU bookkeeping.

export interface SyncKeyedCache<V> {
  get(key: string, compute: () => V): V;
  invalidate(key: string): void;
  /** Cap the entry's REMAINING lifetime at graceMs (debounced invalidation,
   *  #383): the entry keeps serving until min(its TTL horizon, now+graceMs),
   *  then recomputes. No-op for missing keys; never extends a lifetime; a
   *  recompute clears the cap. Use instead of invalidate() on hot write
   *  paths where per-write invalidation would defeat the cache. */
  markStale(key: string, graceMs: number): void;
  clear(): void;
}

export function syncKeyedCache<V>(opts: {
  maxEntries: number;
  ttlMs?: number;
  now?: () => number;
}): SyncKeyedCache<V> {
  const now = opts.now ?? Date.now;
  const entries = new Map<string, { value: V; at: number; staleAt?: number }>();
  return {
    get(key: string, compute: () => V): V {
      const hit = entries.get(key);
      const fresh =
        hit !== undefined &&
        (opts.ttlMs === undefined || now() - hit.at < opts.ttlMs) &&
        (hit.staleAt === undefined || now() < hit.staleAt);
      if (hit && fresh) return hit.value;
      const value = compute(); // a throw propagates; nothing is cached
      if (!entries.has(key) && entries.size >= opts.maxEntries) entries.clear();
      entries.set(key, { value, at: now() });
      return value;
    },
    invalidate(key: string): void {
      entries.delete(key);
    },
    markStale(key: string, graceMs: number): void {
      const hit = entries.get(key);
      if (!hit) return;
      const horizon = now() + graceMs;
      hit.staleAt = hit.staleAt === undefined ? horizon : Math.min(hit.staleAt, horizon);
    },
    clear(): void {
      entries.clear();
    }
  };
}
