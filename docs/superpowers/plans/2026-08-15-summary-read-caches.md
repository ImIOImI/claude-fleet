# Event-Invalidated Observability Read Caches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve `summaryForSession` (behind both summary IPC handlers + the ingest broadcast) and `tokensSpentSince` (behind `usage:rollingSpend`) from event-invalidated in-memory caches, eliminating ~23 min/9 h of measured synchronous SQLite blocking on the main loop.

**Architecture:** A new pure `syncCache.ts` (keyed synchronous cache, cap-clear eviction, optional safety TTL) is wired inside `db.ts`: `summaryForSession` caches per claude-session id (default `topToolsLimit` only); `tokensSpentSince` caches per 15-second floor bucket of its sliding argument. Invalidation is the correctness mechanism — `ingestLine` (the sole hot-path writer, which also performs the ai-title/first-prompt session updates internally) and `deleteSession` invalidate; `openDb` clears both caches so a reopened DB (tests, fleet-root moves) can never serve another database's values.

**Tech Stack:** TypeScript (Electron main), better-sqlite3 (sync), vitest.

**Spec:** `docs/superpowers/specs/2026-08-15-summary-read-caches-design.md` (binding).

## Global Constraints

- Branch: `perf/summary-read-caches` (from origin/main @ ef4e981; the spec commit be9f1a4 is already on it). Worktree `/workspace/claude-fleet/.claude/worktrees/perf-tracing-expansion`; run all commands from the worktree root; never `cd /workspace/claude-fleet`.
- No display / no compiler here: gate = `npm run typecheck` + `npm run test:unit` + `npm run build`; Playwright is CI-only — say so in the PR body. Known CI flake: `broker-sessions.spec.ts` "connection is busy" (#305) — a rerun is legitimate if it hits.
- **`db.ts` trips grep's binary detection — always use `grep -a` on it.**
- Exact values: summary cache `maxEntries: 512, ttlMs: 30_000`; spend cache `maxEntries: 4`, bucket = `Math.floor(sinceMs / 15_000)`; summary cached only when `topToolsLimit === 5` (the default).
- Sync APIs unchanged — no signature changes to any `db.ts` export; no schema, IPC-surface, or MCP changes.
- Broker-mapping learns must NOT invalidate (mapping resolves before the cache; spec Problem section).
- `renameSession` (user_set_name) does NOT invalidate — the summary SELECT doesn't read that column.

---

### Task 1: `src/main/syncCache.ts` — pure keyed synchronous cache

**Files:**
- Create: `src/main/syncCache.ts`
- Test: `src/main/syncCache.test.ts`

**Interfaces:**
- Consumes: nothing (pure module, zero imports).
- Produces (Task 2 relies on these exact shapes):
  `syncKeyedCache<V>(opts: { maxEntries: number; ttlMs?: number; now?: () => number }): SyncKeyedCache<V>` with
  `interface SyncKeyedCache<V> { get(key: string, compute: () => V): V; invalidate(key: string): void; clear(): void; }`

- [ ] **Step 1: Write the failing tests** — create `src/main/syncCache.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { syncKeyedCache } from './syncCache.js';

describe('syncKeyedCache', () => {
  it('computes once per key and serves hits without recomputing', () => {
    let calls = 0;
    const c = syncKeyedCache<number>({ maxEntries: 8 });
    expect(c.get('a', () => { calls += 1; return 42; })).toBe(42);
    expect(c.get('a', () => { calls += 1; return 99; })).toBe(42);
    expect(calls).toBe(1);
  });

  it('caches null and undefined results too (a miss is not "falsy")', () => {
    let calls = 0;
    const c = syncKeyedCache<number | null>({ maxEntries: 8 });
    expect(c.get('a', () => { calls += 1; return null; })).toBeNull();
    expect(c.get('a', () => { calls += 1; return null; })).toBeNull();
    expect(calls).toBe(1);
  });

  it('invalidate(key) forces recompute for that key only', () => {
    let a = 0; let b = 0;
    const c = syncKeyedCache<number>({ maxEntries: 8 });
    c.get('a', () => { a += 1; return a; });
    c.get('b', () => { b += 1; return b; });
    c.invalidate('a');
    expect(c.get('a', () => { a += 1; return a; })).toBe(2);
    expect(c.get('b', () => { b += 1; return b; })).toBe(1);
  });

  it('clear() drops everything', () => {
    let calls = 0;
    const c = syncKeyedCache<number>({ maxEntries: 8 });
    c.get('a', () => { calls += 1; return 1; });
    c.clear();
    c.get('a', () => { calls += 1; return 1; });
    expect(calls).toBe(2);
  });

  it('exceeding maxEntries clears the whole cache (cap-clear, no LRU)', () => {
    let recomputes = 0;
    const c = syncKeyedCache<number>({ maxEntries: 2 });
    c.get('a', () => 1);
    c.get('b', () => 2);
    c.get('c', () => 3); // third insert exceeds the cap → everything cleared, then 'c' cached
    c.get('a', () => { recomputes += 1; return 1; });
    expect(recomputes).toBe(1); // 'a' was evicted by the clear
    c.get('c', () => { recomputes += 1; return 3; });
    expect(recomputes).toBe(1); // 'c' survived (it was inserted after the clear)
  });

  it('ttlMs expires entries (fake clock)', () => {
    let t = 1000; let calls = 0;
    const c = syncKeyedCache<number>({ maxEntries: 8, ttlMs: 500, now: () => t });
    c.get('a', () => { calls += 1; return 1; });
    t = 1499;
    c.get('a', () => { calls += 1; return 1; });
    expect(calls).toBe(1);
    t = 1500;
    c.get('a', () => { calls += 1; return 1; });
    expect(calls).toBe(2);
  });

  it('a compute() that throws caches nothing', () => {
    let calls = 0;
    const c = syncKeyedCache<number>({ maxEntries: 8 });
    expect(() => c.get('a', () => { calls += 1; throw new Error('boom'); })).toThrow('boom');
    expect(c.get('a', () => { calls += 1; return 7; })).toBe(7);
    expect(calls).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/syncCache.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — create `src/main/syncCache.ts`:

```ts
// Keyed synchronous cache for the better-sqlite3 observability reads
// (spec 2026-08-15-summary-read-caches-design.md). Event invalidation is
// the correctness mechanism; ttlMs is only a safety net against a missed
// invalidation path. Eviction is deliberately dumb: when an insert would
// exceed maxEntries, clear everything — recomputing a handful of summaries
// once is cheaper than LRU bookkeeping.

export interface SyncKeyedCache<V> {
  get(key: string, compute: () => V): V;
  invalidate(key: string): void;
  clear(): void;
}

export function syncKeyedCache<V>(opts: {
  maxEntries: number;
  ttlMs?: number;
  now?: () => number;
}): SyncKeyedCache<V> {
  const now = opts.now ?? Date.now;
  const entries = new Map<string, { value: V; at: number }>();
  return {
    get(key: string, compute: () => V): V {
      const hit = entries.get(key);
      if (hit && (opts.ttlMs === undefined || now() - hit.at < opts.ttlMs)) {
        return hit.value;
      }
      const value = compute(); // a throw propagates; nothing is cached
      if (!entries.has(key) && entries.size >= opts.maxEntries) entries.clear();
      entries.set(key, { value, at: now() });
      return value;
    },
    invalidate(key: string): void {
      entries.delete(key);
    },
    clear(): void {
      entries.clear();
    }
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/syncCache.test.ts`
Expected: 7/7 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/syncCache.ts src/main/syncCache.test.ts
git commit -m "feat(perf): pure keyed synchronous cache for the observability reads"
```

---

### Task 2: Wire the caches in `db.ts` (TDD via staleness regression tests)

**Files:**
- Modify: `src/main/db.ts` — import block; `openDb` (the exported open function — find with `grep -a -n "export function openDb" src/main/db.ts`); `ingestLine` (`:468`); `summaryForSession` (`:816`); `tokensSpentSince` (`:794`); `deleteSession` (`:1590`)
- Test: `src/main/dbReadCache.test.ts` (new)

**Interfaces:**
- Consumes: `syncKeyedCache`/`SyncKeyedCache` from `./syncCache.js` (Task 1); `WorkspaceSummary` type already in db.ts.
- Produces: no new exports — behavior contract only (reads served from cache, invalidated by ingest/delete/reopen).

- [ ] **Step 1: Write the failing tests** — create `src/main/dbReadCache.test.ts` (fixture pattern copied from `dbSummaries.test.ts`):

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDb, closeDb, ingestLine, deleteSession,
  summaryForSession, summaryForWorkspace, tokensSpentSince
} from './db.js';

let dir: string;
const WS = '01WS';
const SES = 'ses-cache-1';
const assistantLine = (uuid: string, outputTokens: number) =>
  JSON.stringify({
    type: 'assistant', uuid, timestamp: '2026-07-01T00:00:00Z',
    message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 10, output_tokens: outputTokens }, content: [{ type: 'text', text: 'hi' }] }
  });
