# Async store layer, part 2b: `state.db` reads and caches on async Kysely — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every remaining `state.db` **read** and both read caches onto the async Kysely handle that part 2a built, with no behaviour change and no IPC shape change. After this, the raw better-sqlite3 handle serves only `openDb()`'s synchronous open steps.

**Architecture:** Each sync read in `src/main/db.ts` becomes an `async` Kysely query on `stateKysely()`. The summary recompute (8 queries) and `listSessions` (3 queries) each run in one read transaction, so they still see one consistent state. `syncKeyedCache` is replaced by `asyncKeyedCache`, which de-dupes concurrent misses and lets an invalidation that lands mid-recompute win. Callers in `ipc.ts`, `local.ts`, `index.ts` and `transcriptIndex.ts` await the reads. The MCP server's read-only connection, its snapshot, and `searchTranscripts` stay raw (D1, D14).

**Tech Stack:** TypeScript, Electron main (CJS bundle via electron-vite), better-sqlite3 13, kysely 0.28.x, vitest.

**Spec:** `docs/superpowers/specs/2026-11-02-remote-workspaces-design.md` §7 *One store layer*, §11 sub-project (a). This plan refines the *Part 2b outline* at the end of `docs/superpowers/plans/2026-11-04-async-store-part2.md` (2a, shipped in #484). SPEC.md §4 *Stack*, §6 *Observability* and *Perf telemetry*, §7 *JSONL→SQLite cache*, §11 *In-container SQLite access via MCP* and *Cross-workspace committee control*.

## Global Constraints

Everything in 2a's *Global Constraints* still binds. Repeated here where 2b leans on it, with 2b's additions:

- **SQLite behaviour is unchanged:**
  - The same `state.db`, the same `migrate()` SQL (v1–v14), the same rows.
  - Every IPC channel name, payload and return shape stays the same. No renderer or preload change.
  - **2a's ingest characterization snapshot (`src/main/__snapshots__/dbIngestBatch.test.ts.snap`) and 2b's read characterization snapshot (Task 1, `src/main/__snapshots__/dbReadCharacterization.test.ts.snap`) are the arbiters.** Every task must pass both unmodified. Never run `vitest -u` on either after Task 1.
- **Dialect-neutral queries in store code** (2a rules): no `IFNULL`, no multi-argument `MAX(a, b)`, no `INSERT OR IGNORE`, no `lastInsertRowid`, no SQLite bare-column aggregates (D17). Wrap every `COUNT`/`SUM`/`MAX` result in `num()`. Schema DDL stays SQLite-specific.
- **Transactions await only `trx`.** Inside `kysely.transaction().execute(async (trx) => …)`, use only `trx` and helpers that take a `q: Kysely<StateDb>` argument. An outer-handle query inside a transaction deadlocks on the driver mutex.
- **Cache invalidation runs after the write commits** (2a). 2b does not move any invalidation call.
- **No `.then(onFulfilled, onRejected)`.** Use `await`/`try`, `.catch()` alone, or a single-argument `.then(fn)`.
- **No N+1.** Async Kysely costs more per query than sync better-sqlite3. Never add a per-row or per-workspace query loop where one statement or a `chunked()` IN-list does (D15).
- **Keep every commit shippable:** each task ends green on both `tsc` configs and the full unit suite.
- **`mcpServer.ts` is out of scope.** Its `{ readonly: true }` connection, `buildSnapshot` and typed read tools stay exactly as they are (D1). The injected committee and plan-usage handlers it calls are ported in Task 4 without changing their types.
- **Never `npm install` into `/workspace/claude-fleet/node_modules`** (the shared base checkout). Work in your own worktree.
- **Typecheck both configs separately:** `npx tsc --noEmit -p tsconfig.node.json` and `npx tsc --noEmit -p tsconfig.web.json`.
- **`tsc` cannot see a missing `await`** on a call whose result is unused. Every task lists its call sites and a `/usr/bin/grep` check; inspect each hit.
- **CI (`build-app.yml`: `unit (vitest)` + build + e2e) is the real gate.** The container can't run Electron. Troy eyeballs the app on the host after merge.
- **Every commit message ends with** `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- **SPEC.md is updated in the same PR** (Task 5).

## Decisions

D1–D9 from 2a still bind. The ones 2b leans on: **D1** (the MCP read path stays raw better-sqlite3), **D2** (2b ports reads and caches), **D5** (statement cache on `state.db`), **D7** (fire-and-forget sites log instead of throwing), **D9** (A/B perf gate). New in 2b, recorded in SPEC.md by Task 5:

- **D10 — No stale-while-revalidate.** Once an entry passes its horizon (TTL or `markStale` grace), the next read recomputes and the caller awaits the result, exactly as the sync cache did. Inside the 3 s grace the cached value is served, also as before.
  - Why not SWR: it would serve values older than the grace and break the documented ≈3.25 s freshness bound that the trailing re-broadcast relies on (SPEC §6 `observability:summaryForWorkspace`). The grace already is the bounded-staleness mechanism.
- **D11 — In-flight rules for `asyncKeyedCache`:**
  - Concurrent misses on one key share a single compute promise.
  - An `invalidate(key)` or `clear()` that lands while a compute is in flight **wins**. That compute's result is still returned to its own callers but is never stored, and the next read recomputes.
  - A `markStale(key, grace)` that lands while a compute is in flight caps the stored result's lifetime at the grace.
  - A rejected compute rejects every sharer and stores nothing.
  - Writers keep invalidating **after commit** (2a). With D11 that ordering is enough: a read that started before the commit can't overwrite the invalidation.
  - On the SQLite driver these races can't be provoked from `db.ts`. A read's continuation stores its result before a queued write can commit, because neither side does I/O. So they're unit-tested with hand-settled promises (`asyncCache.test.ts`). They matter once part 3's pooled Postgres connections make reads and writes truly concurrent.
- **D12 — Multi-query reads run in one read transaction:** `summaryForSessionUncached` (8 queries) and `listSessions` (3 queries).
  - On the sync path no write could land between their queries. On the async path another Kysely query can take the mutex between two awaited queries, so without the transaction a summary could mix pre- and post-ingest rows. The transaction costs ~4 µs.
  - `lookupResumableBrokerSession` becomes one statement (an `EXISTS` on `sessions`) instead of two queries, so it's atomic without a transaction.
  - Single-query reads take no transaction.
- **D13 — The raw handle after 2b:**
  - It serves only `openDb()`'s synchronous open steps: `migrate()` (including its v12 `repairSyntheticFirstUserMessages`) and `rehydratePendingClaudeIds()`.
  - The rehydrate stays raw because `openDb()` is synchronous and the guard set must be loaded before the first ingest can run. Making it async would need a readiness gate on `ingestBatch`, which is more code than it saves.
  - `getDb()` and `openDbOrThrow()` are deleted.
  - `openDb()` keeps returning the raw handle. Tests use it for fixtures and `EXPLAIN QUERY PLAN` pins, and the bench uses it for the MCP-path search. Task 4's grep gate proves no app module uses it.
- **D14 — `searchTranscripts` stays raw; the embedding backlog reads move.**
  - `searchTranscripts` keeps its better-sqlite3 `db` parameter, which becomes **required** (the `getDb()` default goes away). Its only production caller is the MCP server's `search_transcripts` tool on the read-only connection (D1). Its brute-force scan decodes Float32 BLOBs, which is SQLite-specific. Part 3 replaces it per backend with `searchEmbeddings` (sqlite brute-force / pgvector), per the design spec §7.
  - The app-side embedding reads `unembeddedTurnEvents`, `unembeddedSummaries` and `maxEventId` are dialect-neutral, so they move to Kysely.
- **D15 — Committee liveness reads one grouped query.**
  - Today `liveStatusFields` calls `listSessions(ws)[0]?.lastActiveAt` once per roster candidate. Async, that would be an N+1 of 3-query transactions.
  - Instead, the new `latestActivityByWorkspace(ids)` runs `MAX(last_active_at) … GROUP BY workspace_id` per 500 ids. It returns the same value: `MAX` ignores NULLs, which matches the first row of `ORDER BY COALESCE(last_active_at, 0) DESC`.
  - `liveStatusFields` becomes a pure function of its inputs.
- **D16 — `EXPLAIN QUERY PLAN` pins target the compiled Kysely SQL.**
  - The exported SQL strings (`OBSERVED_MAX_SQL`, `TOP_TOOLS_SQL`, `LATEST_ASSISTANT_SQL`, `LIST_SESSION_COSTS_SQL`, `LIST_SESSION_COSTS_BY_WS_SQL`) become exported query builders: `observedMaxQuery`, `topToolsQuery`, `latestAssistantQuery`, `listSessionCostsQuery`.
  - The pins compile them through the test helper `explainPlan(raw, query)`. That pins the SQL actually executed, not a copy.
- **D17 — Dialect-neutral latest-tags query.** `listSessions` picks each session's latest tagged chapter with SQLite's bare-column `MAX(id)` rule. That becomes `WHERE id IN (SELECT MAX(id) … GROUP BY session_id)`. The rows are the same, and the read snapshot covers it with two tagged chapters on one session.
- **D18 — Perf gate tolerances are ones the container can resolve.**
  - Read metrics swing about ±25% here, so 2a's 10% read gate couldn't actually be resolved. Every metric gets **tol 25%**. `stall_max_ms` gets 50%, because one GC pause moves a maximum.
  - Metrics measured in µs, plus `list_sessions_ms`, also get an **absolute slack**. A few µs of async overhead is a large ratio of a tiny number but far below one IPC round trip:
    - `summary_cached_us` and `lookup_mapping_us`: +15 µs.
    - `list_sessions_ms`: +0.15 ms. Kysely builds, compiles and maps three result sets per call, which measured +17% to +34% (about +0.1 ms) in the prototype.
    - `stall_p50_ms`: +2 ms.
    - `stall_max_ms`: +5 ms.
  - Pass when `candidate ≤ baseline × (1 + tol) + slack`.
  - New metrics:
    - `lookup_mapping_us`, `events_page_ms`.
    - `embed_insert_us_per_row`: the batched `insertEmbeddings` path, 8 rows per call like the backfill.
    - `stall_p50_ms` / `stall_max_ms`: event-loop gaps while a fresh 6000-line session ingests and readers poll the summary, list and events alongside.
- **D19 — Live summary push.**
  - The `'ingest'` listener schedules the trailing re-broadcast synchronously, as before, then awaits `summaryForWorkspace` and sends.
  - A rejection from either push is logged as `observability-broadcast` (warn). Both pushes run from an emit or a timer, where a rejection would otherwise go unhandled (D7).

## Inventory: every remaining raw-handle read and cache

Raw reads in `src/main/db.ts` at `origin/main` `ee75294`, with their production call sites:

| Read | Call sites | Task |
|---|---|---|
| `summaryForWorkspace` | `ipc.ts` `'ingest'` broadcast, trailing re-broadcast, `observability:summaryForWorkspace` | 3 |
| `summaryForSession` (cached at the default top-tools limit) | via `summaryForWorkspace` / `summaryForBrokerSession` | 3 |
| `summaryForBrokerSession` | `ipc.ts` `observability:summaryForBrokerSession` | 3 |
| `recentToolCallsForSession`, `costSeriesForSession`, `tokenSeriesForSession` | inside the summary recompute (exported for tests) | 3 |
| `costForSession` / `costForWorkspace` | summary recompute; `observability:getCost` / `getCostForWorkspace` | 3 |
| `tokensSpentSince` (cached) | `ipc.ts` `usage:rollingSpend` | 3 |
| `lookupBrokerSession` | `summaryForBrokerSession`; `ipc.ts` `claudeIdFor` (`mirror:setOverride`, `transcript:hasForBrokerSession`, `transcript:deleteForBrokerSession`), `observability:summaryForBrokerSession`, `__test:lookupBrokerSession` | 3 |
| `eventsForSession` | `ipc.ts` `committeeCollect` (MCP `committee_collect`), `observability:eventsForSession` | 4 |
| `getSession` | none in production (tests and characterization only) | 4 |
| `lookupVerifiedBrokerSession` | `ipc.ts` `sessions:resolveResumeTarget` | 4 |
| `lookupResumableBrokerSession` (+ raw `claudeSessionIsReal`) | `local.ts` attach → `effectiveResumeOf` thunk | 4 |
| `planUsageRows`, `latestAnchorCovering`, `latestLimitHitAnchor` | `ipc.ts` `computePlanUsage` (`observability:planUsage`, MCP `plan_usage`) | 4 |
| `listSessions` | `ipc.ts` `sessions:list`, `committeeCollect`, `liveStatusFields` (MCP `committee_status` / `committee_roster`); `index.ts` embed backfill | 4 |
| `unembeddedTurnEvents`, `unembeddedSummaries` | `transcriptIndex.ts` `indexSessionTurns` / `indexSessionSummaries` | 4 |
| `maxEventId` | none in production (tests and characterization only) | 4 |
| `getDb()` | `transcriptIndex.ts` `searchTranscripts` default parameter only | 4 (deleted) |

Caches:

| Cache | Keyed by | Filled by | Invalidated by | Task |
|---|---|---|---|---|
| `summaryCache` (`maxEntries: 512`, `ttlMs: 30_000`) | claude session id | `summaryForSession` at the default top-tools limit | `ingestBatch` → `markStale(id, 3 s)` after each committed chunk; `renameSession` / `deleteSession` → `invalidate(id)` after commit; `openDb` / `closeDb` → `clear()` | 3 |
| `spendCache` (`maxEntries: 4`) | `floor(sinceMs / 15 s)` | `tokensSpentSince` | `ingestBatch` (a chunk that inserted a row), `deleteSession`, `openDb` / `closeDb` → `clear()` | 3 |

Not in scope:
- `workspaceListCache` and `ttlCache` in `ipc.ts` (manifests and Docker, not `state.db`).
- `mappingUnresolvedSeen` (a log de-dupe set).
- `pendingClaudeIds` (an in-memory mirror of DB state; 2a owns it and 2b doesn't touch it).

MCP read paths:
- **Stay raw (D1, D14):** `list_sessions`, `get_session`, `get_cost`, `list_events`, `session_summary`, `list_errors` and `query` on `rodb`, and `search_transcripts` → `searchTranscripts(…, _db)`.
- **Ported in Task 4:** the injected handlers that reach app reads, which are `committee_collect`, `committee_status`, `committee_roster` and `plan_usage`. `perf_status` is already async (2a).

## Verification environment (do this once, before Task 1)

```bash
git -C /workspace/claude-fleet fetch -q origin
WT=/workspace/claude-fleet/.claude/worktrees/async-store-p2b
git -C /workspace/claude-fleet worktree add -b feat/async-store-p2b "$WT" origin/main
cd "$WT"
npm ci --ignore-scripts                                  # worktree-local node_modules
printf 'electron-stub' > node_modules/electron/path.txt  # lets `import { app } from 'electron'` load in vitest
npx vitest run src/main/db.test.ts                       # baseline: expect PASS
npx tsc --noEmit -p tsconfig.node.json; echo "node tsc exit $?"   # expect 0
npx tsc --noEmit -p tsconfig.web.json;  echo "web tsc exit $?"    # expect 0
```

Never `cd /workspace/claude-fleet` from inside the worktree. Use `$WT` paths or `git -C "$WT"`.

If the test run fails with "Module did not self-register", run `(cd node_modules/better-sqlite3 && npx --yes prebuild-install)` once.

`CI=true npx vitest run src` takes ~155 s here. `src/main/jsonlWatcher.ordering.test.ts > stop() resolves only after every queued batch has finished` times out about one run in three under full-suite load on unchanged `origin/main` (it's chokidar-timed and mocks `db.ts`). If that's the only failure, re-run that one file: three clean passes in a row mean it's the flake, not your change.

### Test-conversion rule (Tasks 3 and 4)

Save this helper once. It extends 2a's `conv-async.py` with `db.fn(` member calls, dereferenced results and comment lines:

```bash
cat > /tmp/conv-async-reads.py <<'PYEOF'
#!/usr/bin/env python3
"""Mechanical sync→async test conversion (async store part 2b: reads).

usage: python3 /tmp/conv-async-reads.py --fns name1,name2 file1.test.ts [file2.test.ts ...]

1. Prefix `await ` to every call of a listed function, bare or as `db.fn(`,
   that is not already awaited, not a declaration, and not on a comment line.
2. Leave import lists untouched.
3. Parenthesize an awaited call that is immediately dereferenced:
   `await fn(x).y` / `await fn(x)?.y` / `await fn(x)[0]` → `(await fn(x)).y`.
4. Make every it/test/beforeEach/afterEach/beforeAll/afterAll callback of the
   form `() => {` async.
Helpers that now contain `await` are NOT rewritten — tsc reports them (TS1308).
"""
import re, sys

args = sys.argv[1:]
if len(args) < 3 or args[0] != '--fns':
    sys.exit(__doc__)
fns = '|'.join(re.escape(f) for f in args[1].split(','))
call = re.compile(r'(?<![\w.])(?<!await )(?<!function )((?:db\.)?(?:' + fns + r'))\(')
for path in args[2:]:
    src = open(path).read()
    out = '\n'.join(
        line if line.lstrip().startswith(('//', '*', '/*')) else call.sub(lambda m: 'await ' + m.group(1) + '(', line)
        for line in src.split('\n'))
    out = re.sub(r'import \{[^}]*\}', lambda m: m.group(0).replace('await ', ''), out, flags=re.S)
    awaited = re.compile(r'await ((?:db\.)?(?:' + fns + r'))\(')
    i = 0
    while (m := awaited.search(out, i)):
        depth, j = 0, m.end() - 1
        while j < len(out):
            depth += {'(': 1, ')': -1}.get(out[j], 0)
            if depth == 0:
                break
            j += 1
        if out[j + 1:j + 2] in ('.', '[') or out[j + 1:j + 3] == '?.':
            out = out[:m.start()] + '(' + out[m.start():j + 1] + ')' + out[j + 1:]
        i = m.end()
    out = re.sub(r"\b(it|test|beforeEach|afterEach|beforeAll|afterAll)\((['\"`][^\n]*?['\"`]\s*,\s*)?\(\) => \{",
                 lambda m: f"{m.group(1)}({m.group(2) or ''}async () => {{", out)
    if out != src:
        open(path, 'w').write(out)
        print('converted', path)
PYEOF
```

1. Run `python3 /tmp/conv-async-reads.py --fns <the task's functions> <the task's test files>`.
2. Run `npx tsc --noEmit -p tsconfig.node.json`. The task lists the hand edits that remain. Each other hit is a helper that now awaits (TS1308): make it `async`, and `await` its call sites.
3. A `vi.mock('./db.js', …)` factory that stubs a converted function keeps returning plain values. `await` on a plain value is fine.

---

## File structure

| File | Responsibility |
|---|---|
| `src/main/state/ingestFixture.ts` (new) | The ingest fixture (`WS`, `S`, `at`, `FIXTURE`, `dump`) moved out of `dbIngestBatch.test.ts`, so the read characterization can share it. Test support only. |
| `src/main/dbReadCharacterization.test.ts` + `.snap` (new) | Every exported `state.db` read on one fixture state, recorded pre-port. |
| `src/main/state/stateBench.test.ts` | Adds the 2b metrics and the `GATE` table (D18). |
| `src/main/asyncCache.ts` + `.test.ts` (new) | `asyncKeyedCache` (D10, D11). Replaces `syncCache.ts` + `.test.ts` (deleted in Task 3). |
| `src/main/state/explainPlan.ts` (new) | Test helper: `EXPLAIN QUERY PLAN` of a compiled Kysely query (D16). |
| `src/main/db.ts` | Every read async on Kysely. Query builders exported for the pins. `latestActivityByWorkspace` added. `getDb` / `openDbOrThrow` / `claudeSessionIsReal` removed. |
| `src/main/ipc.ts` | Awaits the reads. Async live push (D19). Committee liveness via `latestActivityByWorkspace` (D15). |
| `src/main/local.ts` | `effectiveResumeOf` is async. |
| `src/main/index.ts`, `src/main/transcriptIndex.ts` | Await the backfill reads. `searchTranscripts`' `db` parameter is required (D14). |
| `docs/SPEC.md` | §4, §6, §7, §11 (Task 5). |

---

### Task 1: Read characterization snapshot and perf-bench metrics, recorded pre-port

**Files:**
- Create: `src/main/state/ingestFixture.ts`
- Modify: `src/main/dbIngestBatch.test.ts` (imports the fixture instead of defining it)
- Create: `src/main/dbReadCharacterization.test.ts` (its `.snap` is written by the first run)
- Modify: `src/main/state/stateBench.test.ts`

**Interfaces:**
- Produces: `WS`, `S`, `at(s)`, `FIXTURE`, `dump(raw)` from `./state/ingestFixture.js`. The `GATE` table and the metrics that Task 5's A/B compares. `/tmp/async-store-p2b-base.sha`, the baseline commit.

- [ ] **Step 1: Move the ingest fixture into its own module**

Create `src/main/state/ingestFixture.ts` with a header, then the block of `src/main/dbIngestBatch.test.ts` from `const WS = '01WSINGEST';` up to (not including) `let dir: string;`, **moved verbatim**. Add `export` to `WS`, `S` and `at` (`FIXTURE` and `dump` are already exported). This script does exactly that:

```bash
cd "$WT"
python3 - <<'EOF'
p = 'src/main/dbIngestBatch.test.ts'
s = open(p).read()
start = s.index("const WS = '01WSINGEST';")
end = s.index("let dir: string;")
block = s[start:end]
mod = ("// The state.db ingest fixture shared by the ingest and read characterization\n"
       "// tests. Test support only: never imported by app code.\n"
       "import type Database from 'better-sqlite3';\n\n"
       + block.replace("const WS =", "export const WS =")
              .replace("const S =", "export const S =")
              .replace("const at =", "export const at =").rstrip() + "\n")
open('src/main/state/ingestFixture.ts', 'w').write(mod)
s = s[:start] + s[end:]
s = s.replace("import * as db from './db.js';\n",
              "import * as db from './db.js';\nimport { WS, S, at, FIXTURE, dump } from './state/ingestFixture.js';\n", 1)
open(p, 'w').write(s)
EOF
head -12 src/main/dbIngestBatch.test.ts
```

Expected: the test file's imports end with `import { WS, S, at, FIXTURE, dump } from './state/ingestFixture.js';`, followed by one blank line and `let dir: string;`. If there are two blank lines, delete one.

- [ ] **Step 2: Run the ingest characterization; it must still pass unmodified**

Run: `npx vitest run src/main/dbIngestBatch.test.ts`
Expected: PASS (9 tests), with no snapshot written or updated.

- [ ] **Step 3: Write the read characterization test**

Create `src/main/dbReadCharacterization.test.ts`:

```ts
// state.db read characterization (async store part 2b). Recorded on the
// pre-port synchronous reads; every later version of the read path must
// reproduce it unmodified. `await` on a sync return is a no-op, so the same
// file runs on both sides.
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as db from './db.js';
import { EMBED_DIM, EMBED_MODEL_ID, encodeVector } from './vectors.js';
import { WS, S, FIXTURE } from './state/ingestFixture.js';

const WS2 = '01WSREADS2';
const S2 = 'sess-reads-2';
const S2_LINES = [
  JSON.stringify({ type: 'user', uuid: 'r1', timestamp: '2026-07-01T01:00:00.000Z', message: { role: 'user', content: 'second workspace prompt' } }),
  JSON.stringify({ type: 'assistant', uuid: 'r2', timestamp: '2026-07-01T01:00:05.000Z', message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 4, output_tokens: 9, service_tier: 'priority' }, content: [{ type: 'text', text: 'ok' }] } }),
  // Two tagged chapters: listSessions must report the latest one's tags.
  JSON.stringify({ type: 'session-summary', summary: 'Older chapter.', tags: ['old'], model: 'haiku', fromEventTs: '2026-07-01T01:00:00.000Z', toEventTs: '2026-07-01T01:00:05.000Z', timestamp: '2026-07-01T01:00:06.000Z' }),
  JSON.stringify({ type: 'assistant', uuid: 'r3', timestamp: '2026-07-01T01:00:07.000Z', message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 1, output_tokens: 1 } } }),
  JSON.stringify({ type: 'session-summary', summary: 'Newer chapter.', tags: ['new', 'tags'], model: 'haiku', fromEventTs: '2026-07-01T01:00:00.000Z', toEventTs: '2026-07-01T01:00:07.000Z', timestamp: '2026-07-01T01:00:08.000Z' }),
];

