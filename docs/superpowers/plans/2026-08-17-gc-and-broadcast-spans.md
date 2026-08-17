# GC Rows + Ingest-Broadcast Span Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the remaining unattributed stalls names — record main-process GC pauses ≥25 ms as `perf_events` rows (`kind='gc'`) and wrap the per-ingest observability broadcast (summary compute + per-window structured clone) in an attributed sync span.

**Architecture:** `perf.ts` gains a `PerformanceObserver('gc')` whose callback delegates to an exported, directly-testable `recordGcEntries()`; rows use the existing PerfStore path (no migration — `kind` is unconstrained TEXT; `PerfKind` union grows). `ipc.ts`'s `jsonlWatcher.on('ingest')` listener body is wrapped in `perfSpan('claude_fleet.observability.ingest_broadcast', …, { workspace_id })` — it currently runs outside any span and has been invisible to every attribution query.

**Tech Stack:** TypeScript (Electron main), node:perf_hooks PerformanceObserver, vitest.

**Spec:** `docs/superpowers/specs/2026-08-17-gc-and-broadcast-spans-design.md` (binding).

## Global Constraints

- Branch: `perf/gc-and-broadcast-spans` (from origin/main @ d189ec4; spec commit already on it). Worktree `/workspace/claude-fleet/.claude/worktrees/perf-tracing-expansion`; never `cd /workspace/claude-fleet`.
- No display / no compiler: gate = `npm run typecheck` + `npm run test:unit` + `npm run build`; Playwright CI-only (flake #305 may need a rerun) — say so in the PR body.
- **`db.ts` trips grep binary detection — `grep -a`** (only relevant if you touch its schema comment; see Task 1 Step 5).
- GC row threshold: reuse the exported `SLOW_OP_MS` (25). Row shape exactly: `kind:'gc'`, `name:'claude_fleet.gc.<kindName>'`, `durMs`, `ts = Math.round(performance.timeOrigin + entry.startTime)`, `meta:{ gcKind:<kindName>, flags }`, workspace/session absent (NULL).
- Kind-name decoding from Node constants: 1→minor, 2→major, 4→incremental, 8→weakcb, anything else→`'unknown'`.
- No schema migration, no new deps, no MCP tool-surface changes (`perf_status` eventCounts is a generic map — verified no kind allowlist exists in mcpServer tests).
- `perf.ts` stays Electron-free.

---

### Task 1: GC rows in `perf.ts` (+ `PerfKind`, schema comments)

**Files:**
- Modify: `src/main/perfStore.ts:8` (PerfKind union)
- Modify: `src/main/perf.ts` — perf_hooks import (line ~9), `Runtime` interface, `initPerf` (recording-on path), `shutdownPerf`, new exports near `recordPtyChunk`
- Modify: `src/main/db.ts` (v11 migration SQL comment: kind enumeration — cosmetic, fresh-DB-only; use `grep -a` to find `stall | slow_op | pty_window`)
- Test: `src/main/perf.test.ts`

**Interfaces:**
- Consumes: existing `rt` runtime, `PerfStore.enqueue`, `SLOW_OP_MS`.
- Produces: `recordGcEntries(entries: ReadonlyArray<{ startTime: number; duration: number; detail?: unknown }>): void` (exported; the observer callback delegates to it). Task 2 does not depend on it.

- [ ] **Step 1: Write the failing tests** — append to `src/main/perf.test.ts` (add `recordGcEntries` to the `from './perf.js'` import):

```ts
describe('recordGcEntries (GC pause rows)', () => {
  const entry = (duration: number, kind: number, startTime = 1000) =>
    ({ startTime, duration, detail: { kind, flags: 0 } });

  it('records >=25ms GC pauses as gc rows with decoded kind names', async () => {
    initPerf(store, ON);
    recordGcEntries([entry(180, 2), entry(30, 1), entry(40, 4), entry(26, 8), entry(50, 99)]);
    await shutdownPerf();
    const rows = db.prepare(
      `SELECT name, dur_ms, meta FROM perf_events WHERE kind = 'gc' ORDER BY dur_ms DESC`
    ).all() as Array<{ name: string; dur_ms: number; meta: string }>;
    expect(rows.map((r) => r.name)).toEqual([
      'claude_fleet.gc.major',
      'claude_fleet.gc.unknown',
      'claude_fleet.gc.incremental',
      'claude_fleet.gc.minor',
      'claude_fleet.gc.weakcb'
    ]);
    expect(rows[0].dur_ms).toBe(180);
    expect(JSON.parse(rows[0].meta)).toEqual({ gcKind: 'major', flags: 0 });
  });

  it('drops sub-threshold pauses and tolerates missing detail', async () => {
    initPerf(store, ON);
    recordGcEntries([entry(24, 2), { startTime: 1000, duration: 60 }]);
    await shutdownPerf();
    const rows = db.prepare(`SELECT name FROM perf_events WHERE kind = 'gc'`).all() as Array<{ name: string }>;
    expect(rows).toEqual([{ name: 'claude_fleet.gc.unknown' }]);
  });

  it('converts startTime to epoch ms via timeOrigin', async () => {
    initPerf(store, ON);
    recordGcEntries([entry(100, 2, 5000)]);
    await shutdownPerf();
    const row = db.prepare(`SELECT ts FROM perf_events WHERE kind = 'gc'`).get() as { ts: number };
    expect(row.ts).toBe(Math.round(performance.timeOrigin + 5000));
  });

  it('is a no-op while disabled or uninitialized', async () => {
    recordGcEntries([entry(500, 2)]); // before init
    initPerf(store, OFF);
    recordGcEntries([entry(500, 2)]);
    await shutdownPerf();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM perf_events WHERE kind='gc'`).get()).toEqual({ n: 0 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/perf.test.ts -t 'recordGcEntries'`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement.**

(a) `src/main/perfStore.ts:8`:

```ts
export type PerfKind = 'stall' | 'slow_op' | 'pty_window' | 'input_hop' | 'output_hop' | 'echo_rtt' | 'gc';
```

(b) `src/main/perf.ts` — extend the perf_hooks import (line ~9):

```ts
import { monitorEventLoopDelay, PerformanceObserver, performance } from 'node:perf_hooks';
```

(c) Add to the `Runtime` interface: `gcObserver: PerformanceObserver | null;` and initialize `gcObserver: null` in the `rt = { ... }` literal.

(d) New exports near `recordPtyChunk` (module scope):

```ts
const GC_KIND_NAMES: Record<number, string> = { 1: 'minor', 2: 'major', 4: 'incremental', 8: 'weakcb' };

/** GC pauses are synchronous stops no span can capture — the 2026-08-17
 *  analysis found 84% of surviving big stalls overlap no instrumented op.
 *  Entries >= SLOW_OP_MS become app-global gc rows (workspace NULL, like
 *  stalls). Exported for tests; the observer callback delegates here. */
export function recordGcEntries(
  entries: ReadonlyArray<{ startTime: number; duration: number; detail?: unknown }>
): void {
  const r = rt;
  if (!r?.effective.recording) return;
  for (const e of entries) {
    if (e.duration < SLOW_OP_MS) continue;
    const detail = (e.detail ?? {}) as { kind?: number; flags?: number };
    const kindName = GC_KIND_NAMES[detail.kind ?? -1] ?? 'unknown';
    r.store.enqueue({
      ts: Math.round(performance.timeOrigin + e.startTime),
      kind: 'gc',
      name: `claude_fleet.gc.${kindName}`,
      durMs: e.duration,
      meta: { gcKind: kindName, flags: detail.flags ?? 0 }
    });
  }
}
```

(e) In `initPerf`, on the recording-on path (near the sampler setup), create the observer:

```ts
  rt.gcObserver = new PerformanceObserver((list) => {
    recordGcEntries(list.getEntries() as unknown as Array<{ startTime: number; duration: number; detail?: unknown }>);
  });
  rt.gcObserver.observe({ entryTypes: ['gc'] });
```

(f) In `shutdownPerf`, alongside the other teardown: `r.gcObserver?.disconnect();`

(g) `src/main/db.ts` v11 migration comment (cosmetic, fresh-DB only): `grep -a -n "stall | slow_op | pty_window" src/main/db.ts` and extend the enumeration comment with `| gc`.

- [ ] **Step 4: Run the perf suites**

Run: `npx vitest run src/main/perf.test.ts src/main/perfStore.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/perf.ts src/main/perfStore.ts src/main/db.ts src/main/perf.test.ts
git commit -m "feat(perf): record main-process GC pauses >=25ms as gc rows"
```

---

### Task 2: Span the ingest broadcast (+ SPEC edits)

No new unit tests (`ipc.ts` not vitest-loadable; span machinery covered). Gate: typecheck.

**Files:**
- Modify: `src/main/ipc.ts:754-761` (the `jsonlWatcher.on('ingest', …)` listener)
- Modify: `docs/SPEC.md` — §6 slow-op named-span area + perf_events kind enumeration (~line 294)

**Interfaces:**
- Consumes: `perfSpan` (already imported in ipc.ts? verify — the file imports from './perf.js'; extend that import if `perfSpan` is absent).

- [ ] **Step 1: Wrap the listener.** Replace the body at `ipc.ts:755-761`:

```ts
    jsonlWatcher.on('ingest', ({ workspaceId }) => {
      // Runs from a watcher emit, not an IPC handler — the generic IPC span
      // wrapper never covered it, so the summary recompute + the per-window
      // structured clone inside webContents.send were invisible to stall
      // attribution until this span (2026-08-17 analysis).
      perfSpan(
        'claude_fleet.observability.ingest_broadcast',
        () => {
          const summary = summaryForWorkspace(workspaceId);
          broadcastObservabilitySummary(
            { workspaceId, summary },
            BrowserWindow.getAllWindows()
          );
        },
        { workspace_id: workspaceId }
      );
    });
```

Keep the existing comment block above the listener; add the new comment inside as shown. Extend the `./perf.js` import with `perfSpan` if not already imported.

- [ ] **Step 2: SPEC edits.**

(a) In the §6 slow-op bullet (search `claude_fleet.ingest`), after the sentence introducing `claude_fleet.ingest`, add: `` The per-ingest summary broadcast is spanned as `claude_fleet.observability.ingest_broadcast` (workspace-attributed) — it runs from the watcher emit, outside any IPC handler. ``

(b) In the perf_events schema block (search `stall | slow_op | pty_window`), extend the kind comment with `| gc`, and near the stall-detector bullet add: `` Main-process GC pauses ≥25 ms are recorded as app-global `gc` rows (`claude_fleet.gc.major/minor/incremental/weakcb`) via a PerformanceObserver — synchronous stops no span can capture. ``

- [ ] **Step 3: Typecheck + commit**

Run: `npm run typecheck`
Expected: clean.

```bash
git add src/main/ipc.ts docs/SPEC.md
git commit -m "feat(perf): span the per-ingest observability broadcast + SPEC for gc rows"
```

---

### Task 3: Full gate + PR

- [ ] **Step 1: Full local gate**

Run: `npm run typecheck && npm run test:unit && npm run build`
Expected: all three succeed.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin perf/gc-and-broadcast-spans
gh pr create --head perf/gc-and-broadcast-spans --title "feat(perf): GC pause rows + ingest-broadcast span — name the unattributed stalls" --body "$(cat <<'EOF'
## Summary
Next round from the 2026-08-17 A/B (input_hop 144→8 ms confirmed the cache round; 84% of surviving big stalls overlap NO instrumented op):
- **GC pauses ≥25 ms** recorded as app-global `gc` rows (`claude_fleet.gc.major/minor/incremental/weakcb`) via a `PerformanceObserver` — synchronous stops no span can capture. New `PerfKind` value; `kind` is unconstrained TEXT so **no migration**; MCP `perf_status`/`query` pick it up generically.
- **The per-ingest observability broadcast is now spanned** (`claude_fleet.observability.ingest_broadcast`, workspace-attributed): it runs from the watcher emit outside any IPC handler, so its summary recompute + per-window structured-clone cost were invisible to every attribution query to date.

Acceptance after dogfood: re-run the big-stall overlap query — the unattributed share should collapse into gc rows and/or the broadcast span, which then become the next fix target.

Spec: `docs/superpowers/specs/2026-08-17-gc-and-broadcast-spans-design.md`.

## Verification
typecheck + unit tests + build in the dev container (no display; Playwright in CI — flake #305 may need a rerun). `recordGcEntries` unit-tested directly (threshold, kind decoding, timeOrigin→epoch conversion, off/uninit no-op); observer lifecycle tied to initPerf/shutdownPerf.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review notes (already applied)

- **Spec coverage:** F1 → Task 1 (incl. PerfKind, schema comments, lifecycle); F2 → Task 2; acceptance criteria live in the PR body.
- **Type consistency:** `recordGcEntries` signature identical in Task 1 steps 1/3; `GC_KIND_NAMES` decoding matches the test expectations (1/2/4/8/unknown).
- **Deliberate choices:** observer created only on the recording-on path (no-op when off); `performance` imported from node:perf_hooks for the timeOrigin conversion; db.ts migration-comment edit flagged as cosmetic/fresh-DB-only.