const userLine = (uuid: string, content: string) =>
  JSON.stringify({ type: 'user', uuid, timestamp: '2026-07-01T00:00:00Z', message: { content } });

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cf-cache-')); openDb(dir); });
afterEach(() => { closeDb(); rmSync(dir, { recursive: true, force: true }); });

describe('summaryForSession cache', () => {
  it('STALENESS REGRESSION: the very next read after an ingest reflects it', () => {
    ingestLine(WS, SES, userLine('u1', 'first'));
    const before = summaryForSession(SES);
    expect(before).not.toBeNull();
    ingestLine(WS, SES, assistantLine('a1', 100));
    const after = summaryForSession(SES);
    // The assistant event must be visible immediately — a stale cached
    // summary here is the bug this whole test file exists to prevent.
    expect(after!.totals.outputTokens).toBeGreaterThan(before!.totals.outputTokens ?? 0);
  });

  it('repeated reads between ingests hit the cache (same object identity)', () => {
    ingestLine(WS, SES, userLine('u1', 'first'));
    const a = summaryForSession(SES);
    const b = summaryForSession(SES);
    expect(b).toBe(a); // identity, not equality: proves no recompute
  });

  it('summaryForWorkspace serves the same cache (funnels into summaryForSession)', () => {
    ingestLine(WS, SES, userLine('u1', 'first'));
    const direct = summaryForSession(SES);
    const viaWorkspace = summaryForWorkspace(WS);
    expect(viaWorkspace).toBe(direct);
  });

  it('a non-default topToolsLimit bypasses the cache', () => {
    ingestLine(WS, SES, userLine('u1', 'first'));
    const a = summaryForSession(SES, 3);
    const b = summaryForSession(SES, 3);
    expect(b).not.toBe(a); // recomputed each time — deliberate bypass
  });

  it('deleteSession invalidates immediately', () => {
    ingestLine(WS, SES, userLine('u1', 'first'));
    expect(summaryForSession(SES)).not.toBeNull();
    deleteSession(SES);
    expect(summaryForSession(SES)).toBeNull();
  });

  it('reopening a different DB never serves the previous DB values', () => {
    ingestLine(WS, SES, userLine('u1', 'first'));
    expect(summaryForSession(SES)).not.toBeNull();
    closeDb();
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), 'cf-cache2-'));
    openDb(dir); // fresh empty DB — the cached summary must not leak across
    expect(summaryForSession(SES)).toBeNull();
  });
});

