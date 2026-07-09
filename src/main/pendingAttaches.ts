// LEGACY FALLBACK (#195). Queue of broker_session_id → claude_session_id
// pairings waiting to be learned from JSONL appearance order. Since the
// host started assigning claude session ids at CREATE time (`--session-id`,
// see docker.ts/local.ts), production code no longer records pending
// attaches — the mapping is learned deterministically before claude spawns.
// The queue and its consume path remain as the pairing mechanism for
// sessions the host did NOT name (and for the e2e __test seeding hook);
// when consumed with >1 entry pending the pairing is a guess and is logged
// as `mapping-ambiguous-consume`.
//
// Lifetime: an entry sits in the queue from the moment its tab is
// attached until claude writes its first JSONL for that tab. There is
// **no TTL** — claude doesn't write any JSONL until the user actually
// types in the session, and the gap between attaching a tab and typing
// in it can be arbitrarily long. A user opens a new workspace, the
// auto-created "main" tab attaches, the user spends five minutes in
// session 2 before coming back to type in main — that's the realistic
// scenario, and a TTL of any reasonable length would expire the main
// entry long before its JSONL ever appears.
//
// Matching policy: **FIFO**. When `consumeForWorkspace` is called, the
// oldest pending attach for the workspace is consumed and returned.
// The broker usually spawns claudes in attach-order so this pairs
// correctly in the common case; broker-goroutine races can swap the
// pairing within a batch, accepted as the worst-case for "wrong
// sometimes" vs the prior failure mode of "always blank".
//
// Memory: pending entries accumulate within an app session if the
// user opens tabs without ever typing in them. The bound is the
// lifetime user-tab count, in practice ≤ a few dozen. Cleared on app
// restart. Persisting across restart is an open follow-up — without
// it, tabs that were attached in a prior run and never had their
// mapping learned stay unmapped after restart.
//
// Pure module — no DB, no fs, no electron. Module-scope state, but the
// tests can clear it via `_resetForTests`.

interface PendingAttach {
  workspaceId: string;
  brokerSessionId: string;
  recordedAt: number;
}

const pending: PendingAttach[] = [];

export function recordPendingAttach(
  workspaceId: string,
  brokerSessionId: string,
  now = Date.now(),
): void {
  // Dedupe — if the same (workspace, broker_session) is already pending,
  // refresh its timestamp rather than letting two entries linger.
  for (const p of pending) {
    if (p.workspaceId === workspaceId && p.brokerSessionId === brokerSessionId) {
      p.recordedAt = now;
      return;
    }
  }
  pending.push({ workspaceId, brokerSessionId, recordedAt: now });
}

/**
 * Take the oldest pending attach for the workspace and return its
 * `brokerSessionId` (removing it from the queue). Returns null only
 * when no pending attach exists for the workspace.
 */
export function consumeForWorkspace(workspaceId: string): string | null {
  const idx = pending.findIndex((p) => p.workspaceId === workspaceId);
  if (idx === -1) return null;
  const match = pending[idx]!;
  pending.splice(idx, 1);
  return match.brokerSessionId;
}

/**
 * Read-only view of the queue for one workspace, oldest first. Used by the
 * new-session handler to log how ambiguous a FIFO consume was (#195): with
 * more than one entry pending, the pairing is a guess and the snapshot is
 * the evidence trail.
 */
export function pendingSnapshotForWorkspace(
  workspaceId: string,
): Array<{ brokerSessionId: string; recordedAt: number }> {
  return pending
    .filter((p) => p.workspaceId === workspaceId)
    .map((p) => ({ brokerSessionId: p.brokerSessionId, recordedAt: p.recordedAt }));
}

/**
 * Drop a specific pending entry without learning a mapping. Called
 * when the user closes a tab before claude ever wrote anything — the
 * entry would otherwise sit in the queue forever and incorrectly pair
 * with a future JSONL.
 */
export function removePendingAttach(
  workspaceId: string,
  brokerSessionId: string,
): void {
  for (let i = pending.length - 1; i >= 0; i--) {
    const p = pending[i]!;
    if (p.workspaceId === workspaceId && p.brokerSessionId === brokerSessionId) {
      pending.splice(i, 1);
      return;
    }
  }
}

/** Internal: clear all pending state. Vitest-only. */
export function _resetForTests(): void {
  pending.length = 0;
}
