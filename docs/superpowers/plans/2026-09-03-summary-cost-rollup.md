# Summary Cost Rollup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kill the main-thread recompute storm (#382/#383): an incrementally-maintained `session_costs` rollup replaces full-history `SUM`s over `events`, and debounced cache invalidation (`markStale`) replaces invalidate-per-event.

**Architecture:** All changes live in the DB layer (`src/main/db.ts` + `src/main/syncCache.ts`). A migration (v13) creates + backfills `session_costs`; `ingestLine` maintains it transactionally; four lifetime-scope readers switch to it; `ingestLine`'s cache invalidation becomes a 3s `markStale`. No IPC or renderer changes.

**Tech Stack:** better-sqlite3 (synchronous, prepared statements), vitest.

**Spec:** `docs/superpowers/specs/2026-09-03-summary-cost-rollup-design.md` — read it first. Issue #383.

## Global Constraints

- Worktree: `/workspace/claude-fleet/.claude/worktrees/summary-cost-rollup`, branch `perf/summary-cost-rollup`. Run everything from the worktree root. NEVER `cd /workspace/claude-fleet`; NEVER `npm install` (node_modules resolve to the pre-provisioned base checkout).
- `src/main/db.ts` trips grep's binary detection — always `grep -a` it.
- Environment limits (pre-existing, not yours to fix): better-sqlite3 is ABI-broken in this container ("Module did not self-register") — **db-dependent tests cannot run here; write them anyway, they run in CI.** `npm run typecheck` short-circuits node→web — **always run `npm run typecheck:node` AND `npm run typecheck:web` separately.** Baselines: node = 13 errors confined to `src/main/perf.ts`(11)/`perfIpc.ts`(1)/`embeddings.ts`(1); web = 2 errors in `TerminalSession.tsx` (`@xterm/addon-webgl`/`-canvas`). Zero NEW errors allowed. `npm run build` is env-blocked (same @xterm gap) — CI is the build authority.
- Grace period is exactly **3000 ms** (`SUMMARY_STALE_GRACE_MS`). New schema version is exactly **13**. Rollup NULL sentinel: key columns store `''` for NULL `model`/`service_tier`; readers map back via `NULLIF(col,'')`.
- Invariant every DB task must preserve (pinned by test): `session_costs` ≡ `SELECT … FROM events GROUP BY session_id, workspace_id, COALESCE(model,''), COALESCE(service_tier,'')` at every commit boundary.
- Migration 13 starts with `DROP TABLE IF EXISTS session_costs` (rebuild-on-migration is the drift self-heal).
- Commit after every task; conventional messages; body ends with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: `syncCache.markStale` + the storm-reproduction test (TDD, runs in-container)

**Files:**
- Modify: `src/main/syncCache.ts` (whole file is 39 lines — read it all)
- Test: `src/main/syncCache.test.ts` (create if absent; if present, extend)

**Interfaces:**
- Consumes: existing `syncKeyedCache<V>(opts: { maxEntries: number; ttlMs?: number; now?: () => number })` returning `{ get, invalidate, clear }`.
- Produces (Task 4 depends on the exact name/signature): `SyncKeyedCache<V>` gains
  `markStale(key: string, graceMs: number): void` — caps the entry's REMAINING lifetime at `graceMs`; no-op for missing keys; never extends a lifetime; a `get()` recompute clears the cap.

- [ ] **Step 1: Write the failing tests**

Add to `src/main/syncCache.test.ts` (fake clock via the existing `now` option — no timer mocks needed):

