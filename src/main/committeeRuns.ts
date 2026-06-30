// Host-enforced runaway guards for committee runs (#121). The manager's loop is
// driven by an LLM, so the caps here are **host-enforced, not prompt-enforced** —
// a misbehaving or looping manager can't talk its way past them. State is kept
// in main, keyed by manager workspace id, and is intentionally simple: a
// cumulative post counter (there is deliberately no dollar cost cap — committee
// experts run without a spend ceiling). v1 has no explicit "convene"
// primitive, so a run = "everything this manager has posted since the app
// started" (resets on host restart); #123's run-committee skill can add an
// explicit reset when it lands.

/** Caps. Env-overridable so a power user can widen them without a rebuild. */
function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export const COMMITTEE_CAPS = {
  /** Max committee posts a single manager may issue per run. */
  maxPosts: envInt('COMMITTEE_MAX_POSTS', 40),
  /** A reachable expert busy longer than this since its last flip is "stalled". */
  turnTimeoutMs: envInt('COMMITTEE_TURN_TIMEOUT_MS', 180_000)
};

export interface BudgetVerdict {
  exceeded: boolean;
  reason?: string;
}

const postsByManager = new Map<string, number>();

/** Live view of a manager's run (for status/telemetry). */
export function committeeRun(managerId: string): { posts: number } {
  return { posts: postsByManager.get(managerId) ?? 0 };
}

/**
 * Would the *next* post by `managerId` breach a cap? Pure given its inputs, so
 * the truth table is unit-testable. Only the about-to-be post count (current +
 * 1) is checked — committee runs have no dollar cost control (the USD ceiling
 * was removed; experts are meant to run without a spend cap).
 */
export function wouldExceed(managerId: string): BudgetVerdict {
  const nextPosts = (postsByManager.get(managerId) ?? 0) + 1;
  if (nextPosts > COMMITTEE_CAPS.maxPosts) {
    return { exceeded: true, reason: `max posts per run reached (${COMMITTEE_CAPS.maxPosts})` };
  }
  return { exceeded: false };
}

/** Record a permitted post against the manager's run counter. */
export function recordPost(managerId: string): void {
  postsByManager.set(managerId, (postsByManager.get(managerId) ?? 0) + 1);
}

/** Reset a manager's run counter (host restart, or a future explicit convene). */
export function resetRun(managerId: string): void {
  postsByManager.delete(managerId);
}