let dir: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cf-read-char-'));
  db.openDb(dir);
  for (const line of FIXTURE) await db.ingestLine(WS, S, line);
  for (const line of S2_LINES) await db.ingestLine(WS2, S2, line);
  await db.learnBrokerSessionMapping(WS, 'tab-1', S);
  await db.learnBrokerSessionMapping(WS2, 'auto-run1-step1', S2);
  const [turn] = await db.unembeddedTurnEvents(S, EMBED_MODEL_ID, 1);
  await db.insertEmbedding({
    workspaceId: WS, sessionId: S, kind: 'turn', refEventId: turn.id, ts: turn.ts, text: 'x',
    modelId: EMBED_MODEL_ID, dim: EMBED_DIM, vec: encodeVector(new Float32Array(EMBED_DIM)), dedupKey: `t${turn.id}`,
  });
});
afterEach(async () => {
  await db.closeDb();
  rmSync(dir, { recursive: true, force: true });
});

it('every state.db read returns the recorded value', async () => {
  const insideWindow = Date.UTC(2026, 6, 1, 14);
  const reads = {
    eventsForSession: (await db.eventsForSession(S)).map(({ rawJsonl, ...e }) => ({ ...e, rawLen: rawJsonl.length })),
    eventsForSessionPage: (await db.eventsForSession(S, 3, 2)).map((e) => e.id),
    getSession: await db.getSession(S),
    getSessionMissing: await db.getSession('nope'),
    summaryForWorkspace: await db.summaryForWorkspace(WS),
    summaryForWorkspaceEmpty: await db.summaryForWorkspace('01WSNONE'),
    summaryForSessionTop1: await db.summaryForSession(S, 1),
    summaryForBrokerSession: await db.summaryForBrokerSession(WS, 'tab-1'),
    summaryForBrokerSessionUnmapped: await db.summaryForBrokerSession(WS, 'tab-none'),
    recentToolCallsForSession: await db.recentToolCallsForSession(S, 2),
    costSeriesForSession: await db.costSeriesForSession(S, 2),
    tokenSeriesForSession: await db.tokenSeriesForSession(S),
    tokensSpentSince: await db.tokensSpentSince(0),
    tokensSpentSinceLater: await db.tokensSpentSince(Date.UTC(2026, 6, 1, 0, 30)),
    costForSession: await db.costForSession(S),
    costForWorkspace: await db.costForWorkspace(WS2),
    planUsageRows: await db.planUsageRows(0, Date.UTC(2027, 0, 1)),
    latestAnchorCovering: await db.latestAnchorCovering(insideWindow),
    latestAnchorCoveringNone: await db.latestAnchorCovering(0),
    latestLimitHitAnchor: await db.latestLimitHitAnchor(),
    listSessions: await db.listSessions(),
    listSessionsWs2: await db.listSessions(WS2),
    lookupBrokerSession: await db.lookupBrokerSession(WS, 'tab-1'),
    lookupBrokerSessionNone: await db.lookupBrokerSession(WS, 'tab-none'),
    lookupVerifiedBrokerSession: await db.lookupVerifiedBrokerSession(WS2, 'auto-run1-step1'),
    lookupResumableBrokerSession: await db.lookupResumableBrokerSession(WS, 'tab-1'),
    unembeddedTurnEvents: (await db.unembeddedTurnEvents(S, EMBED_MODEL_ID)).map((t) => [t.id, t.workspaceId, t.ts, t.rawJsonl.length]),
    unembeddedSummaries: await db.unembeddedSummaries(EMBED_MODEL_ID),
    maxEventId: await db.maxEventId(S),
    maxEventIdNone: await db.maxEventId('nope'),
  };
  expect(reads).toMatchSnapshot();
});
```

- [ ] **Step 4: Record the snapshot on the pre-port code**

Run: `npx vitest run src/main/dbReadCharacterization.test.ts`
Expected: PASS, `Snapshots 1 written`. Check the recorded file. `src/main/__snapshots__/dbReadCharacterization.test.ts.snap` must show:
- `"headless": true` for `sess-reads-2`, with `"tags": ["new", "tags"]`;
- `"tags": ["Broker", " reconnect "]` for `sess-ingest`;
- a non-null `latestAnchorCovering` with `"kind": "limit-hit"`;
- `"lookupResumableBrokerSession": "sess-ingest"`, `"maxEventId": 16`, `"maxEventIdNone": 0`.

`sess-ingest`'s `listSessions` `usd` is a float sum such as `0.7534357500000001`. That order-dependent tail is intended: the port must keep the cost rows' order.

```bash
/usr/bin/grep -c '"headless": true' src/main/__snapshots__/dbReadCharacterization.test.ts.snap   # expect 2
```

- [ ] **Step 5: Add the 2b metrics to the bench**

Apply these five edits to `src/main/state/stateBench.test.ts`.

(a) In the header comment, replace

```ts
// Machine noise is large (±30% between quiet and busy minutes), so the gate
// is A/B: baseline and candidate runs alternate in one session (the plan's
// perf-gate task has the loop). Numbers are machine-specific.
```

with

```ts
// Machine noise is large (about ±25% on read metrics between quiet and busy
// minutes), so the gate is A/B: baseline and candidate runs alternate in one
// session (the plan's perf-gate task has the loop). Numbers are machine-specific.
```

(b) Replace `const N_EMBEDDINGS = 5000;` with:

```ts
const N_EMBEDDINGS = 5000;
/** transcriptIndex's EMBED_BATCH: the backfill inserts at most this many rows per call. */
const EMBED_BATCH_ROWS = 8;
const N_LOOKUPS = 2000;
```

(c) Replace the whole `TOLERANCE` block, from `/** Allowed slowdown per metric` through its closing `};`, with:

```ts
/** Pass when candidate ≤ baseline × (1 + tol) + slack (slack in the metric's
 *  own unit). Read metrics resolve to about ±25% in the container, so no gate
 *  is tighter than that; the µs-scale metrics also get an absolute slack,
 *  because a few µs of async overhead is a large ratio of a tiny number and
 *  far below one IPC round trip. */
export const GATE: Record<string, { tol: number; slack: number }> = {
  ingest_fresh_us_per_line: { tol: 0.25, slack: 0 },
  ingest_replay_us_per_line: { tol: 0.25, slack: 0 },
  summary_uncached_ms: { tol: 0.25, slack: 0 },
  summary_cached_us: { tol: 0.25, slack: 15 },
  lookup_mapping_us: { tol: 0.25, slack: 15 },
  events_page_ms: { tol: 0.25, slack: 0 },
  list_sessions_ms: { tol: 0.25, slack: 0.15 },
  search_ms: { tol: 0.25, slack: 0 },
  embed_insert_us_per_row: { tol: 0.25, slack: 0 },
  stall_p50_ms: { tol: 0.25, slack: 2 },
  stall_max_ms: { tol: 0.5, slack: 5 },
  record_mapping_us: { tol: 0.25, slack: 0 },
  record_error_us: { tol: 0.25, slack: 0 },
  perf_flush_ms: { tol: 0.25, slack: 0 },
};
```

(d) Insert the stall probe directly above `const median = (xs: number[]): number =>`:

```ts
/** Gaps between consecutive 0 ms timer ticks: how long the loop went without
 *  reaching its timers phase (≈1 ms when idle). */
function stallProbe(): { stop: () => number[] } {
  const gaps: number[] = [];
  let last = performance.now();
  let on = true;
  const tick = (): void => {
    const now = performance.now();
    gaps.push(now - last);
    last = now;
    if (on) setTimeout(tick, 0);
  };
  setTimeout(tick, 0);
  return { stop: () => { on = false; return gaps; } };
}