```ts
import { describe, expect, it } from 'vitest';
import { syncKeyedCache } from './syncCache.js';

describe('markStale', () => {
  it('is a no-op for missing keys', () => {
    let t = 0;
    const c = syncKeyedCache<number>({ maxEntries: 4, ttlMs: 30_000, now: () => t });
    c.markStale('absent', 1_000); // must not throw or create an entry
    let computes = 0;
    c.get('absent', () => ++computes);
    expect(computes).toBe(1);
  });

  it('caps remaining lifetime without extending it', () => {
    let t = 0;
    const c = syncKeyedCache<number>({ maxEntries: 4, ttlMs: 30_000, now: () => t });
    let computes = 0;
    c.get('k', () => ++computes);            // cached at t=0, TTL horizon 30s
    t = 1_000;
    c.markStale('k', 3_000);                 // stale horizon now t=4000
    t = 2_000;
    c.markStale('k', 10_000);                // t=12000 later than t=4000 → must NOT extend
    t = 3_999;
    c.get('k', () => ++computes);
    expect(computes).toBe(1);                // still fresh
    t = 4_000;
    c.get('k', () => ++computes);
    expect(computes).toBe(2);                // stale horizon hit → recompute
    t = 5_000;
    c.get('k', () => ++computes);
    expect(computes).toBe(2);                // recompute cleared the cap
  });

  it('the tighter of TTL and stale horizon wins', () => {
    let t = 0;
    const c = syncKeyedCache<number>({ maxEntries: 4, ttlMs: 5_000, now: () => t });
    let computes = 0;
    c.get('k', () => ++computes);            // TTL horizon t=5000
    t = 1_000;
    c.markStale('k', 10_000);                // stale horizon t=11000 — TTL is tighter
    t = 5_000;
    c.get('k', () => ++computes);
    expect(computes).toBe(2);                // TTL still expired it at t=5000
  });

  // The #383 storm, reproduced: an event every 200ms + a poll every 1500ms
  // for a simulated 60s. invalidate-per-event (the shipped policy) recomputes
  // on EVERY poll; markStale(3s) bounds recomputes to the grace cadence.
  it('reproduces the recompute storm and bounds it', () => {
    let t = 0;
    const now = (): number => t;
    const old = syncKeyedCache<number>({ maxEntries: 4, ttlMs: 30_000, now });
    const fixed = syncKeyedCache<number>({ maxEntries: 4, ttlMs: 30_000, now });
    let oldComputes = 0;
    let fixedComputes = 0;
    for (t = 0; t <= 60_000; t += 100) {
      if (t % 200 === 0) {
        old.invalidate('s');
        fixed.markStale('s', 3_000);
      }
      if (t % 1_500 === 0) {
        old.get('s', () => ++oldComputes);
        fixed.get('s', () => ++fixedComputes);
      }
    }
    expect(oldComputes).toBe(41);            // every one of the 41 polls recomputed
    // Fixed cadence: recompute at t=0, then each stale horizon lands mid-poll-
    // gap so the next 1.5s-grid poll at +4.5s recomputes → 0,4500,…,58500.
    expect(fixedComputes).toBe(14);
    expect(fixedComputes).toBeLessThanOrEqual(60_000 / 3_000 + 1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/main/syncCache.test.ts`
Expected: FAIL — `markStale` is not a function (type error at compile: property does not exist).

- [ ] **Step 3: Implement**

In `src/main/syncCache.ts`: extend the entry shape and interface.

```ts
export interface SyncKeyedCache<V> {
  get(key: string, compute: () => V): V;
  invalidate(key: string): void;
  /** Cap the entry's REMAINING lifetime at graceMs (debounced invalidation,
   *  #383): the entry keeps serving until min(its TTL horizon, now+graceMs),
   *  then recomputes. No-op for missing keys; never extends a lifetime; a
   *  recompute clears the cap. Use instead of invalidate() on hot write
   *  paths where per-write invalidation would defeat the cache. */
  markStale(key: string, graceMs: number): void;
  clear(): void;
}
```

Entry gains an optional stale horizon:

```ts
  const entries = new Map<string, { value: V; at: number; staleAt?: number }>();
```

`get()` freshness check becomes:

```ts
      const hit = entries.get(key);
      const fresh =
        hit !== undefined &&
        (opts.ttlMs === undefined || now() - hit.at < opts.ttlMs) &&
        (hit.staleAt === undefined || now() < hit.staleAt);
      if (hit && fresh) return hit.value;
```

(the recompute path already does `entries.set(key, { value, at: now() })`, which drops any prior `staleAt` — that is the "recompute clears the cap" behavior.)

`markStale`:

```ts
    markStale(key: string, graceMs: number): void {
      const hit = entries.get(key);
      if (!hit) return;
      const horizon = now() + graceMs;
      hit.staleAt = hit.staleAt === undefined ? horizon : Math.min(hit.staleAt, horizon);
    },
```

Also update the file's header comment: invalidation is no longer described as "the correctness mechanism" full stop — hard `invalidate` is for correctness edges (delete/rename), `markStale` is the hot-path debounce, TTL remains the safety net.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/main/syncCache.test.ts`
Expected: PASS (all cases incl. exact counts 41 / 14).

- [ ] **Step 5: Commit**

```bash
git add src/main/syncCache.ts src/main/syncCache.test.ts
git commit -m "feat(syncCache): markStale — debounced invalidation with storm-reproduction test (#383)"
```

---

### Task 2: `session_costs` — migration v13, transactional ingest upsert, delete path, invariant tests

**Files:**
- Modify: `src/main/db.ts` — `migrate()` (add the `if (current < 13)` block after the v12 block, ~line 390), `insertEvent`/`getStmts` (~lines 445–530), `ingestLine` (~line 568), `deleteSession` (~line 1679)
- Test: `src/main/dbSessionCosts.test.ts` (new; copy the temp-db + `openDb` setup pattern from `src/main/dbSessionsList.test.ts` — read that file first)

**Interfaces:**
- Consumes: `markStale` does NOT appear in this task (Task 4 does the swap); existing `ingestLine`, `deleteSession`, `openDb`/`closeDb` test seams from `dbSessionsList.test.ts`.
- Produces (Task 3 reads this table): table `session_costs(session_id, workspace_id, model, service_tier, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, event_count)`, PK `(session_id, workspace_id, model, service_tier)`, key columns NOT NULL with `''` sentinel, index `idx_session_costs_workspace(workspace_id)`.

- [ ] **Step 1: Write the failing tests**

`src/main/dbSessionCosts.test.ts`. Build JSONL fixture lines the way `dbSessionsList.test.ts` does (an assistant line with `message.usage` tokens + `message.model`, a user line with no usage, and replays of the SAME `uuid` for the duplicate case). Core helpers + cases:

```ts
// Ground truth: recompute the rollup shape straight from events. The ORDER BY
// makes deep-equality comparisons deterministic.
const GROUND_TRUTH_SQL = `
  SELECT session_id, workspace_id,
         COALESCE(model, '')         AS model,
         COALESCE(service_tier, '')  AS service_tier,
         COALESCE(SUM(input_tokens), 0)                AS input_tokens,
         COALESCE(SUM(output_tokens), 0)               AS output_tokens,
         COALESCE(SUM(cache_read_input_tokens), 0)     AS cache_read_input_tokens,
         COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
         COUNT(id)                                     AS event_count
  FROM events
  GROUP BY session_id, workspace_id, COALESCE(model,''), COALESCE(service_tier,'')
  ORDER BY session_id, workspace_id, model, service_tier`;
const ROLLUP_SQL = `
  SELECT session_id, workspace_id, model, service_tier, input_tokens,
         output_tokens, cache_read_input_tokens, cache_creation_input_tokens, event_count
  FROM session_costs
  ORDER BY session_id, workspace_id, model, service_tier`;

function expectRollupMatchesEvents(d: Database.Database): void {
  expect(d.prepare(ROLLUP_SQL).all()).toEqual(d.prepare(GROUND_TRUTH_SQL).all());
}
```