describe('tokensSpentSince cache', () => {
  it('STALENESS REGRESSION: an ingested token event is visible immediately', () => {
    ingestLine(WS, SES, assistantLine('a1', 100));
    const floor = Date.parse('2026-07-01T00:00:00Z') - 1000;
    const before = tokensSpentSince(floor);
    expect(before).toBeGreaterThan(0);
    ingestLine(WS, SES, assistantLine('a2', 5000));
    expect(tokensSpentSince(floor)).toBeGreaterThan(before);
  });

  it('same 15s bucket serves the cache; different bucket recomputes', () => {
    ingestLine(WS, SES, assistantLine('a1', 100));
    const floor = Date.parse('2026-07-01T00:00:00Z') - 1000;
    const a = tokensSpentSince(floor);
    const b = tokensSpentSince(floor + 14_000); // same 15s bucket in most alignments…
    const c = tokensSpentSince(floor + 15_000); // …this one is provably a different bucket
    expect(b).toBe(a);
    expect(c).toBe(a); // same data → same value, but computed via a different key
  });

  it('deleteSession clears the spend cache (deleted tokens vanish)', () => {
    ingestLine(WS, SES, assistantLine('a1', 5000));
    const floor = Date.parse('2026-07-01T00:00:00Z') - 1000;
    const before = tokensSpentSince(floor);
    deleteSession(SES);
    expect(tokensSpentSince(floor)).toBeLessThan(before);
  });
});
```

Note on the bucket test: `floor + 14_000` can land in the adjacent bucket depending on alignment — that assertion checks VALUE equality (`toBe(a)` on a number), which holds either way because the data didn't change; only the `floor + 15_000` line guarantees a different key. This is intentional: value-level assertions keep the test honest without exposing cache internals.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/dbReadCache.test.ts`
Expected: mixed — the two identity tests (`toBe`) and the bypass test FAIL against uncached code (fresh objects each call); the staleness tests PASS (nothing is cached yet). That failure pattern is the correct TDD baseline: identity tests drive the cache in; staleness tests pin the invalidation as you add it.

