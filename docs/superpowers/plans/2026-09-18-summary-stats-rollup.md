# Summary Stats Rollup Implementation Plan (round 2 of #386)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the last O(table)/O(session-history) reads from the summary path: a `(session_id, type)` index (kills the `observedMax` planner bug, 56ms→3ms measured) plus `session_stats`/`session_tool_counts` rollups replacing the `observedMax` and `topTools` inline queries.

**Architecture:** All DB-layer (`src/main/db.ts`), extending the #384 `session_costs` machinery: migration v14 creates+backfills, `ingestEventTx` maintains both tables under the same `changes > 0` guard, `deleteSession` cleans up, the two readers switch. No IPC/renderer/cache-policy changes.

**Tech Stack:** better-sqlite3 (sync, prepared), vitest.

**Spec:** `docs/superpowers/specs/2026-09-18-summary-stats-rollup-design.md` — read it first. Issue #390. Reference implementation for every pattern used here: the #384 work (`session_costs` in db.ts + `src/main/dbSessionCosts.test.ts`).

## Global Constraints

- Worktree `/workspace/claude-fleet/.claude/worktrees/summary-stats-rollup`, branch `perf/summary-stats-rollup`. Run everything from the worktree root. NEVER `cd /workspace/claude-fleet`; NEVER `npm install`.
- `src/main/db.ts` trips grep binary detection — always `grep -a`.
- Environment (pre-existing): better-sqlite3 ABI-broken in-container — **DB tests cannot run here; write them anyway (CI runs them)** and desk-check SQL. Gates per task: `npm run typecheck:node` (baseline: 13 errors confined to perf.ts/perfIpc.ts/embeddings.ts) AND `npm run typecheck:web` (baseline: 2 errors in TerminalSession.tsx) run SEPARATELY (bare `npm run typecheck` short-circuits node→web); `npx vitest run src/main/syncCache.test.ts src/main/trailingBroadcast.test.ts` stays green (16 tests).
- New schema version is exactly **14**. Migration starts with `DROP TABLE IF EXISTS` for both new tables (rebuild-on-migration self-heal). The index name is exactly `idx_events_session_type`.
- Invariants every task preserves (CI-pinned): `session_stats` ≡ the MAX-recompute from `events`; `session_tool_counts` ≡ the `GROUP BY tool_name` recompute — at every commit boundary.
- `max_context_tokens` candidate formula (must match the current reader exactly): `COALESCE(input_tokens,0) + COALESCE(cache_read_input_tokens,0) + COALESCE(cache_creation_input_tokens,0)`, assistant events only.
- Commit per task; conventional messages; body ends with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Migration v14 + ingest maintenance + delete path + invariant tests

**Files:**
- Modify: `src/main/db.ts` — `migrate()` (add `if (current < 14)` after the v13 block, ~line 450), statement factories (~line 546 area), `Cache` interface + `getStmts` (~lines 563–601), `deleteSession` (~line 1769)
- Test: `src/main/dbSessionStats.test.ts` (new; copy setup/fixture helpers from `src/main/dbSessionCosts.test.ts` — read that file first, reuse its `assistantLine`/`userLine`-style builders, adding a `toolUseLine` builder if it lacks one)

**Interfaces:**
- Consumes: `IngestEventParams` (db.ts:563) — already carries `@type`, `@tool_name`, `@input_tokens`, `@cache_read_input_tokens`, `@cache_creation_input_tokens`, `@session_id`.
- Produces (Task 2 reads these): tables `session_stats(session_id PK, max_context_tokens)` and `session_tool_counts(session_id, tool_name, count, PK(session_id, tool_name))`; index `idx_events_session_type`.

- [ ] **Step 1: Write the failing tests**

`src/main/dbSessionStats.test.ts`, mirroring `dbSessionCosts.test.ts`'s structure (temp dir, `openDb`/`closeDb`, JSONL fixtures through `ingestLine`). Ground-truth helpers:

```ts
const STATS_GROUND_TRUTH_SQL = `
  SELECT session_id,
         COALESCE(MAX(
           COALESCE(input_tokens, 0)
           + COALESCE(cache_read_input_tokens, 0)
           + COALESCE(cache_creation_input_tokens, 0)
         ), 0) AS max_context_tokens
  FROM events WHERE type = 'assistant'
  GROUP BY session_id ORDER BY session_id`;
const STATS_ROLLUP_SQL = `
  SELECT session_id, max_context_tokens FROM session_stats ORDER BY session_id`;
const TOOLS_GROUND_TRUTH_SQL = `
  SELECT session_id, tool_name, COUNT(*) AS count
  FROM events WHERE tool_name IS NOT NULL
  GROUP BY session_id, tool_name ORDER BY session_id, tool_name`;
const TOOLS_ROLLUP_SQL = `
  SELECT session_id, tool_name, count FROM session_tool_counts
  ORDER BY session_id, tool_name`;
```

Cases (each ends by asserting both rollups `toEqual` their ground truths):
1. **mixed ingest** — two sessions: assistant lines with varying token mixes (ensure the MAX is NOT the last event — e.g. tokens 100+0+0, then 50+400+50 (max=500), then 200+0+0 — so a sum-instead-of-max bug fails), tool_use lines for ≥2 distinct tools with different counts, user lines (no type='assistant', no tool_name → contribute to NEITHER table), an assistant line with all-NULL tokens (candidate 0 — must not lower an existing max).
2. **sessions with no assistant events** have NO `session_stats` row (reader treats absent as 0 — Task 2 covers the reader side); sessions with no tool calls have no `session_tool_counts` rows.
3. **duplicate replay is a no-op** — re-ingest the same uuid assistant line and the same uuid tool line: `inserted: false`, both rollups unchanged (snapshot equality + ground truth).
4. **deleteSession scoping** — deletes only that session's rows in both tables.
5. **migration rebuild** — `d.pragma('user_version = 13')`, `closeDb()`, `openDb(dir)` → v14 re-runs (DROP IF EXISTS makes it safe), both tables rebuilt ≡ ground truth, and the index exists:
```ts
const idx = d.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_events_session_type'`).get();
expect(idx).toBeTruthy();
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/main/dbSessionStats.test.ts`
Expected in-container: FAIL with `Module did not self-register` (the env limit — that IS the expected outcome; CI executes these). Local gate = both typechecks instead.

- [ ] **Step 3: Migration v14**

In `migrate()`, after the v13 block (~line 450):

```ts
  if (current < 14) {
    // (session_id, type) composite index + two summary-stat rollups (#390).
    // The observedMax query (session_id + type='assistant') previously hit
    // idx_events_type and scanned every assistant row in the table (#386:
    // 84k rows for one session's 4; 56ms → 3ms with this index). The
    // rollups remove the remaining O(session-history) reads from the
    // summary path entirely. Same invariants + rebuild-on-migration
    // self-heal as session_costs (v13): ≡ recomputing from events at every
    // commit boundary, pinned by dbSessionStats.test.ts.
    d.exec(`
      CREATE INDEX IF NOT EXISTS idx_events_session_type ON events(session_id, type);

      DROP TABLE IF EXISTS session_stats;
      CREATE TABLE session_stats (
        session_id          TEXT PRIMARY KEY,
        max_context_tokens  INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO session_stats (session_id, max_context_tokens)
      SELECT session_id,
             COALESCE(MAX(
               COALESCE(input_tokens, 0)
               + COALESCE(cache_read_input_tokens, 0)
               + COALESCE(cache_creation_input_tokens, 0)
             ), 0)
      FROM events WHERE type = 'assistant'
      GROUP BY session_id;

      DROP TABLE IF EXISTS session_tool_counts;
      CREATE TABLE session_tool_counts (
        session_id  TEXT NOT NULL,
        tool_name   TEXT NOT NULL,
        count       INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (session_id, tool_name)
      );
      INSERT INTO session_tool_counts (session_id, tool_name, count)
      SELECT session_id, tool_name, COUNT(*)
      FROM events WHERE tool_name IS NOT NULL
      GROUP BY session_id, tool_name;
    `);
    d.pragma('user_version = 14');
  }