Cases (each ends with `expectRollupMatchesEvents`):
1. **mixed ingest** — two sessions in two workspaces; per session: 3 assistant lines (two models, one with `service_tier`), 2 user lines (NULL tokens/model → the `('','')` rollup row).
2. **duplicate replay is a no-op** — re-ingest the exact same assistant line (same `uuid`): `inserted: false` and the rollup unchanged (assert equality to a snapshot taken before the replay AND to ground truth).
3. **deleteSession removes its rollup rows** — delete one session; its rows gone from `session_costs`, the other session's intact, ground truth still matches.
4. **migration backfill rebuilds from events** — after ingesting: `db.pragma('user_version = 12')`, `closeDb()`, `openDb(...)` again → migration 13 re-runs (its `DROP TABLE IF EXISTS` makes this safe) and the rebuilt table matches ground truth. This is the drift-self-heal test.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/main/dbSessionCosts.test.ts`
Expected in-container: FAIL with `Module did not self-register` (better-sqlite3 ABI — the env limit). That is the expected "failure" here; correctness runs in CI. Gate this task locally with `npm run typecheck:node` instead (zero new errors) and re-read your SQL against the schema by hand.

- [ ] **Step 3: Implement the migration**

In `migrate()`, after the v12 block:

```ts
  if (current < 13) {
    // session_costs: incrementally-maintained lifetime token rollup (#383).
    // Kills the full-history SUM(...) scans that dominated main-thread stalls
    // (#382). Key columns use '' for NULL model/service_tier (SQLite PKs
    // treat NULLs as distinct); readers map back with NULLIF(col, '').
    // Invariant: ≡ GROUP BY over events at every commit boundary — pinned by
    // dbSessionCosts.test.ts. DROP+rebuild here is the drift self-heal: any
    // future schema bump reconstructs the table from ground truth.
    d.exec(`
      DROP TABLE IF EXISTS session_costs;
      CREATE TABLE session_costs (
        session_id                  TEXT NOT NULL,
        workspace_id                TEXT NOT NULL,
        model                       TEXT NOT NULL DEFAULT '',
        service_tier                TEXT NOT NULL DEFAULT '',
        input_tokens                INTEGER NOT NULL DEFAULT 0,
        output_tokens               INTEGER NOT NULL DEFAULT 0,
        cache_read_input_tokens     INTEGER NOT NULL DEFAULT 0,
        cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
        event_count                 INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (session_id, workspace_id, model, service_tier)
      );
      CREATE INDEX idx_session_costs_workspace ON session_costs(workspace_id);
      INSERT INTO session_costs (session_id, workspace_id, model, service_tier,
        input_tokens, output_tokens, cache_read_input_tokens,
        cache_creation_input_tokens, event_count)
      SELECT session_id, workspace_id, COALESCE(model, ''), COALESCE(service_tier, ''),
             COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0),
             COALESCE(SUM(cache_read_input_tokens), 0),
             COALESCE(SUM(cache_creation_input_tokens), 0), COUNT(id)
      FROM events
      GROUP BY session_id, workspace_id, COALESCE(model, ''), COALESCE(service_tier, '');
    `);
    d.pragma('user_version = 13');
  }
```

- [ ] **Step 4: Implement the ingest upsert (transactional)**

Next to `insertEvent` (~line 445) add:

```ts
const upsertSessionCost = (d: Database.Database) =>
  d.prepare(`
    INSERT INTO session_costs (session_id, workspace_id, model, service_tier,
      input_tokens, output_tokens, cache_read_input_tokens,
      cache_creation_input_tokens, event_count)
    VALUES (@session_id, @workspace_id, COALESCE(@model, ''), COALESCE(@service_tier, ''),
      COALESCE(@input_tokens, 0), COALESCE(@output_tokens, 0),
      COALESCE(@cache_read_input_tokens, 0), COALESCE(@cache_creation_input_tokens, 0), 1)
    ON CONFLICT (session_id, workspace_id, model, service_tier) DO UPDATE SET
      input_tokens                = input_tokens + excluded.input_tokens,
      output_tokens               = output_tokens + excluded.output_tokens,
      cache_read_input_tokens     = cache_read_input_tokens + excluded.cache_read_input_tokens,
      cache_creation_input_tokens = cache_creation_input_tokens + excluded.cache_creation_input_tokens,
      event_count                 = event_count + 1
  `);
