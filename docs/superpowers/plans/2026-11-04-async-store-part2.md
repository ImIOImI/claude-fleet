# Async store layer, part 2a: `state.db` writes on async Kysely — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every `state.db` **write** (JSONL ingest and its rollups, broker-session mappings, usage events, errors, session rename/delete, embeddings, perf telemetry) onto the async Kysely store layer that part 1 built for `inbox.db`. It stays on SQLite, with no behaviour change, and ingest gets faster rather than slower. Part 2b (outlined at the end) moves the reads and the read caches.

**Architecture:** `openDb()` still opens `state.db` with better-sqlite3 and runs today's `user_version` migrations synchronously. It then wraps the same connection in one Kysely handle (`stateKysely()`) with a **prepared-statement cache**, because Kysely's SQLite driver calls `prepare()` on every query and better-sqlite3 does not cache. Every write goes through that handle, so the driver's connection mutex serializes all writes and every transaction. Ingest moves from one commit per line to **one transaction per 500-line chunk** of each watcher batch, with a macrotask yield between chunks. A **per-file serial queue** in the watcher keeps each file's batches strictly ordered. Mapping check-then-act runs as a single transaction. Reads stay synchronous raw better-sqlite3 in 2a, on the same connection, and the MCP server keeps its own read-only connection and snapshot.

**Tech Stack:** TypeScript, Electron main (CJS bundle via electron-vite), better-sqlite3 13, kysely 0.28.x (already a dependency since part 1), vitest.

**Spec:** `docs/superpowers/specs/2026-11-02-remote-workspaces-design.md` §7 *One store layer*, §11 sub-project (a). The outline this refines is at the end of `docs/superpowers/plans/2026-11-02-async-store-part1.md` ("Part 2"). SPEC.md §4 *Stack*, §7 *JSONL→SQLite cache* / *Local embeddings*, §5 *Perf telemetry*, §11 *In-container SQLite access via MCP*.

## Global Constraints

- **SQLite behaviour is unchanged:**
  - The same `state.db` file, the same `migrate()` SQL (v1–v14), and the same rows. Event ids are included: an ignored replay `INSERT` still advances `AUTOINCREMENT` exactly as before.
  - Every IPC channel name, payload and return shape stays the same. No renderer or preload change.
  - **The characterization snapshot from Task 1 is the arbiter.** Any task that changes ingest must still pass it unmodified. Never run `vitest -u` on it after Task 1.
- **Dialect-neutral queries in store code:**
  - No `IFNULL` (use `coalesce`) and no multi-argument `MAX(a, b)` (use `CASE WHEN … THEN … ELSE … END`). No `INSERT OR IGNORE` (use `.onConflict((oc) => oc.doNothing())`), and no `lastInsertRowid`.
  - Wrap every `COUNT`/`SUM`/`numAffectedRows`/`numInsertedOrUpdatedRows`/`numDeletedRows` in `num()`.
  - Qualify columns in `ON CONFLICT … DO UPDATE` with the table name or `excluded.`.
  - Schema DDL (`migrate()`) stays SQLite-specific. Part 3 adds per-dialect DDL.
  - `INSERT OR IGNORE` → `ON CONFLICT DO NOTHING` is exact here because every NOT NULL column of `events`, `embeddings`, `session_summaries`, `session_tags` and `usage_anchors` is always bound non-null by the callers.
- **Transactions await only `trx`.** Inside `kysely.transaction().execute(async (trx) => …)`, use only `trx` and helpers that take a `q: Kysely<StateDb>` argument, never `stateKysely()` or a module helper that calls `kyselyOrThrow()`. The SQLite driver has one connection behind a mutex, so an outer-handle query inside a transaction deadlocks.
- **Check-then-act stays atomic.** A read followed by a dependent write is either one transaction or one guarded statement.
  - In-memory mirrors of DB state (`pendingClaudeIds`) are mutated **inside** the transaction callback, after its last `await`. They're restored in a `catch` if the transaction rejects. Mutating them there orders the change with every other transaction through the mutex.
  - Cache invalidation (`summaryCache`, `spendCache`) runs **after** the transaction commits.
- **No `.then(onFulfilled, onRejected)`.** Use `await`/`try`, or `.catch()` alone, or a single-argument `.then(fn)`.
- **No N+1.** Async Kysely costs more per query than sync better-sqlite3 (~18 µs vs ~14 µs uncached; ~6 µs with the statement cache). Never add a per-row query loop where one statement or a `chunked()` IN-list does.
- **Keep every commit shippable:**
  - Each task ends green on both `tsc` configs and the full unit suite.
  - Raw-handle sync writes and Kysely transactions coexist in intermediate commits. That is safe: a Kysely-on-better-sqlite3 transaction does no I/O, so it runs to completion inside one macrotask's microtask drain, and a raw sync write from another event source can't land inside it.
  - Tasks 3 and 5 still come in dependency order: mappings before ingest, so ingest's promotion step is always on the same handle as the mapping writes.
- **`mcpServer.ts` is out of scope** apart from the injected-handler types and the three `run` bodies named in Tasks 3 and 6. Its `{ readonly: true }` better-sqlite3 connection, `buildSnapshot` ATTACH snapshot and typed read tools stay exactly as they are. This is decided in *Decisions*, D1.
- **Never `npm install` into `/workspace/claude-fleet/node_modules`** (the shared base checkout). Work in your own worktree with its own `node_modules` (see *Verification environment*).
- **Typecheck both configs separately:** `npx tsc --noEmit -p tsconfig.node.json` and `npx tsc --noEmit -p tsconfig.web.json`. `npm run typecheck` short-circuits after the node config.
- **`tsc` cannot see a missing `await`** on a call whose result is unused. Every task that converts a function lists its call sites. Before committing, run the task's `/usr/bin/grep` check and inspect each hit.
- **CI (`build-app.yml`: `unit (vitest)` + build + e2e) is the real gate.** The container can't run Electron. Troy eyeballs the app on the host after merge: Sessions list, observability rail, tab remaps, Settings → perf status.
- **Every commit message ends with** `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- **SPEC.md is updated in the same PR** (Task 8): §4 *Stack*, §5 *Perf telemetry*, §7 *JSONL→SQLite cache* and *Error log*, §11 *In-container SQLite access via MCP*.

## Decisions (not in the spec; recorded here and in SPEC.md by Task 8)

- **D1 — The MCP read path stays raw better-sqlite3.** `mcpServer.ts` opens its own `{ readonly: true }` connection. Its `query` tool ATTACHes `state.db` into a per-call in-memory snapshot. Both are SQLite-only by design: the snapshot *is* the isolation mechanism. They keep working unchanged:
  - They read a different connection, which only sees committed WAL frames, so a snapshot never sees half an ingest chunk.
  - Part 5 gives Postgres its own role/RLS path. It doesn't port the snapshot.
- **D2 — Part 2 is split.** 2a (this plan) ports every **write**; 2b ports the **reads and caches** (outlined at the end). Writes go first because a write is what can interleave with, or land inside, another transaction. After 2a, the raw handle is used only for migrations and synchronous reads.
- **D3 — Ingest commits per 500-line chunk, not per line.** Today each line is its own transaction, and that per-line WAL commit is ~80% of ingest cost. One transaction per `INGEST_TX_LINES = 500` lines of a watcher batch, with a `setImmediate` yield between chunks, cuts fresh ingest by about 4×. It also stops a large startup re-read from blocking the loop for the whole file. Durability is unchanged: the byte offset only advances after the batch resolves, and a crash re-reads from JSONL.
- **D4 — Per-chunk sessions-row fold.** The per-line `sessions` upsert is folded per chunk by `foldSessionTouch` into one read plus at most one write. The fold reproduces the old SQL exactly, including SQLite's `MAX(x, NULL) = NULL` rule: a timestamp-less line nulls `last_active_at`. That rule is a pre-existing bug, filed as **#475**, and is **deliberately preserved** here. Fix it in its own change.
- **D5 — Prepared-statement cache for state.db only.** `sqliteKysely(raw, { statementCache: 256 })` memoizes `prepare()` by SQL text and clears the cache when it's full. `inbox.db` keeps the default (off), so part 1's behaviour is untouched.
- **D6 — Errors retention prune becomes a PK seek.** `DELETE FROM errors WHERE id NOT IN (SELECT id … LIMIT 2000)` becomes `WHERE id <= (SELECT id … ORDER BY id DESC LIMIT 1 OFFSET 2000)`. The same rows survive, but it's about 3× faster at the cap. The insert and the prune share one transaction.
- **D7 — Fire-and-forget sites log instead of throwing:**
  - The `logError` DB sink, the MCP search/clickthrough usage signals, the watcher `'new-session'` learn, local `onFreshSpawn`, and the perf flush/prune timers now `.catch()` their rejections. The sink swallows silently, as before. The other sites log a `warn`, or `console.warn` for perf.
  - The old synchronous throws were already swallowed, or escaped as uncaught exceptions. No caller depended on them.
- **D8 — The `claude_fleet.ingest` span now measures the wall time of the whole batch**, including inter-chunk yields, rather than one blocking loop. Event-loop blocking is still attributed by the `stall` rows.
- **D9 — Perf gate is A/B with per-metric tolerance.** Container noise between quiet and busy minutes is about ±30%, more than any tolerance worth setting. Baseline and candidate are therefore measured alternately, three times each, in one session, and compared by per-metric median:
  - Read and ingest hot paths: **no regression beyond 10%**.
  - Low-frequency writes (mapping, error, perf flush): **no regression beyond 25%**.

## Verification environment (do this once, before Task 1)

```bash
git -C /workspace/claude-fleet fetch -q origin
WT=/workspace/claude-fleet/.claude/worktrees/async-store-p2a
git -C /workspace/claude-fleet worktree add -b feat/async-store-p2a "$WT" origin/main
cd "$WT"
npm ci --ignore-scripts                                  # worktree-local node_modules; skips electron + native postinstalls
printf 'electron-stub' > node_modules/electron/path.txt  # lets `import { app } from 'electron'` load in vitest
npx vitest run src/main/db.test.ts                       # baseline: expect PASS (better-sqlite3 13 ships Node prebuilds)
npx tsc --noEmit -p tsconfig.node.json; echo "node tsc exit $?"   # baseline: exit 0
npx tsc --noEmit -p tsconfig.web.json;  echo "web tsc exit $?"    # baseline: exit 0
```

Never `cd /workspace/claude-fleet` from inside the worktree. That's the shared main checkout, on a different branch. Use `$WT` paths or `git -C "$WT"`.

If the test run fails with "Module did not self-register", run `(cd node_modules/better-sqlite3 && npx --yes prebuild-install)` once. If `npm ci` is refused, don't install into the base checkout. Gate each task on the two `tsc` commands, note "vitest not runnable in-container; CI gates" in the commit body, and let PR CI run the suites.

`chunked()` comes from PR #473 (`src/main/store/kysely.ts`). If `/usr/bin/grep -n "export function chunked" src/main/store/kysely.ts` prints nothing, #473 hasn't merged. Task 2 then adds `chunked()` itself, verbatim.

### Test-conversion rule (Tasks 2, 3, 5, 6, 7)

Converting a function to async changes every test that calls it. Save this helper once, then apply the rules to the files each task lists:

```bash
cat > /tmp/conv-async.py <<'PYEOF'
#!/usr/bin/env python3
"""Mechanical sync→async test conversion (async store part 2).

usage: python3 /tmp/conv-async.py --fns name1,name2 file1.test.ts [file2.test.ts ...]

1. Prefix `await ` to every call of a listed function that is not already
   awaited, not a declaration, and not a member access (`x.fn(` is left alone).
2. Leave import lists untouched.
3. Make every it/test/beforeEach/afterEach/beforeAll/afterAll callback of the
   form `() => {` async.
Helpers that now contain `await` (e.g. `function realSession(...)`) are NOT
rewritten — tsc reports them (TS1308); fix those by hand as the task says.
"""
import re, sys

args = sys.argv[1:]
if len(args) < 3 or args[0] != '--fns':
    sys.exit(__doc__)
fns = '|'.join(re.escape(f) for f in args[1].split(','))
call = re.compile(r'(?<![\w.])(?<!await )(?<!function )(' + fns + r')\(')
for path in args[2:]:
    src = open(path).read()
    out = call.sub(lambda m: 'await ' + m.group(1) + '(', src)
    out = re.sub(r'import \{[^}]*\}', lambda m: m.group(0).replace('await ', ''), out, flags=re.S)
    out = re.sub(r"\b(it|test|beforeEach|afterEach|beforeAll|afterAll)\((['\"`][^\n]*?['\"`]\s*,\s*)?\(\) => \{",
                 lambda m: f"{m.group(1)}({m.group(2) or ''}async () => {{", out)
    # `afterEach(() => closeDb())` is fine as written (vitest awaits the returned promise).
    out = re.sub(r"\b(afterEach|beforeEach)\(\(\) => await closeDb\(\)\)", r"\1(() => closeDb())", out)
    if out != src:
        open(path, 'w').write(out)
        print('converted', path)
PYEOF
```

1. Run `python3 /tmp/conv-async.py --fns <the task's functions> <the task's test files>`. It awaits every bare call and makes each `it`/hook callback async.
2. Run `npx tsc --noEmit -p tsconfig.node.json`. Every `TS1308 'await' expressions are only allowed within async functions` hit is a helper that now awaits. Make it `async function …(): Promise<…>`, and put `await` on each of its call sites (the task lists them).
3. Change `expect(() => x.m(…)).toThrow(re)` on a converted call to `await expect(x.m(…)).rejects.toThrow(re)`.
4. Leave `afterEach(() => closeDb())` as written: vitest awaits the returned promise.
5. A `vi.mock('./db.js', …)` factory that stubs a converted function keeps returning plain values. `await` on a plain value is fine. Only rename it where the task says.

After converting, run this check and inspect each hit. A statement-level call to a converted function without `await` is a bug, even if the test passes:

```bash
/usr/bin/grep -nE "^\s+(<fn1>|<fn2>)\(" <test files>
```

---

## File structure

| File | Responsibility |
|---|---|
| `src/main/store/kysely.ts` | `sqliteKysely(raw, { statementCache })` (new option), `num`, `chunked`. Still the only file that names the SQLite dialect. |
| `src/main/store/stateSchema.ts` (new) | Kysely table types for `state.db` (`StateDb`), mirroring migrations v1–v14. |
| `src/main/state/ingestParse.ts` (new) | Pure line → events-row extraction (moved out of `db.ts`) and `foldSessionTouch`. |
| `src/main/state/serialQueue.ts` (new) | `keyedSerialQueue()`: per-key strictly ordered async tasks with `drain()`. |
| `src/main/state/stateBench.test.ts` (new) | The env-gated hot-path benchmark, for the perf gate. |
| `src/main/dbIngestBatch.test.ts` + `src/main/__snapshots__/dbIngestBatch.test.ts.snap` (new) | Ingest characterization snapshot (recorded pre-port), `ingestBatch` semantics, the mapping/ingest race. |
| `src/main/db.ts` | Opens/migrates (unchanged). Adds the Kysely handle, async `closeDb`, async writes (`ingestBatch`, `ingestLine`, mappings, usage events, errors, rename/delete, embeddings, anchors). Reads stay sync until 2b. |
| `src/main/jsonlWatcher.ts` | Per-file serial queue, drain on `stop()`, `ingestBatch` per read. |
| `src/main/perfStore.ts`, `src/main/perf.ts` | Async serialized flush, prune and counts; async `getPerfStatus`. |
| `src/main/ipc.ts`, `docker.ts`, `local.ts`, `index.ts`, `mcpServer.ts`, `transcriptIndex.ts` | Await the converted writes. |
| `docs/SPEC.md` | §4, §5 *Perf telemetry*, §7 *JSONL→SQLite cache* / *Error log*, §11 MCP. |

---

### Task 1: Benchmark harness, baseline, and the ingest characterization snapshot

No production change. This task pins *today's* behaviour and speed, so every later task is measured against it.

**Files:**
- Create: `src/main/state/stateBench.test.ts`
- Create: `src/main/dbIngestBatch.test.ts` (characterization part only; Task 5 appends to it)
- Create (generated): `src/main/__snapshots__/dbIngestBatch.test.ts.snap`

**Interfaces:**
- Produces:
  - `FIXTURE: string[]` and `dump(raw): Record<string, unknown[]>`, exported from `dbIngestBatch.test.ts`.
  - The snapshot entries `ingest characterization … > results 1`, `state 1`, and the trailing-light-line entry.
  - The bench env contract: `STATE_BENCH=1`; `STATE_BENCH_OUT=<file>` to measure; `STATE_BENCH_BASELINE=<f,…>` with `STATE_BENCH_CANDIDATE=<f,…>` to compare.

- [ ] **Step 1: Write the benchmark**

`src/main/state/stateBench.test.ts`:

```ts
// state.db hot-path benchmark — the async store part 2 perf gate.
//
// Skipped unless STATE_BENCH=1. Written against the API both before and after
// the async port (`await` on a sync return is a no-op; `ingestBatch` is used
// when db.ts exports it, else the per-line loop the watcher ran before), so
// the same file measures both sides.
//
// Measure (writes the per-metric medians of RUNS runs):
//   STATE_BENCH=1 STATE_BENCH_OUT=/tmp/b1.json npx vitest run src/main/state/stateBench.test.ts
// Compare (no measuring; each side is the per-metric median of its files):
//   STATE_BENCH=1 STATE_BENCH_BASELINE=/tmp/a1.json,/tmp/a2.json,/tmp/a3.json \
//     STATE_BENCH_CANDIDATE=/tmp/b1.json,/tmp/b2.json,/tmp/b3.json npx vitest run src/main/state/stateBench.test.ts
//
// Machine noise is large (±30% between quiet and busy minutes), so the gate
// is A/B: baseline and candidate runs alternate in one session (the plan's
// perf-gate task has the loop). Numbers are machine-specific.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as db from '../db.js';
import { searchTranscripts } from '../transcriptIndex.js';
import { PerfStore } from '../perfStore.js';
import { EMBED_DIM, EMBED_MODEL_ID, encodeVector } from '../vectors.js';

const RUNS = 5;
const N_LINES = 6000;
const WATCHER_BATCH = 200;
const N_LIST_SESSIONS = 300;
const N_EMBEDDINGS = 5000;
const N_WRITES = 500;
const N_PERF_ROWS = 5000;

type Metrics = Record<string, number>;

/** Allowed slowdown per metric (candidate ≤ baseline × (1 + tolerance)). The
 *  read/ingest hot paths get 10%; the low-frequency writes get 25%. */
export const TOLERANCE: Record<string, number> = {
  ingest_fresh_us_per_line: 0.1,
  ingest_replay_us_per_line: 0.1,
  summary_uncached_ms: 0.1,
  summary_cached_us: 0.1,
  list_sessions_ms: 0.1,
  search_ms: 0.1,
  record_mapping_us: 0.25,
  record_error_us: 0.25,
  perf_flush_ms: 0.25,
};

function medianOfFiles(list: string): Metrics {
  const all = list.split(',').map((p) => JSON.parse(readFileSync(p.trim(), 'utf8')) as Metrics);
  const out: Metrics = {};
  for (const k of Object.keys(all[0])) out[k] = median(all.map((m) => m[k]));
  return out;
}