```

(e) In `oneRun()`, make three changes:

- After `m.summary_cached_us = median(hits) * 1000;` insert:

```ts
    m.lookup_mapping_us = ((await time(async () => {
      for (let i = 0; i < N_LOOKUPS; i++) await db.lookupBrokerSession('ws', 'tab-big');
    })) * 1000) / N_LOOKUPS;
    const pages: number[] = [];
    for (let i = 0; i < 50; i++) pages.push(await time(() => db.eventsForSession('big', 0, 500)));
    m.events_page_ms = median(pages);
```

- After `m.list_sessions_ms = median(lists);` insert:

```ts

    // Event-loop stall while a fresh session ingests with readers polling alongside.
    let ingesting = true;
    const loop = stallProbe();
    const ingest = (async () => {
      const all = lines(N_LINES, 'stall');
      // The watcher's async file read between batches is a macrotask boundary.
      for (let i = 0; i < all.length; i += WATCHER_BATCH) {
        await ingestLikeWatcher('ws', 'stall', all.slice(i, i + WATCHER_BATCH));
        await new Promise<void>((r) => setImmediate(r));
      }
    })().finally(() => { ingesting = false; });
    const readers = (async () => {
      while (ingesting) {
        await db.summaryForSession('big', 6);
        await db.listSessions();
        await db.eventsForSession('big', 0, 200);
        await new Promise<void>((r) => setImmediate(r));
      }
    })();
    await Promise.all([ingest, readers]);
    const gaps = loop.stop().sort((a, b) => a - b);
    m.stall_p50_ms = median(gaps);
    m.stall_max_ms = gaps[gaps.length - 1];
```

- Replace the per-row embedding seed loop, from `    const vec = new Float32Array(EMBED_DIM);` up to (not including) `    const embed = async`, with the timed batched path:

```ts
    const rows = Array.from({ length: N_EMBEDDINGS }, (_, i) => {
      const vec = new Float32Array(EMBED_DIM);
      vec[i % EMBED_DIM] = 1;
      return { workspaceId: `ws${i % 7}`, sessionId: `s${i % N_LIST_SESSIONS}`, kind: 'turn' as const, refEventId: i, ts: i,
        text: `turn ${i}`, modelId: EMBED_MODEL_ID, dim: EMBED_DIM, vec: encodeVector(vec), dedupKey: `t${i}` };
    });
    m.embed_insert_us_per_row = ((await time(async () => {
      for (let i = 0; i < rows.length; i += EMBED_BATCH_ROWS) await db.insertEmbeddings(rows.slice(i, i + EMBED_BATCH_ROWS));
    })) * 1000) / N_EMBEDDINGS;
```

Finally, in the compare branch, replace the `const rows = Object.keys(TOLERANCE).map(…)` statement (through its closing `}));`) with:

```ts
      const rows = Object.keys(GATE).map((k) => ({
        metric: k, baseline: base[k], candidate: cand[k], change: `${(((cand[k] - base[k]) / base[k]) * 100).toFixed(1)}%`,
        limit: `+${GATE[k].tol * 100}%${GATE[k].slack ? ` +${GATE[k].slack}` : ''}`,
        ok: cand[k] <= base[k] * (1 + GATE[k].tol) + GATE[k].slack,
      }));
```

Run: `/usr/bin/grep -n "TOLERANCE\|insertEmbedding(" src/main/state/stateBench.test.ts`
Expected: no output.

- [ ] **Step 6: Smoke-run the bench once**

Run: `STATE_BENCH=1 STATE_BENCH_OUT=/tmp/p2b-smoke.json npx vitest run src/main/state/stateBench.test.ts && cat /tmp/p2b-smoke.json`
Expected: PASS (about 40 s), with all 14 `GATE` keys present and `stall_p50_ms` a few tens of ms, not 0. On the prototype: `stall_p50_ms` ≈ 18–21, `stall_max_ms` ≈ 36–45, `list_sessions_ms` ≈ 0.5. A stall near the whole ingest time (≈450 ms) means the macrotask yield between batches is missing.

- [ ] **Step 7: Typecheck, full suite, commit, record the baseline**

```bash
npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json && CI=true npx vitest run src
git -C "$WT" add src/main/state/ingestFixture.ts src/main/dbIngestBatch.test.ts src/main/dbReadCharacterization.test.ts \
  src/main/__snapshots__/dbReadCharacterization.test.ts.snap src/main/state/stateBench.test.ts
git -C "$WT" commit -m "test(state): read characterization snapshot + 2b bench metrics, recorded pre-port (async store 2b)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git -C "$WT" rev-parse HEAD > /tmp/async-store-p2b-base.sha
```

Expected: both tsc exit 0. The suite passes (see *Verification environment* for the one known flake).

---

### Task 2: `asyncKeyedCache`

**Files:**
- Create: `src/main/asyncCache.ts`
- Test: `src/main/asyncCache.test.ts`

**Interfaces:**
- Produces: `asyncKeyedCache<V>(opts: { maxEntries: number; ttlMs?: number; now?: () => number }): AsyncKeyedCache<V>`, where `AsyncKeyedCache<V>` is `{ get(key: string, compute: () => Promise<V>): Promise<V>; invalidate(key: string): void; markStale(key: string, graceMs: number): void; clear(): void }`. Task 3 consumes it.

- [ ] **Step 1: Write the failing tests**

Create `src/main/asyncCache.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { asyncKeyedCache } from './asyncCache.js';

