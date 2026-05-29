// Tiny TTL map used to learn the broker_session_id → claude_session_id
// pairing. `attachPty` records a pending entry per attach; when the
// JsonlWatcher first sees a new claude JSONL in a workspace, it asks
// `consumeForWorkspace` for the matching pending attach.
//
// Disambiguation: we only auto-map when exactly ONE pending attach is
// in flight for the workspace inside the window. Concurrent attaches
// (e.g., three tabs re-mounted simultaneously on app restart) deliver
// multiple new-JSONL events in close succession; without an explicit
// id we'd have to pair them by arrival order, and broker goroutines
// can race. A wrong mapping shows wrong data for a tab forever, which
// is strictly worse than no mapping (no mapping falls back to the
// workspace summary — v1 behavior). So this module is conservative
// by design: when in doubt, skip and let the fallback handle it.
//
// Pure module — no DB, no fs, no electron. Module-scope state, but the
// tests can clear it via `_resetForTests`.

interface PendingAttach {
  workspaceName: string;
  brokerSessionId: string;
  recordedAt: number;
}

/** Window during which a freshly-recorded attach is considered for matching. */
export const DEFAULT_WINDOW_MS = 30_000;

const pending: PendingAttach[] = [];

function pruneExpired(now: number, windowMs: number): void {
  const cutoff = now - windowMs;
  for (let i = pending.length - 1; i >= 0; i--) {
    if (pending[i]!.recordedAt < cutoff) pending.splice(i, 1);
  }
}

export function recordPendingAttach(
  workspaceName: string,
  brokerSessionId: string,
  now = Date.now(),
): void {
  // Dedupe — if the same (workspace, broker_session) is already pending,
  // refresh its timestamp rather than letting two entries linger.
  for (const p of pending) {
    if (p.workspaceName === workspaceName && p.brokerSessionId === brokerSessionId) {
      p.recordedAt = now;
      return;
    }
  }
  pending.push({ workspaceName, brokerSessionId, recordedAt: now });
}

/**
 * Look for a single unambiguous pending attach for the given workspace
 * within the window. Returns the matched `brokerSessionId` and removes
 * it from the pending list; returns null when there are zero or >1
 * candidates (the "ambiguous, skip" case — see the top-of-file
 * disambiguation rule). Always prunes expired entries as a side effect.
 */
export function consumeForWorkspace(
  workspaceName: string,
  now = Date.now(),
  windowMs = DEFAULT_WINDOW_MS,
): string | null {
  pruneExpired(now, windowMs);
  const matches = pending.filter((p) => p.workspaceName === workspaceName);
  if (matches.length !== 1) return null;
  const match = matches[0]!;
  const idx = pending.indexOf(match);
  if (idx >= 0) pending.splice(idx, 1);
  return match.brokerSessionId;
}

/** Internal: clear all pending state. Vitest-only. */
export function _resetForTests(): void {
  pending.length = 0;
}