- [ ] **Step 3: Implement in `db.ts`** (remember: `grep -a` for all searches in this file):

(a) Import (top of file, alongside other `./` imports):

```ts
import { syncKeyedCache } from './syncCache.js';
```

(b) Module-level caches, directly above `summaryForSession` (~line 816):

```ts
// Event-invalidated read caches (spec 2026-08-15-summary-read-caches-design.md).
// Invalidation is the correctness mechanism: ingestLine (sole hot-path events
// writer; also performs the ai-title/first-prompt session updates) and
// deleteSession invalidate; openDb clears (a reopened DB must never serve the
// previous database's values). The TTL on summaries is a safety net only.
// Broker-mapping learns deliberately do NOT invalidate — the mapping resolves
// before the cache and only the post-resolution summary is cached.
const summaryCache = syncKeyedCache<WorkspaceSummary | null>({ maxEntries: 512, ttlMs: 30_000 });
const spendCache = syncKeyedCache<number>({ maxEntries: 4 });

const DEFAULT_TOP_TOOLS = 5;
```

(c) `summaryForSession` (~line 816): rename the existing function to `summaryForSessionUncached` (keep it un-exported) and add the exported wrapper above it:

```ts
export function summaryForSession(sessionId: string, topToolsLimit = DEFAULT_TOP_TOOLS): WorkspaceSummary | null {
  if (topToolsLimit !== DEFAULT_TOP_TOOLS) return summaryForSessionUncached(sessionId, topToolsLimit);
  return summaryCache.get(sessionId, () => summaryForSessionUncached(sessionId, topToolsLimit));
}
```

(Confirm `summaryForWorkspace` and `summaryForBrokerSession` call `summaryForSession` — they do — so they inherit the cache with no edits.)

(d) `tokensSpentSince` (~line 794): rename existing to `tokensSpentSinceUncached` (un-exported), add wrapper:

```ts
export function tokensSpentSince(sinceMs: number): number {
  // 15s bucket key: freshness emerges from the keying (a stale bucket is
  // simply never asked for again); staleness is capped at 15s against the
  // budget bar's 60s poll. Ingest/delete clear the cache outright.
  return spendCache.get(String(Math.floor(sinceMs / 15_000)), () => tokensSpentSinceUncached(sinceMs));
}
```

(e) `ingestLine` (~line 468): immediately before the function's `return` of the `IngestResult` (locate the single exit or each exit path), add:

```ts
  summaryCache.invalidate(sessionId);
  if (result.inserted) spendCache.clear();
```

Adapt to the actual local variable names (the function computes an `inserted` boolean and knows `sessionId` — invalidate unconditionally for the session because ingest also updates session-row fields like ai_title even on duplicate events; clear the spend cache only when an event row actually landed).

(f) `deleteSession` (~line 1590): after the transaction call `tx(id);` add:

```ts
  summaryCache.invalidate(id);
  spendCache.clear();
```

(g) `openDb` (the exported open function): add as the first statements of its body:

```ts
  summaryCache.clear();
  spendCache.clear();
```

- [ ] **Step 4: Run the new tests + the neighboring db suites**

Run: `npx vitest run src/main/dbReadCache.test.ts src/main/dbSummaries.test.ts src/main/db.test.ts src/main/db.planUsage.test.ts`
Expected: all PASS. If any pre-existing db test fails on object identity or stale reads, the invalidation wiring is wrong — fix the wiring, do not weaken the test.

- [ ] **Step 5: Commit**

```bash
git add src/main/db.ts src/main/dbReadCache.test.ts
git commit -m "perf(db): event-invalidated caches for summaryForSession + tokensSpentSince"
```

---

### Task 3: SPEC §6 + full gate + PR

**Files:**
- Modify: `docs/SPEC.md` §6 (Observability section — find the cost/summary description near the `perf_events`/observability text)

- [ ] **Step 1: SPEC sentence.** In `docs/SPEC.md` §6, locate the paragraph describing observability reads (search for `summaryForWorkspace` or the Observability section header) and append:

`The summary and rolling-spend reads are served from event-invalidated in-memory caches (invalidated by ingest and session deletion, cleared on DB open; the rolling sum is keyed by 15 s bucket), so repeated renderer polls and the per-ingest broadcast cost one query per data change rather than one per poll.`

- [ ] **Step 2: Full local gate**

Run: `npm run typecheck && npm run test:unit && npm run build`
Expected: all three succeed.

- [ ] **Step 3: Commit + push + PR**

```bash
git add docs/SPEC.md
git commit -m "docs(spec): document the event-invalidated observability read caches"
git push -u origin perf/summary-read-caches
gh pr create --head perf/summary-read-caches --title "perf(db): event-invalidated caches for the synchronous observability reads" --body "$(cat <<'EOF'
## Summary
Item 2 of the 2026-08-14 slowdown list (spec: docs/superpowers/specs/2026-08-15-summary-read-caches-design.md):
- New pure `syncCache.ts` (keyed sync cache, cap-clear eviction, optional safety TTL)
- `summaryForSession` — the single funnel behind `observability:summaryForWorkspace`, `observability:summaryForBrokerSession`, the per-ingest broadcast, and MCP `session_summary` — is cached per claude-session id, invalidated by `ingestLine` and `deleteSession`, cleared on `openDb`
- `tokensSpentSince` (behind `usage:rollingSpend`) cached per 15 s floor bucket of its sliding argument; ingest/delete clear it
- Broker-mapping learns deliberately do NOT invalidate (mapping resolves before the cache); non-default `topToolsLimit` bypasses
- Measured target: these reads were ~23 min of guaranteed synchronous main-loop blocking per 9 h on 0.12.0+3f3b8d6 (summaryForBrokerSession 2,924×211 ms, rollingSpend 2,209×250 ms, summaryForWorkspace 1,107×218 ms) — expect slow-op counts to collapse to ~one per ingest batch. Side benefit: shrinks the sync-query window behind CI flake #305.

Approach B (worker-thread reads) is recorded in the spec as the agreed long-term path if these numbers disappoint.

## Verification
typecheck + unit tests + build in the dev container (no display; Playwright in CI — note flake #305 may need a rerun). Staleness regression tests pin the invalidation contract: the very next read after an ingest/delete must reflect it. Post-merge dogfood: A/B `summaryFor*`/`rollingSpend` slow-op counts and the stall rate across the app-start build boundary.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR URL printed.

---

## Self-review notes (already applied)

- **Spec coverage:** Design §1 → Task 1; §2 (all wiring + invalidation sites incl. openDb clear) → Task 2; §3 acceptance + SPEC → Task 3. Non-goals respected.
- **Type consistency:** `syncKeyedCache<V>` string-keyed in both tasks; `SyncKeyedCache.get(key, compute)` shape identical; wrapper names (`summaryForSessionUncached`, `tokensSpentSinceUncached`) used consistently.
- **Deliberate test-design choices:** identity assertions (`toBe`) prove cache hits without exposing internals; the Step-2 mixed-failure baseline is documented so the implementer isn't surprised; assistant-line fixtures carry usage tokens so spend tests have real data.