/** A compute whose promise the test settles by hand. */
function deferred<V>(): { promise: Promise<V>; resolve: (v: V) => void; reject: (e: Error) => void } {
  let resolve!: (v: V) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<V>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('asyncKeyedCache', () => {
  it('computes once per key and serves hits without recomputing', async () => {
    let calls = 0;
    const c = asyncKeyedCache<number>({ maxEntries: 8 });
    expect(await c.get('a', async () => { calls += 1; return 42; })).toBe(42);
    expect(await c.get('a', async () => { calls += 1; return 99; })).toBe(42);
    expect(calls).toBe(1);
  });

  it('caches null results too (a miss is not "falsy")', async () => {
    let calls = 0;
    const c = asyncKeyedCache<number | null>({ maxEntries: 8 });
    expect(await c.get('a', async () => { calls += 1; return null; })).toBeNull();
    expect(await c.get('a', async () => { calls += 1; return null; })).toBeNull();
    expect(calls).toBe(1);
  });

  it('invalidate(key) forces recompute for that key only', async () => {
    let a = 0; let b = 0;
    const c = asyncKeyedCache<number>({ maxEntries: 8 });
    await c.get('a', async () => ++a);
    await c.get('b', async () => ++b);
    c.invalidate('a');
    expect(await c.get('a', async () => ++a)).toBe(2);
    expect(await c.get('b', async () => ++b)).toBe(1);
  });

  it('clear() drops everything', async () => {
    let calls = 0;
    const c = asyncKeyedCache<number>({ maxEntries: 8 });
    await c.get('a', async () => ++calls);
    c.clear();
    await c.get('a', async () => ++calls);
    expect(calls).toBe(2);
  });

  it('exceeding maxEntries clears the whole cache (cap-clear, no LRU)', async () => {
    let recomputes = 0;
    const c = asyncKeyedCache<number>({ maxEntries: 2 });
    await c.get('a', async () => 1);
    await c.get('b', async () => 2);
    await c.get('c', async () => 3);
    await c.get('a', async () => { recomputes += 1; return 1; });
    expect(recomputes).toBe(1);
    await c.get('c', async () => { recomputes += 1; return 3; });
    expect(recomputes).toBe(1);
  });

  it('ttlMs expires entries (fake clock)', async () => {
    let t = 1000; let calls = 0;
    const c = asyncKeyedCache<number>({ maxEntries: 8, ttlMs: 500, now: () => t });
    await c.get('a', async () => ++calls);
    t = 1499;
    await c.get('a', async () => ++calls);
    expect(calls).toBe(1);
    t = 1500;
    await c.get('a', async () => ++calls);
    expect(calls).toBe(2);
  });

  it('a rejected compute rejects every sharer and caches nothing', async () => {
    let calls = 0;
    const c = asyncKeyedCache<number>({ maxEntries: 8 });
    const d = deferred<number>();
    const first = c.get('a', () => { calls += 1; return d.promise; });
    const second = c.get('a', async () => { calls += 1; return 5; });
    d.reject(new Error('boom'));
    await expect(first).rejects.toThrow('boom');
    await expect(second).rejects.toThrow('boom');
    expect(await c.get('a', async () => { calls += 1; return 7; })).toBe(7);
    expect(calls).toBe(2);
  });

  it('a compute that throws synchronously rejects and caches nothing', async () => {
    const c = asyncKeyedCache<number>({ maxEntries: 8 });
    await expect(c.get('a', () => { throw new Error('sync boom'); })).rejects.toThrow('sync boom');
    expect(await c.get('a', async () => 7)).toBe(7);
  });
});

describe('in-flight semantics', () => {
  it('concurrent misses on one key share a single compute', async () => {
    let calls = 0;
    const c = asyncKeyedCache<number>({ maxEntries: 8 });
    const d = deferred<number>();
    const p1 = c.get('a', () => { calls += 1; return d.promise; });
    const p2 = c.get('a', () => { calls += 1; return Promise.resolve(2); });
    expect(p2).toBe(p1);
    d.resolve(1);
    expect(await Promise.all([p1, p2])).toEqual([1, 1]);
    expect(calls).toBe(1);
  });

  it('an invalidate during the compute wins: the result is returned, not stored', async () => {
    let calls = 0;
    const c = asyncKeyedCache<number>({ maxEntries: 8 });
    const d = deferred<number>();
    const stale = c.get('a', () => { calls += 1; return d.promise; });
    c.invalidate('a');
    const fresh = c.get('a', async () => { calls += 1; return 2; });
    expect(fresh).not.toBe(stale);
    d.resolve(1);
    expect(await stale).toBe(1);
    expect(await fresh).toBe(2);
    expect(await c.get('a', async () => { calls += 1; return 3; })).toBe(2);
    expect(calls).toBe(2);
  });

  it('a clear during the compute wins the same way', async () => {
    const c = asyncKeyedCache<number>({ maxEntries: 8 });
    const d = deferred<number>();
    const stale = c.get('a', () => d.promise);
    c.clear();
    d.resolve(1);
    expect(await stale).toBe(1);
    expect(await c.get('a', async () => 2)).toBe(2);
  });

  it('a markStale during the compute caps the stored result', async () => {
    let t = 0; let calls = 0;
    const c = asyncKeyedCache<number>({ maxEntries: 8, ttlMs: 30_000, now: () => t });
    const d = deferred<number>();
    const p = c.get('a', () => { calls += 1; return d.promise; });
    c.markStale('a', 3_000);
    d.resolve(1);
    await p;
    t = 2_999;
    expect(await c.get('a', async () => { calls += 1; return 2; })).toBe(1);
    t = 3_000;
    expect(await c.get('a', async () => { calls += 1; return 2; })).toBe(2);
    expect(calls).toBe(2);
  });
});

describe('markStale', () => {
  it('is a no-op for missing keys', async () => {
    const c = asyncKeyedCache<number>({ maxEntries: 4, ttlMs: 30_000, now: () => 0 });
    c.markStale('absent', 1_000);
    let computes = 0;
    await c.get('absent', async () => ++computes);
    expect(computes).toBe(1);
  });

  it('caps remaining lifetime without extending it', async () => {
    let t = 0;
    const c = asyncKeyedCache<number>({ maxEntries: 4, ttlMs: 30_000, now: () => t });
    let computes = 0;
    await c.get('k', async () => ++computes);
    t = 1_000;
    c.markStale('k', 3_000);
    t = 2_000;
    c.markStale('k', 10_000);
    t = 3_999;
    await c.get('k', async () => ++computes);
    expect(computes).toBe(1);
    t = 4_000;
    await c.get('k', async () => ++computes);
    expect(computes).toBe(2);
    t = 5_000;
    await c.get('k', async () => ++computes);
    expect(computes).toBe(2);
  });

  it('the tighter of TTL and stale horizon wins', async () => {
    let t = 0;
    const c = asyncKeyedCache<number>({ maxEntries: 4, ttlMs: 5_000, now: () => t });
    let computes = 0;
    await c.get('k', async () => ++computes);
    t = 1_000;
    c.markStale('k', 10_000);
    t = 5_000;
    await c.get('k', async () => ++computes);
    expect(computes).toBe(2);
  });

  // The #383 storm: an event every 200ms + a poll every 1500ms for 60s.
  it('bounds the recompute storm to the grace cadence', async () => {
    let t = 0;
    const c = asyncKeyedCache<number>({ maxEntries: 4, ttlMs: 30_000, now: () => t });
    let computes = 0;
    for (t = 0; t <= 60_000; t += 100) {
      if (t % 200 === 0) c.markStale('s', 3_000);
      if (t % 1_500 === 0) await c.get('s', async () => ++computes);
    }
    expect(computes).toBe(14);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/main/asyncCache.test.ts`
Expected: FAIL, `Failed to load url ./asyncCache.js` (or "Cannot find module").

- [ ] **Step 3: Implement**

Create `src/main/asyncCache.ts`:

```ts
// Keyed async cache for the state.db observability reads
// (spec 2026-08-15-summary-read-caches-design.md). Hard invalidate() is the
// correctness mechanism for deletes/renames; markStale() is the hot-path
// debounce for frequent writes (#383); ttlMs is only a safety net against a
// missed invalidation path. Eviction is deliberately dumb: when an insert
// would exceed maxEntries, clear everything.
//
// Async rules: concurrent misses on a key share one compute; a stale entry
// is recomputed and awaited (never served stale past its horizon); an
// invalidate/clear that lands while a compute is in flight wins, so that
// compute's result is returned to its callers but never stored; a markStale
// that lands while a compute is in flight caps the stored result.

export interface AsyncKeyedCache<V> {
  get(key: string, compute: () => Promise<V>): Promise<V>;
  invalidate(key: string): void;
  /** Cap the entry's REMAINING lifetime at graceMs (debounced invalidation,
   *  #383). Never extends a lifetime; a recompute clears the cap. On a key
   *  with a compute in flight, the cap applies to the stored result. */
  markStale(key: string, graceMs: number): void;
  clear(): void;
}

interface Flight<V> {
  promise: Promise<V>;
  /** Set by invalidate/clear: the result is returned but not stored. */
  dropped: boolean;
  staleAt?: number;
}

export function asyncKeyedCache<V>(opts: {
  maxEntries: number;
  ttlMs?: number;
  now?: () => number;
}): AsyncKeyedCache<V> {
  // Lazy lambda: module-level caches are built before test fake-timers
  // install their Date mock.
  const now = opts.now ?? ((): number => Date.now());
  const entries = new Map<string, { value: V; at: number; staleAt?: number }>();
  const flights = new Map<string, Flight<V>>();
  const minHorizon = (a: number | undefined, b: number): number => (a === undefined ? b : Math.min(a, b));

  return {
    get(key: string, compute: () => Promise<V>): Promise<V> {
      const hit = entries.get(key);
      const fresh =
        hit !== undefined &&
        (opts.ttlMs === undefined || now() - hit.at < opts.ttlMs) &&
        (hit.staleAt === undefined || now() < hit.staleAt);
      if (hit && fresh) return Promise.resolve(hit.value);
      const inFlight = flights.get(key);
      if (inFlight) return inFlight.promise;
      const flight: Flight<V> = { promise: Promise.resolve(undefined as V), dropped: false };
      // Registered before compute() runs, so a synchronous throw still unregisters it.
      flights.set(key, flight);
      flight.promise = (async () => {
        try {
          const value = await compute(); // a rejection propagates; nothing is stored
          if (!flight.dropped) {
            if (!entries.has(key) && entries.size >= opts.maxEntries) entries.clear();
            entries.set(key, { value, at: now(), staleAt: flight.staleAt });
          }
          return value;
        } finally {
          if (flights.get(key) === flight) flights.delete(key);
        }
      })();
      return flight.promise;
    },
    invalidate(key: string): void {
      entries.delete(key);
      const flight = flights.get(key);
      if (flight) {
        flight.dropped = true;
        flights.delete(key);
      }
    },
    markStale(key: string, graceMs: number): void {
      const horizon = now() + graceMs;
      const hit = entries.get(key);
      if (hit) hit.staleAt = minHorizon(hit.staleAt, horizon);
      const flight = flights.get(key);
      if (flight) flight.staleAt = minHorizon(flight.staleAt, horizon);
    },
    clear(): void {
      entries.clear();
      for (const flight of flights.values()) flight.dropped = true;
      flights.clear();
    }
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/main/asyncCache.test.ts`
Expected: PASS (16 tests).

- [ ] **Step 5: Mutation check (do not commit the mutation)**

Each D11 rule must be load-bearing. Break one at a time, then restore the file:

```bash
cp src/main/asyncCache.ts /tmp/asyncCache.bak
sed -i 's/if (!flight.dropped) {/if (true) {/' src/main/asyncCache.ts
npx vitest run src/main/asyncCache.test.ts 2>&1 | /usr/bin/grep -E "Tests "   # expect 2 failed (invalidate/clear during compute)
cp /tmp/asyncCache.bak src/main/asyncCache.ts
sed -i 's/staleAt: flight.staleAt });/});/' src/main/asyncCache.ts
npx vitest run src/main/asyncCache.test.ts 2>&1 | /usr/bin/grep -E "Tests "   # expect 1 failed (markStale during compute)
cp /tmp/asyncCache.bak src/main/asyncCache.ts
npx vitest run src/main/asyncCache.test.ts 2>&1 | /usr/bin/grep -E "Tests "   # expect 16 passed
```

- [ ] **Step 6: Typecheck and commit**

```bash
npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json
git -C "$WT" add src/main/asyncCache.ts src/main/asyncCache.test.ts
git -C "$WT" commit -m "feat(state): asyncKeyedCache with in-flight de-dupe; invalidation wins over an in-flight compute (async store 2b)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The observability summary path goes async (summary, cost, spend, broker lookup) on the async caches

**Files:**
- Modify: `src/main/db.ts` (cache construction, summary family, cost rollups, `tokensSpentSince`, `lookupBrokerSession`, `summaryForBrokerSession`)
- Modify: `src/main/ipc.ts` (live push, trailing re-broadcast, `usage:rollingSpend`, `claudeIdFor` and its three handlers, `observability:summaryForBrokerSession`)
- Create: `src/main/state/explainPlan.ts`
- Delete: `src/main/syncCache.ts`, `src/main/syncCache.test.ts`
- Test: `src/main/dbReadCache.test.ts`, `src/main/dbSessionStats.test.ts`, `src/main/dbSessionCosts.test.ts`, `src/main/db.test.ts`, `src/main/jsonlWatcher.localdir.test.ts`, `src/main/jsonlWatcher.subagent.test.ts`, `src/main/dbIngestBatch.test.ts`

**Interfaces:**
- Consumes: `asyncKeyedCache` (Task 2). `stateKysely()`, `num`, `existingMappingQ(q, ws, broker)` (2a, private in `db.ts`).
- Produces (all `async`, same resolved shapes as before):
  - `summaryForWorkspace(ws, topToolsLimit = 5): Promise<WorkspaceSummary | null>`
  - `summaryForSession(id, topToolsLimit = 5): Promise<WorkspaceSummary | null>`
  - `summaryForBrokerSession(ws, broker, topToolsLimit = 5): Promise<WorkspaceSummary | null>`
  - `recentToolCallsForSession(id, limit = 10): Promise<ToolCall[]>`
  - `costSeriesForSession(id, limit = 20): Promise<number[]>`
  - `tokenSeriesForSession(id, limit = 20): Promise<number[]>`
  - `tokensSpentSince(sinceMs): Promise<number>`
  - `costForSession(id): Promise<SessionCost>`, `costForWorkspace(ws): Promise<SessionCost>`
  - `lookupBrokerSession(ws, broker): Promise<string | null>`
  - The query builders `observedMaxQuery(q, id)`, `topToolsQuery(q, id, limit)` and `latestAssistantQuery(q, id)`, which replace the exported `OBSERVED_MAX_SQL`, `TOP_TOOLS_SQL` and `LATEST_ASSISTANT_SQL`
  - `explainPlan(raw: Database.Database, query: Compilable): string` in `./state/explainPlan.js`
  - Private helper `costForSessionQ(q, id)`, used by Task 4 too.

- [ ] **Step 1: Convert the tests and re-target the EXPLAIN pins (red)**

```bash
python3 /tmp/conv-async-reads.py \
  --fns summaryForWorkspace,summaryForSession,summaryForBrokerSession,recentToolCallsForSession,costSeriesForSession,tokenSeriesForSession,tokensSpentSince,costForSession,costForWorkspace,lookupBrokerSession \
  src/main/db.test.ts src/main/dbReadCache.test.ts src/main/dbSessionCosts.test.ts src/main/dbSessionStats.test.ts \
  src/main/jsonlWatcher.localdir.test.ts src/main/jsonlWatcher.subagent.test.ts src/main/dbIngestBatch.test.ts
```

Expected: `converted …` for all seven files.

Hand edits:

(a) `src/main/dbSessionStats.test.ts`, header comment: replace

```ts
//   5. EXPLAIN pins — OBSERVED_MAX_SQL + TOP_TOOLS_SQL never mention events
//   6. EXPLAIN pin — LATEST_ASSISTANT_SQL uses a session-prefixed index
```

with

```ts
//   5. EXPLAIN pins — observedMaxQuery + topToolsQuery never mention events
//   6. EXPLAIN pin — latestAssistantQuery uses a session-prefixed index
```

In the `./db.js` import, replace

```ts
  summaryForSession,
  OBSERVED_MAX_SQL,
  TOP_TOOLS_SQL,
  LATEST_ASSISTANT_SQL,
} from './db.js';
```

with

```ts
  summaryForSession,
  stateKysely,
  observedMaxQuery,
  topToolsQuery,
  latestAssistantQuery,
} from './db.js';
import { explainPlan } from './state/explainPlan.js';
```

Replace the last two tests of the file, from `  it('observedMax/topTools EXPLAIN plans never touch events'` to the end of the file, with:

```ts
  it('observedMax/topTools EXPLAIN plans never touch events', async () => {
    // Pin: both rollup queries must be served from their tables, not events.
    // If either plan mentions 'events', a future schema drift broke the query.
    const d = openDb(dir);
    const k = stateKysely();
    expect(explainPlan(d, observedMaxQuery(k, 'x'))).not.toMatch(/\bevents\b/);
    expect(explainPlan(d, topToolsQuery(k, 'x', 5))).not.toMatch(/\bevents\b/);
  });

  it('latestAssistantQuery EXPLAIN plan uses a session-prefixed index', async () => {
    // Pin: the query must use idx_events_session_type (or idx_events_session_ts)
    // and must NOT use the bare idx_events_type index (which scans the entire
    // table for assistant events across all sessions).
    const d = openDb(dir);
    const details = explainPlan(d, latestAssistantQuery(stateKysely(), 'x'));
    expect(details).toMatch(/idx_events_session_type|idx_events_session_ts/);
    expect(details).not.toMatch(/\bidx_events_type\b/);
  });
});
```

(b) `src/main/dbReadCache.test.ts`: add `_summaryRecomputesForTests` to the `./db.js` import, so it reads

```ts
import {
  openDb, closeDb, ingestLine, deleteSession,
  summaryForSession, summaryForWorkspace, tokensSpentSince,
  SUMMARY_STALE_GRACE_MS, _summaryRecomputesForTests,
} from './db.js';
```

Replace `// staleAt horizon check in syncCache.ts.` with `// staleAt horizon check in asyncCache.ts.`. Then insert directly above `describe('tokensSpentSince cache', () => {`:

```ts
// Concurrent misses share one recompute. The write-during-recompute rules are
// unit-tested in asyncCache.test.ts: on the SQLite driver a read stores its
// result before a queued write can commit, so they can't be provoked here.
describe('summaryForSession cache, in flight', () => {
  it('concurrent misses share one recompute', async () => {
    await ingestLine(WS, SES, userLine('u1', 'first'));
    const before = _summaryRecomputesForTests();
    const [a, b] = await Promise.all([summaryForSession(SES), summaryForSession(SES)]);
    expect(b).toBe(a);
    expect(_summaryRecomputesForTests() - before).toBe(1);
  });
});

```

(c) Create `src/main/state/explainPlan.ts`:

```ts
// Test support: the SQLite query plan of a Kysely query, as one string.
// Pins the SQL the store actually compiles, not a hand-copied string.
import type Database from 'better-sqlite3';
import type { Compilable } from 'kysely';

export function explainPlan(raw: Database.Database, query: Compilable): string {
  const { sql, parameters } = query.compile();
  const rows = raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(parameters as unknown[])) as Array<{ detail: string }>;
  return rows.map((r) => r.detail).join(' | ');
}
```

- [ ] **Step 2: Typecheck to see it fail**

Run: `npx tsc --noEmit -p tsconfig.node.json 2>&1 | head`
Expected: errors such as `Module '"./db.js"' has no exported member 'observedMaxQuery'` and `Property 'title' does not exist on type 'WorkspaceSummary | null'`, the latter where a converted call is awaited but `db.ts` is still sync. These are the red state.

- [ ] **Step 3: Switch the caches**

In `src/main/db.ts`, replace `import { syncKeyedCache } from './syncCache.js';` with `import { asyncKeyedCache } from './asyncCache.js';`. Then replace

```ts
const summaryCache = syncKeyedCache<WorkspaceSummary | null>({ maxEntries: 512, ttlMs: 30_000 });
const spendCache = syncKeyedCache<number>({ maxEntries: 4 });
```

with

```ts
const summaryCache = asyncKeyedCache<WorkspaceSummary | null>({ maxEntries: 512, ttlMs: 30_000 });
const spendCache = asyncKeyedCache<number>({ maxEntries: 4 });
```

The invalidation calls in `openDb`, `closeDb`, `ingestBatch`, `renameSession` and `deleteSession` keep their exact positions, since `asyncKeyedCache` has the same `markStale` / `invalidate` / `clear` API. Then delete the old module:

```bash
git -C "$WT" rm -q src/main/syncCache.ts src/main/syncCache.test.ts
```

- [ ] **Step 4: Port the summary family**

In `src/main/db.ts`, replace everything from `export function summaryForWorkspace(` up to (not including) the line `// ── broker_sessions: per-tab mapping ──…` with:

```ts
export async function summaryForWorkspace(workspaceId: string, topToolsLimit = 5): Promise<WorkspaceSummary | null> {
  const latest = await kyselyOrThrow()
    .selectFrom('sessions')
    .select('id')
    .where('workspace_id', '=', workspaceId)
    .orderBy((eb) => eb.fn.coalesce('last_active_at', eb.lit(0)), 'desc')
    .limit(1)
    .executeTakeFirst();
  if (!latest) return null;
  return summaryForSession(latest.id, topToolsLimit);
}

/**
 * Total tokens spent across the **whole fleet** within a trailing time window —
 * the numerator for the observability rail's plan-usage bar. Sums every token
 * type (input + output + cache create + cache read), since Anthropic's rolling
 * subscription limit meters against all of them. `sinceMs` is an absolute epoch
 * floor in ms (the caller passes `Date.now() - windowMs`); as the oldest events
 * age past it they drop out of the sum, mirroring the real rolling reset.
 */
async function tokensSpentSinceUncached(sinceMs: number): Promise<number> {
  const row = await kyselyOrThrow()
    .selectFrom('events')
    .select(
      sql<number>`COALESCE(SUM(
        COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) +
        COALESCE(cache_read_input_tokens, 0) + COALESCE(cache_creation_input_tokens, 0)
      ), 0)`.as('total'),
    )
    .where('ts', 'is not', null)
    .where('ts', '>=', sinceMs)
    .executeTakeFirstOrThrow();
  return num(row.total);
}

export async function summaryForSession(
  sessionId: string,
  topToolsLimit = DEFAULT_TOP_TOOLS,
): Promise<WorkspaceSummary | null> {
  if (topToolsLimit !== DEFAULT_TOP_TOOLS) return summaryForSessionUncached(sessionId, topToolsLimit);
  // The cached object is shared by every caller until invalidation. Freeze it
  // (shallow) so a future consumer that decorates the summary throws instead
  // of silently corrupting the cache for every window. Callers that need to
  // modify must copy.
  return summaryCache.get(sessionId, async () => {
    const summary = await summaryForSessionUncached(sessionId, topToolsLimit);
    return summary === null ? null : Object.freeze(summary);
  });
}

export async function tokensSpentSince(sinceMs: number): Promise<number> {
  // 15s bucket key: freshness emerges from the keying (a stale bucket is
  // simply never asked for again); staleness is capped at 15s against the
  // budget bar's 60s poll. Ingest/delete clear the cache outright.
  return spendCache.get(String(Math.floor(sinceMs / 15_000)), () => tokensSpentSinceUncached(sinceMs));
}

// Exported so the EXPLAIN QUERY PLAN tests in dbSessionStats.test.ts pin the
// compiled SQL of the real queries and assert the two rollup queries never
// touch events. latestAssistant reads events via a session-prefixed index.
export function observedMaxQuery(q: Kysely<StateDb>, sessionId: string) {
  return q.selectFrom('session_stats').select('max_context_tokens').where('session_id', '=', sessionId);
}
export function topToolsQuery(q: Kysely<StateDb>, sessionId: string, limit: number) {
  return q
    .selectFrom('session_tool_counts')
    .select(['tool_name as name', 'count'])
    .where('session_id', '=', sessionId)
    .orderBy('count', 'desc')
    .orderBy('tool_name')
    .limit(limit);
}
export function latestAssistantQuery(q: Kysely<StateDb>, sessionId: string) {
  return q
    .selectFrom('events')
    .select((eb) => [
      'model',
      eb.fn.coalesce('input_tokens', eb.lit(0)).as('input_tokens'),
      eb.fn.coalesce('cache_read_input_tokens', eb.lit(0)).as('cache_read_input_tokens'),
      eb.fn.coalesce('cache_creation_input_tokens', eb.lit(0)).as('cache_creation_input_tokens'),
    ])
    .where('session_id', '=', sessionId)
    .where('type', '=', 'assistant')
    .where('model', 'is not', null)
    .orderBy('id', 'desc')
    .limit(1);
}

/**
 * Same shape as `summaryForWorkspace`, but scoped to one specific claude
 * session UUID — the per-tab endpoint reaches here via
 * `summaryForBrokerSession` after resolving the broker→claude mapping.
 * Returns null when the session id has no rows in `sessions` (mapping
 * stale, claude exited and the user wiped state, etc.).
 *
 * One read transaction: the eight queries see one consistent state, as the
 * synchronous version did (no ingest chunk can commit between them).
 */
async function summaryForSessionUncached(
  sessionId: string,
  topToolsLimit = DEFAULT_TOP_TOOLS,
): Promise<WorkspaceSummary | null> {
  summaryRecomputes++;
  return kyselyOrThrow().transaction().execute(async (trx) => {
    const session = await trx
      .selectFrom('sessions')
      .select(['id', 'ai_title', 'first_user_message', 'started_at', 'last_active_at'])
      .where('id', '=', sessionId)
      .executeTakeFirst();
    if (!session) return null;

    const aggregates = await trx
      .selectFrom('session_costs')
      .select((eb) => [
        eb.fn.coalesce(eb.fn.sum<number>('event_count'), eb.lit(0)).as('event_count'),
        eb.fn.coalesce(eb.fn.sum<number>('input_tokens'), eb.lit(0)).as('input_tokens'),
        eb.fn.coalesce(eb.fn.sum<number>('output_tokens'), eb.lit(0)).as('output_tokens'),
        eb.fn.coalesce(eb.fn.sum<number>('cache_read_input_tokens'), eb.lit(0)).as('cache_read_input_tokens'),
        eb.fn.coalesce(eb.fn.sum<number>('cache_creation_input_tokens'), eb.lit(0)).as('cache_creation_input_tokens'),
      ])
      .where('session_id', '=', session.id)
      .executeTakeFirstOrThrow();

    // Latest assistant event drives both the displayed model and the
    // context-window fullness proxy (idx_events_session_type seek + LIMIT 1).
    const latestAssistant = await latestAssistantQuery(trx, session.id).executeTakeFirst();
    const lastTurnContextTokens = latestAssistant
      ? latestAssistant.input_tokens +
        latestAssistant.cache_read_input_tokens +
        latestAssistant.cache_creation_input_tokens
      : null;

    // Observed-max context tokens from the session_stats rollup; drives the 1M
    // auto-upgrade in contextWindowFor. Absent row ⇒ 0.
    const observedMax = (await observedMaxQuery(trx, session.id).executeTakeFirst()) ?? { max_context_tokens: 0 };
    const contextWindowTokens = contextWindowFor(latestAssistant?.model ?? null, observedMax.max_context_tokens);

    // topTools from the session_tool_counts rollup; ties ordered by tool_name.
    const topTools: ToolCallCount[] = await topToolsQuery(trx, session.id, topToolsLimit).execute();

    const cost = await costForSessionQ(trx, session.id);

    return {
      sessionId: session.id,
      title:
        session.ai_title ??
        (session.first_user_message ? session.first_user_message.slice(0, 80) : null),
      model: latestAssistant?.model ?? null,
      startedAt: session.started_at,
      lastActiveAt: session.last_active_at,
      eventCount: num(aggregates.event_count),
      inputTokens: num(aggregates.input_tokens),
      outputTokens: num(aggregates.output_tokens),
      cacheReadInputTokens: num(aggregates.cache_read_input_tokens),
      cacheCreationInputTokens: num(aggregates.cache_creation_input_tokens),
      usd: cost.usd,
      lastTurnContextTokens,
      contextWindowTokens,
      topTools,
      recentToolCalls: await recentToolCallsQ(trx, session.id, 10),
      costSeries: await costSeriesQ(trx, session.id, 20),
      tokenSeries: await tokenSeriesQ(trx, session.id, 20),
    };
  });
}

/**
 * Recent tool calls in a session, newest first. Each tool_use is matched to
 * its tool_result by tool_use_id (within the session) to derive duration and
 * ok/error status; calls still awaiting a result come back 'pending'.
 */
export async function recentToolCallsForSession(sessionId: string, limit = 10): Promise<ToolCall[]> {
  return recentToolCallsQ(kyselyOrThrow(), sessionId, limit);
}

async function recentToolCallsQ(q: Kysely<StateDb>, sessionId: string, limit: number): Promise<ToolCall[]> {
  const rows = await q
    .selectFrom('events as u')
    .leftJoin('events as r', (j) =>
      j
        .onRef('r.session_id', '=', 'u.session_id')
        .onRef('r.tool_use_id', '=', 'u.tool_use_id')
        .on('r.tool_result_is_error', 'is not', null),
    )
    .select([
      'u.tool_name as name',
      'u.tool_input as input',
      'u.ts as start_ts',
      'r.ts as end_ts',
      'r.tool_result_is_error as is_error',
    ])
    .where('u.session_id', '=', sessionId)
    .where('u.tool_name', 'is not', null)
    .where('u.tool_use_id', 'is not', null)
    .orderBy('u.id', 'desc')
    .limit(limit)
    .execute();
  return rows.map((r) => ({
    name: r.name as string,
    input: r.input,
    durationMs: r.start_ts != null && r.end_ts != null ? r.end_ts - r.start_ts : null,
    status: r.is_error == null ? 'pending' : r.is_error ? 'error' : 'ok',
    ts: r.start_ts,
  }));
}

/**
 * Per-turn USD cost over the last `limit` assistant turns, oldest→newest —
 * the series a cost sparkline plots. Each assistant event with usage is one
 * turn; cost is computed per row so mixed models/tiers price correctly.
 */
export async function costSeriesForSession(sessionId: string, limit = 20): Promise<number[]> {
  return costSeriesQ(kyselyOrThrow(), sessionId, limit);
}

async function costSeriesQ(q: Kysely<StateDb>, sessionId: string, limit: number): Promise<number[]> {
  const rows = await q
    .selectFrom('events')
    .select((eb) => [
      'model',
      'service_tier',
      eb.fn.coalesce('input_tokens', eb.lit(0)).as('input_tokens'),
      eb.fn.coalesce('output_tokens', eb.lit(0)).as('output_tokens'),
      eb.fn.coalesce('cache_read_input_tokens', eb.lit(0)).as('cache_read_input_tokens'),
      eb.fn.coalesce('cache_creation_input_tokens', eb.lit(0)).as('cache_creation_input_tokens'),
    ])
    .where('session_id', '=', sessionId)
    .where('type', '=', 'assistant')
    .where('output_tokens', 'is not', null)
    .orderBy('id', 'desc')
    .limit(limit)
    .execute();
  return rows
    .reverse()
    .map((r) =>
      costFor(r.model, r.service_tier, {
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        cacheReadInputTokens: r.cache_read_input_tokens,
        cacheCreationInputTokens: r.cache_creation_input_tokens,
      }),
    );
}

/**
 * Per-turn total tokens (input + output + cache create + cache read) over the
 * last `limit` assistant turns, oldest→newest — the sibling of
 * `costSeriesForSession` that the observability sparkline plots when toggled
 * from cost to tokens. Same per-turn definition, so the two graphs line up.
 */
export async function tokenSeriesForSession(sessionId: string, limit = 20): Promise<number[]> {
  return tokenSeriesQ(kyselyOrThrow(), sessionId, limit);
}

async function tokenSeriesQ(q: Kysely<StateDb>, sessionId: string, limit: number): Promise<number[]> {
  const rows = await q
    .selectFrom('events')
    .select(
      sql<number>`COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)
        + COALESCE(cache_read_input_tokens, 0) + COALESCE(cache_creation_input_tokens, 0)`.as('total'),
    )
    .where('session_id', '=', sessionId)
    .where('type', '=', 'assistant')
    .where('output_tokens', 'is not', null)
    .orderBy('id', 'desc')
    .limit(limit)
    .execute();
  return rows.reverse().map((r) => num(r.total));
}

```

- [ ] **Step 5: Port the broker lookup, the per-tab summary and the cost rollups**

In `src/main/db.ts`, replace everything from `/** Look up the claude_session_id for a broker session, or null if unmapped. */` up to (not including) `export interface PlanUsageRow {` with the block below. It keeps the `COST_COLUMNS` string, which `planUsageRows` still uses until Task 4.

```ts
/** Look up the claude_session_id for a broker session, or null if unmapped. */
export async function lookupBrokerSession(
  workspaceId: string,
  brokerSessionId: string,
): Promise<string | null> {
  return (await existingMappingQ(kyselyOrThrow(), workspaceId, brokerSessionId))?.claude_session_id ?? null;
}

/**
 * Per-tab summary. Resolves the broker→claude mapping and returns that
 * session's summary, or null when no mapping is known.
 *
 * **No workspace fallback here.** A brand-new tab the user just opened
 * carries an unmapped broker session id but legitimately has no data;
 * returning the workspace's most-recently-active session in that case
 * surfaces the *previous* tab's numbers — confusing ("why does my new
 * tab already show 4K tokens?"). Renderer decides when to apply a
 * workspace fallback: tabs loaded from `sessions.json` get one (best
 * guess for tabs that pre-date this table or were skipped by the
 * concurrent-attach disambiguator); freshly-added tabs do not.
 */
export async function summaryForBrokerSession(
  workspaceId: string,
  brokerSessionId: string,
  topToolsLimit = 5,
): Promise<WorkspaceSummary | null> {
  const claudeId = await lookupBrokerSession(workspaceId, brokerSessionId);
  if (!claudeId) return null;
  return summaryForSession(claudeId, topToolsLimit);
}

// ── Cost rollup ───────────────────────────────────────────────────────────
//
// Pricing varies by model and service_tier, so we can't just sum tokens once
// and multiply — different events within a session may use different models.
// Group by (model, service_tier), let pricing.ts compute USD per group,
// then sum.

export interface SessionCost {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  usd: number;
}

interface CostGroupRow {
  model: string | null;
  service_tier: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

const COST_COLUMNS = `
  COALESCE(SUM(input_tokens), 0)                AS input_tokens,
  COALESCE(SUM(output_tokens), 0)               AS output_tokens,
  COALESCE(SUM(cache_read_input_tokens), 0)     AS cache_read_input_tokens,
  COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens
`;

function rollupGroups(rows: CostGroupRow[]): SessionCost {
  let usd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadInputTokens = 0;
  let cacheCreationInputTokens = 0;
  for (const r of rows) {
    inputTokens += r.input_tokens;
    outputTokens += r.output_tokens;
    cacheReadInputTokens += r.cache_read_input_tokens;
    cacheCreationInputTokens += r.cache_creation_input_tokens;
    usd += costFor(r.model, r.service_tier, {
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cacheReadInputTokens: r.cache_read_input_tokens,
      cacheCreationInputTokens: r.cache_creation_input_tokens,
    });
  }
  return { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, usd };
}

export async function costForSession(sessionId: string): Promise<SessionCost> {
  return costForSessionQ(kyselyOrThrow(), sessionId);
}

async function costForSessionQ(q: Kysely<StateDb>, sessionId: string): Promise<SessionCost> {
  const rows = await q
    .selectFrom('session_costs')
    .select((eb) => [
      eb.fn<string | null>('nullif', ['model', eb.val('')]).as('model'),
      eb.fn<string | null>('nullif', ['service_tier', eb.val('')]).as('service_tier'),
      'input_tokens',
      'output_tokens',
      'cache_read_input_tokens',
      'cache_creation_input_tokens',
    ])
    .where('session_id', '=', sessionId)
    .execute();
  return rollupGroups(rows);
}

export async function costForWorkspace(workspaceId: string): Promise<SessionCost> {
  const rows = await kyselyOrThrow()
    .selectFrom('session_costs')
    .select((eb) => [
      eb.fn<string | null>('nullif', ['model', eb.val('')]).as('model'),
      eb.fn<string | null>('nullif', ['service_tier', eb.val('')]).as('service_tier'),
      eb.fn.coalesce(eb.fn.sum<number>('input_tokens'), eb.lit(0)).as('input_tokens'),
      eb.fn.coalesce(eb.fn.sum<number>('output_tokens'), eb.lit(0)).as('output_tokens'),
      eb.fn.coalesce(eb.fn.sum<number>('cache_read_input_tokens'), eb.lit(0)).as('cache_read_input_tokens'),
      eb.fn.coalesce(eb.fn.sum<number>('cache_creation_input_tokens'), eb.lit(0)).as('cache_creation_input_tokens'),
    ])
    .where('workspace_id', '=', workspaceId)
    .groupBy(['model', 'service_tier'])
    .execute();
  return rollupGroups(
    rows.map((r) => ({
      model: r.model,
      service_tier: r.service_tier,
      input_tokens: num(r.input_tokens),
      output_tokens: num(r.output_tokens),
      cache_read_input_tokens: num(r.cache_read_input_tokens),
      cache_creation_input_tokens: num(r.cache_creation_input_tokens),
    })),
  );
}

```

Run: `npx tsc --noEmit -p tsconfig.node.json 2>&1 | /usr/bin/grep "src/main/db.ts"`
Expected: no output (`db.ts` compiles; `ipc.ts` errors remain).

- [ ] **Step 6: Await the summary path in `ipc.ts` (D19)**

In `src/main/ipc.ts`:

(a) In the `./perf.js` import, replace `perfNotePowerEvent, perfSpan, setPerfMemorySource` with `perfNotePowerEvent, perfSpanAsync, setPerfMemorySource`. `perfSpan` has no other use in `ipc.ts`.

(b) Directly above `export function registerIpc(opts: RegisterIpcOpts = { jsonlWatcher: null }): void {`, insert:

```ts
/** A failed live summary push is logged, not thrown: it runs from a watcher
 *  emit or a timer, where a rejection would go unhandled. */
function logBroadcastFailure(workspaceId: string, e: unknown): void {
  logError({ source: 'main', level: 'warn', type: 'observability-broadcast', message: String(e), workspaceId });
}

```

(c) In the `makeTrailingRebroadcast(…)` callback, replace

```ts
      perfSpan(
        'claude_fleet.observability.trailing_rebroadcast',
        () => {
          const summary = summaryForWorkspace(workspaceId);
          broadcastObservabilitySummary(
            { workspaceId, summary },
            BrowserWindow.getAllWindows()
          );
        },
        { workspace_id: workspaceId }
      );
```

with

```ts
      void perfSpanAsync(
        'claude_fleet.observability.trailing_rebroadcast',
        async () => {
          const summary = await summaryForWorkspace(workspaceId);
          broadcastObservabilitySummary(
            { workspaceId, summary },
            BrowserWindow.getAllWindows()
          );
        },
        { workspace_id: workspaceId }
      ).catch((e: unknown) => logBroadcastFailure(workspaceId, e));
```

(d) In `jsonlWatcher.on('ingest', …)`, replace

```ts
      perfSpan(
        'claude_fleet.observability.ingest_broadcast',
        () => {
          const summary = summaryForWorkspace(workspaceId);
          broadcastObservabilitySummary(
            { workspaceId, summary },
            BrowserWindow.getAllWindows()
          );
          // Reset the trailing timer — fires once after quiescence to push the
          // final fresh state (see comment above makeTrailingRebroadcast).
          trailingRebroadcast.schedule(workspaceId);
        },
        { workspace_id: workspaceId }
      );
```

with

```ts
      // Reset the trailing timer — fires once after quiescence to push the
      // final fresh state (see comment above makeTrailingRebroadcast).
      trailingRebroadcast.schedule(workspaceId);
      void perfSpanAsync(
        'claude_fleet.observability.ingest_broadcast',
        async () => {
          const summary = await summaryForWorkspace(workspaceId);
          broadcastObservabilitySummary(
            { workspaceId, summary },
            BrowserWindow.getAllWindows()
          );
        },
        { workspace_id: workspaceId }
      ).catch((e: unknown) => logBroadcastFailure(workspaceId, e));
```

(e) `usage:rollingSpend`: replace

```ts
  ipcMain.handle('usage:rollingSpend', () => {
    const windowMs = USAGE_BUDGET_WINDOW_HOURS * 60 * 60 * 1000;
    return {
      spentTokens: tokensSpentSince(Date.now() - windowMs),
```

with

```ts
  ipcMain.handle('usage:rollingSpend', async () => {
    const windowMs = USAGE_BUDGET_WINDOW_HOURS * 60 * 60 * 1000;
    return {
      spentTokens: await tokensSpentSince(Date.now() - windowMs),
```

(f) `claudeIdFor`: replace

```ts
  const claudeIdFor = (workspaceId: string, brokerSessionId: string): string | null => {
    try {
      return lookupBrokerSession(workspaceId, brokerSessionId) ?? null;
    } catch {
      return null;
    }
  };
```

with

```ts
  const claudeIdFor = async (workspaceId: string, brokerSessionId: string): Promise<string | null> => {
    try {
      return (await lookupBrokerSession(workspaceId, brokerSessionId)) ?? null;
    } catch {
      return null;
    }
  };
```

Then make its three handlers async and await it:
- `mirror:setOverride`: `(_e, workspaceId: string, brokerSessionId: string, setting: 'on' | 'off') => {` → `async (_e, workspaceId: string, brokerSessionId: string, setting: 'on' | 'off') => {`, and `const claudeId = claudeIdFor(` → `const claudeId = await claudeIdFor(`.
- `transcript:hasForBrokerSession`: `(_e, workspaceId: string, brokerSessionId: string) => {` → `async (_e, workspaceId: string, brokerSessionId: string) => {`, and `const claudeId = claudeIdFor(` → `const claudeId = await claudeIdFor(`.
- `transcript:deleteForBrokerSession` is already `async`: `const claudeId = claudeIdFor(` → `const claudeId = await claudeIdFor(`.

(g) `observability:summaryForBrokerSession`: replace

```ts
    (_e, workspaceId: string, brokerSessionId: string) => {
      const summary = summaryForBrokerSession(workspaceId, brokerSessionId);
      if (!summary) {
        // Blank-rail root signal: no-mapping = why the per-tab summary is null;
        // mapped-no-session = stale mapping. Deduped per (workspace:tab:outcome).
        const claudeId = lookupBrokerSession(workspaceId, brokerSessionId);
```

with

```ts
    async (_e, workspaceId: string, brokerSessionId: string) => {
      const summary = await summaryForBrokerSession(workspaceId, brokerSessionId);
      if (!summary) {
        // Blank-rail root signal: no-mapping = why the per-tab summary is null;
        // mapped-no-session = stale mapping. Deduped per (workspace:tab:outcome).
        const claudeId = await lookupBrokerSession(workspaceId, brokerSessionId);
```

Leave these unchanged: they return the promise straight to `ipcMain.handle`, which awaits it. They are `observability:summaryForWorkspace`, `observability:getCost`, `observability:getCostForWorkspace` and `__test:lookupBrokerSession`.

- [ ] **Step 7: Typecheck, call-site grep, run the tests**

```bash
npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json && echo TSC-OK
/usr/bin/grep -rnaE "(summaryForWorkspace|summaryForSession|summaryForBrokerSession|recentToolCallsForSession|costSeriesForSession|tokenSeriesForSession|tokensSpentSince|costForSession|costForWorkspace|lookupBrokerSession|claudeIdFor)\(" src/main --include=*.ts \
  | /usr/bin/grep -v "test.ts" | /usr/bin/grep -vE "await |function |return |=> *$"
npx vitest run src/main/asyncCache.test.ts src/main/dbReadCache.test.ts src/main/dbSessionStats.test.ts src/main/dbSessionCosts.test.ts \
  src/main/db.test.ts src/main/jsonlWatcher.localdir.test.ts src/main/jsonlWatcher.subagent.test.ts \
  src/main/dbIngestBatch.test.ts src/main/dbReadCharacterization.test.ts
```

Expected: `TSC-OK`. The grep prints exactly four handler-arrow bodies in `ipc.ts`, each on its own line after `=>`: `summaryForWorkspace(workspaceId)`, `costForSession(sessionId)`, `costForWorkspace(workspaceId)` and `__test:lookupBrokerSession`'s `lookupBrokerSession(workspaceId, brokerSessionId)`. Everything else is awaited. The tests PASS (9 files), with both characterization snapshots unchanged.

- [ ] **Step 8: Full suite and commit**

```bash
CI=true npx vitest run src
git -C "$WT" add -A src/main
git -C "$WT" status --short   # expect only src/main changes; never stage .superpowers/
git -C "$WT" commit -m "feat(state): summary, cost, spend and broker-lookup reads on Kysely; async read caches (async store 2b)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The remaining reads go async; the raw handle shrinks to `openDb()`

**Files:**
- Modify: `src/main/db.ts`
- Modify: `src/main/ipc.ts` (`committeeCollect`, committee liveness, `computePlanUsage`, `sessions:list`)
- Modify: `src/main/local.ts` (`effectiveResumeOf`)
- Modify: `src/main/index.ts` (embed backfill `listSessions`)
- Modify: `src/main/transcriptIndex.ts` (backlog reads; `searchTranscripts` `db` required)
- Test: `src/main/db.test.ts`, `src/main/dbSessionCosts.test.ts`, `src/main/dbSessionsList.test.ts`, `src/main/db.planUsage.test.ts`, `src/main/db.usageAnchors.test.ts`, `src/main/db.ingestAnchor.test.ts`, `src/main/dbEmbeddings.test.ts`, `src/main/transcriptIndex.test.ts`, `src/main/dbSummaries.test.ts`, `src/main/local.liveState.test.ts`, `src/main/transcriptSearch.test.ts`

**Interfaces:**
- Consumes: `explainPlan` (Task 3). `claudeSessionIsRealQ`, `chunked`, `num` (2a).
- Produces (all `async`, same resolved shapes):
  - `eventsForSession(id, since = 0, limit = 500): Promise<EventRow[]>`
  - `getSession(id): Promise<SessionRow | null>`
  - `lookupVerifiedBrokerSession(ws, broker): Promise<string | null>`
  - `lookupResumableBrokerSession(ws, broker): Promise<string | null>`
  - `planUsageRows(from, to): Promise<PlanUsageRow[]>`
  - `latestAnchorCovering(at): Promise<UsageAnchorRow | null>`, `latestLimitHitAnchor(): Promise<UsageAnchorRow | null>`
  - `listSessions(ws?): Promise<SessionListRow[]>`
  - `unembeddedTurnEvents(id, modelId, limit = 200): Promise<UnembeddedTurn[]>`
  - `unembeddedSummaries(modelId, limit = 100): Promise<PendingSummary[]>`
  - `maxEventId(id): Promise<number>`
  - New: `latestActivityByWorkspace(ids: readonly string[]): Promise<Map<string, number | null>>` (D15) and `listSessionCostsQuery(q, ws?)` (replaces `LIST_SESSION_COSTS_SQL` / `LIST_SESSION_COSTS_BY_WS_SQL`)
  - `effectiveResumeOf(explicit, hasLivePty, lookupResumable: () => Promise<string | null>): Promise<string | undefined>`
  - `searchTranscripts(query, allowed, embed, opts, db: Database.Database)`: `db` is required
  - Removed: `getDb`, `openDbOrThrow`, `claudeSessionIsReal`

- [ ] **Step 1: Convert the tests, then add the hand edits (red)**

```bash
python3 /tmp/conv-async-reads.py \
  --fns eventsForSession,getSession,lookupVerifiedBrokerSession,lookupResumableBrokerSession,planUsageRows,latestAnchorCovering,latestLimitHitAnchor,listSessions,unembeddedTurnEvents,unembeddedSummaries,maxEventId \
  src/main/db.test.ts src/main/dbSessionCosts.test.ts src/main/dbSessionsList.test.ts src/main/db.planUsage.test.ts \
  src/main/db.usageAnchors.test.ts src/main/db.ingestAnchor.test.ts src/main/dbEmbeddings.test.ts \
  src/main/transcriptIndex.test.ts src/main/dbSummaries.test.ts
```

Hand edits:

(a) `src/main/dbSessionCosts.test.ts`: in the `./db.js` import, replace the two lines

```ts
  LIST_SESSION_COSTS_SQL,
  LIST_SESSION_COSTS_BY_WS_SQL,
```

with

```ts
  stateKysely,
  listSessionCostsQuery,
```

After that import's closing `} from './db.js';`, add `import { explainPlan } from './state/explainPlan.js';`. Then replace the test `it('listSessions cost query never scans events (EXPLAIN QUERY PLAN pin)', …)` (through its closing `});`) with:

```ts
  it('listSessions cost query never scans events (EXPLAIN QUERY PLAN pin)', async () => {
    const d = openDb(dir);
    for (const ws of [undefined, 'explain-dummy']) {
      const details = explainPlan(d, listSessionCostsQuery(stateKysely(), ws));
      expect(details).toContain('session_costs');
      expect(details).not.toMatch(/\bevents\b/);
    }
  });
```

(b) `src/main/local.liveState.test.ts`: replace the whole `describe('effectiveResumeOf — cross-restart auto-resume decision', …)` block with:

```ts
describe('effectiveResumeOf — cross-restart auto-resume decision', () => {
  it('prefers an explicit resume target', async () => {
    expect(await local.effectiveResumeOf('explicit-uuid', false, async () => 'mapped-uuid')).toBe(
      'explicit-uuid'
    );
  });

  it('never auto-resumes over a live pty (re-attach ignores resume args anyway)', async () => {
    expect(await local.effectiveResumeOf(undefined, true, async () => 'mapped-uuid')).toBeUndefined();
  });

  it('auto-resumes the mapped conversation when the tab has no live pty', async () => {
    expect(await local.effectiveResumeOf(undefined, false, async () => 'mapped-uuid')).toBe('mapped-uuid');
  });

  it('spawns fresh when no resumable mapping exists', async () => {
    expect(await local.effectiveResumeOf(undefined, false, async () => null)).toBeUndefined();
  });

  it('spawns fresh when the DB is dormant (lookup rejects — mock mode)', async () => {
    expect(
      await local.effectiveResumeOf(undefined, false, async () => {
        throw new Error('db not open');
      })
    ).toBeUndefined();
  });
});
```

(c) `src/main/transcriptSearch.test.ts` passes the raw handle explicitly (D14):
- Add `import type Database from 'better-sqlite3';` after the vitest import.
- `let dir: string; const A = '01WSA', B = '01WSB';` → `let dir: string; let raw: Database.Database; const A = '01WSA', B = '01WSB';`
- `openDb(dir); });` in `beforeEach` → `raw = openDb(dir); });`
- `searchTranscripts('broker debugging', new Set([A, B]), stub, { limit: 5 });` → `searchTranscripts('broker debugging', new Set([A, B]), stub, { limit: 5 }, raw);`
- `searchTranscripts('banana', new Set([A]), stub); // only A allowed` → `searchTranscripts('banana', new Set([A]), stub, {}, raw); // only A allowed`
- `searchTranscripts('x', new Set<string>(), stub)` → `searchTranscripts('x', new Set<string>(), stub, {}, raw)`