```

(`CREATE INDEX IF NOT EXISTS` because the rebuild path re-enters this block with the index already present.)

- [ ] **Step 4: Ingest maintenance**

Next to `upsertSessionCost` (~line 546) add two factories:

```ts
const upsertSessionStats = (d: Database.Database) =>
  d.prepare(`
    INSERT INTO session_stats (session_id, max_context_tokens)
    VALUES (@session_id,
      COALESCE(@input_tokens, 0) + COALESCE(@cache_read_input_tokens, 0)
      + COALESCE(@cache_creation_input_tokens, 0))
    ON CONFLICT (session_id) DO UPDATE SET
      max_context_tokens = MAX(max_context_tokens, excluded.max_context_tokens)
  `);
const upsertSessionToolCount = (d: Database.Database) =>
  d.prepare(`
    INSERT INTO session_tool_counts (session_id, tool_name, count)
    VALUES (@session_id, @tool_name, 1)
    ON CONFLICT (session_id, tool_name) DO UPDATE SET count = count + 1
  `);
```

Extend `getStmts` (~line 585): build both as locals alongside `upsertSessionCostStmt`, add them to the `Cache` interface (`upsertSessionStats` / `upsertSessionToolCount` as `ReturnType<typeof …>`), and extend the transaction body:

```ts
      ingestEventTx: d.transaction((params: IngestEventParams) => {
        const info = insertEventStmt.run(params);
        if (info.changes > 0) {
          upsertSessionCostStmt.run(params);
          // Rollup maintenance (#390): same changes>0 guard — duplicate
          // replays must not inflate the max (harmless) or the counts (real
          // drift). Branch in JS: the params carry type/tool_name already.
          if (params.type === 'assistant') upsertSessionStatsStmt.run(params);
          if (params.tool_name != null) upsertSessionToolCountStmt.run(params);
        }
        return info;
      }),
```

(Check how `params.type`/`params.tool_name` are typed on `IngestEventParams` — it derives from the insertEvent statement params, all present. If TypeScript needs a cast, cast the two reads, not the whole object.)

- [ ] **Step 5: deleteSession**

Inside its existing transaction (~line 1771), alongside the `session_costs` delete:

```ts
    d.prepare(`DELETE FROM session_stats WHERE session_id = ?`).run(sid);
    d.prepare(`DELETE FROM session_tool_counts WHERE session_id = ?`).run(sid);
```

- [ ] **Step 6: Gate + commit**

Run: `npm run typecheck:node` (13 baseline) and `npm run typecheck:web` (2 baseline) separately; `npx vitest run src/main/syncCache.test.ts src/main/trailingBroadcast.test.ts` (16 green).

```bash
git add src/main/db.ts src/main/dbSessionStats.test.ts
git commit -m "feat(db): session_stats + session_tool_counts rollups, (session_id,type) index — migration v14 (#390)"
```

---

### Task 2: Readers switch + EXPLAIN pins + equivalence tests

**Files:**
- Modify: `src/main/db.ts` — `observedMax` (~line 1062) and `topTools` (~line 1078) inside `summaryForSessionUncached`
- Test: `src/main/dbSessionStats.test.ts` (extend)

**Interfaces:**
- Consumes: Task 1's tables. Produces: identical `WorkspaceSummary` output shape (`maxContextTokens` derivation via `contextWindowFor`, `topTools: ToolCallCount[]`); two exported SQL consts for the EXPLAIN pin: `OBSERVED_MAX_SQL`, `TOP_TOOLS_SQL`.

- [ ] **Step 1: Extend tests**

```ts
it('summary readers serve stats from the rollups, identical to events-side recompute', () => {
  // After case-1's mixed ingest: summaryForSession(SES_A) must report
  // maxContextTokens/topTools identical to computing them from events by
  // hand (hardcode the expected values from the fixture: max=500; tools
  // e.g. [['Bash', 3], ['Read', 1]] respecting count-desc, name-asc order).
  // Also: a session with NO assistant events reports the absent-row
  // behavior (contextWindow derivation sees 0 — assert whatever field
  // shape summaryForSession exposes for it matches a pre-change fixture).
});

