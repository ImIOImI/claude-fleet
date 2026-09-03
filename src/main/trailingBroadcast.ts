// Trailing-edge debounce for per-workspace re-broadcast after a summary-cache
// grace window (#383 follow-up). When a burst of ingest events arrives, the
// markStale debounce in db.ts lets the cache serve ≤SUMMARY_STALE_GRACE_MS-
// stale data on every mid-burst push. The last push of the burst therefore
// serves stale data, and nothing re-pushes once the grace expires — leaving
// the renderer with chip data that can be frozen for up to the 30s safety
// poll. This module closes that gap: each ingest call resets a per-workspace
// timer; the timer fires once at (delayMs) after the last ingest for that
// workspace, by which time the grace has fully elapsed and the cache
// recomputes fresh on demand.

/** Factory deps — injectable for tests so no Electron or DB calls needed. */
export interface TrailingRebroadcastDeps {
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof globalThis.setTimeout>;
  clearTimeout: (id: ReturnType<typeof globalThis.setTimeout>) => void;
}

/** Handle returned by makeTrailingRebroadcast. */
export interface TrailingRebroadcast {
  /** Call on every ingest for workspaceId — resets the trailing timer. */
  schedule(workspaceId: string): void;
  /** Cancel all pending timers (call on app quit or test teardown). */
  dispose(): void;
}

/**
 * Build a trailing-edge re-broadcast scheduler.
 *
 * @param delayMs - How long after the last ingest to fire (should be
 *   SUMMARY_STALE_GRACE_MS + a small buffer so the grace has fully elapsed).
 * @param fire - Called once per workspace after quiescence; receives the
 *   workspaceId and should recompute + broadcast the summary.
 * @param deps - Timer shims (defaults to global setTimeout/clearTimeout).
 */
export function makeTrailingRebroadcast(
  delayMs: number,
  fire: (workspaceId: string) => void,
  deps?: Partial<TrailingRebroadcastDeps>
): TrailingRebroadcast {
  const st = deps?.setTimeout ?? globalThis.setTimeout;
  const ct = deps?.clearTimeout ?? globalThis.clearTimeout;
  const timers = new Map<string, ReturnType<typeof globalThis.setTimeout>>();

  return {
    schedule(workspaceId: string): void {
      const existing = timers.get(workspaceId);
      if (existing !== undefined) ct(existing);
      const id = st(() => {
        timers.delete(workspaceId);
        fire(workspaceId);
      }, delayMs);
      // unref so these timers don't hold the Electron main process open if the
      // app is otherwise ready to quit. Matches the widthSweep pattern in ipc.ts.
      (id as { unref?: () => void }).unref?.();
      timers.set(workspaceId, id);
    },

    dispose(): void {
      for (const id of timers.values()) ct(id);
      timers.clear();
    }
  };
}