```

In `getStmts`'s statement object (~line 509): add `upsertSessionCost: upsertSessionCost(d)` and a transaction that keeps event + rollup atomic (a crash between the two would otherwise leave silent drift until the next migration):

```ts
    // Event insert + rollup upsert are one transaction: the rollup must never
    // drift from events across a crash (#383 invariant). The upsert only runs
    // when the event actually landed (changes > 0) — duplicate-event replays
    // (same dedup_key, INSERT OR IGNORE) must not double-count.
    ingestEventTx: d.transaction((params: Parameters<ReturnType<typeof insertEvent>['run']>[0]) => {
      const info = stmts.insertEvent.run(params);
      if (info.changes > 0) stmts.upsertSessionCost.run(params);
      return info;
    }),
```

(Adapt the exact typing to how `getStmts` is structured — read it; if the object literal can't self-reference, build the two statements as locals first and close over them. The event params object in `ingestLine` already carries every column the upsert needs — pass it through unchanged.)

In `ingestLine` (~line 568): `const info = s.insertEvent.run({...})` → `const info = s.ingestEventTx({...})` (same params object, unchanged).

- [ ] **Step 5: deleteSession**

Inside the existing transaction in `deleteSession` (~line 1681), add alongside the other DELETEs:

```ts
    d.prepare(`DELETE FROM session_costs WHERE session_id = ?`).run(sid);
```

- [ ] **Step 6: Gate + commit**

Run: `npm run typecheck:node` (13 baseline errors, zero new) and `npm run typecheck:web` (2 baseline errors, zero new). Then:

```bash
git add src/main/db.ts src/main/dbSessionCosts.test.ts
git commit -m "feat(db): session_costs rollup — migration v13, transactional ingest upsert, delete path (#383)"
```

---

### Task 3: Switch the four lifetime readers to the rollup + EXPLAIN-plan pin

**Files:**
- Modify: `src/main/db.ts` — `summaryForSessionUncached` totals query (~line 925), `costForSession` (~line 1384), `costForWorkspace` (~line 1398), `listSessions` cost query both arms (~lines 1583–1596)
- Test: `src/main/dbSessionCosts.test.ts` (extend)

**Interfaces:**
- Consumes: `session_costs` from Task 2 (`''` sentinel in key columns).
- Produces: identical return shapes as today for all four functions (callers unchanged). Time-windowed readers (`tokensSpentSinceUncached`, `planUsageRows`, `costSeriesForSession`, `tokenSeriesForSession`) and the latest-assistant/observed-max queries DELIBERATELY stay on `events` — do not touch them.

- [ ] **Step 1: Extend the tests (they run in CI)**

Add to `dbSessionCosts.test.ts`:

```ts
it('cost readers return identical results from the rollup as from events', () => {
  // After the mixed ingest of case 1:
  // costForSession / costForWorkspace / listSessions rows / summaryForSession
  // token totals must equal values computed via GROUND_TRUTH_SQL aggregation.
  // Assert costForSession(sessionA).usd and token fields equal the events-side
  // recomputation via rollupGroups-equivalent math; assert listSessions()
  // rows carry usd/eventCount matching per-session ground truth; assert
  // summaryForSession(sessionA) totals (input/output/cache tokens,
  // eventCount) match ground truth sums. NULL-model events must appear in
  // totals (the '' sentinel row) and listSessions must not lose them.
});