(d) `src/main/dbSessionsList.test.ts`: change the import to `import { openDb, closeDb, ingestLine, listSessions, latestActivityByWorkspace } from './db.js';`, and append:

```ts

describe('latestActivityByWorkspace', () => {
  const at = (uuid: string, ts: string) =>
    JSON.stringify({ type: 'user', uuid, timestamp: ts, message: { content: 'x' } });

  it('equals listSessions(ws)[0]?.lastActiveAt for each workspace; absent when it has no sessions', async () => {
    await ingestLine('ws-a', 'a1', at('u1', '2026-07-01T00:00:00Z'));
    await ingestLine('ws-a', 'a2', at('u2', '2026-07-01T00:05:00Z'));
    await ingestLine('ws-b', 'b1', JSON.stringify({ type: 'ai-title', aiTitle: 't', sessionId: 'b1' }));
    const got = await latestActivityByWorkspace(['ws-a', 'ws-b', 'ws-none']);
    for (const ws of ['ws-a', 'ws-b']) {
      expect(got.get(ws)).toBe((await listSessions(ws))[0]?.lastActiveAt ?? null);
    }
    expect(got.get('ws-a')).toBe(Date.parse('2026-07-01T00:05:00Z'));
    expect(got.get('ws-b')).toBeNull();
    expect(got.has('ws-none')).toBe(false);
  });
});
```