function lines(n: number, sid: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const ts = new Date(1_782_864_000_000 + i * 1000).toISOString();
    if (i % 3 === 0) {
      out.push(JSON.stringify({ type: 'assistant', uuid: `${sid}-a${i}`, timestamp: ts, message: {
        model: 'claude-opus-4-1',
        usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 5, service_tier: 'standard' },
        content: [{ type: 'tool_use', id: `tu${i}`, name: i % 2 ? 'Bash' : 'Read', input: { command: 'ls -la ' + 'x'.repeat(200) } }] } }));
    } else if (i % 3 === 1) {
      out.push(JSON.stringify({ type: 'user', uuid: `${sid}-u${i}`, timestamp: ts, message: { role: 'user',
        content: [{ type: 'tool_result', tool_use_id: `tu${i - 1}`, is_error: false, content: 'y'.repeat(800) }] } }));
    } else {
      out.push(JSON.stringify({ type: 'user', uuid: `${sid}-p${i}`, timestamp: ts, message: { role: 'user', content: `prompt ${i}` } }));
    }
  }
  return out;
}

/** The watcher's per-batch ingest, on whichever API this db.ts has. */
async function ingestLikeWatcher(ws: string, sid: string, all: string[]): Promise<void> {
  const mod = db as unknown as { ingestBatch?: (w: string, s: string, l: string[]) => Promise<unknown> };
  for (let i = 0; i < all.length; i += WATCHER_BATCH) {
    const batch = all.slice(i, i + WATCHER_BATCH);
    if (mod.ingestBatch) await mod.ingestBatch(ws, sid, batch);
    else for (const l of batch) await db.ingestLine(ws, sid, l);
  }
}