it('observedMax/topTools no longer touch events (EXPLAIN pin)', () => {
  for (const sql of [OBSERVED_MAX_SQL, TOP_TOOLS_SQL]) {
    const stmt = d.prepare(`EXPLAIN QUERY PLAN ${sql}`);
    // both have one ? param (session id); TOP_TOOLS_SQL has a second (limit)
    const plan = (sql === TOP_TOOLS_SQL ? stmt.all('x', 5) : stmt.all('x')) as Array<{ detail: string }>;
    const details = plan.map((r) => r.detail).join(' | ');
    expect(details).not.toMatch(/\bevents\b/);
  }
});

it('latestAssistant uses a session-prefixed index (EXPLAIN pin)', () => {
  // Export LATEST_ASSISTANT_SQL as well; assert the plan mentions
  // idx_events_session_type OR idx_events_session_ts (either is
  // session-prefixed) and never idx_events_type alone.
});
```

(Remember the #384 lesson: better-sqlite3 requires placeholders bound even for EXPLAIN QUERY PLAN — bind dummies as shown.)

- [ ] **Step 2: Implement**

In `summaryForSessionUncached`, export the SQL as module consts (the EXPLAIN tests pin the real strings) and switch:

```ts
export const OBSERVED_MAX_SQL = `
  SELECT max_context_tokens FROM session_stats WHERE session_id = ?`;
export const TOP_TOOLS_SQL = `
  SELECT tool_name AS name, count
  FROM session_tool_counts
  WHERE session_id = ?
  ORDER BY count DESC, tool_name
  LIMIT ?`;
export const LATEST_ASSISTANT_SQL = /* lift the existing latestAssistant SQL string unchanged */;
```

```ts
  const observedMax =
    (d.prepare(OBSERVED_MAX_SQL).get(session.id) as { max_context_tokens: number } | undefined)
      ?? { max_context_tokens: 0 };
```

```ts
  const topTools = d.prepare(TOP_TOOLS_SQL).all(session.id, topToolsLimit) as ToolCallCount[];
```

Keep the surrounding comments' content but update them: the observedMax comment currently explains the 1M-context auto-upgrade rationale — KEEP that rationale, replace only the "across all assistant events" mechanics with the rollup reference. Add the deterministic tie-break note on topTools (count desc, then name — the old GROUP BY left ties unordered).

- [ ] **Step 3: Gate + commit**

Run: both typechecks (baselines only); `npx vitest run src/main/syncCache.test.ts src/main/trailingBroadcast.test.ts` green.

```bash
git add src/main/db.ts src/main/dbSessionStats.test.ts
git commit -m "perf(db): observedMax/topTools served by rollups — no events reads left in summary hot path (#390)"
```

---

### Task 3: SPEC.md + final gate

**Files:**
- Modify: `docs/SPEC.md` (grep -a for `session_costs` — both the schema block and the observability read-cache paragraph from #384; extend in place)

- [ ] **Step 1: SPEC edits** (edit in place, present tense, no changelog prose)

1. Schema section: extend the v-current schema description with `session_stats` + `session_tool_counts` (columns, PKs, maintained transactionally with each event insert under the `changes > 0` guard, deleted with the session, rebuilt from `events` on migration, invariants ≡ their `events` recomputes) and the `idx_events_session_type` index (why: `session_id + type` predicates — `observedMax`-class lookups and `latestAssistant` — must never fall back to the table-wide `idx_events_type`).
2. Observability paragraph: the summary read path's per-session stats (`max_context_tokens`, top tools) are rollup-served; the only remaining `events` reads in a summary recompute are the token/cost series and `latestAssistant`/`recentToolCalls` (indexed, bounded).

- [ ] **Step 2: Full gate + commit**

Run: `npm run typecheck:node` (13 baseline), `npm run typecheck:web` (2 baseline), `npx vitest run src/main/syncCache.test.ts src/main/trailingBroadcast.test.ts` (16 green). Do NOT run `npm run build` (env-blocked; CI is the authority).

```bash
git add docs/SPEC.md
git commit -m "docs: SPEC — session_stats/tool_counts rollups + session/type index (#390)"
```

*(Push/PR/merge handled by the controller after the final whole-branch review — do not push.)*