Run: `npx tsc --noEmit -p tsconfig.node.json 2>&1 | head`
Expected: errors such as `has no exported member 'listSessionCostsQuery'` / `'latestActivityByWorkspace'` (red).

- [ ] **Step 2: Port the remaining reads in `db.ts`**

Replace each region of `src/main/db.ts` below, in order. "From A up to B" means from the line starting with A, inclusive, to the line starting with B, exclusive.

(a) From `export function eventsForSession(` up to `export interface SessionRow {`:

```ts
export async function eventsForSession(sessionId: string, sinceEventId = 0, limit = 500): Promise<EventRow[]> {
  const rows = await kyselyOrThrow()
    .selectFrom('events')
    .selectAll()
    .where('session_id', '=', sessionId)
    .where('id', '>', sinceEventId)
    .orderBy('id', 'asc')
    .limit(limit)
    .execute();
  return rows.map(rowFromSql);
}

```

(b) From `interface SessionRowSql {` up to `// ── Workspace summary`, which drops `SessionRowSql` because `selectAll()` is typed:

```ts
export async function getSession(id: string): Promise<SessionRow | null> {
  const row = await kyselyOrThrow().selectFrom('sessions').selectAll().where('id', '=', id).executeTakeFirst();
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    cwd: row.cwd,
    startedAt: row.started_at,
    lastActiveAt: row.last_active_at,
    aiTitle: row.ai_title,
    firstUserMessage: row.first_user_message,
    userSetName: row.user_set_name,
  };
}

```

(c) Delete the raw `claudeSessionIsReal`. Replace

```ts
function claudeSessionIsReal(d: Database.Database, claudeSessionId: string): boolean {
  return (
    d.prepare(`SELECT 1 FROM sessions WHERE id = ?`).get(claudeSessionId) !== undefined
  );
}

/** `claudeSessionIsReal` on a Kysely handle (used inside mapping transactions). */
async function claudeSessionIsRealQ(
```

with

```ts
async function claudeSessionIsRealQ(
```

The doc comment above it (`/** True once \`claudeSessionId\` has ingested ≥1 transcript line …`) stays and now documents `claudeSessionIsRealQ`.

(d) From `export function lookupVerifiedBrokerSession(` up to `/** Look up the claude_session_id for a broker session`:

```ts
export async function lookupVerifiedBrokerSession(
  workspaceId: string,
  brokerSessionId: string,
): Promise<string | null> {
  const row = await kyselyOrThrow()
    .selectFrom('broker_sessions')
    .select('claude_session_id')
    .where('workspace_id', '=', workspaceId)
    .where('broker_session_id', '=', brokerSessionId)
    .where('verified', '=', 1)
    .executeTakeFirst();
  return row?.claude_session_id ?? null;
}

/** Resume-grade lookup that additionally requires the mapped session to have
 *  ingested ≥1 transcript line. The local backend's cross-restart auto-resume
 *  uses this: `claude --resume <uuid>` of a session that never wrote a
 *  transcript errors visibly in the tab, so an unreal session means "spawn
 *  fresh" rather than "resume". One statement, so the two checks are atomic. */
export async function lookupResumableBrokerSession(
  workspaceId: string,
  brokerSessionId: string,
): Promise<string | null> {
  const row = await kyselyOrThrow()
    .selectFrom('broker_sessions as b')
    .select('b.claude_session_id')
    .where('b.workspace_id', '=', workspaceId)
    .where('b.broker_session_id', '=', brokerSessionId)
    .where('b.verified', '=', 1)
    .where((eb) => eb.exists(eb.selectFrom('sessions as s').select('s.id').whereRef('s.id', '=', 'b.claude_session_id')))
    .executeTakeFirst();
  return row?.claude_session_id ?? null;
}

```

(e) Delete the `COST_COLUMNS` constant (the 6-line template string starting `const COST_COLUMNS = \``, plus its trailing blank line). Its last user is ported next.

(f) From `export function planUsageRows(` up to `// ── Usage anchors`:

```ts
export async function planUsageRows(fromMs: number, toMs: number): Promise<PlanUsageRow[]> {
  const rows = await kyselyOrThrow()
    .selectFrom('events')
    .select((eb) => [
      'workspace_id',
      'model',
      'service_tier',
      eb.fn.coalesce(eb.fn.sum<number>('input_tokens'), eb.lit(0)).as('input_tokens'),
      eb.fn.coalesce(eb.fn.sum<number>('output_tokens'), eb.lit(0)).as('output_tokens'),
      eb.fn.coalesce(eb.fn.sum<number>('cache_read_input_tokens'), eb.lit(0)).as('cache_read_input_tokens'),
      eb.fn.coalesce(eb.fn.sum<number>('cache_creation_input_tokens'), eb.lit(0)).as('cache_creation_input_tokens'),
    ])
    .where('type', '=', 'assistant')
    .where('ts', 'is not', null)
    .where('ts', '>=', fromMs)
    .where('ts', '<', toMs)
    .groupBy(['workspace_id', 'model', 'service_tier'])
    .execute();
  return rows.map((r) => ({
    workspaceId: r.workspace_id,
    model: r.model,
    serviceTier: r.service_tier,
    inputTokens: num(r.input_tokens),
    outputTokens: num(r.output_tokens),
    cacheReadInputTokens: num(r.cache_read_input_tokens),
    cacheCreationInputTokens: num(r.cache_creation_input_tokens),
  }));
}

```