it('listSessions cost query never scans events (EXPLAIN QUERY PLAN pin)', () => {
  // Reconstruct the two SQL strings the implementation uses (export them as
  // consts from db.ts — LIST_SESSION_COSTS_SQL / LIST_SESSION_COSTS_BY_WS_SQL —
  // so the test pins the real strings, not a copy).
  for (const sql of [LIST_SESSION_COSTS_SQL, LIST_SESSION_COSTS_BY_WS_SQL]) {
    const plan = d.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>;
    const details = plan.map((r) => r.detail).join(' | ');
    expect(details).toContain('session_costs');
    expect(details).not.toMatch(/\bevents\b/);
  }
});
```

- [ ] **Step 2: Implement the reader switches**

1. `listSessions` (~lines 1583–1596) — export the two SQL strings as module consts so the EXPLAIN test pins them, and replace the events aggregation:

```ts
export const LIST_SESSION_COSTS_SQL = `
  SELECT session_id, NULLIF(model, '') AS model, NULLIF(service_tier, '') AS service_tier,
         input_tokens, output_tokens, cache_read_input_tokens,
         cache_creation_input_tokens, event_count
  FROM session_costs`;
export const LIST_SESSION_COSTS_BY_WS_SQL = `${LIST_SESSION_COSTS_SQL}
  WHERE workspace_id = ?`;
```

The consumer loop that builds `byId` from `costRows` is unchanged — the rows keep the exact same shape (one row per `(session, model, tier)`; a session with rows in two workspaces yields two rows, which the summing loop already handles).

2. `costForSession` (~line 1384):

```ts
      SELECT NULLIF(model, '') AS model, NULLIF(service_tier, '') AS service_tier,
             input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens
      FROM session_costs
      WHERE session_id = ?
```

(`rollupGroups` sums per-row; no GROUP BY needed — the PK makes rows unique per (model, tier) within a session/workspace.)

3. `costForWorkspace` (~line 1398) — multiple sessions per workspace, so this one still aggregates, but over the small rollup:

```ts
      SELECT NULLIF(model, '') AS model, NULLIF(service_tier, '') AS service_tier,
             COALESCE(SUM(input_tokens), 0)                AS input_tokens,
             COALESCE(SUM(output_tokens), 0)               AS output_tokens,
             COALESCE(SUM(cache_read_input_tokens), 0)     AS cache_read_input_tokens,
             COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens
      FROM session_costs
      WHERE workspace_id = ?
      GROUP BY model, service_tier
```

4. `summaryForSessionUncached` totals (~line 925) — replace the events SUM query with:

```ts
      SELECT
        COALESCE(SUM(event_count), 0)                 AS event_count,
        COALESCE(SUM(input_tokens), 0)                AS input_tokens,
        COALESCE(SUM(output_tokens), 0)               AS output_tokens,
        COALESCE(SUM(cache_read_input_tokens), 0)     AS cache_read_input_tokens,
        COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens
      FROM session_costs
      WHERE session_id = ?
