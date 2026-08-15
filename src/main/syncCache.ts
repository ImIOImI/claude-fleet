// Keyed synchronous cache for the better-sqlite3 observability reads
// (spec 2026-08-15-summary-read-caches-design.md). Event invalidation is
// the correctness mechanism; ttlMs is only a safety net against a missed
// invalidation path. Eviction is deliberately dumb: when an insert would
// exceed maxEntries, clear everything — recomputing a handful of summaries
// once is cheaper than LRU bookkeeping.

export interface SyncKeyedCache<V> {
  get(key: string, compute: () => V): V;
  invalidate(key: string): void;
  clear(): void;
}

export function syncKeyedCache<V>(opts: {
  maxEntries: number;
  ttlMs?: number;
  now?: () => number;
}): SyncKeyedCache<V> {
  const now = opts.now ?? Date.now;
  const entries = new Map<string, { value: V; at: number }>();
  return {
    get(key: string, compute: () => V): V {
      const hit = entries.get(key);
      if (hit && (opts.ttlMs === undefined || now() - hit.at < opts.ttlMs)) {
        return hit.value;
      }
      const value = compute(); // a throw propagates; nothing is cached
      if (!entries.has(key) && entries.size >= opts.maxEntries) entries.clear();
      entries.set(key, { value, at: now() });
      return value;
    },
    invalidate(key: string): void {
      entries.delete(key);
    },
    clear(): void {
      entries.clear();
    }
  };
}