(g) Replace the `UsageAnchorSql` interface

```ts
interface UsageAnchorSql {
  id: number; ts: number; workspace_id: string | null; session_id: string | null;
  kind: string; http_status: number | null; scope: string | null;
  reset_at: number | null; window_start: number | null; message: string | null;
}
```

with

```ts
const ANCHOR_COLUMNS = [
  'id', 'ts', 'workspace_id', 'session_id', 'kind', 'http_status', 'scope', 'reset_at', 'window_start', 'message',
] as const;
type UsageAnchorSql = Pick<Selectable<UsageAnchorsTable>, (typeof ANCHOR_COLUMNS)[number]>;
```

Then update the imports at the top of the file. `import { sql, type Kysely } from 'kysely';` → `import { sql, type Kysely, type Selectable } from 'kysely';`, and `import type { StateDb } from './store/stateSchema.js';` → `import type { StateDb, UsageAnchorsTable } from './store/stateSchema.js';`.

(h) From `export function latestAnchorCovering(` up to `// ── Sessions table`:

```ts
export async function latestAnchorCovering(atMs: number): Promise<UsageAnchorRow | null> {
  const r = await kyselyOrThrow()
    .selectFrom('usage_anchors')
    .select(ANCHOR_COLUMNS)
    .where('scope', '=', 'session')
    .where('window_start', 'is not', null)
    .where('reset_at', 'is not', null)
    .where('window_start', '<=', atMs)
    .where('reset_at', '>=', atMs)
    .orderBy('ts', 'desc')
    .limit(1)
    .executeTakeFirst();
  return r ? toAnchorRow(r) : null;
}

export async function latestLimitHitAnchor(): Promise<UsageAnchorRow | null> {
  const r = await kyselyOrThrow()
    .selectFrom('usage_anchors')
    .select(ANCHOR_COLUMNS)
    .where('kind', '=', 'limit-hit')
    .where('window_start', 'is not', null)
    .orderBy('ts', 'desc')
    .limit(1)
    .executeTakeFirst();
  return r ? toAnchorRow(r) : null;
}

```

(i) From `interface SessionListSql {` up to the doc comment that opens `renameSession` (the line `/**` directly above ` * Set (or clear) the manual name override for a session.`). This region holds `SessionListSql`, `HEADLESS_BROKER_PREFIX`, `HEADLESS_SQL`, the two `LIST_SESSION_COSTS*` strings and `listSessions`. Replace it with:

```ts
/** Prefix of the broker session ids automation fresh steps spawn under
 *  (`auto-<runId>-<stepId>`, automations/runner.ts). */
export const HEADLESS_BROKER_PREFIX = 'auto-';

// Exported so the EXPLAIN QUERY PLAN test in dbSessionCosts.test.ts pins the
// compiled SQL of the real query and asserts session_costs is used, not events.
export function listSessionCostsQuery(q: Kysely<StateDb>, workspaceId?: string) {
  return q
    .selectFrom('session_costs')
    .select((eb) => [
      'session_id',
      eb.fn<string | null>('nullif', ['model', eb.val('')]).as('model'),
      eb.fn<string | null>('nullif', ['service_tier', eb.val('')]).as('service_tier'),
      'input_tokens',
      'output_tokens',
      'cache_read_input_tokens',
      'cache_creation_input_tokens',
      'event_count',
    ])
    .$if(workspaceId !== undefined, (qb) => qb.where('workspace_id', '=', workspaceId as string));
}

/**
 * All sessions, newest-active first. Optionally scoped to one workspace.
 * Three queries total regardless of session count, in one read transaction:
 * session metadata, one pass over `session_costs` for per-session cost +
 * event count (rolled up in JS, since USD is per-(model, service_tier)), and
 * each session's latest tagged chapter. No N+1.
 */
export async function listSessions(workspaceId?: string): Promise<SessionListRow[]> {
  const scoped = workspaceId !== undefined && workspaceId !== '';
  return kyselyOrThrow().transaction().execute(async (trx) => {
    const sessRows = await trx
      .selectFrom('sessions')
      .select((eb) => [
        'id',
        'workspace_id',
        'ai_title',
        'first_user_message',
        'user_set_name',
        'started_at',
        'last_active_at',
        eb
          .exists(
            eb
              .selectFrom('broker_sessions as b')
              .select('b.broker_session_id')
              .whereRef('b.claude_session_id', '=', 'sessions.id')
              .where('b.broker_session_id', 'like', `${HEADLESS_BROKER_PREFIX}%`),
          )
          .as('headless'),
      ])
      .$if(scoped, (qb) => qb.where('workspace_id', '=', workspaceId as string))
      .orderBy((eb) => eb.fn.coalesce('last_active_at', eb.lit(0)), 'desc')
      .execute();

    const costRows = await listSessionCostsQuery(trx, scoped ? workspaceId : undefined).execute();

    const byId = new Map<string, { usd: number; eventCount: number }>();
    for (const r of costRows) {
      const agg = byId.get(r.session_id) ?? { usd: 0, eventCount: 0 };
      agg.eventCount += r.event_count;
      agg.usd += costFor(r.model, r.service_tier, {
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        cacheReadInputTokens: r.cache_read_input_tokens,
        cacheCreationInputTokens: r.cache_creation_input_tokens,
      });
      byId.set(r.session_id, agg);
    }

    // The latest tagged chapter per session, by id.
    const tagRows = await trx
      .selectFrom('session_summaries')
      .select(['session_id', 'tags'])
      .where('id', 'in', (eb) =>
        eb
          .selectFrom('session_summaries')
          .select((e) => e.fn.max('id').as('latest'))
          .where('tags', 'is not', null)
          .$if(scoped, (qb) => qb.where('workspace_id', '=', workspaceId as string))
          .groupBy('session_id'),
      )
      .execute();

    const tagsById = new Map<string, string[]>();
    for (const r of tagRows) {
      try {
        const parsed: unknown = JSON.parse(r.tags as string);
        if (Array.isArray(parsed)) {
          tagsById.set(r.session_id, parsed.filter((t): t is string => typeof t === 'string'));
        }
      } catch {
        /* malformed tags JSON — treat as untagged */
      }
    }

    return sessRows.map((s) => {
      const agg = byId.get(s.id) ?? { usd: 0, eventCount: 0 };
      return {
        id: s.id,
        workspaceId: s.workspace_id,
        aiTitle: s.ai_title,
        firstUserMessage: s.first_user_message,
        userSetName: s.user_set_name,
        startedAt: s.started_at,
        lastActiveAt: s.last_active_at,
        eventCount: agg.eventCount,
        usd: agg.usd,
        tags: tagsById.get(s.id) ?? [],
        headless: Boolean(s.headless),
      };
    });
  });
}

/** Each workspace's most recent session activity (the max `last_active_at`,
 *  null when it has none) — what `listSessions(ws)[0]?.lastActiveAt` gives,
 *  for many workspaces in one grouped query per 500 ids. */
export async function latestActivityByWorkspace(workspaceIds: readonly string[]): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  for (const part of chunked(workspaceIds)) {
    const rows = await kyselyOrThrow()
      .selectFrom('sessions')
      .select((eb) => ['workspace_id', eb.fn.max('last_active_at').as('last')])
      .where('workspace_id', 'in', part)
      .groupBy('workspace_id')
      .execute();
    for (const r of rows) out.set(r.workspace_id, r.last === null ? null : num(r.last));
  }
  return out;
}

```

The `SessionListRow` interface above this region stays unchanged.

(j) From `export function unembeddedTurnEvents(` up to `export interface PendingSummary {`:

```ts
export async function unembeddedTurnEvents(sessionId: string, modelId: string, limit = 200): Promise<UnembeddedTurn[]> {
  return kyselyOrThrow()
    .selectFrom('events as e')
    .leftJoin('embeddings as em', (j) =>
      j.onRef('em.ref_event_id', '=', 'e.id').on('em.kind', '=', 'turn').on('em.model_id', '=', modelId),
    )
    .select(['e.id as id', 'e.workspace_id as workspaceId', 'e.ts as ts', 'e.raw_jsonl as rawJsonl'])
    .where('e.session_id', '=', sessionId)
    .where('e.type', 'in', ['user', 'assistant'])
    .where('em.id', 'is', null)
    .orderBy('e.id', 'asc')
    .limit(limit)
    .execute();
}

export async function maxEventId(sessionId: string): Promise<number> {
  const row = await kyselyOrThrow()
    .selectFrom('events')
    .select((eb) => eb.fn.coalesce(eb.fn.max('id'), eb.lit(0)).as('m'))
    .where('session_id', '=', sessionId)
    .executeTakeFirstOrThrow();
  return num(row.m);
}

```

(k) From `export function unembeddedSummaries(` up to `// ── Error recording`:

```ts
export async function unembeddedSummaries(modelId: string, limit = 100): Promise<PendingSummary[]> {
  return kyselyOrThrow()
    .selectFrom('session_summaries as s')
    .leftJoin('embeddings as em', (j) =>
      j
        .onRef('em.session_id', '=', 's.session_id')
        .on('em.kind', '=', 'summary')
        .on('em.model_id', '=', modelId)
        .on((eb) => eb('em.dedup_key', '=', eb.cast<string>('s.source_max_event_id', 'text'))),
    )
    .select([
      's.session_id as sessionId',
      's.workspace_id as workspaceId',
      's.summary as summary',
      's.source_max_event_id as sourceMaxEventId',
      's.generated_at as ts',
    ])
    .where('em.id', 'is', null)
    .orderBy('s.generated_at', 'desc')
    .limit(limit)
    .execute();
}

```

(l) In `// ── Helpers`, delete `openDbOrThrow()` (its 4-line function plus the trailing blank line) and the last line, `export function getDb(): Database.Database { return openDbOrThrow(); }`. `kyselyOrThrow()` stays.

Run: `npx tsc --noEmit -p tsconfig.node.json 2>&1 | /usr/bin/grep "src/main/db.ts"`
Expected: no output.

- [ ] **Step 3: Await the reads in the callers**

`src/main/ipc.ts`:

(a) In the `./db.js` import, add `latestActivityByWorkspace,` after `listSessions,`.

(b) `committeeCollect`: replace

```ts
  const sessionId = listSessions(targetId)[0]?.id ?? null;
  if (!sessionId) return { id: targetId, sessionId: null, cursor: since, turns: [] };
  const events = eventsForSession(sessionId, since, 500);
```

with

```ts
  const sessionId = (await listSessions(targetId))[0]?.id ?? null;
  if (!sessionId) return { id: targetId, sessionId: null, cursor: since, turns: [] };
  const events = await eventsForSession(sessionId, since, 500);
```