```

(`SUM(event_count)` across the session's rollup rows equals the old `COUNT(*)` over events — every landed event incremented exactly one rollup row. The per-model cost query in the same function — find it just below, it feeds `rollupGroups` — switches the same way as `costForSession`.)

- [ ] **Step 3: Gate + commit**

Run: `npm run typecheck:node` + `npm run typecheck:web` (baselines only), `npx vitest run src/main/syncCache.test.ts` (still green).

```bash
git add src/main/db.ts src/main/dbSessionCosts.test.ts
git commit -m "perf(db): lifetime cost readers served by session_costs — no more full-history scans (#383)"
```

---

### Task 4: The debounce swap, recompute-counter seam, bounded-recompute test, SPEC.md

**Files:**
- Modify: `src/main/db.ts` — ingest invalidation (~line 653), `summaryForSessionUncached` (counter, ~line 905), a new exported test seam
- Modify: `docs/SPEC.md` — §6 observability (read caches paragraph + sqlite schema block; grep for "syncKeyedCache" / "summaryCache" / "schema" anchors)
- Test: `src/main/dbSessionCosts.test.ts` (extend)

**Interfaces:**
- Consumes: `markStale` (Task 1), rollup readers (Task 3).
- Produces: `SUMMARY_STALE_GRACE_MS = 3_000` (module const, db.ts); `_summaryRecomputesForTests(): number` export.

- [ ] **Step 1: The swap**

At the top of db.ts near the cache declarations (~line 30):

```ts
// Debounced summary invalidation (#383): ingest marks the entry stale with a
// 3s grace instead of deleting it, so a streaming session recomputes at most
// once per grace window instead of on every poll-after-every-event. ai_title
// and friends propagate within ≤3s — under the renderer's own 5s poll.
const SUMMARY_STALE_GRACE_MS = 3_000;
```

At ~line 653, replace `summaryCache.invalidate(sessionId);` with `summaryCache.markStale(sessionId, SUMMARY_STALE_GRACE_MS);` and rewrite the comment above it (it currently justifies always-invalidate; the new justification is the debounce). Leave `deleteSession`'s hard `invalidate` (~line 1687) untouched. Leave `spendCache.clear()` behavior untouched.

- [ ] **Step 2: Counter seam + bounded-recompute test**

In db.ts:

```ts
// Test seam (#383): counts summaryForSessionUncached executions so the
// storm-bound integration test can assert the debounce works end-to-end.
let summaryRecomputes = 0;
export function _summaryRecomputesForTests(): number {
  return summaryRecomputes;
}
```

Increment `summaryRecomputes++` as the first line of `summaryForSessionUncached`.

Extend `dbSessionCosts.test.ts` (real clock — the whole loop runs far inside one 3s grace window, so the bound is deterministic):

```ts
it('ingest burst with interleaved summary reads recomputes at most twice (debounce end-to-end)', () => {
  // Prime the cache once.
  summaryForSession(SESSION_A);
  const before = _summaryRecomputesForTests();
  for (let i = 0; i < 200; i++) {
    ingestLine(WS_A, SESSION_A, assistantLine({ uuid: `burst-${i}`, inputTokens: 10 }));
    summaryForSession(SESSION_A); // the renderer-poll stand-in
  }
  // Old policy: ~200 recomputes (every read after every ingest missed).
  // markStale(3s): the first read after the first markStale horizon may
  // recompute once; everything else inside the grace window is a hit.
  expect(_summaryRecomputesForTests() - before).toBeLessThanOrEqual(2);
});
```

- [ ] **Step 3: SPEC.md (same-commit rule)**

Edit in place, present tense, no changelog prose:
1. The §6 read-caches paragraph (grep -a `docs/SPEC.md` for `summaryCache` or `syncKeyedCache`): describe the current policy — ingest calls `markStale(sessionId, 3s)` (debounced invalidation; hard `invalidate` reserved for delete/rename; TTL 30s safety net), and why (per-event invalidation defeats the cache for streaming sessions).
2. The sqlite schema section (grep for `broker_sessions` or the schema block): add `session_costs` — columns, PK, `''` NULL sentinel, maintained transactionally with each event insert (`changes > 0` guard), deleted with the session, rebuilt from `events` on migration; invariant ≡ `GROUP BY` over events; serves the lifetime cost readers (`listSessions`, `costForSession`, `costForWorkspace`, summary totals) while time-windowed reads stay on `events`.

- [ ] **Step 4: Full gate + commit**

Run: `npm run typecheck:node` (13 baseline), `npm run typecheck:web` (2 baseline), `npx vitest run src/main/syncCache.test.ts src/main/workspaceMerge.test.ts` (green; workspaceMerge guards against accidental db.ts fallout via its type imports).

```bash
git add src/main/db.ts src/main/dbSessionCosts.test.ts docs/SPEC.md
git commit -m "perf(db): debounced summary invalidation (markStale 3s) + SPEC — closes the recompute storm (#383)"
```

*(PR creation/push is handled by the controller after the final whole-branch review — do not push.)*
