# Event-invalidated caches for the synchronous observability reads

**Date:** 2026-08-15
**Status:** Approved (approach chosen with Troy from the 2026-08-14 slowdown list; worker threads noted as the long-term strategy)
**Repo:** claude-fleet
**Follows:** `2026-08-11-perf-stall-fixes-design.md`, perf dogfood analyses of 2026-08-11/14

## Problem

On build `0.12.0+3f3b8d6` (9.3 h of perf_events): 3,521 stalls, avg 1.27 s —
~1 h of blocked main loop (~11% of wall time); keystrokes averaged 144 ms
renderer→main. The largest *provably synchronous* contributors are the
better-sqlite3 observability reads, re-computing identical answers between
ingests:

| handler | slow instances | avg | sync total |
|---|---|---|---|
| `observability:summaryForBrokerSession` | 2,924 | 211 ms | 616 s |
| `usage:rollingSpend` | 2,209 | 250 ms | 552 s |
| `observability:summaryForWorkspace` | 1,107 | 218 ms | 241 s |

≈ 23 minutes of guaranteed loop blocking in 9 h — and those only count calls
≥25 ms. The same queries also run from the ingest-event broadcast
(`ipc.ts` `jsonlWatcher.on('ingest')` recomputes the workspace summary per
batch) and from renderer polls every 2 s per visible pane. A side casualty:
long sync queries widen the window for the Playwright-CDP-vs-sqlite race
that flaked `broker-sessions.spec.ts` on PR #304's CI run.

Key structural facts (verified 2026-08-15):
- Both summary handlers funnel into **`summaryForSession(claudeSessionId,
  topToolsLimit)`** (`db.ts:816`): `summaryForWorkspace` resolves the
  latest session id first; `summaryForBrokerSession` resolves the
  broker→claude mapping first. One cache on `summaryForSession` covers both.
- `usage:rollingSpend` → **`tokensSpentSince(Date.now() - windowMs)`**
  (`db.ts:794`) — the argument slides every call, so arg-keyed caching never
  hits; the sum also changes as old events age out of the window even with
  no writes.
- All source-data changes flow through enumerable chokepoints: `ingestLine`
  (`db.ts:468`, sole event-row writer on the hot path) and the
  session-deletion paths. Broker-mapping learns do NOT invalidate anything:
  `summaryForBrokerSession` re-resolves the mapping on every call and only
  the post-resolution `summaryForSession` is cached (keyed by claude id).
- `db.ts` trips grep's binary detection (stray byte) — use `grep -a`.

## Decision

**Approach A — keyed synchronous caches with event invalidation, wired
inside `db.ts`.** Sync API and all call sites unchanged. Approach B (moving
reads to a worker thread) is explicitly the long-term strategy if A's
numbers disappoint: it fixes every current and future sync read at the cost
of an async API ripple through IPC and the ingest broadcast. A first —
smallest diff, reversible, measurable.

## Design

### 1. `src/main/syncCache.ts` — pure keyed cache (new module)

```ts
export interface SyncKeyedCache<V> {
  get(key: string, compute: () => V): V;
  invalidate(key: string): void;
  clear(): void;
}
export function syncKeyedCache<V>(opts: {
  maxEntries: number;
  ttlMs?: number;          // optional safety TTL; entries older are recomputed
  now?: () => number;      // test seam
}): SyncKeyedCache<V>
```

- Fully synchronous (the wrapped functions are sync; no promises anywhere).
- `maxEntries` cap: when an insert would exceed it, `clear()` everything —
  no LRU bookkeeping; recomputing a handful of summaries once is cheaper
  than tracking recency (YAGNI).
- `ttlMs` is a **safety net against missed invalidation paths**, not the
  correctness mechanism — event invalidation is.
- Pure module, no imports, direct vitest coverage.

### 2. Wiring in `db.ts`

- **Session summaries:**
  `const summaryCache = syncKeyedCache<WorkspaceSummary | null>({ maxEntries: 512, ttlMs: 30_000 })`.
  `summaryForSession` consults it **only when `topToolsLimit` is the default
  (5)** — non-default limits (none exist among runtime callers today) bypass
  the cache rather than complicating the key.
  Key = the claude session id.
- **Rolling spend:**
  `const spendCache = syncKeyedCache<number>({ maxEntries: 4 })` keyed by
  `String(Math.floor(sinceMs / 15_000))` — the 15 s bucket makes freshness
  emerge from the key itself (a stale bucket is simply never asked for
  again), bounding budget-bar staleness at 15 s, invisible at its 60 s poll
  cadence.
- **Invalidation:**
  - `ingestLine`, on any successful insert for session S:
    `summaryCache.invalidate(S)` + `spendCache.clear()` (token sums changed).
  - Every other `events`/`sessions` mutation found by
    `grep -a -n "DELETE FROM events\|DELETE FROM sessions\|UPDATE events\|UPDATE sessions" src/main/db.ts`
    (session delete, transcript delete, rename paths as applicable):
    `summaryCache.invalidate(<session>)` where the session is known, else
    `summaryCache.clear()`; plus `spendCache.clear()` when token-bearing
    rows are deleted. The implementation plan enumerates the exact sites.
- **Not invalidated (by design):** broker-mapping learns (see Problem);
  pricing tables (compile-time constant).

### 3. What gets faster

- Renderer 2 s summary polls and the per-ingest broadcast recompute: one
  real query per ingest batch, cache hits otherwise.
- `usage:rollingSpend`: one real sum per 15 s bucket per window size
  (vs every 60 s poll × windows today) and after each ingest batch.
- MCP `session_summary` (same `db.ts` reads) benefits transparently.

## Non-goals

- Worker-thread read migration (**Approach B — the agreed long-term path**;
  revisit with post-merge stall data).
- Poll-rate or push-architecture changes in the renderer.
- Caching `computePlanUsage`, `costForSession/Workspace`, or the MCP
  `allowedReadWorkspaces` resolution (separate slowdown-list item).
- Any schema, IPC-surface, or MCP-surface change.

## Testing

- `syncCache.test.ts` — hit/miss, compute-once, TTL expiry (fake `now`),
  cap-clear at `maxEntries`, `invalidate`/`clear`.
- `db`-level tests (pattern of `dbSummaries.test.ts`): the **staleness
  regression test is the critical one** — ingest a new event for a session
  and assert the very next `summaryForSession`/`summaryForWorkspace` call
  reflects it (cache invalidated, not stale); same for `tokensSpentSince`
  after ingest; session-delete makes the summary disappear immediately.
- Perf acceptance (post-merge dogfood): `summaryFor*` + `rollingSpend`
  slow-op counts should collapse to ~one per ingest batch; A/B the stall
  rate across the `app-start` build boundary (build-sha rows from #299).

## SPEC.md (same-commit rule)

§6 Observability: one sentence — the summary/rolling-spend reads are served
from event-invalidated in-memory caches (invalidated by ingest and
deletion; 15 s bucket for the rolling sum), so repeated polls cost one
query per data change rather than one per poll.
