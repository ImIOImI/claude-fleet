// Keyed async cache for the state.db observability reads
// (spec 2026-08-15-summary-read-caches-design.md). Hard invalidate() is the
// correctness mechanism for deletes/renames; markStale() is the hot-path
// debounce for frequent writes (#383); ttlMs is only a safety net against a
// missed invalidation path. Eviction is deliberately dumb: when an insert
// would exceed maxEntries, clear everything.
//
// Async rules: concurrent misses on a key share one compute; a stale entry
// is recomputed and awaited (never served stale past its horizon); an
// invalidate/clear that lands while a compute is in flight wins, so that
// compute's result is returned to its callers but never stored; a markStale
// that lands while a compute is in flight caps the stored result.

export interface AsyncKeyedCache<V> {
  get(key: string, compute: () => Promise<V>): Promise<V>;
  invalidate(key: string): void;
  /** Cap the entry's REMAINING lifetime at graceMs (debounced invalidation,
   *  #383). Never extends a lifetime; a recompute clears the cap. On a key
   *  with a compute in flight, the cap applies to the stored result. */
  markStale(key: string, graceMs: number): void;
  clear(): void;
}

interface Flight<V> {
  promise: Promise<V>;
  /** Set by invalidate/clear: the result is returned but not stored. */
  dropped: boolean;
  staleAt?: number;
}

export function asyncKeyedCache<V>(opts: {
  maxEntries: number;
  ttlMs?: number;
  now?: () => number;
}): AsyncKeyedCache<V> {
  // Lazy lambda: module-level caches are built before test fake-timers
  // install their Date mock.
  const now = opts.now ?? ((): number => Date.now());
  const entries = new Map<string, { value: V; at: number; staleAt?: number }>();
  const flights = new Map<string, Flight<V>>();
  const minHorizon = (a: number | undefined, b: number): number => (a === undefined ? b : Math.min(a, b));

  return {
    get(key: string, compute: () => Promise<V>): Promise<V> {
      const hit = entries.get(key);
      const fresh =
        hit !== undefined &&
        (opts.ttlMs === undefined || now() - hit.at < opts.ttlMs) &&
        (hit.staleAt === undefined || now() < hit.staleAt);
      if (hit && fresh) return Promise.resolve(hit.value);
      const inFlight = flights.get(key);
      if (inFlight) return inFlight.promise;
      let resolve!: (v: V) => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<V>((res, rej) => { resolve = res; reject = rej; });
      const flight: Flight<V> = { promise, dropped: false };
      // The flight holds its real (deferred) promise from the start, before
      // compute() runs, so a synchronous reentrant get(key) from inside
      // compute() shares it instead of a placeholder, and a synchronous throw
      // still unregisters the flight.
      flights.set(key, flight);
      (async () => {
        try {
          const value = await compute(); // a rejection propagates; nothing is stored
          if (!flight.dropped) {
            if (!entries.has(key) && entries.size >= opts.maxEntries) entries.clear();
            entries.set(key, { value, at: now(), staleAt: flight.staleAt });
          }
          resolve(value);
        } catch (err) {
          reject(err);
        } finally {
          if (flights.get(key) === flight) flights.delete(key);
        }
      })();
      return promise;
    },
    invalidate(key: string): void {
      entries.delete(key);
      const flight = flights.get(key);
      if (flight) {
        flight.dropped = true;
        flights.delete(key);
      }
    },
    markStale(key: string, graceMs: number): void {
      const horizon = now() + graceMs;
      const hit = entries.get(key);
      if (hit) hit.staleAt = minHorizon(hit.staleAt, horizon);
      const flight = flights.get(key);
      if (flight) flight.staleAt = minHorizon(flight.staleAt, horizon);
    },
    clear(): void {
      entries.clear();
      for (const flight of flights.values()) flight.dropped = true;
      flights.clear();
    }
  };
}