(c) Replace the `liveStatusFields` function and its doc comment (from `/**\n * Liveness for an expert (#121)` through the function's closing `}`) with:

```ts
/**
 * Liveness for an expert (#121): `busy` is host-computed from the broker output
 * stream (renderer-independent); `stalled` = busy past the turn timeout (the
 * "it's wedged" signal); `lastActiveAt` is best-effort from the DB (see
 * `lastActiveAtFor`). Shared by committee_status and committee_roster.
 */
function liveStatusFields(targetId: string, paused: boolean, lastActiveAt: number | null): RosterStatus {
  const b = committeeBusy.get(targetId);
  const busy = b?.busy ?? false;
  const stalled = busy && b ? Date.now() - b.since > COMMITTEE_CAPS.turnTimeoutMs : false;
  return { paused, busy, stalled, lastActiveAt };
}

/** Latest session activity per workspace; empty when the DB isn't open (mock). */
async function lastActiveAtFor(workspaceIds: string[]): Promise<Map<string, number | null>> {
  try {
    return await latestActivityByWorkspace(workspaceIds);
  } catch {
    return new Map();
  }
}
```

(d) In `committeeStatus`, replace `    ...liveStatusFields(targetId, ws?.state === 'paused')` with `    ...liveStatusFields(targetId, ws?.state === 'paused', (await lastActiveAtFor([targetId])).get(targetId) ?? null)`.

(e) In `committeeRoster`, replace

```ts
  return buildRoster(caller, callerId, all, (id) => liveStatusFields(id, stateById.get(id) === 'paused'));
```

with

```ts
  const lastActive = await lastActiveAtFor(all.map((w) => w.id));
  return buildRoster(caller, callerId, all, (id) =>
    liveStatusFields(id, stateById.get(id) === 'paused', lastActive.get(id) ?? null)
  );
```

(f) In `computePlanUsage`:
- `const covering = latestAnchorCovering(at);` → `const covering = await latestAnchorCovering(at);`
- `foldPlanUsage(planUsageRows(window.startMs, window.endMs), localIds)` → `foldPlanUsage(await planUsageRows(window.startMs, window.endMs), localIds)`
- `const hit = latestLimitHitAnchor();` → `const hit = await latestLimitHitAnchor();`
- `foldPlanUsage(planUsageRows(hit.windowStart, hit.resetAt), localIds)` → `foldPlanUsage(await planUsageRows(hit.windowStart, hit.resetAt), localIds)`

(g) In `sessions:list`: `const rows = listSessions(workspaceId);` → `const rows = await listSessions(workspaceId);`

`observability:eventsForSession` and `sessions:resolveResumeTarget` return the promise to `ipcMain.handle` as they are; leave them.

`src/main/local.ts`: replace `effectiveResumeOf`

```ts
export function effectiveResumeOf(
  explicit: string | undefined,
  hasLivePty: boolean,
  lookupResumable: () => string | null
): string | undefined {
  if (explicit) return explicit;
  if (hasLivePty) return undefined;
  try {
    return lookupResumable() ?? undefined;
  } catch {
    return undefined;
  }
}
```

with

```ts
export async function effectiveResumeOf(
  explicit: string | undefined,
  hasLivePty: boolean,
  lookupResumable: () => Promise<string | null>
): Promise<string | undefined> {
  if (explicit) return explicit;
  if (hasLivePty) return undefined;
  try {
    return (await lookupResumable()) ?? undefined;
  } catch {
    return undefined;
  }
}
```

In its caller (the local attach, after `await persistLiveState(id);`), change `const resume = effectiveResumeOf(resumeOf, hasLiveSession(id, sessionId), () =>` to `const resume = await effectiveResumeOf(resumeOf, hasLiveSession(id, sessionId), () =>`. `hasLiveSession` is still evaluated before the await, as before. The doc comment's line ` * - A throwing lookup (dormant DB in mock mode) degrades to a fresh spawn.` becomes ` * - A rejecting lookup (dormant DB in mock mode) degrades to a fresh spawn.`

`src/main/index.ts`: `const sessions = perfSpan('claude_fleet.index.list_sessions', () => listSessions());` → `const sessions = await perfSpanAsync('claude_fleet.index.list_sessions', () => listSessions());`. `perfSpanAsync` is already imported, and `perfSpan` stays imported for its other uses.

`src/main/transcriptIndex.ts`:
- `import { insertEmbeddings, unembeddedTurnEvents, unembeddedSummaries, getDb } from './db.js';` → `import { insertEmbeddings, unembeddedTurnEvents, unembeddedSummaries } from './db.js';`
- `import { perfSpan } from './perf.js';` → `import { perfSpan, perfSpanAsync } from './perf.js';`
- In `indexSessionTurns`, replace

```ts
    // Sync SQLite read on the main loop, once per session in the startup
    // backfill — spanned so stalls it causes self-attribute.
    const pending = perfSpan('claude_fleet.index.pending_turns',
      () => unembeddedTurnEvents(sessionId, EMBED_MODEL_ID, batch), { session_id: sessionId });
```

  with

```ts
    // Once per session in the startup backfill — spanned so stalls it causes
    // self-attribute.
    const pending = await perfSpanAsync('claude_fleet.index.pending_turns',
      () => unembeddedTurnEvents(sessionId, EMBED_MODEL_ID, batch), { session_id: sessionId });
```

- In `indexSessionSummaries`: `const pending = perfSpan('claude_fleet.index.pending_summaries', () => unembeddedSummaries(EMBED_MODEL_ID, batch));` → `const pending = await perfSpanAsync('claude_fleet.index.pending_summaries', () => unembeddedSummaries(EMBED_MODEL_ID, batch));`
- In `searchTranscripts`' signature, replace

```ts
  opts: { limit?: number; kind?: 'turn' | 'summary' } = {},
  db: Database.Database = getDb(),
): Promise<SearchHit[]> {
```

  with

```ts
  opts: { limit?: number; kind?: 'turn' | 'summary' },
  /** The MCP server's read-only connection: search stays raw better-sqlite3
   *  (SPEC §11); Postgres gets its own pgvector search in part 3. */
  db: Database.Database,
): Promise<SearchHit[]> {
```

`mcpServer.ts` already passes all five arguments (`searchTranscripts(a.query, allowed, queryEmbedder, { limit, kind }, _db)`), and so does `stateBench.test.ts`.

- [ ] **Step 4: Typecheck, the call-site grep and the raw-handle gate**

```bash
npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json && echo TSC-OK
/usr/bin/grep -rnaE "(eventsForSession|getSession|lookupVerifiedBrokerSession|lookupResumableBrokerSession|planUsageRows|latestAnchorCovering|latestLimitHitAnchor|listSessions|latestActivityByWorkspace|unembeddedTurnEvents|unembeddedSummaries|maxEventId|effectiveResumeOf|lastActiveAtFor)\(" \
  src/main/ipc.ts src/main/local.ts src/main/index.ts src/main/transcriptIndex.ts | /usr/bin/grep -vE "await |function |=> *$|\(\) => (list|unembedded|lookup)"
/usr/bin/grep -rn "getDb\b\|openDbOrThrow" src/            # gate 1
/usr/bin/grep -anE "\.prepare\(" src/main/db.ts             # gate 2
/usr/bin/grep -rnaE "openDb\(" src/main --include=*.ts | /usr/bin/grep -v "test.ts"  # gate 3
```

Expected:
- `TSC-OK`.
- The call-site grep prints exactly three thunk/arrow bodies, each on its own line after `=>`: `ipc.ts`'s `eventsForSession(sessionId, sinceEventId, limit)` and `lookupVerifiedBrokerSession(workspaceId, brokerSessionId)`, and `local.ts`'s `lookupResumableBrokerSession(id, sessionId)` (the `effectiveResumeOf` thunk).
- Gate 1 prints nothing.
- Gate 2 prints exactly four lines, all inside `rehydratePendingClaudeIds` (one) and `repairSyntheticFirstUserMessages` (three). Those are `openDb()`'s open steps (D13).
- Gate 3 prints three lines: `db.ts`'s `export function openDb(` declaration, the `kyselyOrThrow` error message (`… call openDb(userDataDir) first`), and `src/main/index.ts`'s `openDb(app.getPath('userData'));`, a statement that ignores the returned handle.

- [ ] **Step 5: Run the touched tests, both characterizations included**

Run:
```bash
npx vitest run src/main/dbReadCharacterization.test.ts src/main/dbIngestBatch.test.ts src/main/db.test.ts src/main/dbSessionCosts.test.ts \
  src/main/dbSessionsList.test.ts src/main/db.planUsage.test.ts src/main/db.usageAnchors.test.ts src/main/db.ingestAnchor.test.ts \
  src/main/dbEmbeddings.test.ts src/main/transcriptIndex.test.ts src/main/dbSummaries.test.ts src/main/local.liveState.test.ts \
  src/main/transcriptSearch.test.ts src/main/mcpServer.test.ts
```
Expected: PASS (14 files), with no snapshot written or updated. A `dbReadCharacterization` diff in `usd` (float tail) means the cost rows' order changed: `listSessionCostsQuery` must keep the old statement shape, with no `ORDER BY`. A diff in `tags` means D17's subquery is wrong.

- [ ] **Step 6: Full suite and commit**

```bash
CI=true npx vitest run src
git -C "$WT" add -A src/main
git -C "$WT" status --short   # only src/main; never stage .superpowers/
git -C "$WT" commit -m "feat(state): remaining state.db reads on Kysely; raw handle only at open; search stays on the MCP connection (async store 2b)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Perf gate, SPEC.md, PR

**Files:**
- Modify: `docs/SPEC.md`

- [ ] **Step 1: Run the A/B perf gate**

This compares the Task 1 commit (pre-port, with the 2b bench) against HEAD, alternating three times each in one session:

```bash
BASE_SHA=$(cat /tmp/async-store-p2b-base.sha)
BASE=/tmp/async-store-p2b-base
git -C "$WT" worktree add --detach "$BASE" "$BASE_SHA"
ln -s "$WT/node_modules" "$BASE/node_modules"
for i in 1 2 3; do
  (cd "$BASE" && STATE_BENCH=1 STATE_BENCH_OUT=/tmp/ab2b-a$i.json npx vitest run src/main/state/stateBench.test.ts >/dev/null)
  (cd "$WT"   && STATE_BENCH=1 STATE_BENCH_OUT=/tmp/ab2b-b$i.json npx vitest run src/main/state/stateBench.test.ts >/dev/null)
done
cd "$WT"
STATE_BENCH=1 STATE_BENCH_BASELINE=/tmp/ab2b-a1.json,/tmp/ab2b-a2.json,/tmp/ab2b-a3.json \
  STATE_BENCH_CANDIDATE=/tmp/ab2b-b1.json,/tmp/ab2b-b2.json,/tmp/ab2b-b3.json \
  npx vitest run src/main/state/stateBench.test.ts --reporter=verbose 2>&1 | tee /tmp/ab2b-compare.txt
git -C "$WT" worktree remove --force "$BASE"
```

Expected: PASS. **Acceptance criterion:** every metric in `GATE` satisfies `candidate ≤ baseline × (1 + tol) + slack` (D18).

The prototype of this plan measured, in this container on 2026-11-04, the per-metric median of 3 A/B pairs, over two complete loops:

| metric | loop 1 before → after | loop 2 before → after |
|---|---|---|
| ingest_fresh_us_per_line | 78.4 → 77.6 (−1%) | 78.0 → 68.8 (−12%) |
| ingest_replay_us_per_line | 24.0 → 22.7 (−6%) | 21.9 → 21.5 (−2%) |
| summary_uncached_ms | 2.10 → 2.22 (+6%) | 2.03 → 2.11 (+4%) |
| summary_cached_us | 9.8 → 7.6 (−23%) | 9.2 → 7.8 (−15%) |
| lookup_mapping_us | 9.9 → 9.5 (−4%) | 9.5 → 8.9 (−6%) |
| events_page_ms | 1.64 → 1.79 (+9%) | 1.53 → 1.54 (+1%) |
| list_sessions_ms | 0.54 → 0.73 (+34%) | 0.50 → 0.58 (+17%) |
| search_ms | 33.1 → 32.2 (−3%) | 29.7 → 32.7 (+10%) |
| embed_insert_us_per_row | 78.4 → 78.0 (−1%) | 76.2 → 76.3 (0%) |
| stall_p50_ms | 20.7 → 18.8 (−9%) | 17.7 → 17.7 (0%) |
| stall_max_ms | 42.9 → 42.1 (−2%) | 40.8 → 36.1 (−12%) |
| record_mapping_us | 166.5 → 158.9 (−5%) | 151.0 → 146.4 (−3%) |
| record_error_us | 132.9 → 133.1 (0%) | 129.0 → 126.1 (−2%) |
| perf_flush_ms | 17.5 → 17.6 (+1%) | 17.0 → 18.0 (+6%) |

`list_sessions_ms` is the one real cost. Isolated in one process, sync raw SQL took 0.26 ms and the Kysely transaction 0.37–0.46 ms. That's Kysely building, compiling and mapping three result sets per call, about +0.1 ms per Sessions-list IPC. D18's 0.15 ms slack absorbs it. The stall metrics are unchanged because, on the SQLite driver, an async read still runs to completion inside one microtask drain: the loop's blocking is set by the ingest chunk, not by the reads.

If a metric fails, re-run the whole loop once; it is a regression only if it fails twice. A real regression on `summary_*`, `events_page_ms` or `lookup_mapping_us` means a read lost the statement cache (check `stateKysely()` is the handle in use) or gained a query. On `list_sessions_ms` beyond the slack, it means a per-session query crept in.

- [ ] **Step 2: Update SPEC.md**

Apply these replacements to `docs/SPEC.md`. Each `old` string occurs exactly once.

§4 *Stack*, `Store layer | kysely` row: replace

`` `state.db` writes run on the same layer (`stateKysely()`, `src/main/db.ts`), with a prepared-statement cache (`sqliteKysely(raw, { statementCache: 256 })`) because the SQLite driver prepares every query and better-sqlite3 does not cache; `state.db` reads are still synchronous better-sqlite3 on the same connection until they move too. Postgres is a second dialect of the same queries. ``

with

`` `state.db` reads and writes run on the same layer (`stateKysely()`, `src/main/db.ts`), with a prepared-statement cache (`sqliteKysely(raw, { statementCache: 256 })`) because the SQLite driver prepares every query and better-sqlite3 does not cache. The raw better-sqlite3 handle serves only `openDb()`'s synchronous open steps (`migrate()` and the `pendingClaudeIds` rehydrate); the MCP server's read-only connection and `searchTranscripts` stay raw (§11). Postgres is a second dialect of the same queries. ``

§6 *Observability*, `observability:summaryForWorkspace`: replace

`The summary and rolling-spend reads are served from event-invalidated in-memory caches, cleared on DB open; the rolling sum is keyed by 15 s bucket.`

with

`` The summary and rolling-spend reads are served from event-invalidated in-memory async caches (`asyncKeyedCache`, `src/main/asyncCache.ts`), cleared on DB open; the rolling sum is keyed by 15 s bucket. Concurrent misses on a key share one in-flight recompute. A stale entry is recomputed and awaited, never served past its horizon. An `invalidate`/`clear` that lands while a recompute is in flight wins: that result goes to its callers but is not stored. A `markStale` that lands mid-recompute caps the stored result. Every invalidation runs after its write commits. A summary recompute (and `listSessions`) runs its queries in one read transaction, so they see one consistent state. ``

In the same paragraph, replace `` using `LATEST_ASSISTANT_SQL` — an index seek `` with `` using `latestAssistantQuery` — an index seek ``.

§6 *Perf telemetry*, *Boot + embedding attribution spans*: replace

`` `claude_fleet.index.pending_turns`/`pending_summaries`/`list_sessions`/`delete_stale_models` (sync SQLite), and `claude_fleet.search.scan` (sync brute-force vector read + top-k). ``

with

`` `claude_fleet.index.pending_turns`/`pending_summaries`/`list_sessions`/`delete_stale_models` (async SQLite reads on the Kysely handle), and `claude_fleet.search.scan` (sync brute-force vector read + top-k on the MCP read-only connection). ``

§7 *JSONL→SQLite cache*, *Async write path*: replace the bullet

`  - Reads (summaries, lists, cost, lookups, search) are still synchronous on the same connection.`

with

`` - **Reads** (summaries, lists, cost, lookups, anchors, embedding backlog) are async on the same handle. On the SQLite driver a query does no I/O, so a read or read transaction runs to completion inside one microtask drain and never yields to an ingest mid-read. The live summary push (`observability:summary`) awaits the summary before sending; a failed push is logged as `observability-broadcast` (warn). ``

Keep the bullet's two-space indent.

§11 *Cross-workspace committee control*, `committee_status`: replace

`` `lastActiveAt` best-effort from the DB. The metadata adds no exposure ``

with

`` `lastActiveAt` best-effort from the DB (the workspace's max session `last_active_at`, `latestActivityByWorkspace`; the roster reads every candidate's in one grouped query). The metadata adds no exposure ``

§11 *In-container SQLite access via MCP*: replace

`Postgres gets its own isolation path (role + RLS) instead of a ported snapshot.`

with

`` Postgres gets its own isolation path (role + RLS) instead of a ported snapshot. `search_transcripts` also reads this connection: `searchTranscripts(…, db)` takes the handle explicitly, with no app-connection default. ``

Run: `/usr/bin/grep -n "reads are still synchronous\|are still synchronous on the same connection\|LATEST_ASSISTANT_SQL" docs/SPEC.md`
Expected: no output.

- [ ] **Step 3: Final verification**

Run: `CI=true npx vitest run src && npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json && npm run build`
Expected: all PASS. If `npm run build` is env-blocked in the container (@xterm addons), say so in the PR. CI builds.

- [ ] **Step 4: Commit, push, PR**

```bash
git -C "$WT" add docs/SPEC.md
git -C "$WT" commit -m "docs(spec): async state.db reads, async read caches, raw handle only at open (async store 2b)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git -C "$WT" push -u origin feat/async-store-p2b
COMPARE=$(sed -n '/STATE_BENCH_COMPARE/,/^\]/p' /tmp/ab2b-compare.txt | sed '1s/^.*STATE_BENCH_COMPARE //')
BODY=$(cat <<'EOF'
Part 2b of the async store layer (plan: docs/superpowers/plans/2026-11-04-async-store-part2b.md).

- Every remaining state.db read is async on the Kysely handle: summaries, cost, spend, lookups, sessions list, plan usage, anchors, embedding backlog. IPC shapes unchanged.
- summaryCache / spendCache are asyncKeyedCache: in-flight de-dupe; an invalidate/clear during a recompute wins; no stale-while-revalidate.
- Summary recompute and listSessions run in one read transaction.
- Raw better-sqlite3 handle now serves only openDb()'s open steps. MCP read connection, query snapshot and searchTranscripts unchanged (SQLite-only by design).
- Read characterization snapshot recorded pre-port; unchanged, as is 2a's ingest snapshot.

Perf gate (A/B, median of 3 pairs, this container; pass = candidate ≤ baseline × (1 + tol) + slack, tol 25%):
EOF
)
FOOT=$(cat <<'EOF'
Gate: typecheck (node + web) + unit + build + e2e in CI. No UI change; Troy to eyeball the Sessions list, observability rail (live updates during a streaming turn), a tab /clear remap, committee roster, and the plan-usage bar on the host.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)
gh pr create --repo ImIOImI/claude-fleet --head feat/async-store-p2b \
  --title "feat(state): async store part 2b — state.db reads and caches on Kysely" \
  --body "$(printf '%s\n\n%s\n\n%s\n' "$BODY" "$COMPARE" "$FOOT")"
```

---

## Self-review notes

- **Requirements coverage:**
  - Inventory of every raw read and cache with call sites, including IPC and MCP paths: *Inventory*.
  - No behaviour change and IPC shapes unchanged: *Global Constraints*; Task 1's read snapshot plus 2a's ingest snapshot, re-run in Tasks 3 and 4.
  - Cache semantics (no SWR, in-flight de-dupe, invalidation after commit wins): D10 and D11, implemented in Task 2, wired in Task 3.
  - Raw handle at the end of 2b: D13, enforced by Task 4 Step 4's gates.
  - `searchTranscripts` and the embedding reads: D14.
  - Perf gate with resolvable tolerances and the new stall and `insertEmbeddings` metrics: D18, Task 1 Step 5, Task 5 Step 1.
  - SPEC: Task 5 Step 2.
- **Type consistency:**
  - `costForSessionQ(q, id)` is defined in Task 3 and used by the summary transaction.
  - `explainPlan(raw, query)` is defined in Task 3 and used in Tasks 3 and 4.
  - `latestActivityByWorkspace(ids)` is defined in Task 4 Step 2(i) and used by `ipc.ts` `lastActiveAtFor` in Step 3.
  - `effectiveResumeOf`'s thunk returns `Promise<string | null>`, which `lookupResumableBrokerSession` satisfies.
  - The `local.*.test.ts` `vi.mock('./db.js')` factories return plain values, and awaiting them is fine.
- **Deliberately not done:**
  - Making `openDb()` async to move the rehydrate onto Kysely (D13).
  - Pre-compiling Kysely queries to recover `list_sessions_ms` (+0.1 ms; not worth a second query path).
  - Part 3's Postgres dialect and `searchEmbeddings`.
