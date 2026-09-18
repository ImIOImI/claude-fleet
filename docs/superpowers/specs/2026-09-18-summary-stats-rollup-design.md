# Summary stats rollup + session/type index: round 2 of the recompute fix

**Date:** 2026-09-18
**Status:** Approved (designed with Troy; items 1+2 of the #386 re-profile fix list — item 4 deferred with evidence, item 3 pending re-measurement)
**Repo:** claude-fleet
**Follows:** `2026-09-03-summary-cost-rollup-design.md` (#383/#384), the 2026-09-18 CDP re-profile on #386

## Problem

The #386 re-profile (v0.13.15, 900s capture) shows the summary path still
owns **77.9%** of stall-window samples after #384. Span *duration* capped
(<1s) but span *count* per stall did not — stalls are stacked recomputes.
Inside `summaryForSessionUncached`, the cost is **81% inline `events`
queries** (series queries only ~19%):

1. **`observedMax` picks the wrong index** (`db.ts`, the
   `MAX(input+cache_read+cache_creation) … WHERE session_id = ? AND
   type = 'assistant'` query): the planner chooses `idx_events_type` and
   scans every assistant row in the table (84,388 rows to find one
   session's 4). Measured 56–61ms as shipped; 3ms with a composite
   `(session_id, type)` index (~19× on the profile's hottest query). Same
   defect class as #382's unfiltered `listSessions`; it survived #384
   because the rollup replaced the aggregate query, not this inline one.
   Degrades with total table growth, independent of session size.
2. **`topTools` is O(session history)**: `GROUP BY tool_name` over the
   session's events (22ms on a 66k-event session, temp B-tree for
   GROUP BY + ORDER BY), re-run on every summary recompute.

## Design

### 1. Migration v14 (single migration, three parts)

```sql
CREATE INDEX idx_events_session_type ON events(session_id, type);

CREATE TABLE session_stats (
  session_id          TEXT PRIMARY KEY,
  max_context_tokens  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE session_tool_counts (
  session_id  TEXT NOT NULL,
  tool_name   TEXT NOT NULL,
  count       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, tool_name)
);
```

- Both tables `DROP TABLE IF EXISTS` first and **backfill from `events`**
  in the migration (the `session_costs` rebuild-on-migration self-heal
  pattern): `session_stats` from
  `MAX(COALESCE(input_tokens,0)+COALESCE(cache_read_input_tokens,0)+COALESCE(cache_creation_input_tokens,0))`
  over `type='assistant'` rows grouped by session;
  `session_tool_counts` from `COUNT(*) GROUP BY session_id, tool_name
  WHERE tool_name IS NOT NULL`.
- The index also serves the `latestAssistant` query
  (`session_id + type='assistant' … ORDER BY id DESC LIMIT 1`) for free —
  no code change there.

### 2. Ingest maintenance (inside the existing `ingestEventTx`)

When the event insert lands (`info.changes > 0` — same duplicate-replay
guard as `session_costs`):

- `type === 'assistant'` and any token column non-null → upsert
  `session_stats` with
  `max_context_tokens = MAX(max_context_tokens, excluded.max_context_tokens)`
  (candidate = the same COALESCE sum the reader uses today).
- `tool_name IS NOT NULL` → upsert `session_tool_counts` with
  `count = count + 1`.
- `deleteSession` deletes both tables' rows in its existing transaction.
- **Invariants (pinned by CI tests):** at every commit boundary,
  `session_stats` ≡ the MAX-recompute from `events`, and
  `session_tool_counts` ≡ the GROUP BY recompute — including after
  duplicate replays, `deleteSession`, and a forced migration rebuild
  (`user_version` wind-back), mirroring `dbSessionCosts.test.ts`.

### 3. Readers

- `observedMax` in `summaryForSessionUncached` →
  `SELECT max_context_tokens FROM session_stats WHERE session_id = ?`
  (absent row ⇒ 0, same as today's COALESCE).
- `topTools` →
  `SELECT tool_name AS name, count FROM session_tool_counts WHERE
  session_id = ? ORDER BY count DESC, tool_name LIMIT ?`. The
  `topToolsLimit` parameter and the non-default-limit cache bypass in
  `summaryForSession` are unchanged. (Tie-break by `tool_name` makes
  ordering deterministic where the old query left ties to chance —
  acceptable, strictly more stable.)
- Everything else stays put: series queries (`token/costSeriesForSession`)
  remain on `events` (item 3 — pending re-measurement),
  `recentToolCallsForSession` (0.4% of cost) stays, `latestAssistant`
  stays (now index-served).

### 4. Item 4 ("dedupe recompute fan-out") — deferred, with evidence

The #386 report suggested deduping in-flight recomputes across
`summaryForWorkspace`/`summaryForBrokerSession`. Investigation shows both
already share one cache entry: `DEFAULT_TOP_TOOLS = 5` and
`summaryForWorkspace`'s default `topToolsLimit = 5`, so both funnel into
the same cached `summaryForSession` (pinned by an existing
`dbReadCache.test.ts` case), and synchronous compute has no in-flight
window to dedupe. The observed 285 calls/15min is the designed debounce
bound (≤1 recompute / 3s / active session) × N active sessions; the
problem is each recompute's cost, which this round cuts ~80%. Re-measure
after v14: if `summaryFor*` spans still exceed the 25ms slow-op threshold
at volume, the remaining cost is the series queries (item 3, bucketed
rollup) — not coalescing.

## Non-goals

- Bucketed series rollup (item 3) — decide on post-v14 profile evidence.
- Worker-thread reads (#382 item 3) — re-measure first, per #386.
- ETW round — still not indicated (idle residue flat at ~21%).
- Any IPC or renderer change.

## Testing

- **CI DB tests** (`dbSessionStats.test.ts`, patterned on
  `dbSessionCosts.test.ts`; better-sqlite3 is ABI-broken in the dev
  container so these are CI-verified): both invariants over mixed ingest
  (assistant with/without tokens, tool_use lines, NULL-tool lines,
  duplicate replays), delete scoping, migration rebuild; an
  `EXPLAIN QUERY PLAN` pin that the summary path's remaining `events`
  queries (`latestAssistant`) use a `session_id`-prefixed index and that
  `observedMax`/`topTools` no longer touch `events` at all (their SQL now
  names the rollup tables — pin the exported SQL strings like
  `LIST_SESSION_COSTS_SQL`).
- **Reader equivalence:** summary output (maxContextTokens/topTools
  fields) identical to an events-side recompute on the same fixture.
- Existing suites (`syncCache`, `dbSessionCosts`, `dbReadCache`) must pass
  unchanged — no behavior change to caching or costs.

## Performance expectations

Per the #386 profile: `observedMax` 56–61ms → ~0ms (indexed rollup read),
`topTools` ~22ms → ~0ms; a summary recompute drops from ~300ms avg to
under ~100ms (series-dominated). Stacked-span stalls shrink mechanically.
Success check: post-release, `summaryFor*` slow-op avg well under 150ms
and the ≥2s stall rate visibly below the current ~40/hr; then re-profile
(CDP method) to size item 3.

## SPEC.md (same-commit rule)

- §6 sqlite schema: v14, the two tables + composite index, maintenance
  points, invariants (extend the `session_costs` paragraph's pattern).
- §6 observability: summary reads served by `session_stats`/
  `session_tool_counts`; series remain on `events`.
