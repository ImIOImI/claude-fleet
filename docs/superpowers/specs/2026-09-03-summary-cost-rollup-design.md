# Summary cost rollup + debounced cache invalidation: kill the recompute storm

**Date:** 2026-09-03
**Status:** Approved (designed with Troy; Option 1 of the #382 fix list — worker-thread reads (#382 item 3) is a separate later round)
**Repo:** claude-fleet
**Follows:** issue #382 (CDP profile naming the blocker), `2026-08-15-summary-read-caches-design.md` (the caches this fixes)

## Problem

The #382 CPU profile attributes **76% of main-thread blocked time** to
synchronous SQLite aggregation in the session-summary path. Two compounding
defects, both verified in source:

1. **The summary cache defeats itself for active sessions.** `db.ts:653`
   calls `summaryCache.invalidate(sessionId)` on *every ingested event*
   (deliberately, so `ai_title`-style session-row updates propagate). For a
   streaming session the 30s TTL never applies: every renderer poll is a
   cache miss that re-runs ~8 synchronous queries, several of which `SUM()`
   over the session's entire event history. Cost grows with session length —
   stall rate tracks event-table growth, not terminal I/O (#379).
2. **`listSessions(undefined)` aggregates the whole events table.**
   `db.ts:1590`: when no `workspaceId` is given, the cost query is
   `SELECT … SUM(...) FROM events GROUP BY session_id, model, service_tier`
   with no WHERE — measured at **4.2s** inside the worst captured stall.
   `SessionsPane` reloads the unfiltered list on every observability push,
   throttled to 1.5s — *shorter than the query itself*, so during active
   streaming the loop is self-amplifying.

`better-sqlite3` is synchronous by design; every one of these runs on the
main thread's event loop.

## Design

### 1. `session_costs` rollup table (migration + ingest upsert)

New table, next schema version:

```sql
CREATE TABLE session_costs (
  session_id                   TEXT NOT NULL,
  model                        TEXT,
  service_tier                 TEXT,
  input_tokens                 INTEGER NOT NULL DEFAULT 0,
  output_tokens                INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens  INTEGER NOT NULL DEFAULT 0,
  event_count                  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, model, service_tier)
);
```

- **Backfill in the migration** with the existing full `GROUP BY` — run
  once, at migration time. (NULL model/service_tier: SQLite PKs treat NULLs
  as distinct, so normalize NULL → '' in the rollup's key columns and map
  back on read, matching how `rollupGroups` treats missing model today.)
- **Maintained in `ingestLine`**: when the event insert actually lands
  (`info.changes > 0` — the same guard `spendCache` uses; duplicate-event
  replays must not double-count), upsert
  `ON CONFLICT(session_id, model, service_tier) DO UPDATE SET
  input_tokens = input_tokens + excluded.input_tokens, …,
  event_count = event_count + 1` with the same parsed token columns the
  event insert already has. Prepared statement, same transaction as the
  event insert.
- **`deleteSession`** deletes the session's rollup rows in the same
  transaction as its event/session deletes.
- **Invariant (pinned by test):** at any commit boundary,
  `session_costs` ≡ `SELECT … FROM events GROUP BY session_id, model,
  service_tier`. Rebuild-on-migration means any future drift also self-heals
  on the next schema bump.

### 2. Readers switch to the rollup

- `listSessions` (both arms — filtered and unfiltered): the cost query reads
  `session_costs` (joining through `sessions` for the workspace filter in
  the filtered arm) instead of aggregating `events`. The unfiltered arm — the
  4.2s offender — becomes an indexed read of a few hundred small rows.
- `summaryForSessionUncached`: its token-total and per-model cost queries
  read `session_costs WHERE session_id = ?`. The session-row lookup and the
  **time-series queries (`tokenSeriesForSession`, `costSeriesForSession`)
  stay on `events`** — a time-bucketed rollup is deliberate non-scope
  (YAGNI; the debounce below bounds their recompute rate; revisit only if a
  future profile implicates them).
- `tokensSpentSinceUncached` (spend window) stays on `events` (time-windowed,
  can't be served by a lifetime rollup; already bucket-cached).

### 3. Debounced invalidation — `markStale`

- `syncKeyedCache` gains `markStale(key: string, graceMs: number)`: caps the
  entry's **remaining** lifetime at `graceMs` (no-op if the entry is already
  due to expire sooner, or absent). `get()` honors the tightened deadline.
- `ingestLine` replaces `summaryCache.invalidate(sessionId)` with
  `summaryCache.markStale(sessionId, 3_000)`. A streaming session's summary
  recomputes **at most once per 3s** regardless of event and poll rates —
  and what it recomputes is now cheap (rollup reads + the two series).
- Hard `invalidate` remains for correctness edges: `deleteSession` (and any
  existing rename/edit paths that call it today keep calling it).
- Freshness bound: summary-derived UI (chip cost/activity) lags at most ~3s;
  the renderer's own poll is 5s, so the debounce is invisible to users.

### 4. Storm-reproduction tests (Troy's explicit requirement)

- **Pure vitest (runs in-container, no better-sqlite3):**
  `syncCache.test.ts` gains a storm simulation with an injected fake clock —
  an event `markStale` every 200ms interleaved with a cached `get` every
  1.5s for a simulated 60s, compute function counts invocations. Assert the
  old `invalidate`-per-event policy computes ~once-per-poll (reproduces the
  storm) and the `markStale(3s)` policy computes ≤ 60/3 + 1 times. Plus
  unit cases: markStale on missing key is a no-op; never *extends* a
  lifetime; interleaves correctly with the 30s TTL.
- **Real-DB integration (CI-verified; better-sqlite3 is ABI-broken in this
  container):** in the db test suite — (a) rollup ≡ from-scratch `GROUP BY`
  after mixed ingest incl. duplicate-event replays and a `deleteSession`;
  (b) `EXPLAIN QUERY PLAN` for `listSessions`' cost query mentions
  `session_costs` and not a scan of `events` — pins the rollup so a future
  refactor can't silently regress to the full scan; (c) a recompute counter
  (test seam) stays bounded while ingesting a burst with interleaved
  `summaryForSession` calls.

## Non-goals

- Worker-thread observability reads (#382 item 3 / Approach B) — separate
  later round; this design makes that migration smaller and safer.
- Time-bucketed series rollup (revisit only on profile evidence).
- Any IPC or renderer change — the payload shapes are untouched; the
  SessionsPane 1.5s reload throttle stays (its query becomes cheap).

## Performance expectations (how we'll judge it)

Post-release A/B against the #379/#382 corpus: the summary-dominated stall
population (every stall >2s in the #382 capture) should collapse;
`sessions:list` slow-op avg (1.6s, max 4.2s in the capture window) should
drop to low ms. The ~17% genuinely-idle blocked-time residue is expected to
REMAIN — that's #382's Option A (ETW) follow-up, to be run after this ships.

## SPEC.md (same-commit rule)

- §6 data model / sqlite schema: `session_costs` table, its invariant,
  maintenance points (ingest upsert, deleteSession, migration backfill).
- §6 observability: the debounced-invalidation semantics (`markStale`,
  3s grace) replacing invalidate-per-event; readers served by the rollup.