async function time(fn: () => Promise<unknown> | unknown): Promise<number> {
  const t = performance.now();
  await fn();
  return performance.now() - t;
}

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function oneRun(): Promise<Metrics> {
  const dir = mkdtempSync(join(tmpdir(), 'cf-state-bench-'));
  const m: Metrics = {};
  try {
    const raw = db.openDb(dir);
    const big = lines(N_LINES, 'big');
    m.ingest_fresh_us_per_line = ((await time(() => ingestLikeWatcher('ws', 'big', big))) * 1000) / N_LINES;
    m.ingest_replay_us_per_line = ((await time(() => ingestLikeWatcher('ws', 'big', big))) * 1000) / N_LINES;

    // summaryForSession with a non-default topTools limit bypasses the cache: the recompute cost.
    const sums: number[] = [];
    for (let i = 0; i < 100; i++) sums.push(await time(() => db.summaryForSession('big', 6)));
    m.summary_uncached_ms = median(sums);
    await db.learnBrokerSessionMapping('ws', 'tab-big', 'big');
    const hits: number[] = [];
    for (let i = 0; i < 200; i++) hits.push(await time(() => db.summaryForBrokerSession('ws', 'tab-big')));
    m.summary_cached_us = median(hits) * 1000;

    for (let s = 0; s < N_LIST_SESSIONS; s++) await ingestLikeWatcher(`ws${s % 7}`, `s${s}`, lines(20, `s${s}`));
    const lists: number[] = [];
    for (let i = 0; i < 30; i++) lists.push(await time(() => db.listSessions()));
    m.list_sessions_ms = median(lists);

    const vec = new Float32Array(EMBED_DIM);
    for (let i = 0; i < N_EMBEDDINGS; i++) {
      vec.fill(0);
      vec[i % EMBED_DIM] = 1;
      await db.insertEmbedding({ workspaceId: `ws${i % 7}`, sessionId: `s${i % N_LIST_SESSIONS}`, kind: 'turn', refEventId: i, ts: i,
        text: `turn ${i}`, modelId: EMBED_MODEL_ID, dim: EMBED_DIM, vec: encodeVector(vec), dedupKey: `t${i}` });
    }
    const embed = async (texts: string[]) => texts.map(() => { const v = new Float32Array(EMBED_DIM); v[3] = 1; return v; });
    const allowed = new Set(Array.from({ length: 7 }, (_, i) => `ws${i}`));
    const searches: number[] = [];
    for (let i = 0; i < 10; i++) searches.push(await time(() => searchTranscripts('q', allowed, embed, { limit: 10 }, raw)));
    m.search_ms = median(searches);

    m.record_mapping_us = ((await time(async () => {
      for (let i = 0; i < N_WRITES; i++) await db.recordBrokerSessionMapping('ws', `tab-${i}`, `s${i % N_LIST_SESSIONS}`);
    })) * 1000) / N_WRITES;
    m.record_error_us = ((await time(async () => {
      for (let i = 0; i < N_WRITES; i++) await db.recordError({ ts: i, source: 'main', type: 'bench', message: 'm' });
    })) * 1000) / N_WRITES;

    // Pre-port PerfStore takes the raw handle; the ported one (it has a
    // flushChain field) takes the Kysely handle.
    const probe = new PerfStore(raw as never);
    const store = 'flushChain' in probe
      ? new PerfStore((db as unknown as { stateKysely: () => unknown }).stateKysely() as never)
      : probe;
    for (let i = 0; i < N_PERF_ROWS; i++) store.enqueue({ ts: i, kind: 'stall', durMs: 60, meta: { p50: 1 } });
    m.perf_flush_ms = await time(() => store.flush());
    return m;
  } finally {
    await db.closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(process.env.STATE_BENCH !== '1')('state.db hot-path benchmark', () => {
  it('measures every hot path (median of RUNS), or compares saved runs', async () => {
    if (process.env.STATE_BENCH_BASELINE && process.env.STATE_BENCH_CANDIDATE) {
      const base = medianOfFiles(process.env.STATE_BENCH_BASELINE);
      const cand = medianOfFiles(process.env.STATE_BENCH_CANDIDATE);
      const rows = Object.keys(TOLERANCE).map((k) => ({
        metric: k, baseline: base[k], candidate: cand[k], change: `${(((cand[k] - base[k]) / base[k]) * 100).toFixed(1)}%`,
        limit: `+${TOLERANCE[k] * 100}%`, ok: cand[k] <= base[k] * (1 + TOLERANCE[k]),
      }));
      console.log('STATE_BENCH_COMPARE ' + JSON.stringify(rows, null, 2));
      expect(rows.filter((r) => !r.ok).map((r) => r.metric)).toEqual([]);
      return;
    }
    const runs: Metrics[] = [];
    for (let r = 0; r < RUNS; r++) runs.push(await oneRun());
    const result: Metrics = {};
    for (const k of Object.keys(runs[0])) result[k] = Number(median(runs.map((x) => x[k])).toFixed(3));
    console.log('STATE_BENCH ' + JSON.stringify(result));
    if (process.env.STATE_BENCH_OUT) writeFileSync(process.env.STATE_BENCH_OUT, JSON.stringify(result, null, 2) + '\n');
  }, 600_000);
});
```

It's written against both the pre-port API and the ported one:
- `await` on a sync return is a no-op.
- `ingestBatch` is feature-detected. Before the port, the bench runs the watcher's old per-line loop.
- `stateKysely` is feature-detected the same way for `PerfStore`.

- [ ] **Step 2: Check that it stays skipped by default and runs when asked**

Run: `npx vitest run src/main/state/stateBench.test.ts`
Expected: `1 skipped`.

Run: `STATE_BENCH=1 STATE_BENCH_OUT=/tmp/bench-baseline.json npx vitest run src/main/state/stateBench.test.ts && cat /tmp/bench-baseline.json`
Expected: PASS in about 90 s, plus a JSON object with the nine metrics. For reference, this container measured on origin/main 2026-11-04: `ingest_fresh_us_per_line ≈ 280`, `ingest_replay_us_per_line ≈ 37`, `summary_uncached_ms ≈ 2.0`, `summary_cached_us ≈ 10.5`, `list_sessions_ms ≈ 0.53`, `search_ms ≈ 31`, `record_mapping_us ≈ 130`, `record_error_us ≈ 145`, `perf_flush_ms ≈ 12`.

- [ ] **Step 3: Write the characterization test**

`src/main/dbIngestBatch.test.ts`:

```ts
// state.db ingest port (async store part 2a). The characterization snapshot
// was recorded on the pre-port synchronous ingestLine; every later version of
// the ingest path must reproduce it byte-for-byte.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import * as db from './db.js';

const WS = '01WSINGEST';
const S = 'sess-ingest';

const at = (s: number): string => new Date(Date.UTC(2026, 6, 1, 0, 0, s)).toISOString();

/** One line of every shape ingest treats specially, plus replays + junk. */
export const FIXTURE: string[] = [
  JSON.stringify({ type: 'system', uuid: 'sys1', timestamp: at(0), cwd: '/workspace/app', subtype: 'init' }),
  JSON.stringify({ type: 'user', uuid: 'u1', timestamp: at(1), message: { role: 'user', content: '<command-name>/clear</command-name>' } }),
  JSON.stringify({ type: 'user', uuid: 'u2', timestamp: at(2), isMeta: true, message: { role: 'user', content: 'meta, never a title' } }),
  JSON.stringify({ type: 'user', uuid: 'u3', timestamp: at(3), message: { role: 'user', content: 'fix the reconnect bug' } }),
  JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u3', timestamp: at(4), message: { model: 'claude-opus-4-1', usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 5, service_tier: 'standard' }, content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls -la' } }] } }),
  JSON.stringify({ type: 'user', uuid: 'u4', timestamp: at(5), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: 'nope' }] } }),
  JSON.stringify({ type: 'assistant', uuid: 'a2', timestamp: at(6), message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 3, output_tokens: 7 }, content: [{ type: 'tool_use', id: 'tu2', name: 'Read', input: { file_path: '/x.ts' } }] } }),
  JSON.stringify({ type: 'user', uuid: 'u5', timestamp: at(7), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'ok' }] } }),
  JSON.stringify({ type: 'ai-title', aiTitle: 'Reconnect bug', sessionId: S }),
  JSON.stringify({ type: 'last-prompt', lastPrompt: 'a later prompt', sessionId: S }),
  '{"type":"assistant","uuid":"broken',
  JSON.stringify({ type: 'assistant', uuid: 'a3', timestamp: at(9), error: 'rate_limit', isApiErrorMessage: true, apiErrorStatus: 429, message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit · resets 6pm (UTC)" }] } }),
  JSON.stringify({ type: 'session-summary', summary: 'Fixed the reconnect bug.', tags: ['Broker', ' reconnect ', 7], model: 'haiku', fromEventTs: at(1), toEventTs: at(9), timestamp: at(10) }),
  JSON.stringify({ type: 'ai-title', aiTitle: 'Reconnect bug, fixed', sessionId: S }),
  JSON.stringify({ type: 'assistant', uuid: 'a1', timestamp: at(4), message: { model: 'claude-opus-4-1', usage: { input_tokens: 10, output_tokens: 20 } } }),
  JSON.stringify({ type: 'system', uuid: 'sys2', timestamp: at(11), cwd: '/elsewhere' }),
  JSON.stringify({ type: 'assistant', uuid: 'a4', timestamp: at(12), message: { model: 'claude-opus-4-1', usage: { input_tokens: 50000, output_tokens: 1, cache_read_input_tokens: 2 }, content: [{ type: 'tool_use', id: 'tu3', name: 'Bash', input: { command: 'npm test' } }] } }),
];

/** Every ingest-maintained table, in primary-key order, minus raw_jsonl. */
export function dump(raw: Database.Database): Record<string, unknown[]> {
  const q = (sqlText: string): unknown[] => raw.prepare(sqlText).all();
  return {
    events: q(`SELECT id, session_id, workspace_id, ts, type, subtype, uuid, parent_uuid, model, input_tokens, output_tokens,
                      cache_read_input_tokens, cache_creation_input_tokens, service_tier, tool_name, tool_use_id, tool_input,
                      tool_result_is_error, dedup_key FROM events ORDER BY id`),
    sessions: q(`SELECT * FROM sessions ORDER BY id`),
    session_costs: q(`SELECT * FROM session_costs ORDER BY session_id, workspace_id, model, service_tier`),
    session_stats: q(`SELECT * FROM session_stats ORDER BY session_id`),
    session_tool_counts: q(`SELECT * FROM session_tool_counts ORDER BY session_id, tool_name`),
    session_summaries: q(`SELECT * FROM session_summaries ORDER BY id`),
    session_tags: q(`SELECT * FROM session_tags ORDER BY session_id, tag`),
    usage_anchors: q(`SELECT * FROM usage_anchors ORDER BY id`),
  };
}

let dir: string;
let raw: Database.Database;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cf-ingest-batch-'));
  raw = db.openDb(dir);
});
afterEach(async () => {
  await db.closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe('ingest characterization (recorded on the pre-port code)', () => {
  it('line-by-line ingest of the fixture produces the recorded state', async () => {
    const results = [];
    for (const line of FIXTURE) results.push(await db.ingestLine(WS, S, line));
    expect(results).toMatchSnapshot('results');
    expect(dump(raw)).toMatchSnapshot('state');
  });

  it('a trailing ts-less line nulls last_active_at (pre-existing MAX(…, NULL) rule, preserved)', async () => {
    for (const line of FIXTURE) await db.ingestLine(WS, S, line);
    await db.ingestLine(WS, S, JSON.stringify({ type: 'ai-title', aiTitle: 'light', sessionId: S }));
    expect(raw.prepare('SELECT started_at, last_active_at FROM sessions WHERE id = ?').get(S)).toMatchSnapshot();
  });
});
```

- [ ] **Step 4: Record the snapshot on the pre-port code**

Run: `npx vitest run src/main/dbIngestBatch.test.ts`
Expected: PASS with `Snapshots 3 written`. This is the only time this snapshot is ever written.

Run it again with `CI=true npx vitest run src/main/dbIngestBatch.test.ts`.
Expected: PASS, `3 passed` snapshots. With `CI=true`, vitest refuses to write snapshots. Use it for every later run of this file.

Check the snapshot pins the details it exists for:

```bash
/usr/bin/grep -c '"id":' src/main/__snapshots__/dbIngestBatch.test.ts.snap        # event ids are pinned
/usr/bin/grep -A3 'trailing ts-less' src/main/__snapshots__/dbIngestBatch.test.ts.snap   # "last_active_at": null
```

- [ ] **Step 5: Full suite and commit**

Run: `npx vitest run src && npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json`
Expected: all PASS, bench skipped.

```bash
git add src/main/state/stateBench.test.ts src/main/dbIngestBatch.test.ts src/main/__snapshots__/dbIngestBatch.test.ts.snap
git commit -m "test(state): hot-path bench + ingest characterization snapshot (async store 2a)

Baseline on this container (median of 5): $(tr -d '\n ' < /tmp/bench-baseline.json)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git rev-parse HEAD > /tmp/async-store-p2a-base.sha   # the perf gate's baseline commit (Task 8)
```

---

### Task 2: The Kysely handle on `state.db`, statement cache, async `closeDb`

**Files:**
- Modify: `src/main/store/kysely.ts` (statement cache option; `chunked` if #473 hasn't merged)
- Modify: `src/main/store/kysely.test.ts`
- Create: `src/main/store/stateSchema.ts`
- Modify: `src/main/db.ts` (imports, module state, `openDb`, `closeDb`, `stateKysely`, `kyselyOrThrow`)
- Create: `src/main/dbStore.test.ts`
- Modify: `src/main/index.ts` (`await closeDb()`)
- Modify (test conversion, `--fns closeDb`): every `src/main/*.test.ts` that calls `closeDb(`

**Interfaces:**
- Produces:
  - `sqliteKysely<DB>(raw, opts?: { statementCache?: number }): Kysely<DB>`
  - `chunked<T>(items, size = 500): T[][]`
  - `type StateDb` and the table interfaces
  - `stateKysely(): Kysely<StateDb>`
  - `closeDb(): Promise<void>`. It waits for the connection mutex, then closes.
  - `openDb(dir): Database.Database` is unchanged: same signature, still returns the raw handle.
  - Internal `kyselyOrThrow()`, used by every later task.

- [ ] **Step 1: Write the failing tests**

Append to `src/main/store/kysely.test.ts`. It already imports `Database`, `sqliteKysely`, and declares `interface T { t: { v: number } }`:

```ts
describe('sqliteKysely statementCache', () => {
  function counting() {
    const raw = new Database(':memory:');
    raw.exec('CREATE TABLE t (v INTEGER NOT NULL)');
    let prepares = 0;
    const orig = raw.prepare.bind(raw);
    raw.prepare = ((sqlText: string) => { prepares++; return orig(sqlText); }) as typeof raw.prepare;
    return { raw, prepares: () => prepares };
  }

  it('reuses one prepared statement per distinct SQL text', async () => {
    const { raw, prepares } = counting();
    const k = sqliteKysely<T>(raw, { statementCache: 8 });
    for (let i = 0; i < 5; i++) await k.insertInto('t').values({ v: i }).execute();
    expect(prepares()).toBe(1);
    expect(await k.selectFrom('t').select('v').orderBy('v').execute()).toEqual([0, 1, 2, 3, 4].map((v) => ({ v })));
    expect(prepares()).toBe(2);
    await k.destroy();
  });

  it('is off by default (inbox.db keeps preparing per query)', async () => {
    const { raw, prepares } = counting();
    const k = sqliteKysely<T>(raw);
    for (let i = 0; i < 3; i++) await k.insertInto('t').values({ v: i }).execute();
    expect(prepares()).toBe(3);
    await k.destroy();
  });

  it('clears when full instead of growing', async () => {
    const { raw, prepares } = counting();
    const k = sqliteKysely<T>(raw, { statementCache: 2 });
    await k.selectFrom('t').select('v').where('v', '=', 1).execute();
    await k.selectFrom('t').select('v').where('v', '>', 1).execute();
    await k.selectFrom('t').select('v').where('v', '<', 1).execute(); // evicts all
    await k.selectFrom('t').select('v').where('v', '=', 1).execute(); // re-prepared
    expect(prepares()).toBe(4);
    await k.destroy();
  });

  it('destroy() closes the wrapped connection', async () => {
    const { raw } = counting();
    const k = sqliteKysely<T>(raw, { statementCache: 8 });
    await k.selectFrom('t').selectAll().execute();
    await k.destroy();
    expect(raw.open).toBe(false);
  });
});
```

`src/main/dbStore.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb, stateKysely } from './db.js';

let dir = '';
afterEach(async () => {
  await closeDb();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('state.db Kysely handle', () => {
  it('throws before openDb', () => {
    expect(() => stateKysely()).toThrow(/db not opened/);
  });

  it('shares the raw connection: a Kysely write is visible to raw reads', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cf-dbstore-'));
    const raw = openDb(dir);
    await stateKysely().insertInto('usage_events').values({ ts: 1, workspace_id: 'w', session_id: null, kind: 'resumed', detail: null }).execute();
    expect(raw.prepare('SELECT kind FROM usage_events').all()).toEqual([{ kind: 'resumed' }]);
  });

  it('closeDb waits for an in-flight transaction, then closes the connection', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cf-dbstore-'));
    const raw = openDb(dir);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const tx = stateKysely().transaction().execute(async (trx) => {
      await trx.insertInto('usage_events').values({ ts: 2, workspace_id: 'w', session_id: null, kind: 'resumed', detail: null }).execute();
      await gate;
    });
    await new Promise((r) => setTimeout(r, 10));
    const closing = closeDb();
    expect(() => stateKysely()).toThrow(/db not opened/); // new work is refused at once
    await new Promise((r) => setTimeout(r, 10));
    expect(raw.open).toBe(true); // still open: the transaction holds the mutex
    release();
    await tx;
    await closing;
    expect(raw.open).toBe(false);
    const reopened = openDb(dir);
    expect(reopened.prepare('SELECT COUNT(*) AS n FROM usage_events').get()).toEqual({ n: 1 });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/main/store/kysely.test.ts src/main/dbStore.test.ts`
Expected: FAIL. The `statementCache` tests show `prepares` 5 vs 1. `dbStore.test.ts` fails to import `stateKysely` ("does not provide an export named 'stateKysely'").

- [ ] **Step 3: Implement the statement cache**

Replace `src/main/store/kysely.ts` with:

```ts
// The async store layer's dialect seam (remote-workspaces spec §7 "One store
// layer"). Stores are written once against Kysely; this file is the only place
// that names the SQLite dialect. Part 3 adds the Postgres dialect beside it.
//
// Invariant the stores rely on: Kysely's SQLite driver runs every query on the
// single wrapped connection behind a ConnectionMutex, so Kysely queries and
// transactions on this instance are serialized — every inbox.db query goes
// through this mutex, with no raw better-sqlite3 handle left to bypass it. A
// transaction callback must still await only Kysely queries on its `trx`
// (never the outer `db`/`kysely` handle): an outer-handle query inside a
// transaction would queue behind the mutex the transaction already holds and
// deadlock.
import type Database from 'better-sqlite3';
import { Kysely, SqliteDialect, type SqliteDatabase } from 'kysely';

export interface SqliteKyselyOptions {
  /** Reuse up to this many prepared statements, keyed by SQL text (0 = off,
   *  the default). Kysely's SQLite driver calls `prepare()` for every query;
   *  better-sqlite3 does not cache, so a hot path pays a full SQL compile per
   *  query without this. When the cache is full it is cleared, not LRU'd. */
  statementCache?: number;
}

export function sqliteKysely<DB>(raw: Database.Database, opts: SqliteKyselyOptions = {}): Kysely<DB> {
  const database: SqliteDatabase = opts.statementCache ? cachingDatabase(raw, opts.statementCache) : raw;
  return new Kysely<DB>({ dialect: new SqliteDialect({ database }) });
}

function cachingDatabase(raw: Database.Database, max: number): SqliteDatabase {
  const cache = new Map<string, Database.Statement>();
  return {
    prepare(sqlText: string) {
      let stmt = cache.get(sqlText);
      if (!stmt) {
        stmt = raw.prepare(sqlText);
        if (cache.size >= max) cache.clear();
        cache.set(sqlText, stmt);
      }
      return stmt;
    },
    close() {
      cache.clear();
      if (raw.open) raw.close();
    }
  };
}

/** COUNT/SUM come back as number (SQLite), bigint, or string (Postgres); NULL sums as 0. */
export function num(v: unknown): number {
  if (v === null || v === undefined) return 0;
  return typeof v === 'number' ? v : Number(v);
}

/**
 * Split `items` into chunks of at most `size` (default 500). Used to keep
 * `WHERE col IN (...)` batches under SQLite's default ~999-parameter limit
 * while leaving headroom for other bound parameters in the same query.
 */
export function chunked<T>(items: readonly T[], size = 500): T[][] {
  if (items.length === 0) return [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
```

This is the existing file with the `statementCache` option and `cachingDatabase` added. `num` is unchanged, and `chunked` is identical to #473's. If #473 has already merged, keep its comment text for `chunked`.

- [ ] **Step 4: Add the schema types**

`src/main/store/stateSchema.ts`:

```ts
// Kysely table types for state.db (the JSONL→SQLite cache). Mirrors migrate()
// v1–v14 in db.ts exactly; a migration that changes a table changes it here too.
import type { Generated, Selectable } from 'kysely';

export interface EventsTable {
  id: Generated<number>;
  session_id: string;
  workspace_id: string;
  ts: number | null;
  type: string;
  subtype: string | null;
  uuid: string | null;
  parent_uuid: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  service_tier: string | null;
  tool_name: string | null;
  raw_jsonl: string;
  dedup_key: string;
  tool_use_id: string | null;
  tool_input: string | null;
  tool_result_is_error: number | null;
}
export interface SessionsTable {
  id: string;
  workspace_id: string;
  cwd: string | null;
  started_at: number | null;
  last_active_at: number | null;
  ai_title: string | null;
  first_user_message: string | null;
  user_set_name: string | null;
}
export interface BrokerSessionsTable {
  workspace_id: string;
  broker_session_id: string;
  claude_session_id: string;
  learned_at: number;
  verified: Generated<number>;
  pending_claude_session_id: string | null;
}
export interface ErrorsTable {
  id: Generated<number>;
  ts: number;
  workspace_id: string | null;
  session_id: string | null;
  source: string;
  level: string;
  type: string;
  message: string;
  stack: string | null;
  extra: string | null;
}
export interface EmbeddingsTable {
  id: Generated<number>;
  workspace_id: string;
  session_id: string;
  kind: 'turn' | 'summary';
  ref_event_id: number | null;
  ts: number | null;
  text: string;
  model_id: string;
  dim: number;
  vec: Buffer;
  dedup_key: string;
}
export interface SessionSummariesTable {
  id: Generated<number>;
  session_id: string;
  workspace_id: string;
  summary: string;
  tags: string | null;
  source_max_event_id: number;
  from_ts: number | null;
  to_ts: number | null;
  model: string | null;
  generated_at: number;
}
export interface SessionTagsTable { workspace_id: string; session_id: string; tag: string }
export interface UsageEventsTable {
  id: Generated<number>;
  ts: number;
  workspace_id: string;
  session_id: string | null;
  kind: string;
  detail: string | null;
}
export interface UsageAnchorsTable {
  id: Generated<number>;
  ts: number;
  workspace_id: string | null;
  session_id: string | null;
  kind: string;
  http_status: number | null;
  scope: string | null;
  reset_at: number | null;
  window_start: number | null;
  message: string | null;
  rate_limits: string | null;
  dedup_key: string;
}
export interface PerfEventsTable {
  id: Generated<number>;
  ts: number;
  kind: string;
  workspace_id: string | null;
  session_id: string | null;
  name: string | null;
  dur_ms: number | null;
  trace_id: string | null;
  span_id: string | null;
  meta: string | null;
}
/** Key columns hold '' for a NULL model/service_tier (v13). */
export interface SessionCostsTable {
  session_id: string;
  workspace_id: string;
  model: string;
  service_tier: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  event_count: number;
}
export interface SessionStatsTable { session_id: string; max_context_tokens: number }
export interface SessionToolCountsTable { session_id: string; tool_name: string; count: number }

export interface StateDb {
  events: EventsTable;
  sessions: SessionsTable;
  broker_sessions: BrokerSessionsTable;
  errors: ErrorsTable;
  embeddings: EmbeddingsTable;
  session_summaries: SessionSummariesTable;
  session_tags: SessionTagsTable;
  usage_events: UsageEventsTable;
  usage_anchors: UsageAnchorsTable;
  perf_events: PerfEventsTable;
  session_costs: SessionCostsTable;
  session_stats: SessionStatsTable;
  session_tool_counts: SessionToolCountsTable;
}

export type EventRowSel = Selectable<EventsTable>;
export type BrokerSessionRow = Selectable<BrokerSessionsTable>;
```

- [ ] **Step 5: Wire the handle into `db.ts`**

In `src/main/db.ts`, add these lines after `import { syncKeyedCache } from './syncCache.js';`:

```ts
import { sql, type Kysely } from 'kysely';
import { sqliteKysely } from './store/kysely.js';
import type { StateDb } from './store/stateSchema.js';
```

Replace `let db: Database.Database | null = null;` with:

```ts
let db: Database.Database | null = null;
let kdb: Kysely<StateDb> | null = null;
/** Prepared statements kept per state.db connection (see sqliteKysely). */
const STATE_STATEMENT_CACHE = 256;
```

Replace the whole `openDb` and `closeDb` functions (from `export function openDb(` up to the `// Claude session ids that some tab` comment) with:

```ts
export function openDb(userDataDir: string): Database.Database {
  if (db) return db;
  // A reopened DB must never serve the previous database's values.
  summaryCache.clear();
  spendCache.clear();
  const path = join(userDataDir, 'state.db');
  mkdirSync(dirname(path), { recursive: true });
  db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  rehydratePendingClaudeIds(db);
  // Every state.db write goes through this one Kysely handle (its connection
  // mutex serializes them); the raw handle is for migrations above and the
  // not-yet-ported sync reads. The statement cache restores the prepared-
  // statement reuse the old hand-cached `getStmts()` gave the ingest path.
  kdb = sqliteKysely<StateDb>(db, { statementCache: STATE_STATEMENT_CACHE });
  return db;
}

/** Close state.db. Waits for any in-flight query or transaction on the
 *  connection mutex (an ingest chunk, a mapping write) before closing. */
export async function closeDb(): Promise<void> {
  if (!db || !kdb) return;
  const raw = db;
  const k = kdb;
  db = null;
  kdb = null;
  // The prepared-statement cache is bound to the closing handle; drop it so a
  // subsequent openDb() re-prepares against the fresh connection.
  stmts = null;
  pendingClaudeIds.clear();
  summaryCache.clear();
  spendCache.clear();
  // Queues behind whatever holds the mutex; also forces driver init so
  // destroy() really closes the connection.
  await sql`select 1`.execute(k).catch(() => undefined);
  await k.destroy();
  if (raw.open) raw.close();
}

/** The async store handle over state.db. Throws before openDb / after closeDb. */
export function stateKysely(): Kysely<StateDb> {
  return kyselyOrThrow();
}
```

After the existing `openDbOrThrow()` helper (in `// ── Helpers ──`), add:

```ts
function kyselyOrThrow(): Kysely<StateDb> {
  if (!kdb) throw new Error('db not opened — call openDb(userDataDir) first');
  return kdb;
}
```

- [ ] **Step 6: Await `closeDb` at quit**

In `src/main/index.ts` `before-quit`, change `closeDb();` to `await closeDb();`.

- [ ] **Step 7: Convert the tests that call `closeDb`**

```bash
python3 /tmp/conv-async.py --fns closeDb $(/usr/bin/grep -lE "closeDb\(" src/main/*.test.ts)
npx tsc --noEmit -p tsconfig.node.json
```

Fix each `TS1308` by hand. On origin/main the only one is `poison()` in `src/main/db.firstUserMessage.test.ts`. Make it `async function poison(dir: string, sessionId: string, value: string): Promise<void>`, and put `await` on each `poison(` call.

Check: `/usr/bin/grep -nE "^\s+closeDb\(" src/main/*.test.ts`. Expected: no output.

- [ ] **Step 8: Run tests**

Run: `npx vitest run src/main/store/kysely.test.ts src/main/dbStore.test.ts && npx vitest run src && npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json`
Expected: all PASS. `CI=true npx vitest run src/main/dbIngestBatch.test.ts` still PASSes, because nothing in ingest changed.

- [ ] **Step 9: Commit**

```bash
git add src/main/store/kysely.ts src/main/store/kysely.test.ts src/main/store/stateSchema.ts src/main/db.ts src/main/dbStore.test.ts src/main/index.ts src/main/*.test.ts
git commit -m "feat(state): Kysely handle over state.db with a statement cache; async closeDb (async store 2a)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Broker-session mapping writes go async (one transaction per check-then-act)

**Files:**
- Modify: `src/main/db.ts`: `learnBrokerSessionMapping`, `recordBrokerSessionMapping`, and the promote helper. The `claudeSessionIsReal` raw helper stays for the sync reads.
- Modify: `src/main/ipc.ts` (three call sites), `src/main/docker.ts:1049`, `src/main/local.ts` (`onFreshSpawn`), `src/main/mcpServer.ts` (`SessionMappingHandler` type, `report_session_mapping` run)
- Modify (tests): `src/main/db.test.ts`, `src/main/mcpServer.test.ts`

**Interfaces:**
- Consumes: `kyselyOrThrow()`, `StateDb` (Task 2).
- Produces:
  - `learnBrokerSessionMapping(ws, broker, claude): Promise<string | null>`
  - `recordBrokerSessionMapping(ws, broker, claude): Promise<BrokerMappingResult>`
  - Internal helpers taking `q: Kysely<StateDb>`: `claudeSessionIsRealQ`, `existingMappingQ`, `commitMappingQ`, and `promotePendingBrokerMapping(q, ws, claude): Promise<void>`. Task 5's ingest transaction calls `promotePendingBrokerMapping`; Task 6's `recordError` uses `existingMappingQ`.
  - `SessionMappingHandler = (…) => void | Promise<void>`
  - Until Task 5, the sync ingest path keeps the old raw promote under the name `promotePendingBrokerMappingSync(d, ws, claude): void`.

- [ ] **Step 1: Write the failing test**

Append to `src/main/db.test.ts`, inside the `describe('recordBrokerSessionMapping — phantom-safe remaps (#170)'` block:

```ts
  it('concurrent remaps of one tab serialize and leave DB + in-memory pending in agreement', async () => {
    const dir = freshDb();
    try {
      await realSession('ws-a', 'claude-real');
      await learnBrokerSessionMapping('ws-a', 'tab-1', 'claude-real');
      const results = await Promise.all([
        recordBrokerSessionMapping('ws-a', 'tab-1', 'claude-n1'),
        recordBrokerSessionMapping('ws-a', 'tab-1', 'claude-n2'),
      ]);
      expect(results.map((r) => r.mode)).toEqual(['deferred', 'deferred']);
      const db = openDb(dir);
      const { pending_claude_session_id: pending } = db
        .prepare('SELECT pending_claude_session_id FROM broker_sessions WHERE broker_session_id = ?')
        .get('tab-1') as { pending_claude_session_id: string };
      expect(['claude-n1', 'claude-n2']).toContain(pending);
      const loser = pending === 'claude-n1' ? 'claude-n2' : 'claude-n1';
      await realSession('ws-a', loser); // the superseded id must NOT promote
      expect(lookupBrokerSession('ws-a', 'tab-1')).toBe('claude-real');
      await realSession('ws-a', pending); // the surviving pending id must promote
      expect(lookupBrokerSession('ws-a', 'tab-1')).toBe(pending);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
```

`realSession` is still synchronous in this task. `await` on it is harmless, and Task 5 makes it async.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/main/db.test.ts -t "concurrent remaps"`
Expected: it may PASS on the sync code, which is serial by construction. Keep it either way: it is the regression guard that the async version still serializes the two remaps and keeps `pendingClaudeIds` in agreement with the DB. Re-run it after Step 3.

- [ ] **Step 3: Implement the mapping writes**

In `src/main/db.ts`, add `num` to the kysely import (`import { sqliteKysely, num } from './store/kysely.js';`), for Task 5.

Replace the whole block from `/** True once \`claudeSessionId\` has ingested ≥1 transcript line` up to, not including, `/** Resume-grade lookup: returns the claude session id only when the mapping`. On origin/main, that block holds `claudeSessionIsReal`, `learnBrokerSessionMapping`, `BrokerMappingResult`, `recordBrokerSessionMapping` and the raw `promotePendingBrokerMapping(d, …)`. Replace it with:

```ts
/** True once `claudeSessionId` has ingested ≥1 transcript line (a sessions
 *  row exists). A mapping to a session that isn't yet real is a phantom — the
 *  #170 failure mode — so remap policy consults this before committing. */
function claudeSessionIsReal(d: Database.Database, claudeSessionId: string): boolean {
  return (
    d.prepare(`SELECT 1 FROM sessions WHERE id = ?`).get(claudeSessionId) !== undefined
  );
}

/** `claudeSessionIsReal` on a Kysely handle (used inside mapping transactions). */
async function claudeSessionIsRealQ(q: Kysely<StateDb>, claudeSessionId: string): Promise<boolean> {
  const row = await q.selectFrom('sessions').select('id').where('id', '=', claudeSessionId).executeTakeFirst();
  return row !== undefined;
}

async function existingMappingQ(
  q: Kysely<StateDb>,
  workspaceId: string,
  brokerSessionId: string,
): Promise<{ claude_session_id: string; pending_claude_session_id: string | null } | undefined> {
  return q
    .selectFrom('broker_sessions')
    .select(['claude_session_id', 'pending_claude_session_id'])
    .where('workspace_id', '=', workspaceId)
    .where('broker_session_id', '=', brokerSessionId)
    .executeTakeFirst();
}

/** The committing upsert (verified=1, pending cleared). Returns the previously
 *  committed id and the pending id it cleared, if any. */
async function commitMappingQ(
  q: Kysely<StateDb>,
  workspaceId: string,
  brokerSessionId: string,
  claudeSessionId: string,
): Promise<{ previous: string | null; clearedPending: string | null }> {
  const existing = await existingMappingQ(q, workspaceId, brokerSessionId);
  await q
    .insertInto('broker_sessions')
    .values({
      workspace_id: workspaceId,
      broker_session_id: brokerSessionId,
      claude_session_id: claudeSessionId,
      learned_at: Date.now(),
      verified: 1,
    })
    .onConflict((oc) =>
      oc.columns(['workspace_id', 'broker_session_id']).doUpdateSet((eb) => ({
        claude_session_id: eb.ref('excluded.claude_session_id'),
        learned_at: eb.ref('excluded.learned_at'),
        verified: 1,
        pending_claude_session_id: null,
      })),
    )
    .execute();
  return {
    previous: existing?.claude_session_id ?? null,
    clearedPending: existing?.pending_claude_session_id ?? null,
  };
}

/** Persist a (workspace, broker_session) → claude_session mapping, unconditionally
 *  and immediately (verified=1). Clears any parked pending remap for the tab —
 *  a direct commit is authoritative. Returns the claude_session_id that was
 *  previously committed (null on first learn) so callers can log a remap — an
 *  overwrite with a DIFFERENT claude id is the #195 cross-wiring event and must
 *  never happen silently.
 *
 *  This is the low-level commit. Callers reacting to a SessionStart-hook /
 *  CREATE signal should prefer `recordBrokerSessionMapping`, which parks a remap
 *  onto a not-yet-real session instead of black-holing the tab (#170).
 *
 *  `pendingClaudeIds` is mutated inside the transaction after its last await
 *  (so the next ingest transaction sees it) and restored if the commit fails. */
export async function learnBrokerSessionMapping(
  workspaceId: string,
  brokerSessionId: string,
  claudeSessionId: string,
): Promise<string | null> {
  const k = kyselyOrThrow();
  let cleared: string | null = null;
  try {
    return await k.transaction().execute(async (trx) => {
      const r = await commitMappingQ(trx, workspaceId, brokerSessionId, claudeSessionId);
      if (r.clearedPending) {
        pendingClaudeIds.delete(pendingKey(workspaceId, r.clearedPending));
        cleared = r.clearedPending;
      }
      return r.previous;
    });
  } catch (err) {
    if (cleared) pendingClaudeIds.add(pendingKey(workspaceId, cleared));
    throw err;
  }
}

/** Outcome of a `recordBrokerSessionMapping` call. `committed` — the mapping is
 *  live now. `deferred` — the tab already points at a real conversation and the
 *  new id has no transcript yet, so it's parked pending and will be promoted
 *  when it produces its first line (#170). `previous` is the id that was
 *  committed before the call, for remap logging. */
export interface BrokerMappingResult {
  mode: 'committed' | 'deferred';
  previous: string | null;
}

/** Signal-driven remap (SessionStart hook / CREATE). Commits immediately when
 *  it's safe: a fresh tab (nothing to lose), a new id that's already real, or a
 *  currently-committed id that's itself a phantom (a broken mapping must never
 *  win). Otherwise — the tab holds a real conversation and the new id hasn't
 *  written a transcript yet — the remap is parked pending so a would-be phantom
 *  (an abandoned `/clear` session) can't black-hole the tab.
 *
 *  The whole check-then-act is ONE transaction (the connection mutex makes it
 *  atomic against ingest); `pendingClaudeIds` changes happen inside it after
 *  its last await and are undone if the transaction rejects. */
export async function recordBrokerSessionMapping(
  workspaceId: string,
  brokerSessionId: string,
  claudeSessionId: string,
): Promise<BrokerMappingResult> {
  const k = kyselyOrThrow();
  const added: string[] = [];
  const removed: string[] = [];
  try {
    return await k.transaction().execute(async (trx): Promise<BrokerMappingResult> => {
      const existing = await existingMappingQ(trx, workspaceId, brokerSessionId);
      const previous = existing?.claude_session_id ?? null;
      const committedReal = previous != null && (await claudeSessionIsRealQ(trx, previous));
      const newReal = await claudeSessionIsRealQ(trx, claudeSessionId);

      if (previous === claudeSessionId || !committedReal || newReal) {
        const r = await commitMappingQ(trx, workspaceId, brokerSessionId, claudeSessionId);
        if (r.clearedPending) {
          pendingClaudeIds.delete(pendingKey(workspaceId, r.clearedPending));
          removed.push(r.clearedPending);
        }
        return { mode: 'committed', previous };
      }

      // Park it. Replace any earlier pending (a rapid second /clear supersedes
      // the first) and keep the committed real mapping live until this one
      // materializes.
      await trx
        .updateTable('broker_sessions')
        .set({ pending_claude_session_id: claudeSessionId })
        .where('workspace_id', '=', workspaceId)
        .where('broker_session_id', '=', brokerSessionId)
        .execute();
      if (existing?.pending_claude_session_id && existing.pending_claude_session_id !== claudeSessionId) {
        pendingClaudeIds.delete(pendingKey(workspaceId, existing.pending_claude_session_id));
        removed.push(existing.pending_claude_session_id);
      }
      pendingClaudeIds.add(pendingKey(workspaceId, claudeSessionId));
      added.push(claudeSessionId);
      return { mode: 'deferred', previous };
    });
  } catch (err) {
    for (const id of added) pendingClaudeIds.delete(pendingKey(workspaceId, id));
    for (const id of removed) pendingClaudeIds.add(pendingKey(workspaceId, id));
    throw err;
  }
}

/** Promote a parked remap now that `claudeSessionId` has a transcript row:
 *  make it the committed mapping for whichever tab was waiting on it. Called
 *  from the ingest transaction behind the `pendingClaudeIds` guard; the caller
 *  updates the guard set. */
async function promotePendingBrokerMapping(
  q: Kysely<StateDb>,
  workspaceId: string,
  claudeSessionId: string,
): Promise<void> {
  await q
    .updateTable('broker_sessions')
    .set({
      // = pending_claude_session_id: the WHERE pins it to claudeSessionId.
      claude_session_id: claudeSessionId,
      pending_claude_session_id: null,
      learned_at: Date.now(),
      verified: 1,
    })
    .where('workspace_id', '=', workspaceId)
    .where('pending_claude_session_id', '=', claudeSessionId)
    .execute();
}

/** The pre-async promotion, kept only for the still-synchronous ingestLine
 *  until Task 5 ports ingest (then deleted). */
function promotePendingBrokerMappingSync(
  d: Database.Database,
  workspaceId: string,
  claudeSessionId: string,
): void {
  d.prepare(`
    UPDATE broker_sessions
    SET claude_session_id = pending_claude_session_id,
        pending_claude_session_id = NULL,
        learned_at = ?,
        verified = 1
    WHERE workspace_id = ? AND pending_claude_session_id = ?
  `).run(Date.now(), workspaceId, claudeSessionId);
  pendingClaudeIds.delete(pendingKey(workspaceId, claudeSessionId));
}
```

In `ingestLine`, change the one call `promotePendingBrokerMapping(d, workspaceId, sessionId);` to `promotePendingBrokerMappingSync(d, workspaceId, sessionId);`.

- [ ] **Step 4: Convert the tests**

```bash
python3 /tmp/conv-async.py --fns learnBrokerSessionMapping,recordBrokerSessionMapping src/main/db.test.ts
npx tsc --noEmit -p tsconfig.node.json
```

`realSession` calls `ingestLine`, which is still sync, so leave it alone in this task. Task 5 converts it.

In `src/main/mcpServer.test.ts` (`describe('report_session_mapping (#207)'`):

```ts
    setSessionMappingHandler((c, b, s) => { calls.push([c, b, s]); });
    await tool('report_session_mapping').run({} as never, { brokerSessionId: 'tab-1', sessionId: 'uuid-9' }, ctxA);
```

and

```ts
    await expect(tool('report_session_mapping').run({} as never, { brokerSessionId: 'x' }, ctxA)).rejects.toThrow(/required/);
```

Make both `it` callbacks `async`.

- [ ] **Step 5: Update the callers**

`src/main/mcpServer.ts`:

```ts
export type SessionMappingHandler = (callerId: string, brokerSessionId: string, sessionId: string) => void | Promise<void>;
```

In the `report_session_mapping` tool, change `run: (_db, a, ctx) => {` to `run: async (_db, a, ctx) => {`, and `sessionMappingHandler(ctx.callerId, a.brokerSessionId, a.sessionId);` to `await sessionMappingHandler(ctx.callerId, a.brokerSessionId, a.sessionId);`.

`src/main/docker.ts`, line ~1049:

```ts
    const { mode, previous } = await recordBrokerSessionMapping(workspaceId, sessionId, claudeSessionId);
```

`src/main/ipc.ts`:
- In `hostSpawnFresh`, inside the existing `try`: `await recordBrokerSessionMapping(workspaceId, sessionId, claudeSessionId);`
- In `setSessionMappingHandler(...)`: `setSessionMappingHandler(async (callerId, brokerSessionId, claudeSessionId) => {` and `const { mode, previous } = await recordBrokerSessionMapping(callerId, brokerSessionId, claudeSessionId);`
- The watcher `'new-session'` listener stays a synchronous listener. Replace everything from `const previous = learnBrokerSessionMapping(` through the closing `learnMirrorMapping(workspaceId, brokerSessionId, claudeSessionId);` with:

```ts
      // Propagate any pending per-session mirror override onto the claude id —
      // synchronously, before this file's first batch reads the mirror policy.
      learnMirrorMapping(workspaceId, brokerSessionId, claudeSessionId);
      void (async () => {
        const previous = await learnBrokerSessionMapping(workspaceId, brokerSessionId, claudeSessionId);
        // Every learn leaves a trace; the two warn cases are the #195 evidence
        // trail — a FIFO consume that had to guess between tabs, and a mapping
        // silently flipping to a different claude session.
        if (queued.length > 1) {
          logError({
            source: 'main',
            type: 'mapping-ambiguous-consume',
            level: 'warn',
            message: `paired ${claudeSessionId} with broker ${brokerSessionId} by FIFO with ${queued.length} tabs pending — pairing is a guess`,
            workspaceId,
            extra: { claudeSessionId, consumed: brokerSessionId, queued }
          });
        } else {
          logError({
            source: 'main',
            type: 'mapping-learned',
            level: 'info',
            message: `paired ${claudeSessionId} with broker ${brokerSessionId}`,
            workspaceId,
            extra: { claudeSessionId, consumed: brokerSessionId }
          });
        }
        if (previous && previous !== claudeSessionId) {
          logError({
            source: 'main',
            type: 'mapping-remapped',
            level: 'warn',
            message: `broker ${brokerSessionId} remapped ${previous} → ${claudeSessionId}; a tab Refresh will now resume a different conversation`,
            workspaceId,
            extra: { brokerSessionId, from: previous, to: claudeSessionId }
          });
        }
      })().catch((e: unknown) =>
        logError({
          source: 'main',
          type: 'mapping-learn-failed',
          level: 'warn',
          message: `could not record ${brokerSessionId} → ${claudeSessionId}: ${e instanceof Error ? e.message : String(e)}`,
          workspaceId
        })
      );
```

`src/main/local.ts`: `onFreshSpawn` is a synchronous spawn callback. Replace the whole `onFreshSpawn: (claudeSessionId) => { … },` property with the code below. It keeps the same three log branches. `recordUsageEvent` is still sync here and Task 6 awaits it:

```ts
    onFreshSpawn: (claudeSessionId) => {
      // The spawn callback is synchronous; the mapping write is async. The
      // mirror mapping is in-memory and set first, before any transcript line
      // can be read; the DB write lands within this turn (no I/O inside it).
      learnMirrorMapping(id, sessionId, claudeSessionId);
      void (async () => {
        const { mode, previous } = await recordBrokerSessionMapping(id, sessionId, claudeSessionId);
        if (mode === 'deferred') {
          // Re-spawn of a tab that still holds a real conversation onto a fresh
          // (not-yet-written) id — parked until it produces a transcript so an
          // unused session can't black-hole the tab (#170).
          logError({
            source: 'main',
            type: 'mapping-deferred',
            level: 'info',
            message: `broker ${sessionId} parked → ${claudeSessionId} at local spawn (awaiting transcript; keeping ${previous})`,
            workspaceId: id,
            extra: { brokerSessionId: sessionId, pending: claudeSessionId, keeping: previous }
          });
        } else if (previous && previous !== claudeSessionId) {
          logError({
            source: 'main',
            type: 'mapping-remapped',
            level: 'warn',
            message: `broker ${sessionId} remapped ${previous} → ${claudeSessionId} at local spawn`,
            workspaceId: id,
            extra: { brokerSessionId: sessionId, from: previous, to: claudeSessionId }
          });
        } else if (!previous) {
          logError({
            source: 'main',
            type: 'mapping-learned',
            level: 'info',
            message: `paired ${claudeSessionId} with broker ${sessionId} at local spawn (${resume ? 'resume' : 'session-id'})`,
            workspaceId: id,
            extra: { claudeSessionId, brokerSessionId: sessionId, how: resume ? 'resume' : 'session-id' }
          });
        }
        if (resume) recordUsageEvent({ workspaceId: id, sessionId: resume, kind: 'resumed' });
      })().catch((e: unknown) =>
        logError({
          source: 'main',
          type: 'mapping-learn-failed',
          level: 'warn',
          message: `could not record ${sessionId} → ${claudeSessionId}: ${e instanceof Error ? e.message : String(e)}`,
          workspaceId: id
        })
      );
    },
```

`src/main/local.liveState.test.ts` mocks `recordBrokerSessionMapping` with a sync return. `await` on it works unchanged.

- [ ] **Step 6: Run tests**

Run: `npx vitest run src/main/db.test.ts src/main/mcpServer.test.ts src/main/local.liveState.test.ts && npx vitest run src && npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json`
Expected: all PASS, including `concurrent remaps …` and `CI=true npx vitest run src/main/dbIngestBatch.test.ts`.

Check: `/usr/bin/grep -nE "(learn|record)BrokerSessionMapping\(" src/main/*.ts | /usr/bin/grep -v "await\|function\|test.ts\|^src/main/db.ts"`
Expected: no output. Every production call is awaited.

- [ ] **Step 7: Commit**

```bash
git add src/main/db.ts src/main/ipc.ts src/main/docker.ts src/main/local.ts src/main/mcpServer.ts src/main/db.test.ts src/main/mcpServer.test.ts
git commit -m "feat(state): async broker-session mapping writes, check-then-act in one transaction (async store 2a)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: A keyed serial queue for the watcher; `stop()` drains it

The watcher already chains `process()` per file, but its chain is dropped on unlink and unregister, and `stop()` never waits for it. Once ingest is async (Task 5), the queue is the only thing that keeps a file's batches strictly ordered. This task makes the queue explicit and tested, while ingest is still sync.

**Files:**
- Create: `src/main/state/serialQueue.ts`, `src/main/state/serialQueue.test.ts`
- Modify: `src/main/jsonlWatcher.ts` (`chains` → `queue`, `stop()` drains)

**Interfaces:**
- Produces: `keyedSerialQueue(onError: (key: string, err: unknown) => void): KeyedSerialQueue`, with `enqueue(key, task: () => Promise<void>): Promise<void>` (never rejects), `drain(): Promise<void>`, and `activeKeys(): number`.

- [ ] **Step 1: Write the failing test**

`src/main/state/serialQueue.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { keyedSerialQueue } from './serialQueue.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('keyedSerialQueue', () => {
  it('runs one key strictly in enqueue order, never overlapping', async () => {
    const q = keyedSerialQueue(() => {});
    const log: string[] = [];
    let running = 0;
    const task = (id: number, ms: number) => async () => {
      running++;
      expect(running).toBe(1);
      log.push(`start ${id}`);
      await sleep(ms);
      log.push(`end ${id}`);
      running--;
    };
    await Promise.all([q.enqueue('f', task(1, 15)), q.enqueue('f', task(2, 1)), q.enqueue('f', task(3, 5))]);
    expect(log).toEqual(['start 1', 'end 1', 'start 2', 'end 2', 'start 3', 'end 3']);
  });

  it('runs different keys concurrently', async () => {
    const q = keyedSerialQueue(() => {});
    const log: string[] = [];
    const a = q.enqueue('a', async () => { await sleep(20); log.push('a'); });
    const b = q.enqueue('b', async () => { log.push('b'); });
    await Promise.all([a, b]);
    expect(log).toEqual(['b', 'a']);
  });

  it('reports a rejection and keeps the chain going', async () => {
    const errors: Array<[string, unknown]> = [];
    const q = keyedSerialQueue((key, err) => errors.push([key, err]));
    const log: string[] = [];
    const boom = new Error('boom');
    await Promise.all([
      q.enqueue('f', async () => { throw boom; }),
      q.enqueue('f', async () => { log.push('after'); }),
    ]);
    expect(errors).toEqual([['f', boom]]);
    expect(log).toEqual(['after']);
  });

  it('drain() waits for queued and running tasks under every key', async () => {
    const q = keyedSerialQueue(() => {});
    const done: string[] = [];
    void q.enqueue('a', async () => { await sleep(10); done.push('a1'); });
    void q.enqueue('a', async () => { await sleep(10); done.push('a2'); });
    void q.enqueue('b', async () => { await sleep(5); done.push('b'); });
    await q.drain();
    expect(done.sort()).toEqual(['a1', 'a2', 'b']);
    expect(q.activeKeys()).toBe(0);
  });

  it('drain() also waits for tasks enqueued while draining', async () => {
    const q = keyedSerialQueue(() => {});
    const done: string[] = [];
    void q.enqueue('a', async () => {
      await sleep(5);
      void q.enqueue('b', async () => { await sleep(5); done.push('late'); });
    });
    await q.drain();
    expect(done).toEqual(['late']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/main/state/serialQueue.test.ts`
Expected: FAIL with "Failed to load url ./serialQueue.js".

- [ ] **Step 3: Implement**

`src/main/state/serialQueue.ts`:

```ts
// Keyed serial task queue: tasks under one key run strictly one after another
// in enqueue order; different keys run independently. The JSONL watcher keys
// it by file path so a file's batches can never overlap or reorder (async
// store part 2 — ingest is async now, so the old "the loop can't interleave"
// guarantee has to be explicit).

export interface KeyedSerialQueue {
  /** Run `task` once every task enqueued earlier under `key` has settled. A
   *  rejection goes to `onError` and does not break the chain. The returned
   *  promise settles with the task and never rejects. */
  enqueue(key: string, task: () => Promise<void>): Promise<void>;
  /** Resolves once every task enqueued so far, under any key, has settled. */
  drain(): Promise<void>;
  /** Keys with a queued or running task. */
  activeKeys(): number;
}

export function keyedSerialQueue(onError: (key: string, err: unknown) => void): KeyedSerialQueue {
  const tails = new Map<string, Promise<void>>();
  const inflight = new Set<Promise<void>>();
  return {
    enqueue(key, task) {
      const prev = tails.get(key) ?? Promise.resolve();
      const next = prev.then(task).catch((err: unknown) => {
        onError(key, err);
      });
      tails.set(key, next);
      inflight.add(next);
      void next.finally(() => {
        inflight.delete(next);
        // Self-cleaning: drop the tail only if nothing was chained after it.
        if (tails.get(key) === next) tails.delete(key);
      });
      return next;
    },
    async drain() {
      while (inflight.size > 0) await Promise.all([...inflight]);
    },
    activeKeys() {
      return tails.size;
    }
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/main/state/serialQueue.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Use it in the watcher**

In `src/main/jsonlWatcher.ts`:

Add `import { keyedSerialQueue } from './state/serialQueue.js';` after the `./perf.js` import.

Replace:

```ts
  // Per-file mutex (sequenced via a chained promise) so concurrent
  // add/change events on the same file don't race the byte offset.
  private readonly chains = new Map<string, Promise<void>>();
```

with:

```ts
  // Per-file serial queue: a file's process() runs never overlap and run in
  // event order, so its lines ingest strictly in file order (ingest is async;
  // nothing else serializes it). Tails self-clean when they settle and are
  // NOT dropped on unlink/unregister — a re-added file still waits for its
  // in-flight batch — and stop() drains every queued batch.
  private readonly queue = keyedSerialQueue((path, err) => {
    console.error(`[jsonlWatcher] process failed for ${path}:`, err);
  });
```

Delete every `this.chains.delete(…)` call. There are three: in `unregisterLocalWorkspace`'s file loop, `unregisterWorkspace`, and the `'unlink'` handler. Each deletion leaves `this.files.delete(…)` alone. In `unregisterLocalWorkspace`, the one-liner becomes `if (path === dir || path.startsWith(prefix)) this.files.delete(path);`.

In `stop()`, replace `this.chains.clear();` with nothing, and insert these lines before `this.polledDirs.clear();`:

```ts
    // No new events can arrive now; let every queued batch finish before the
    // caller closes state.db.
    await this.queue.drain();
```

Replace the body of `enqueue`:

```ts
  private enqueue(path: string): void {
    if (extname(path) !== '.jsonl') return;
    void this.queue.enqueue(path, () => this.process(path));
  }
```

Check: `/usr/bin/grep -n "chains" src/main/jsonlWatcher.ts`. Expected: no output.

- [ ] **Step 6: Run the watcher suites**

Run: `npx vitest run src/main/jsonlWatcher*.test.ts src/main/state/serialQueue.test.ts && npx tsc --noEmit -p tsconfig.node.json`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/state/serialQueue.ts src/main/state/serialQueue.test.ts src/main/jsonlWatcher.ts
git commit -m "feat(watcher): explicit per-file serial ingest queue, drained on stop (async store 2a)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Ingest goes async: `ingestBatch`, 500-line transactions, ordered per file

**Files:**
- Create: `src/main/state/ingestParse.ts`, `src/main/state/ingestParse.test.ts`
- Modify: `src/main/db.ts` (the whole `// ── Ingest ──` section, `insertUsageAnchor`, helpers, imports)
- Modify: `src/main/jsonlWatcher.ts` (`readAndIngest`)
- Modify: `src/main/dbIngestBatch.test.ts` (append the `ingestBatch` describe)
- Create: `src/main/jsonlWatcher.ordering.test.ts`
- Modify (mocks): `src/main/jsonlWatcher.polled.test.ts`, `src/main/jsonlWatcherMirror.test.ts`
- Modify (test conversion, `--fns ingestLine,insertUsageAnchor`): `db.firstUserMessage`, `db.ingestAnchor`, `db.planUsage`, `db.test`, `db.usageAnchors`, `dbEmbeddings`, `dbReadCache`, `dbSessionCosts`, `dbSessionStats`, `dbSessionsList`, `dbSummaries`, `transcriptIndex`, `transcriptSearch` (`src/main/<name>.test.ts`)

**Interfaces:**
- Consumes:
  - `promotePendingBrokerMapping(q, ws, claude)` (Task 3)
  - `kyselyOrThrow`, `num`, `StateDb` (Task 2)
  - `keyedSerialQueue` (Task 4)
- Produces:
  - `ingestBatch(ws, sid, rawLines: readonly string[]): Promise<IngestResult[]>`, one result per input line, in order
  - `ingestLine(ws, sid, raw): Promise<IngestResult>`
  - `INGEST_TX_LINES = 500`
  - `insertUsageAnchor(…): Promise<void>`
  - `parseIngestLine(raw): ParsedLine | null`
  - `foldSessionTouch(prev, tss): SessionTouch | undefined`

- [ ] **Step 1: Write the failing tests**

`src/main/state/ingestParse.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { parseIngestLine, foldSessionTouch } from './ingestParse.js';

describe('parseIngestLine', () => {
  it('returns null for a partial / invalid line', () => {
    expect(parseIngestLine('{"type":"assistant","uu')).toBeNull();
  });

  it('keys on uuid when present, else the sha256 of the raw line', () => {
    expect(parseIngestLine(JSON.stringify({ type: 'user', uuid: 'u1' }))?.dedupKey).toBe('u1');
    const light = JSON.stringify({ type: 'ai-title', aiTitle: 't' });
    expect(parseIngestLine(light)?.dedupKey).toBe(createHash('sha256').update(light).digest('hex'));
  });

  it('extracts usage, model and the first tool_use block', () => {
    const p = parseIngestLine(JSON.stringify({
      type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-07-01T00:00:00.000Z',
      message: { model: 'claude-opus-4-1', usage: { input_tokens: 1, output_tokens: 2, service_tier: 'standard' },
        content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'x'.repeat(200) } }] },
    }));
    expect(p?.event).toMatchObject({
      ts: Date.parse('2026-07-01T00:00:00.000Z'), type: 'assistant', uuid: 'a1', parent_uuid: 'u1',
      model: 'claude-opus-4-1', input_tokens: 1, output_tokens: 2, cache_read_input_tokens: null,
      service_tier: 'standard', tool_name: 'Bash', tool_use_id: 'tu1', tool_result_is_error: null,
    });
    expect(p?.event.tool_input).toHaveLength(160); // 159 chars + '…'
  });

  it('extracts a tool_result id and its error flag', () => {
    const p = parseIngestLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true }] } }));
    expect(p?.event).toMatchObject({ tool_name: null, tool_use_id: 'tu1', tool_result_is_error: 1 });
  });
});

describe('foldSessionTouch (the per-line sessions upsert, folded)', () => {
  it('a new row starts at the first line', () => {
    expect(foldSessionTouch(undefined, [5, 9, 7])).toEqual({ started_at: 5, last_active_at: 9 });
  });

  it('keeps an existing started_at and takes the max last_active_at', () => {
    expect(foldSessionTouch({ started_at: 1, last_active_at: 10 }, [4, 12, 11])).toEqual({ started_at: 1, last_active_at: 12 });
  });

  it('fills a NULL started_at from the first non-null ts', () => {
    expect(foldSessionTouch(undefined, [null, null, 3, 8])).toEqual({ started_at: 3, last_active_at: 8 });
  });

  it('a ts-less line nulls last_active_at — SQLite MAX(x, NULL) is NULL (#475, preserved)', () => {
    expect(foldSessionTouch({ started_at: 1, last_active_at: 10 }, [12, null])).toEqual({ started_at: 1, last_active_at: null });
    expect(foldSessionTouch({ started_at: 1, last_active_at: 10 }, [null, 4])).toEqual({ started_at: 1, last_active_at: 4 });
  });

  it('returns undefined only when there is no row and no line', () => {
    expect(foldSessionTouch(undefined, [])).toBeUndefined();
    expect(foldSessionTouch({ started_at: 1, last_active_at: 2 }, [])).toEqual({ started_at: 1, last_active_at: 2 });
  });
});
```

Append to `src/main/dbIngestBatch.test.ts`:

```ts
describe('ingestBatch (async store part 2a)', () => {
  it('one batch produces exactly the line-by-line state and per-line results', async () => {
    const lineResults = [];
    for (const line of FIXTURE) lineResults.push(await db.ingestLine(WS, S, line));
    const lineState = dump(raw);
    await db.closeDb();
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), 'cf-ingest-batch-'));
    raw = db.openDb(dir);
    expect(await db.ingestBatch(WS, S, FIXTURE)).toEqual(lineResults);
    expect(dump(raw)).toEqual(lineState);
  });

  it('returns one result per line, in input order, malformed included', async () => {
    const results = await db.ingestBatch(WS, S, ['{"nope', FIXTURE[3], FIXTURE[3]]);
    expect(results).toEqual([
      { inserted: false, sessionId: S, type: 'malformed' },
      { inserted: true, sessionId: S, type: 'user' },
      { inserted: false, sessionId: S, type: 'user' },
    ]);
  });

  it('splits into INGEST_TX_LINES transactions without changing the outcome', async () => {
    const n = db.INGEST_TX_LINES * 2 + 7;
    const lines = Array.from({ length: n }, (_, i) =>
      JSON.stringify({ type: 'assistant', uuid: `big-${i % (n - 3)}`, timestamp: at(i % 50), message: { model: 'claude-opus-4-1', usage: { input_tokens: 1, output_tokens: 1 } } }),
    );
    const results = await db.ingestBatch(WS, S, lines);
    expect(results).toHaveLength(n);
    expect(results.filter((r) => r.inserted)).toHaveLength(n - 3); // the last 3 replay earlier uuids across a chunk boundary
    expect(raw.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: n - 3 });
    expect(raw.prepare('SELECT event_count FROM session_costs WHERE session_id = ?').get(S)).toEqual({ event_count: n - 3 });
  });

  it('a failing line rolls back its whole chunk and rejects', async () => {
    raw.exec('DROP TABLE session_tags'); // the session-summary line's tag insert will throw
    await expect(db.ingestBatch(WS, S, FIXTURE)).rejects.toThrow(/session_tags/);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 0 });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM session_costs').get()).toEqual({ n: 0 });
  });

  it('promotes a parked remap inside the batch that makes its session real', async () => {
    await db.ingestLine(WS, 'claude-real', FIXTURE[3]);
    await db.learnBrokerSessionMapping(WS, 'tab-1', 'claude-real');
    expect(await db.recordBrokerSessionMapping(WS, 'tab-1', 'claude-next')).toEqual({ mode: 'deferred', previous: 'claude-real' });
    expect(db.lookupBrokerSession(WS, 'tab-1')).toBe('claude-real');
    await db.ingestBatch(WS, 'claude-next', [FIXTURE[4], FIXTURE[6]]);
    expect(db.lookupBrokerSession(WS, 'tab-1')).toBe('claude-next');
    expect(raw.prepare('SELECT pending_claude_session_id FROM broker_sessions').get()).toEqual({ pending_claude_session_id: null });
  });

  it('a remap racing the first batch of its session always ends committed, never stranded', async () => {
    await db.ingestLine(WS, 'claude-real', FIXTURE[3]);
    await db.learnBrokerSessionMapping(WS, 'tab-1', 'claude-real');
    await Promise.all([
      db.recordBrokerSessionMapping(WS, 'tab-1', 'claude-next'),
      db.ingestBatch(WS, 'claude-next', [FIXTURE[4]]),
    ]);
    expect(raw.prepare('SELECT claude_session_id, pending_claude_session_id FROM broker_sessions').get())
      .toEqual({ claude_session_id: 'claude-next', pending_claude_session_id: null });
  });

  it('closeDb waits for an in-flight batch before closing', async () => {
    const pending = db.ingestBatch(WS, S, FIXTURE);
    await db.closeDb();
    await expect(pending).resolves.toHaveLength(FIXTURE.length);
    raw = db.openDb(dir); // afterEach closes it again
    expect(raw.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 15 });
  });
});
```

`src/main/jsonlWatcher.ordering.test.ts`:

```ts
// Ingest ordering (async store part 2a): ingest is async, so the watcher's
// per-file queue is the only thing keeping a file's lines in file order. The
// stub ingestBatch takes a random delay so overlapping batches WOULD reorder
// or double-ingest if the queue ever let two of a file's batches run at once.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let userDataDir = '';
vi.mock('electron', () => ({
  app: {
    getPath: (which: string) => {
      if (which === 'userData' || which === 'home') return userDataDir;
      throw new Error(`unexpected getPath: ${which}`);
    },
  },
}));

const h = vi.hoisted(() => ({
  seen: new Set<string>(),
  order: [] as string[],
  inFlight: new Map<string, number>(),
  maxInFlightPerSession: 0,
  finished: 0,
  maxDelayMs: 15,
}));
vi.mock('./db.js', () => ({
  ingestBatch: async (_ws: string, sessionId: string, raws: string[]) => {
    const n = (h.inFlight.get(sessionId) ?? 0) + 1;
    h.inFlight.set(sessionId, n);
    h.maxInFlightPerSession = Math.max(h.maxInFlightPerSession, n);
    await new Promise((r) => setTimeout(r, Math.random() * h.maxDelayMs));
    const out = raws.map((raw) => {
      const uuid = (JSON.parse(raw) as { uuid: string }).uuid;
      const inserted = !h.seen.has(uuid);
      h.seen.add(uuid);
      if (inserted) h.order.push(uuid);
      return { inserted, sessionId, type: 'user' };
    });
    h.inFlight.set(sessionId, n - 1);
    h.finished++;
    return out;
  },
}));

const { JsonlWatcher } = await import('./jsonlWatcher.js');

const SESSION = '11111111-2222-3333-4444-555555555555';
const line = (uuid: string): string => JSON.stringify({ type: 'user', uuid }) + '\n';
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitUntil(fn: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return;
    await sleep(25);
  }
  throw new Error(`timed out (ingested ${h.order.length} lines in ${h.finished} batches)`);
}

let watcher: InstanceType<typeof JsonlWatcher>;
/** The watcher's add/change handler entry point (private). */
const nudge = (path: string): void => (watcher as unknown as { enqueue(p: string): void }).enqueue(path);
let dir: string;
beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'cf-watch-order-'));
  h.seen.clear();
  h.order.length = 0;
  h.inFlight.clear();
  h.maxInFlightPerSession = 0;
  h.finished = 0;
  h.maxDelayMs = 15;
  dir = join(userDataDir, 'projects', '-home-x');
  mkdirSync(dir, { recursive: true });
  watcher = new JsonlWatcher();
  await watcher.start([]);
  watcher.registerLocalDirForTest('ws-order', dir);
});
afterEach(async () => {
  await watcher.stop();
  await rm(userDataDir, { recursive: true, force: true });
});

describe('JsonlWatcher per-file ingest ordering', () => {
  it('ingests a file appended in many bursts exactly once, in file order', async () => {
    const file = join(dir, `${SESSION}.jsonl`);
    writeFileSync(file, '');
    const expected: string[] = [];
    for (let burst = 0; burst < 25; burst++) {
      let chunk = '';
      for (let i = 0; i < 4; i++) {
        const uuid = `e${burst * 4 + i}`;
        expected.push(uuid);
        chunk += line(uuid);
      }
      appendFileSync(file, chunk);
      // Fire the change ourselves too (chokidar coalesces and throttles its
      // own events, so it can't be relied on to deliver one per burst); this
      // queues work far faster than the slow stub drains it.
      nudge(file);
      await sleep(2);
    }
    nudge(file);
    await waitUntil(() => h.order.length === expected.length);
    expect(h.order).toEqual(expected);
    expect(h.maxInFlightPerSession).toBe(1);
  });

  it('stop() resolves only after every queued batch has finished', async () => {
    h.maxDelayMs = 300; // keep the batch in flight while stop() is called
    writeFileSync(join(dir, `${SESSION}.jsonl`), line('s1') + line('s2'));
    await waitUntil(() => h.inFlight.get(SESSION) === 1);
    await watcher.stop();
    expect(h.inFlight.get(SESSION)).toBe(0);
    expect(h.order).toEqual(['s1', 's2']);
    await watcher.start([]); // afterEach stops it again
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/main/state/ingestParse.test.ts src/main/jsonlWatcher.ordering.test.ts && CI=true npx vitest run src/main/dbIngestBatch.test.ts`
Expected: FAIL. `ingestParse.js` doesn't exist yet. `db.ingestBatch is not a function`. The ordering test times out, because the watcher still calls `ingestLine`, which the mock doesn't provide.

- [ ] **Step 3: Move line parsing into `ingestParse.ts`**

`src/main/state/ingestParse.ts`:

```ts
// Pure JSONL-line → events-row extraction for the state.db ingest path.
// No DB access: db.ts's ingest transaction consumes ParsedLine. Moved verbatim
// out of db.ts (async store part 2) so the extraction is testable on its own.
import { createHash } from 'node:crypto';

export interface ParsedLine {
  /** The parsed JSON object (metadata derivation reads it). */
  parsed: Record<string, unknown>;
  /** `parsed.message` when it is an object, else null. */
  message: Record<string, unknown> | null;
  type: string;
  ts: number | null;
  dedupKey: string;
  /** events columns other than session_id / workspace_id / raw_jsonl. */
  event: {
    ts: number | null;
    type: string;
    subtype: string | null;
    uuid: string | null;
    parent_uuid: string | null;
    model: string | null;
    input_tokens: number | null;
    output_tokens: number | null;
    cache_read_input_tokens: number | null;
    cache_creation_input_tokens: number | null;
    service_tier: string | null;
    tool_name: string | null;
    tool_use_id: string | null;
    tool_input: string | null;
    tool_result_is_error: number | null;
    dedup_key: string;
  };
}

/** Parse one raw JSONL line; null when it is not valid JSON (a partial write). */
export function parseIngestLine(rawLine: string): ParsedLine | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawLine) as Record<string, unknown>;
  } catch {
    return null;
  }
  const type = String(parsed.type ?? 'unknown');
  const uuid = typeof parsed.uuid === 'string' ? parsed.uuid : null;
  const ts = parseTimestamp(parsed.timestamp);
  const dedupKey = uuid ?? hashLine(rawLine);
  const message = (parsed.message ?? null) as Record<string, unknown> | null;
  const usage = (message?.usage ?? null) as Record<string, unknown> | null;
  const tool = extractToolDetail(message);
  return {
    parsed,
    message,
    type,
    ts,
    dedupKey,
    event: {
      ts,
      type,
      subtype: typeof parsed.subtype === 'string' ? parsed.subtype : null,
      uuid,
      parent_uuid: typeof parsed.parentUuid === 'string' ? parsed.parentUuid : null,
      model: typeof message?.model === 'string' ? message.model : null,
      input_tokens: numOrNull(usage?.input_tokens),
      output_tokens: numOrNull(usage?.output_tokens),
      cache_read_input_tokens: numOrNull(usage?.cache_read_input_tokens),
      cache_creation_input_tokens: numOrNull(usage?.cache_creation_input_tokens),
      service_tier: typeof usage?.service_tier === 'string' ? usage.service_tier : null,
      tool_name: tool.name,
      tool_use_id: tool.useId,
      tool_input: tool.input,
      tool_result_is_error: tool.resultIsError,
      dedup_key: dedupKey,
    },
  };
}

function parseTimestamp(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function hashLine(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

interface ToolDetail {
  name: string | null;
  useId: string | null;
  input: string | null;
  resultIsError: number | null;
}

/**
 * Pull tool-call detail from an event's `message.content[]`. An assistant
 * event's first `tool_use` block yields the name, its id, and a short input
 * summary; a user event's `tool_result` block yields the matching
 * `tool_use_id` and whether it errored. Events with neither return all-null.
 */
function extractToolDetail(message: Record<string, unknown> | null): ToolDetail {
  const empty: ToolDetail = { name: null, useId: null, input: null, resultIsError: null };
  if (!message) return empty;
  const content = message.content;
  if (!Array.isArray(content)) return empty;
  for (const block of content as Array<Record<string, unknown>>) {
    if (!block) continue;
    if (block.type === 'tool_use' && typeof block.name === 'string') {
      return {
        name: block.name,
        useId: typeof block.id === 'string' ? block.id : null,
        input: summarizeToolInput(block.input),
        resultIsError: null,
      };
    }
    if (block.type === 'tool_result') {
      return {
        name: null,
        useId: typeof block.tool_use_id === 'string' ? block.tool_use_id : null,
        input: null,
        resultIsError: block.is_error === true ? 1 : 0,
      };
    }
  }
  return empty;
}

/**
 * A compact, human-readable one-liner for a tool's input — prefers the most
 * identifying field (command/path/pattern/url/description), else a truncated
 * JSON dump. Capped so it stays a chip-sized label.
 */
function summarizeToolInput(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  const pick =
    (typeof o.command === 'string' && o.command) ||
    (typeof o.file_path === 'string' && o.file_path) ||
    (typeof o.path === 'string' && o.path) ||
    (typeof o.pattern === 'string' && o.pattern) ||
    (typeof o.url === 'string' && o.url) ||
    (typeof o.description === 'string' && o.description) ||
    '';
  const s = pick || JSON.stringify(o);
  return s.length > 160 ? s.slice(0, 159) + '…' : s;
}

export interface SessionTouch {
  started_at: number | null;
  last_active_at: number | null;
}

/**
 * The per-line sessions upsert the ingest path has always run —
 *   INSERT (started_at, last_active_at) = (ts, ts)
 *   ON CONFLICT: last_active_at = MAX(COALESCE(last_active_at, 0), ts),
 *                started_at     = COALESCE(started_at, ts)
 * — folded over a chunk's parsed lines, so a chunk writes the row once.
 * `prev` is the row before the chunk (undefined = no row yet). SQLite's
 * multi-argument MAX returns NULL when any argument is NULL, so a ts-less
 * (light) line sets last_active_at to NULL; that rule is reproduced exactly
 * here and fixed separately (#475).
 */
export function foldSessionTouch(prev: SessionTouch | undefined, tss: ReadonlyArray<number | null>): SessionTouch | undefined {
  let row = prev ? { ...prev } : undefined;
  for (const ts of tss) {
    if (!row) {
      row = { started_at: ts, last_active_at: ts };
      continue;
    }
    row.last_active_at = ts === null ? null : Math.max(row.last_active_at ?? 0, ts);
    row.started_at = row.started_at ?? ts;
  }
  return row;
}
```

`parseTimestamp`, `numOrNull`, `hashLine`, `extractToolDetail` and `summarizeToolInput` move here verbatim. Delete them from the `// ── Helpers ──` section of `db.ts` (everything from `function parseTimestamp(` to the end of the file), and delete `import { createHash } from 'node:crypto';` from `db.ts`.

- [ ] **Step 4: Replace the ingest section of `db.ts`**

Change the imports:

```ts
import { parseIngestLine, foldSessionTouch, type ParsedLine } from './state/ingestParse.js';
```

(add after the `./store/stateSchema.js` import). The `./store/kysely.js` import is already `{ sqliteKysely, num }` from Task 3.

Replace everything from `// ── Ingest ──` up to (not including) `// ── Queries ──` with:

```ts
// ── Ingest ────────────────────────────────────────────────────────────────

export interface IngestResult {
  inserted: boolean;       // false when the event was a duplicate
  sessionId: string;
  type: string;
}

/** Lines per ingest transaction. One commit per chunk instead of one per line
 *  (the per-line WAL commit dominated ingest cost); between chunks the batch
 *  yields one macrotask so a large re-read (startup, compaction) does not hold
 *  the event loop for the whole file. ~500 lines ≈ 30 ms in-container. */
export const INGEST_TX_LINES = 500;

const yieldMacrotask = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

/**
 * Ingest a batch of JSONL lines from ONE file (so one workspace + session; both
 * derived from the file path on disk — JSONL light events sometimes omit
 * sessionId, so the path is authoritative). Lines are applied strictly in
 * order with the per-line semantics ingest always had — the one difference is
 * that each chunk's sessions-row upserts are folded into one write
 * (foldSessionTouch), which yields the same row. Every `INGEST_TX_LINES` lines
 * are one transaction. Returns one result per input line, in input order
 * (`type: 'malformed'` for unparseable lines).
 *
 * Callers must not run two batches for the same file concurrently — the
 * watcher's per-file queue guarantees that (jsonlWatcher.ts).
 */
export async function ingestBatch(
  workspaceId: string,
  sessionId: string,
  rawLines: readonly string[],
): Promise<IngestResult[]> {
  const results: IngestResult[] = [];
  const key = pendingKey(workspaceId, sessionId);
  for (let start = 0; start < rawLines.length; start += INGEST_TX_LINES) {
    if (start > 0) await yieldMacrotask();
    const k = kyselyOrThrow();
    const chunk = rawLines.slice(start, start + INGEST_TX_LINES);
    let promoted = false;
    let chunkResults: IngestResult[];
    try {
      chunkResults = await k.transaction().execute(async (trx) => {
        const lines = chunk.map((rawLine) => ({ rawLine, p: parseIngestLine(rawLine) }));
        const parsed = lines.flatMap((l) => (l.p ? [l.p] : []));
        if (parsed.length === 0) return lines.map(() => ({ inserted: false, sessionId, type: 'malformed' }));
        // The sessions row is touched once per chunk with the folded result of
        // every line's upsert, and BEFORE the lines so per-line metadata
        // UPDATEs always find the row (as they did when each line upserted it).
        await touchSessionQ(trx, workspaceId, sessionId, parsed.map((p) => p.ts));
        const out: IngestResult[] = [];
        for (const { rawLine, p } of lines) {
          if (!p) {
            // Malformed line — skip silently. JSONL writers occasionally
            // produce partial lines mid-write; the watcher re-reads on the
            // next change.
            out.push({ inserted: false, sessionId, type: 'malformed' });
            continue;
          }
          out.push(await ingestOne(trx, workspaceId, sessionId, rawLine, p));
          // This session now has a transcript row — promote any tab whose
          // remap was parked pending on it (#170). The in-memory guard keeps
          // this off the hot path for almost every chunk (no pending remap).
          if (!promoted && pendingClaudeIds.has(key)) {
            await promotePendingBrokerMapping(trx, workspaceId, sessionId);
            pendingClaudeIds.delete(key); // after this step's last await, inside the tx
            promoted = true;
          }
        }
        return out;
      });
    } catch (err) {
      if (promoted) pendingClaudeIds.add(key); // the promotion rolled back with the chunk
      throw err;
    }
    // Cache invalidation, once per committed chunk: mark this session's
    // summary stale with a 3s grace window (ingest also updates session-row
    // fields like ai_title even on duplicate events); only clear the spend
    // cache when an event row actually landed.
    if (chunkResults.some((r) => r.type !== 'malformed')) summaryCache.markStale(sessionId, SUMMARY_STALE_GRACE_MS);
    if (chunkResults.some((r) => r.inserted)) spendCache.clear();
    results.push(...chunkResults);
  }
  return results;
}

/** Single-line convenience over `ingestBatch` (tests, one-off callers). */
export async function ingestLine(workspaceId: string, sessionId: string, rawLine: string): Promise<IngestResult> {
  const [r] = await ingestBatch(workspaceId, sessionId, [rawLine]);
  return r;
}

/** One parsed line's writes, on the chunk transaction: the event insert
 *  (deduped by ON CONFLICT DO NOTHING), rollups only when it landed, then
 *  per-type metadata — which, as before, runs for duplicates too. The
 *  sessions-row touch is folded per chunk by the caller (touchSessionQ). */
async function ingestOne(
  q: Kysely<StateDb>,
  workspaceId: string,
  sessionId: string,
  rawLine: string,
  p: ParsedLine,
): Promise<IngestResult> {
  const e = p.event;

  // Always attempted, even for a replayed line: an ignored INSERT still
  // advances the AUTOINCREMENT sequence, and event ids must stay exactly what
  // they were before the port (the characterization snapshot pins them).
  const ins = await q
    .insertInto('events')
    .values({ ...e, session_id: sessionId, workspace_id: workspaceId, raw_jsonl: rawLine })
    .onConflict((oc) => oc.doNothing())
    .executeTakeFirst();
  const inserted = num(ins.numInsertedOrUpdatedRows) > 0;

  if (inserted) {
    // Rollups (#383/#390) ride the same transaction as the event insert and
    // run only when the event landed — duplicate replays must not double-count.
    await q
      .insertInto('session_costs')
      .values({
        session_id: sessionId,
        workspace_id: workspaceId,
        model: e.model ?? '',
        service_tier: e.service_tier ?? '',
        input_tokens: e.input_tokens ?? 0,
        output_tokens: e.output_tokens ?? 0,
        cache_read_input_tokens: e.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: e.cache_creation_input_tokens ?? 0,
        event_count: 1,
      })
      .onConflict((oc) =>
        oc.columns(['session_id', 'workspace_id', 'model', 'service_tier']).doUpdateSet((eb) => ({
          input_tokens: eb('session_costs.input_tokens', '+', eb.ref('excluded.input_tokens')),
          output_tokens: eb('session_costs.output_tokens', '+', eb.ref('excluded.output_tokens')),
          cache_read_input_tokens: eb('session_costs.cache_read_input_tokens', '+', eb.ref('excluded.cache_read_input_tokens')),
          cache_creation_input_tokens: eb('session_costs.cache_creation_input_tokens', '+', eb.ref('excluded.cache_creation_input_tokens')),
          event_count: eb('session_costs.event_count', '+', 1),
        })),
      )
      .execute();
    if (e.type === 'assistant') {
      await q
        .insertInto('session_stats')
        .values({
          session_id: sessionId,
          max_context_tokens: (e.input_tokens ?? 0) + (e.cache_read_input_tokens ?? 0) + (e.cache_creation_input_tokens ?? 0),
        })
        .onConflict((oc) =>
          oc.column('session_id').doUpdateSet((eb) => ({
            max_context_tokens: eb
              .case()
              .when('excluded.max_context_tokens', '>', eb.ref('session_stats.max_context_tokens'))
              .then(eb.ref('excluded.max_context_tokens'))
              .else(eb.ref('session_stats.max_context_tokens'))
              .end(),
          })),
        )
        .execute();
    }
    if (e.tool_name != null) {
      await q
        .insertInto('session_tool_counts')
        .values({ session_id: sessionId, tool_name: e.tool_name, count: 1 })
        .onConflict((oc) =>
          oc.columns(['session_id', 'tool_name']).doUpdateSet((eb) => ({
            count: eb('session_tool_counts.count', '+', 1),
          })),
        )
        .execute();
    }
  }

  // Derive per-event metadata into the sessions row.
  const parsed = p.parsed;
  const message = p.message;
  if (p.type === 'system' && typeof parsed.cwd === 'string') {
    await q.updateTable('sessions').set({ cwd: parsed.cwd }).where('id', '=', sessionId).where('cwd', 'is', null).execute();
  } else if (p.type === 'ai-title' && typeof parsed.aiTitle === 'string') {
    await q.updateTable('sessions').set({ ai_title: parsed.aiTitle }).where('id', '=', sessionId).execute();
  } else if (p.type === 'last-prompt' && typeof parsed.lastPrompt === 'string' && !isSyntheticPromptText(parsed.lastPrompt)) {
    await setFirstUserMessage(q, sessionId, parsed.lastPrompt);
  } else if (
    p.type === 'user' &&
    parsed.isMeta !== true &&
    typeof message?.content === 'string' &&
    !isSyntheticPromptText(message.content)
  ) {
    await setFirstUserMessage(q, sessionId, message.content);
  } else if (p.type === 'session-summary' && typeof parsed.summary === 'string') {
    const toEpoch = (v: unknown): number | null => {
      const t = typeof v === 'string' ? Date.parse(v) : NaN;
      return Number.isFinite(t) ? t : null;
    };
    await q
      .insertInto('session_summaries')
      .values({
        session_id: sessionId,
        workspace_id: workspaceId,
        summary: parsed.summary,
        tags: Array.isArray(parsed.tags) ? JSON.stringify(parsed.tags) : null,
        source_max_event_id: await maxEventIdQ(q, sessionId),
        from_ts: toEpoch(parsed.fromEventTs),
        to_ts: toEpoch(parsed.toEventTs),
        model: typeof parsed.model === 'string' ? parsed.model : null,
        generated_at: p.ts ?? Date.now(),
      })
      .onConflict((oc) => oc.doNothing())
      .execute();
    if (Array.isArray(parsed.tags)) {
      for (const tag of parsed.tags) {
        if (typeof tag === 'string' && tag.trim()) {
          await q
            .insertInto('session_tags')
            .values({ workspace_id: workspaceId, session_id: sessionId, tag: tag.trim().toLowerCase() })
            .onConflict((oc) => oc.doNothing())
            .execute();
        }
      }
    }
  }

  // Rate-limit anchors (#plan-usage): the account-wide-true checkpoints.
  // Only on a genuinely-new insert so re-reads after compaction don't re-fire.
  if (inserted) {
    const at = p.ts ?? Date.now();
    const anchor = extractAnchor(parsed, at, p.dedupKey);
    if (anchor) await insertUsageAnchorQ(q, workspaceId, sessionId, at, anchor);
  }

  return { inserted, sessionId, type: p.type };
}

/** Apply `foldSessionTouch` over a chunk's timestamps: one read + one write
 *  instead of one upsert per line. */
async function touchSessionQ(
  q: Kysely<StateDb>,
  workspaceId: string,
  sessionId: string,
  tss: Array<number | null>,
): Promise<void> {
  const prev = await q
    .selectFrom('sessions')
    .select(['started_at', 'last_active_at'])
    .where('id', '=', sessionId)
    .executeTakeFirst();
  const next = foldSessionTouch(prev, tss);
  if (!next) return;
  if (!prev) {
    await q.insertInto('sessions').values({ id: sessionId, workspace_id: workspaceId, ...next }).execute();
  } else if (next.started_at !== prev.started_at || next.last_active_at !== prev.last_active_at) {
    await q.updateTable('sessions').set(next).where('id', '=', sessionId).execute();
  }
}

async function setFirstUserMessage(q: Kysely<StateDb>, sessionId: string, text: string): Promise<void> {
  await q
    .updateTable('sessions')
    .set((eb) => ({ first_user_message: eb.fn.coalesce('first_user_message', eb.val(text)) }))
    .where('id', '=', sessionId)
    .execute();
}

async function maxEventIdQ(q: Kysely<StateDb>, sessionId: string): Promise<number> {
  const row = await q
    .selectFrom('events')
    .select((eb) => eb.fn.coalesce(eb.fn.max('id'), eb.lit(0)).as('m'))
    .where('session_id', '=', sessionId)
    .executeTakeFirstOrThrow();
  return num(row.m);
}
```

This removes `insertEvent`, `upsertSession`, the other statement factories, `IngestEventParams`, `interface Cache`, `stmts`, `getStmts`, and the old sync `ingestLine`.

Then:
- In `closeDb`, delete the two comment lines and `stmts = null;` (added in Task 2). `stmts` no longer exists.
- Delete `promotePendingBrokerMappingSync` (Task 3). Its only caller was the old `ingestLine`.
- Replace `export function insertUsageAnchor(…) { … }` (it called `getStmts(d).insertUsageAnchor.run`) with:

```ts
async function insertUsageAnchorQ(
  q: Kysely<StateDb>,
  workspaceId: string,
  sessionId: string,
  tsMs: number,
  a: import('./usageAnchors.js').AnchorInput
): Promise<void> {
  await q
    .insertInto('usage_anchors')
    .values({
      ts: tsMs,
      workspace_id: workspaceId,
      session_id: sessionId,
      kind: a.kind,
      http_status: a.httpStatus,
      scope: a.scope,
      reset_at: a.resetAt,
      window_start: a.windowStart,
      message: a.message,
      rate_limits: a.rateLimits,
      dedup_key: a.dedupKey,
    })
    .onConflict((oc) => oc.doNothing())
    .execute();
}

export async function insertUsageAnchor(
  workspaceId: string,
  sessionId: string,
  tsMs: number,
  a: import('./usageAnchors.js').AnchorInput
): Promise<void> {
  await insertUsageAnchorQ(kyselyOrThrow(), workspaceId, sessionId, tsMs, a);
}
```

- Keep `export function maxEventId(sessionId)`, the sync read. Tests still use it.

Run: `npx tsc --noEmit -p tsconfig.node.json`
Expected: errors only at `jsonlWatcher.ts` (`'inserted' does not exist on type 'Promise<IngestResult>'`) and in tests. There are none in `db.ts`.

- [ ] **Step 5: Switch the watcher to `ingestBatch`**

In `src/main/jsonlWatcher.ts`:
- Change `import { ingestLine } from './db.js';` to `import { ingestBatch } from './db.js';`.
- Change `import { perfSpan } from './perf.js';` to `import { perfSpanAsync } from './perf.js';`.
- In `readAndIngest`, replace everything from `let insertedCount = 0;` through the end of the `perfSpan(...)` call with:

```ts
    const batch = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    const results = await perfSpanAsync(
      'claude_fleet.ingest',
      () => ingestBatch(state.workspaceId, state.sessionId, batch),
      { workspace_id: state.workspaceId, session_id: state.sessionId, lines: batch.length }
    );
    let insertedCount = 0;
    let mirrorBuf = '';
    results.forEach((result, i) => {
      // Mirror only genuinely-new inserts: the DB dedup key suppresses
      // re-reads after a compaction shrink, so we never double-append and the
      // mirror stays append-only / compaction-proof for free.
      if (!result.inserted) return;
      insertedCount++;
      if (mirrorOn) mirrorBuf += batch[i] + '\n';
    });
```

Also change the file-header comment line `// Re-ingestion is idempotent: db.ingestLine uses uuid …` to `db.ingestBatch`.

- [ ] **Step 6: Update the two db mocks**

`src/main/jsonlWatcher.polled.test.ts`: replace the `vi.mock('./db.js', …)` factory with:

```ts
vi.mock('./db.js', () => ({
  ingestBatch: async (_workspaceId: string, sessionId: string, raws: string[]) =>
    raws.map((raw) => {
      const parsed = JSON.parse(raw) as { uuid?: string };
      const uuid = parsed.uuid ?? raw;
      const inserted = !h.seen.has(uuid);
      h.seen.add(uuid);
      return { inserted, sessionId, type: 'user' };
    }),
}));
```

`src/main/jsonlWatcherMirror.test.ts`: replace its factory with:

```ts
vi.mock('./db.js', () => ({
  ingestBatch: async (_workspaceId: string, sessionId: string, raws: string[]) =>
    raws.map((raw) => {
      const uuid = (JSON.parse(raw) as { uuid: string }).uuid;
      const inserted = !h.seen.has(uuid);
      h.seen.add(uuid);
      return { inserted, sessionId, type: 'user' };
    })
}));
```

In both files, change the comment above the factory from `ingestLine` to `ingestBatch`.

- [ ] **Step 7: Convert the ingest tests**

```bash
cd src/main
python3 /tmp/conv-async.py --fns ingestLine,insertUsageAnchor db.firstUserMessage.test.ts db.ingestAnchor.test.ts db.planUsage.test.ts db.test.ts db.usageAnchors.test.ts dbEmbeddings.test.ts dbReadCache.test.ts dbSessionCosts.test.ts dbSessionStats.test.ts dbSessionsList.test.ts dbSummaries.test.ts transcriptIndex.test.ts transcriptSearch.test.ts
cd ../..
npx tsc --noEmit -p tsconfig.node.json
```

Fix each `TS1308` by hand. On origin/main the one helper is `realSession` in `db.test.ts`. Make it `async function realSession(workspaceId: string, sessionId: string, prompt = 'hello there'): Promise<void>`, then run `sed -i -E 's/^(\s+)realSession\(/\1await realSession(/' src/main/db.test.ts`. Scan the other files for module-level helpers that call `ingestLine` in the same way. The converter awaited the call; tsc points at the helper.

Check: `/usr/bin/grep -nE "^\s+(ingestLine|insertUsageAnchor|realSession)\(" src/main/*.test.ts`. Expected: no output.

- [ ] **Step 8: Run tests**

Run: `CI=true npx vitest run src/main/dbIngestBatch.test.ts src/main/state/ingestParse.test.ts src/main/jsonlWatcher.ordering.test.ts`
Expected: PASS. The characterization snapshot is **unchanged**. A mismatch is a behaviour change in the port; fix the port, never the snapshot.

Run the mutation check on the ordering test, to prove it guards the queue:

```bash
cp src/main/jsonlWatcher.ts /tmp/jw.bak
sed -i 's|    void this.queue.enqueue(path, () => this.process(path));|    void this.process(path).catch(() => undefined);|' src/main/jsonlWatcher.ts
npx vitest run src/main/jsonlWatcher.ordering.test.ts   # Expected: FAIL (maxInFlightPerSession > 1)
cp /tmp/jw.bak src/main/jsonlWatcher.ts
```

Run: `CI=true npx vitest run src && npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json`
Expected: all PASS.

- [ ] **Step 9: Quick perf sanity (the full gate is Task 8)**

Run: `STATE_BENCH=1 STATE_BENCH_OUT=/tmp/bench-t5.json npx vitest run src/main/state/stateBench.test.ts && cat /tmp/bench-t5.json`
Expected: `ingest_fresh_us_per_line` well under half of Task 1's baseline (about 65–80 vs about 280 in-container), and `ingest_replay_us_per_line` lower than baseline (about 20 vs about 37). If replay is *higher* than the baseline, check the statement cache is on (`openDb` passes `statementCache`) and that `touchSessionQ` runs once per chunk, not once per line.

- [ ] **Step 10: Commit**

```bash
git add src/main/state/ingestParse.ts src/main/state/ingestParse.test.ts src/main/db.ts src/main/jsonlWatcher.ts src/main/dbIngestBatch.test.ts src/main/jsonlWatcher.ordering.test.ts src/main/*.test.ts
git commit -m "feat(state): async batched ingest — one transaction per 500-line chunk, strict per-file order (async store 2a)

Characterization snapshot unchanged (event ids included). sessions-row
upserts are folded per chunk; the MAX(x, NULL) last_active_at rule is
preserved deliberately (#475).

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: The remaining writes: usage events, errors, rename/delete, embeddings

**Files:**
- Modify: `src/main/db.ts`: `recordUsageEvent`, `recordError`, `renameSession`, `deleteSession`, `deleteEmbeddingsForOtherModels`, `insertEmbedding`
- Modify: `src/main/ipc.ts` (`sessions:rename`, `sessions:delete`), `src/main/docker.ts:1082`, `src/main/local.ts` (`onFreshSpawn`'s `recordUsageEvent`), `src/main/index.ts` (error sink, stale-model delete), `src/main/mcpServer.ts` (`UsageRecorder`, `recordUsageQuietly`, `mark_useful`), `src/main/transcriptIndex.ts` (three `insertEmbedding` sites)
- Modify (test conversion, `--fns recordUsageEvent,recordError,renameSession,deleteSession,insertEmbedding,deleteEmbeddingsForOtherModels,indexSessionTurns,indexSessionSummaries`): `db.test`, `dbEmbeddings`, `dbReadCache`, `dbSessionCosts`, `dbSessionStats`, `transcriptIndex`, `transcriptSearch`, `mcpServer` (`src/main/<name>.test.ts`)

**Interfaces:**
- Consumes: `existingMappingQ` (Task 3), `kyselyOrThrow`, `num` (Task 2).
- Produces:
  - `recordUsageEvent(e): Promise<void>`
  - `recordError(row): Promise<void>`
  - `renameSession(id, name): Promise<void>`
  - `deleteSession(id): Promise<void>`
  - `deleteEmbeddingsForOtherModels(modelId): Promise<number>`
  - `insertEmbedding(row): Promise<boolean>`
  - `UsageRecorder = (e) => void | Promise<void>`

- [ ] **Step 1: Write the failing tests**

Append to `src/main/db.test.ts` inside `describe('recordError'`:

```ts
  it('keeps exactly the newest ERRORS_RETENTION rows across many inserts (PK-seek prune)', async () => {
    const dir = freshDb();
    try {
      for (let i = 0; i < ERRORS_RETENTION + 25; i++) {
        await recordError({ ts: i, source: 'main', type: 't', message: `m${i}` });
      }
      const db = openDb(dir);
      const r = db.prepare('SELECT COUNT(*) AS n, MIN(ts) AS lo, MAX(ts) AS hi FROM errors').get();
      expect(r).toEqual({ n: ERRORS_RETENTION, lo: 25, hi: ERRORS_RETENTION + 24 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('rejects (never throws synchronously) when the DB is closed — the sink swallows it', async () => {
    await closeDb();
    const p = recordError({ ts: 1, source: 'main', type: 't', message: 'm' });
    await expect(p).rejects.toThrow(/db not opened/);
  });
```

Append to `src/main/dbSessionCosts.test.ts`, at top level. Its module-level `beforeEach` has already opened a fresh DB at `dir`, so `openDb(dir)` returns that handle:

```ts
describe('rename/delete are awaited writes', () => {
  it('deleteSession removes every per-session row in one transaction', async () => {
    const raw = openDb(dir);
    await ingestLine('w', 's-del', JSON.stringify({ type: 'assistant', uuid: 'd1', message: { model: 'claude-opus-4-1', usage: { output_tokens: 3 }, content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] } }));
    await deleteSession('s-del');
    for (const t of ['events', 'session_costs', 'session_stats', 'session_tool_counts', 'sessions']) {
      const col = t === 'sessions' ? 'id' : 'session_id';
      expect(raw.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${col} = 's-del'`).get()).toEqual({ n: 0 });
    }
  });

  it('renameSession resolves after the row is updated', async () => {
    const raw = openDb(dir);
    await ingestLine('w', 's-ren', JSON.stringify({ type: 'user', uuid: 'r1', message: { content: 'hi' } }));
    await renameSession('s-ren', '  Named  ');
    expect(raw.prepare('SELECT user_set_name FROM sessions WHERE id = ?').get('s-ren')).toEqual({ user_set_name: 'Named' });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/main/db.test.ts src/main/dbSessionCosts.test.ts`
Expected: FAIL. The closed-DB `recordError` test throws synchronously instead of returning a rejected promise. The retention and rename/delete tests may already pass on the sync code. They guard the transaction rewrites in Step 3, and must still pass after it.

- [ ] **Step 3: Implement the writes in `db.ts`**

Replace `export function recordUsageEvent(…) { … }` with:

```ts
/** Append-only value signal (#207). Scores are derived at read time (Phase 3). */
export async function recordUsageEvent(e: {
  workspaceId: string;
  sessionId?: string | null;
  kind: 'search-impression' | 'clickthrough' | 'marked-useful' | 'resumed';
  detail?: Record<string, unknown>;
}): Promise<void> {
  await kyselyOrThrow()
    .insertInto('usage_events')
    .values({
      ts: Date.now(),
      workspace_id: e.workspaceId,
      session_id: e.sessionId ?? null,
      kind: e.kind,
      detail: e.detail ? JSON.stringify(e.detail) : null,
    })
    .execute();
}
```

Replace `renameSession` and `deleteSession`, from `/**\n * Set (or clear) the manual name override` up to `// ── Embeddings ──`, with:

```ts
/**
 * Set (or clear) the manual name override for a session. An empty/whitespace
 * name clears it back to NULL so the auto title resurfaces.
 */
export async function renameSession(id: string, name: string): Promise<void> {
  const trimmed = name.trim();
  await kyselyOrThrow()
    .updateTable('sessions')
    .set({ user_set_name: trimmed.length ? trimmed : null })
    .where('id', '=', id)
    .execute();
  summaryCache.invalidate(id);
}

/**
 * Drop a session from the cache entirely: its events, its broker mapping,
 * and the session row. The on-disk JSONL is removed by the caller (IPC
 * layer), which knows the host path. Idempotent.
 */
export async function deleteSession(id: string): Promise<void> {
  await kyselyOrThrow().transaction().execute(async (trx) => {
    await trx.deleteFrom('events').where('session_id', '=', id).execute();
    await trx.deleteFrom('session_costs').where('session_id', '=', id).execute();
    await trx.deleteFrom('session_stats').where('session_id', '=', id).execute();
    await trx.deleteFrom('session_tool_counts').where('session_id', '=', id).execute();
    await trx.deleteFrom('broker_sessions').where('claude_session_id', '=', id).execute();
    await trx.deleteFrom('sessions').where('id', '=', id).execute();
  });
  summaryCache.invalidate(id);
  spendCache.clear();
}
```

Replace `deleteEmbeddingsForOtherModels` and `insertEmbedding`, from `/** Drop embedding rows keyed to any OTHER` up to `export interface UnembeddedTurn`, with:

```ts
/** Drop embedding rows keyed to any OTHER model id. Run before backfill so a
 *  model/dtype change (which re-keys EMBED_MODEL_ID) doesn't leave dead
 *  vectors accumulating under retired keys. Returns rows deleted. */
export async function deleteEmbeddingsForOtherModels(modelId: string): Promise<number> {
  const r = await kyselyOrThrow().deleteFrom('embeddings').where('model_id', '!=', modelId).executeTakeFirst();
  return num(r.numDeletedRows);
}

export async function insertEmbedding(row: EmbeddingInsert): Promise<boolean> {
  const r = await kyselyOrThrow()
    .insertInto('embeddings')
    .values({
      workspace_id: row.workspaceId,
      session_id: row.sessionId,
      kind: row.kind,
      ref_event_id: row.refEventId,
      ts: row.ts,
      text: row.text,
      model_id: row.modelId,
      dim: row.dim,
      vec: row.vec,
      dedup_key: row.dedupKey,
    })
    .onConflict((oc) => oc.doNothing())
    .executeTakeFirst();
  return num(r.numInsertedOrUpdatedRows) > 0;
}
```

Replace `export function recordError(…) { … }`, up to `// ── Helpers ──`, with:

```ts
export async function recordError(row: ErrorRow): Promise<void> {
  // Insert + retention prune are one transaction: one commit per error row.
  await kyselyOrThrow().transaction().execute(async (trx) => {
    // Resolve the claude session UUID: prefer an explicit sessionId; else, if
    // the caller only knew the broker id, best-effort resolve it via the
    // mapping (NULL when unmapped — itself an honest signal).
    let sessionId = row.sessionId ?? null;
    if (!sessionId && row.workspaceId && typeof row.extra?.brokerSessionId === 'string') {
      const m = await existingMappingQ(trx, row.workspaceId, row.extra.brokerSessionId as string);
      sessionId = m?.claude_session_id ?? null;
    }
    await trx
      .insertInto('errors')
      .values({
        ts: row.ts,
        workspace_id: row.workspaceId ?? null,
        session_id: sessionId,
        source: row.source,
        level: row.level ?? 'error',
        type: row.type,
        message: row.message,
        stack: row.stack ?? null,
        extra: row.extra ? JSON.stringify(row.extra) : null,
      })
      .execute();
    // Keep the newest ERRORS_RETENTION rows: delete every id at or below the
    // (ERRORS_RETENTION+1)-th newest. Same rows survive as the old
    // `id NOT IN (SELECT … LIMIT n)`, but it is a PK seek, not a scan of the
    // whole table on every error (≈3× faster at the 2000-row cap).
    await trx
      .deleteFrom('errors')
      .where('id', '<=', (eb) =>
        eb.selectFrom('errors').select('id').orderBy('id', 'desc').limit(1).offset(ERRORS_RETENTION)
      )
      .execute();
  });
}
```

- [ ] **Step 4: Update the callers**

`src/main/ipc.ts`:

```ts
  ipcMain.handle('sessions:rename', async (_e, sessionId: string, name: string) => {
    await renameSession(sessionId, name);
  });
```

In `sessions:delete`, change `deleteSession(sessionId);` to `await deleteSession(sessionId);`. The handler is already async. `setUsageRecorder((e) => recordUsageEvent(e));` stays as written: it now returns the promise.

`src/main/docker.ts`, line ~1082: `if (resumeOf) await recordUsageEvent({ workspaceId, sessionId: resumeOf, kind: 'resumed' });`

`src/main/local.ts`, in `onFreshSpawn`'s IIFE (Task 3): `if (resume) await recordUsageEvent({ workspaceId: id, sessionId: resume, kind: 'resumed' });`

`src/main/index.ts`:

```ts
    const db = openDb(app.getPath('userData'));
    // Wire the crash-safe DB sink so every logError call is also persisted to
    // the errors table (best-effort; a wedged DB must never break crash logging —
    // the write is async now, so its rejection is swallowed here, not in logError).
    setErrorSink((row) => {
      void recordError(row).catch(() => undefined);
    });
```

This replaces the existing `const db = openDb(…)` and `setErrorSink((row) => recordError(row));` lines. `db` stays bound for `new PerfStore(db)` until Task 7.

In the embed backfill:

```ts
          await perfSpanAsync('claude_fleet.index.delete_stale_models', () => deleteEmbeddingsForOtherModels(EMBED_MODEL_ID));
```

`src/main/mcpServer.ts`: change the `UsageRecorder` type's return to `=> void | Promise<void>;`, and add after `let usageRecorder: UsageRecorder | null = null;`:

```ts

/** Fire-and-forget a value signal from a read path: a failed write is logged,
 *  never surfaced to the tool caller. */
function recordUsageQuietly(e: Parameters<UsageRecorder>[0]): void {
  if (!usageRecorder) return;
  void Promise.resolve(usageRecorder(e)).catch((err: unknown) =>
    logError({ source: 'main', level: 'warn', type: 'usage-record-failed', message: String(err), workspaceId: e.workspaceId })
  );
}
```

In `noteSearchResults` and `noteRead`, replace `usageRecorder?.({ … })` with `recordUsageQuietly({ … })`, keeping the same argument objects. In `mark_useful`, change `run: (db, a, ctx) => {` to `run: async (db, a, ctx) => {` and `usageRecorder({` to `await usageRecorder({`.

`src/main/transcriptIndex.ts`:
- Both placeholder `insertEmbedding({ … })` statements become `await insertEmbedding({ … })`.
- Both `X.forEach((p, i) => { const ok = insertEmbedding({ … }); if (ok) total++; });` loops become:

```ts
    for (const [i, p] of prepared.entries()) {
      const ok = await insertEmbedding({
        workspaceId: p.ev.workspaceId, sessionId, kind: 'turn', refEventId: p.ev.id, ts: p.ev.ts,
        text: p.text, modelId: EMBED_MODEL_ID, dim: EMBED_DIM,
        vec: encodeVector(vecs[i]), dedupKey: `t${p.ev.id}`,
      });
      if (ok) total++;
    }
```

and, in `indexSessionSummaries`:

```ts
    for (const [i, p] of pending.entries()) {
      const ok = await insertEmbedding({
        workspaceId: p.workspaceId, sessionId: p.sessionId, kind: 'summary', refEventId: null, ts: p.ts,
        text: p.summary.slice(0, MAX_CHARS), modelId: EMBED_MODEL_ID, dim: EMBED_DIM,
        vec: encodeVector(vecs[i]), dedupKey: String(p.sourceMaxEventId),
      });
      if (ok) total++;
    }
```

`tsc` catches both `forEach` sites: `This condition will always return true since this 'Promise<boolean>' is always defined`.

- [ ] **Step 5: Convert the tests**

```bash
cd src/main
python3 /tmp/conv-async.py --fns recordUsageEvent,recordError,renameSession,deleteSession,insertEmbedding,deleteEmbeddingsForOtherModels,indexSessionTurns,indexSessionSummaries db.test.ts dbEmbeddings.test.ts dbReadCache.test.ts dbSessionCosts.test.ts dbSessionStats.test.ts transcriptIndex.test.ts transcriptSearch.test.ts mcpServer.test.ts
cd ../..
npx tsc --noEmit -p tsconfig.node.json
```

In `src/main/mcpServer.test.ts`:
- Every `setUsageRecorder((e) => events.push(e));` becomes `setUsageRecorder((e) => { events.push(e); });`.
- Every `setUsageRecorder((e) => events.push(e as Record<string, unknown>));` becomes `setUsageRecorder((e) => { events.push(e as Record<string, unknown>); });`. A function returning `number` isn't assignable to `=> void | Promise<void>`.
- `tool('mark_useful').run(db, { sessionId: 'sa', note: … }, ctxA);` gets an `await`.
- `expect(() => tool('mark_useful').run(db, { sessionId: 'sb' }, ctxA)).toThrow(/not found/);` becomes `await expect(tool('mark_useful').run(db, { sessionId: 'sb' }, ctxA)).rejects.toThrow(/not found/);`.

Make the enclosing `it` callbacks `async` if the converter didn't.

Check: `/usr/bin/grep -nE "^\s+(recordUsageEvent|recordError|renameSession|deleteSession|insertEmbedding|deleteEmbeddingsForOtherModels)\(" src/main/*.ts src/main/*.test.ts`
Expected: no output.

- [ ] **Step 6: Run tests**

Run: `CI=true npx vitest run src && npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/db.ts src/main/ipc.ts src/main/docker.ts src/main/local.ts src/main/index.ts src/main/mcpServer.ts src/main/transcriptIndex.ts src/main/*.test.ts
git commit -m "feat(state): async usage/error/rename/delete/embedding writes; PK-seek errors prune (async store 2a)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: `PerfStore` on Kysely; async `getPerfStatus`

**Files:**
- Modify: `src/main/perfStore.ts` (whole file), `src/main/perf.ts` (`getPerfStatus`, `initPerf` prune + flush timer, `shutdownPerf`)
- Modify: `src/main/index.ts` (`new PerfStore(stateKysely())`)
- Modify (tests): `src/main/perfStore.test.ts`, `src/main/perf.test.ts`, `src/main/perfIpc.test.ts`, `src/main/mcpServer.test.ts`

**Interfaces:**
- Consumes: `stateKysely()`, `chunked`, `num` (Task 2).
- Produces:
  - `new PerfStore(db: Kysely<StateDb>)`
  - `flush(): Promise<number>`: serialized, and restores rows on failure
  - `prune(olderThanMs?, now?): Promise<number>`
  - `counts24h(now?): Promise<Record<string, number>>`
  - `getPerfStatus(): Promise<PerfStatus>`

- [ ] **Step 1: Write the failing test**

In `src/main/perfStore.test.ts`, change the import to `import { closeDb, openDb, stateKysely } from './db.js';` and `store = new PerfStore(db);` to `store = new PerfStore(stateKysely());`. Then append inside `describe('PerfStore'`:

```ts
  it('concurrent flushes run one at a time and write every row exactly once', async () => {
    for (let i = 0; i < 250; i++) store.enqueue({ ts: i, kind: 'stall', durMs: 60 });
    const first = store.flush();
    for (let i = 250; i < 300; i++) store.enqueue({ ts: i, kind: 'stall', durMs: 60 });
    const second = store.flush();
    expect(await Promise.all([first, second])).toEqual([250, 50]);
    expect(db.prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT ts) AS d FROM perf_events').get()).toEqual({ n: 300, d: 300 });
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/main/perfStore.test.ts`
Expected: FAIL. A TS/runtime error from `PerfStore(Kysely)`: `this.db.prepare is not a function`.

- [ ] **Step 3: Implement**

Replace `src/main/perfStore.ts` with:

```ts
// Buffered writer for the perf_events table. Producers (span/metric
// exporters, the stall sampler) enqueue rows in memory; a single flush()
// writes them in one transaction so telemetry never adds per-event
// SQLite work to the hot path. perf.ts owns the flush timer.

import type { Kysely } from 'kysely';
import { chunked, num } from './store/kysely.js';
import type { StateDb } from './store/stateSchema.js';

export type PerfKind = 'stall' | 'slow_op' | 'pty_window' | 'input_hop' | 'output_hop' | 'echo_rtt' | 'gc' | 'mem';

export interface PerfRow {
  ts: number;
  kind: PerfKind;
  workspaceId?: string | null;
  sessionId?: string | null;
  name?: string | null;
  durMs?: number | null;
  traceId?: string | null;
  spanId?: string | null;
  meta?: Record<string, unknown> | null;
}

/** Drop-oldest cap: telemetry must never become the memory problem. */
const BUFFER_CAP = 10_000;
const DAY_MS = 24 * 60 * 60 * 1000;
export const RETENTION_MS = 7 * DAY_MS;
/** perf_events has 9 bound columns: 500 rows = 4,500 parameters per INSERT —
 *  under SQLite's 32,766 bound-parameter limit (3.32+, which better-sqlite3
 *  bundles) and Postgres's 65,535. */
const FLUSH_ROWS_PER_INSERT = 500;

export class PerfStore {
  private buf: PerfRow[] = [];
  /** flush() calls run one at a time, in call order. */
  private flushChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly db: Kysely<StateDb>) {}

  enqueue(row: PerfRow): void {
    this.buf.push(row);
    if (this.buf.length > BUFFER_CAP) this.buf.splice(0, this.buf.length - BUFFER_CAP);
  }

  pending(): number {
    return this.buf.length;
  }

  /** Write all buffered rows in one transaction. Resolves to rows written. */
  flush(): Promise<number> {
    const run = this.flushChain.catch(() => undefined).then(() => this.flushNow());
    this.flushChain = run;
    return run;
  }

  private async flushNow(): Promise<number> {
    if (this.buf.length === 0) return 0;
    // Take the buffer synchronously: rows enqueued while the write is in
    // flight land in the fresh buffer for the next flush.
    const rows = this.buf;
    this.buf = [];
    try {
      await this.db.transaction().execute(async (trx) => {
        for (const part of chunked(rows, FLUSH_ROWS_PER_INSERT)) {
          await trx
            .insertInto('perf_events')
            .values(
              part.map((r) => ({
                ts: r.ts,
                kind: r.kind,
                workspace_id: r.workspaceId ?? null,
                session_id: r.sessionId ?? null,
                name: r.name ?? null,
                dur_ms: r.durMs ?? null,
                trace_id: r.traceId ?? null,
                span_id: r.spanId ?? null,
                meta: r.meta ? JSON.stringify(r.meta) : null,
              }))
            )
            .execute();
        }
      });
      return rows.length;
    } catch (err) {
      // Telemetry rows must not vanish silently on a transient DB error —
      // put them back (ahead of anything enqueued mid-flush) and rethrow.
      this.buf = rows.concat(this.buf);
      throw err;
    }
  }

  /** Delete rows older than the retention window. Resolves to rows deleted. */
  async prune(olderThanMs: number = RETENTION_MS, now: number = Date.now()): Promise<number> {
    const r = await this.db.deleteFrom('perf_events').where('ts', '<', now - olderThanMs).executeTakeFirst();
    return num(r.numDeletedRows);
  }

  /** Row counts per kind over the trailing 24 h (perf_status / Settings UI). */
  async counts24h(now: number = Date.now()): Promise<Record<string, number>> {
    const rows = await this.db
      .selectFrom('perf_events')
      .select((eb) => ['kind', eb.fn.countAll().as('n')])
      .where('ts', '>=', now - DAY_MS)
      .groupBy('kind')
      .execute();
    return Object.fromEntries(rows.map((r) => [r.kind, num(r.n)]));
  }
}
```

In `src/main/perf.ts`, replace `getPerfStatus` with:

```ts
export async function getPerfStatus(): Promise<PerfStatus> {
  const r = rt; // captured: a shutdown during the awaits must not swap it under us
  if (!r) throw new Error('perf not initialized');
  await r.store.flush(); // counts include anything still buffered
  const eventCounts = await r.store.counts24h();
  return {
    enabled: r.effective.recording,
    source: r.effective.recordingSource,
    otlp: r.effective.otlp,
    eventCounts,
    sentinel: sentinelStatus()
  };
}
```

In `initPerf`, replace `store.prune(RETENTION_MS);` with:

```ts
  void store.prune(RETENTION_MS).catch((err: unknown) => console.warn('[perf] prune failed:', err));
```

and replace the flush timer body with:

```ts
  rt.flushTimer = setInterval(() => {
    const r = rt;
    if (!r) return;
    // A failed flush keeps its rows buffered (PerfStore) for the next tick.
    void perfSpanAsync('claude_fleet.perf.flush', () => r.store.flush()).catch((err: unknown) =>
      console.warn('[perf] flush failed:', err)
    );
  }, FLUSH_INTERVAL_MS);
```

At the end of `shutdownPerf`, change `r.store.flush();` to `await r.store.flush();`.

`src/main/index.ts`: add `stateKysely` to the `./db.js` import. Change `const db = openDb(app.getPath('userData'));` to `openDb(app.getPath('userData'));` and `new PerfStore(db)` to `new PerfStore(stateKysely())`.

The `getPerfStatus()` callers in `ipc.ts` (three handlers, all async: `getEffectivePerf() ? getPerfStatus() : PERF_STATUS_UNINITIALIZED`) and `mcpServer.ts` (async `run`s) already return the value, so a promise flows through unchanged.

- [ ] **Step 4: Convert the perf tests**

- `src/main/perfStore.test.ts`:
  - Prefix each `store.flush()`, `store.prune(`, `store.counts24h(` with `await`, and make the `it`s async.
  - Replace the `let threwError … expect(threwError).toBe(true);` block in `flush restores the buffer when the transaction throws` with `await expect(store.flush()).rejects.toThrow();`.
- `src/main/perf.test.ts`, `src/main/perfIpc.test.ts`:
  - Add `stateKysely` to the db import, and change `new PerfStore(db)` to `new PerfStore(stateKysely())`.
  - `const s = getPerfStatus();` becomes `const s = await getPerfStatus();` (two sites).
  - `expect(() => getPerfStatus()).toThrow(/init/i);` becomes `await expect(getPerfStatus()).rejects.toThrow(/init/i);`.
  - `store.flush(); // rows are buffered …` becomes `await store.flush(); …`.
  - Make each touched `it` async.
- `src/main/mcpServer.test.ts`: in each of the three `perf_status` `beforeEach` blocks, replace `const perfDb = openDb(perfDir);\n      const store = new PerfStore(perfDb);` with `openDb(perfDir);\n      const store = new PerfStore(stateKysely());`, and add `stateKysely` to its db import.

Check: `/usr/bin/grep -nE "store\.(flush|prune|counts24h)\(|getPerfStatus\(\)" src/main/*.test.ts | /usr/bin/grep -v await`
Expected: no output.

- [ ] **Step 5: Run tests**

Run: `CI=true npx vitest run src && npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json`
Expected: all PASS.

Check that no raw-handle write is left in `db.ts`: `/usr/bin/grep -nE "\.run\(|\.exec\(|transaction\(\(" src/main/db.ts`
Expected: hits only inside `migrate()` and `repairSyntheticFirstUserMessages()` (open-time, sync, before the Kysely handle exists).

- [ ] **Step 6: Commit**

```bash
git add src/main/perfStore.ts src/main/perf.ts src/main/index.ts src/main/perfStore.test.ts src/main/perf.test.ts src/main/perfIpc.test.ts src/main/mcpServer.test.ts
git commit -m "feat(perf): PerfStore on the state.db Kysely handle; serialized async flush (async store 2a)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Perf gate, SPEC.md, PR

**Files:**
- Modify: `docs/SPEC.md`

- [ ] **Step 1: Run the A/B perf gate**

This compares the Task 1 commit (pre-port, bench included) with HEAD, alternating three times each in one session:

```bash
BASE_SHA=$(cat /tmp/async-store-p2a-base.sha)
BASE=/tmp/async-store-p2a-base
git -C "$WT" worktree add --detach "$BASE" "$BASE_SHA"
ln -s "$WT/node_modules" "$BASE/node_modules"
for i in 1 2 3; do
  (cd "$BASE" && STATE_BENCH=1 STATE_BENCH_OUT=/tmp/ab-a$i.json npx vitest run src/main/state/stateBench.test.ts >/dev/null)
  (cd "$WT"   && STATE_BENCH=1 STATE_BENCH_OUT=/tmp/ab-b$i.json npx vitest run src/main/state/stateBench.test.ts >/dev/null)
done
cd "$WT"
STATE_BENCH=1 STATE_BENCH_BASELINE=/tmp/ab-a1.json,/tmp/ab-a2.json,/tmp/ab-a3.json \
  STATE_BENCH_CANDIDATE=/tmp/ab-b1.json,/tmp/ab-b2.json,/tmp/ab-b3.json \
  npx vitest run src/main/state/stateBench.test.ts --reporter=verbose 2>&1 | tee /tmp/ab-compare.txt
git -C "$WT" worktree remove --force "$BASE"
```

Expected: PASS. **Acceptance criterion:** each of `ingest_fresh_us_per_line`, `ingest_replay_us_per_line`, `summary_uncached_ms`, `summary_cached_us`, `list_sessions_ms` and `search_ms` is ≤ baseline +10%. Each of `record_mapping_us`, `record_error_us` and `perf_flush_ms` is ≤ baseline +25%.

The prototype of this plan measured, in this container on 2026-11-04 (median of 3 A/B pairs):

| metric | before | after | change |
|---|---|---|---|
| ingest_fresh_us_per_line | 280.7 | 65.6 | −77% |
| ingest_replay_us_per_line | 37.1 | 20.4 | −45% |
| summary_uncached_ms | 2.01 | 1.93 | −4% |
| summary_cached_us | 10.5 | 8.2 | −23% |
| list_sessions_ms | 0.54 | 0.48 | −10% |
| search_ms | 31.4 | 26.9 | −14% |
| record_mapping_us | 130.8 | 108.3 | −17% |
| record_error_us | 144.6 | 120.1 | −17% |
| perf_flush_ms | 12.2 | 13.6 | +11% |

If a metric fails, re-run the whole loop once. Machine noise is large, and it is a regression only if it fails twice. A real regression on a read metric (2a doesn't touch reads) means the statement cache or the shared connection is misconfigured. A regression on ingest means per-line queries crept back in. Batch them per chunk: D3, D4 and the no-N+1 rule.

- [ ] **Step 2: Update SPEC.md**

§4 *Stack*: in the `Store layer | kysely` row, replace `` `state.db` moves next; Postgres is a second dialect of the same queries. `` with:

`` `state.db` writes run on the same layer (`stateKysely()`, `src/main/db.ts`), with a prepared-statement cache (`sqliteKysely(raw, { statementCache: 256 })`) because the SQLite driver prepares every query and better-sqlite3 does not cache; `state.db` reads are still synchronous better-sqlite3 on the same connection until they move too. Postgres is a second dialect of the same queries. ``

§7 *JSONL→SQLite cache*, *Watcher behavior*. Replace the bullet starting `- Per-file byte offsets are kept in memory only.` with:

```markdown
- Per-file byte offsets are kept in memory only. On add/change: read from offset to EOF, find the last `\n`, ingest the complete lines as one batch (`ingestBatch`), and advance the offset past the newline only after the batch resolves. A trailing partial line waits for the next event.
- **Ordering.** Each file has a serial queue (`keyedSerialQueue`, `src/main/state/serialQueue.ts`), so a file's batches never overlap and always apply in file order. The queue tail is not dropped on unlink or unregister: a re-added file waits for its in-flight batch. `stop()` drains every queued batch before `closeDb()` runs.
- **Async write path.** Every `state.db` write goes through one Kysely handle over the connection, whose mutex serializes all writes and transactions:
  - **Ingest:** `ingestBatch` applies `INGEST_TX_LINES` (500) lines per transaction and yields a macrotask between chunks. The per-line semantics are unchanged: deduped event insert; rollups only when it landed; metadata even for duplicates; anchors only for new rows. The per-line sessions upsert is folded once per chunk (`foldSessionTouch`), and reproduces SQLite's `MAX(x, NULL) = NULL` rule (#475).
  - **Mappings:** `recordBrokerSessionMapping` / `learnBrokerSessionMapping` run their check-then-act as one transaction. They mutate the in-memory `pendingClaudeIds` guard inside it, after the last await, and restore it if the transaction rejects. Ingest promotes a parked remap inside its chunk transaction.
  - **Close:** `closeDb()` is async and waits on the mutex before closing.
  - Reads (summaries, lists, cost, lookups, search) are still synchronous on the same connection.
```

§7 *Error log* paragraph (starts `` `logError` is the single write path. ``): after `` `recordError` is a best-effort DB sink registered via `setErrorSink` — a wedged DB never breaks crash logging. `` insert:

`` The sink is async: it inserts the row and prunes to the newest `ERRORS_RETENTION` (2000) in one transaction. The prune is `DELETE … WHERE id <= (SELECT id … ORDER BY id DESC LIMIT 1 OFFSET 2000)`, a PK seek. A rejection is swallowed by the sink. ``

§5 *Perf telemetry*:
- In the *Slow-op spans* bullet, after `` the JSONL ingest batch in `jsonlWatcher.ts` is wrapped as `claude_fleet.ingest` ``, insert ` (wall time of the whole batch, including its inter-chunk yields)`.
- In the *`PerfStore`* paragraph, replace `batch-inserts in one transaction per ~5s flush.` with `batch-inserts in one transaction per ~5s flush (async, on the state.db Kysely handle; flushes are serialized, ≤500 rows per INSERT, and a failed flush restores its rows to the buffer).`

§11 *In-container SQLite access via MCP*: after the bullet `- **Runaway protection**: the read-only connection is the hard write-guard; results are row-capped (1000).`, add:

```markdown
- **Not on the async store layer, by design**: the server keeps its own `{ readonly: true }` better-sqlite3 connection and the per-call in-memory `query` snapshot (ATTACH + copy). Both are SQLite-only, and the snapshot is the isolation mechanism. The connection is separate from the app's write connection and sees only committed WAL frames, so a snapshot never observes half an ingest chunk. Postgres gets its own isolation path (role + RLS) instead of a ported snapshot.
```

Run: `/usr/bin/grep -n "state.db\` moves next" docs/SPEC.md`
Expected: no output.

- [ ] **Step 3: Final verification**

Run: `CI=true npx vitest run src && npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json && npm run build`
Expected: all PASS. If `npm run build` is env-blocked in the container (@xterm addons), say so in the PR. CI builds.

- [ ] **Step 4: Commit, push, PR**

```bash
git add docs/SPEC.md
git commit -m "docs(spec): async state.db write path, ingest ordering, MCP snapshot stays raw (async store 2a)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git push -u origin feat/async-store-p2a
COMPARE=$(sed -n '/STATE_BENCH_COMPARE/,/^\]/p' /tmp/ab-compare.txt | sed '1s/^.*STATE_BENCH_COMPARE //')
BODY=$(cat <<'EOF'
Part 2a of the async store layer (plan: docs/superpowers/plans/2026-11-04-async-store-part2.md).

- Every state.db write is on the async Kysely handle: ingest, mappings, usage events, errors, rename/delete, embeddings, perf. Reads stay sync until 2b.
- Ingest: one transaction per 500-line chunk, with a strict per-file serial queue that stop() drains. The characterization snapshot (recorded pre-port) is unchanged, event ids included.
- MCP read connection + query snapshot unchanged (SQLite-only by design).

Perf gate (A/B, median of 3 pairs, this container; hot paths ≤ +10%, low-frequency writes ≤ +25%):
EOF
)
FOOT=$(cat <<'EOF'
Gate: typecheck (node + web) + unit + build + e2e in CI. No UI change; Troy to eyeball the Sessions list, observability rail, a tab /clear remap, and Settings → perf status on the host.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)
gh pr create --repo ImIOImI/claude-fleet --head feat/async-store-p2a \
  --title "feat(state): async store part 2a — state.db writes on Kysely" \
  --body "$(printf '%s\n\n%s\n\n%s\n' "$BODY" "$COMPARE" "$FOOT")"
```

---

## Self-review notes

- **Spec coverage (part 2a's share of §7 / §11(a)):**
  - Async store interface for every state.db write: Tasks 3, 5, 6, 7.
  - Kysely over the same connection: Task 2.
  - SQLite unchanged: the Task 1 snapshot, re-run in Tasks 2–7.
  - Perf gate with a stated X%: Tasks 1 and 8, D9.
  - Ingest ordering with an explicit queue and tests: Tasks 4 and 5, including a mutation check.
  - MCP snapshot decision: D1, and SPEC §11 in Task 8.
  - Shippable commits: every task ends green, in dependency order, per Global Constraints.
  - Reads and caches, Postgres, pgvector and MCP-on-Postgres are deliberately later (see below).
- **Type consistency:**
  - `promotePendingBrokerMapping(q, ws, claude)` is defined in Task 3 and consumed by Task 5. The sync `promotePendingBrokerMappingSync` lives only from Task 3 to Task 5.
  - `existingMappingQ` comes from Task 3 and is used by `recordError` in Task 6.
  - `num` is imported in Task 3. `chunked` is guaranteed by Task 2 and used by `PerfStore` in Task 7.
  - `stateKysely()` comes from Task 2 and is used by `index.ts` and the perf tests in Task 7, and by the bench (feature-detected).
  - `IngestResult` keeps its shape. `ingestBatch` returns `IngestResult[]` aligned to its input, and `jsonlWatcher.readAndIngest` indexes `batch[i]` against it.
  - `index.ts` keeps `const db = openDb(…)` through Task 6 for `new PerfStore(db)`. Task 7 drops it.

---

## Part 2b outline (written in full when 2a has merged)

**Goal:** move every remaining state.db **read** onto the Kysely handle. The raw handle is then used only by `migrate()` and `repairSyntheticFirstUserMessages()` at open, and by nothing else.

- **Reads become async:** `eventsForSession`, `getSession`, `summaryForWorkspace`/`summaryForSession`/`summaryForBrokerSession` (+ `recentToolCallsForSession`, `costSeriesForSession`, `tokenSeriesForSession`), `tokensSpentSince`, `costForSession`/`costForWorkspace`, `planUsageRows`, `latestAnchorCovering`/`latestLimitHitAnchor`, `listSessions`, the `lookup*BrokerSession` family, `unembeddedTurnEvents`/`unembeddedSummaries`/`maxEventId`, and `PerfStore` is already done. `getDb()` is deleted. `transcriptIndex.searchTranscripts` takes the Kysely handle in the app and keeps its `db` parameter for the MCP caller (raw, D1).
- **Caches:** `syncCache.ts` becomes `asyncKeyedCache`. It keeps `get(key, compute)` with **in-flight de-dupe** (concurrent misses share one promise), `markStale`, `invalidate` and `clear`. An invalidation during an in-flight compute must win, so a generation counter per key drops a stale result. `summaryCache.markStale` from ingest and the `SUMMARY_STALE_GRACE_MS` debounce are unchanged.
- **Callers:** the `observability:*`, `sessions:*`, `plan:usage` and `__test:lookupBrokerSession` IPC handlers in `ipc.ts`; the observability broadcast plus `makeTrailingRebroadcast` (await the summary before sending); `local.ts`'s `lookupResumable` (its `effectiveResumeOf(…, () => string | null)` thunk becomes async); `index.ts`'s backfill `listSessions`; and `planUsage.ts`.
- **No N+1 / perf:**
  - `summaryForSessionUncached` issues 8 queries today. Keep it at ≤ 8 awaited queries with no per-row loops.
  - `listSessions` stays 3 queries.
  - The `EXPLAIN QUERY PLAN` pins in `dbSessionStats.test.ts` and `dbSessionCosts.test.ts` keep pinning the exported SQL strings. Either keep them as `sql` template fragments, or re-pin against the compiled Kysely SQL (`.compile().sql`).
- **Perf gate:** the same bench and A/B procedure, with 2a's merge commit as the baseline. Same tolerances. `summary_uncached_ms`, `summary_cached_us`, `list_sessions_ms` and `search_ms` are the metrics at risk here.
- **SPEC:** §7 *JSONL→SQLite cache* (read caches are async with in-flight de-dupe), and §4 (`state.db` reads on Kysely).

Parts 3–5 (the Postgres dialect + pgvector, the app-managed Postgres + store choice, MCP isolation on Postgres) are unchanged from the outline at the end of `docs/superpowers/plans/2026-11-02-async-store-part1.md`.
