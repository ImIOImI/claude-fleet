// Tiny TTL map used to learn the broker_session_id → claude_session_id
// pairing. `attachPty` records a pending entry per attach; when the
// JsonlWatcher first sees a new claude JSONL in a workspace, it asks
// `consumeForWorkspace` for the matching pending attach.
//
// Matching policy: **FIFO**. When `consumeForWorkspace` is called, the
// oldest pending attach for that workspace is consumed and returned.
//
// The previous single-match-only rule (skip when count > 1) was too
// conservative: in practice a user creating multiple tabs in quick
// succession leaves N pending attaches and N JSONL writes follow
// within milliseconds. Under single-match all N were skipped — the
// ObservabilityPane stayed empty on every tab, the exact bug a user
// reported when typing in the auto-created "main" tab of a fresh
// workspace and clicking + a couple of times before claude had
// written its first event.
//
// FIFO maps them all and is correct in the common case where the
// broker goroutines spawn claudes in roughly attach-order (the host
// dispatches pty:attach sequentially per renderer mount; each spawn
// runs in its own goroutine but the first to start usually finishes
// first). The known failure mode — broker goroutines race and the
// second-attached claude writes its JSONL first — produces a swapped
// pairing for that batch; rare enough that "wrong sometimes" beats
// "always blank" by a wide margin.
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
 * Take the oldest non-expired pending attach for the workspace and
 * return its `brokerSessionId` (removing it from the queue). Returns
 * null only when no pending attach exists for the workspace inside the
 * window. Pruning runs as a side effect on every call.
 */
export function consumeForWorkspace(
  workspaceName: string,
  now = Date.now(),
  windowMs = DEFAULT_WINDOW_MS,
): string | null {
  pruneExpired(now, windowMs);
  const idx = pending.findIndex((p) => p.workspaceName === workspaceName);
  if (idx === -1) return null;
  const match = pending[idx]!;
  pending.splice(idx, 1);
  return match.brokerSessionId;
}

/** Internal: clear all pending state. Vitest-only. */
export function _resetForTests(): void {
  pending.length = 0;
}
