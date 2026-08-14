# Perf Stall Fixes Round 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kill the once-a-minute ~1.5 s main-loop freeze (uncached `resolveClaude` behind `workspace:ping`), fix the clock-skew corruption in the Phase 2 latency hops, and stop OS-suspend gaps from polluting stall telemetry.

**Architecture:** Three independent fixes in one PR, one commit each: (F1) a pure memoizing resolver helper in `claudeResolve.ts` adopted by `local.ts` (non-null cached forever, null cached with TTL, invalidated on spawn failure); (F2) renderer timestamp sites switch from `performance.timeOrigin + performance.now()` to `Date.now()`; (F3) `perf.ts` gains `perfNotePowerEvent('suspend'|'resume')` — the stall sampler discards windows overlapping sleep — wired to Electron `powerMonitor` in `ipc.ts`.

**Tech Stack:** TypeScript (Electron main + React renderer), vitest.

**Spec:** `docs/superpowers/specs/2026-08-11-perf-stall-fixes-design.md` (F1–F3 binding).

## Global Constraints

- Branch: `fix/perf-stall-round1` (from origin/main @ 8bc0cd9), worktree `/workspace/claude-fleet/.claude/worktrees/perf-tracing-expansion`. Run all commands from the worktree root; never `cd /workspace/claude-fleet`.
- No display / no compiler here: gate = `npm run typecheck` + `npm run test:unit` + `npm run build`; Playwright is CI-only — say so in the PR body.
- No schema changes, no new `perf_events` kinds, no new deps, no MCP changes.
- Null-resolution TTL: `5 * 60_000` ms exactly. Suspend discard horizon: one sample interval past resume.
- `perf.ts` stays Electron-free (no `powerMonitor` import there — the wiring lives in `ipc.ts`).
- `echoRtt.ts` is NOT modified (single-clock module; it just receives `Date.now()` values now).
- `docs/SPEC.md` §6 stall-detector sentence lands in the same commit as the F3 wiring (Task 4).
- Line numbers below were verified against this branch's HEAD; anchor by the quoted content if drift occurs.

---

### Task 1: `cachedNullableResolver` helper (pure, TDD)

**Files:**
- Modify: `src/main/claudeResolve.ts` (append the helper at the end of the file)
- Test: `src/main/claudeResolve.test.ts` (append a describe block)

**Interfaces:**
- Consumes: nothing new.
- Produces: `cachedNullableResolver<T>(resolve: () => Promise<T | null>, opts: { nullTtlMs: number; now?: () => number }): { get(): Promise<T | null>; invalidate(): void }` — Task 2 wraps `local.ts`'s `resolveClaude` in it.

- [ ] **Step 1: Write the failing tests** — append to `src/main/claudeResolve.test.ts`:

```ts
describe('cachedNullableResolver', () => {
  it('caches a non-null resolution indefinitely', async () => {
    let calls = 0;
    const r = cachedNullableResolver(async () => { calls += 1; return '/bin/claude'; }, { nullTtlMs: 1000 });
    expect(await r.get()).toBe('/bin/claude');
    expect(await r.get()).toBe('/bin/claude');
    expect(calls).toBe(1);
  });

  it('caches null only for nullTtlMs, then re-probes', async () => {
    let calls = 0;
    let clock = 0;
    const r = cachedNullableResolver(async () => { calls += 1; return null; }, { nullTtlMs: 1000, now: () => clock });
    expect(await r.get()).toBeNull();
    clock = 999;
    expect(await r.get()).toBeNull();
    expect(calls).toBe(1);
    clock = 1001;
    expect(await r.get()).toBeNull();
    expect(calls).toBe(2);
  });

  it('shares one in-flight probe between concurrent gets', async () => {
    let calls = 0;
    let release: (v: string | null) => void = () => {};
    const r = cachedNullableResolver(
      () => { calls += 1; return new Promise<string | null>((res) => { release = res; }); },
      { nullTtlMs: 1000 }
    );
    const a = r.get();
    const b = r.get();
    release('/bin/claude');
    expect(await a).toBe('/bin/claude');
    expect(await b).toBe('/bin/claude');
    expect(calls).toBe(1);
  });

  it('does not cache a rejected probe', async () => {
    let calls = 0;
    const r = cachedNullableResolver(async () => {
      calls += 1;
      if (calls === 1) throw new Error('flaky');
      return '/bin/claude';
    }, { nullTtlMs: 1000 });
    await expect(r.get()).rejects.toThrow('flaky');
    expect(await r.get()).toBe('/bin/claude');
    expect(calls).toBe(2);
  });

  it('invalidate() forces a re-probe even after a non-null hit', async () => {
    let calls = 0;
    const r = cachedNullableResolver(async () => { calls += 1; return `/bin/claude${calls}`; }, { nullTtlMs: 1000 });
    expect(await r.get()).toBe('/bin/claude1');
    r.invalidate();
    expect(await r.get()).toBe('/bin/claude2');
  });
});
```

Add `cachedNullableResolver` to the import from `./claudeResolve.js` at the top of the test file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/claudeResolve.test.ts`
Expected: FAIL — `cachedNullableResolver` not exported.

- [ ] **Step 3: Implement** — append to `src/main/claudeResolve.ts`:

```ts
/** Memoize a nullable async resolution (perf stall fix F1, spec
 *  2026-08-11-perf-stall-fixes-design.md). The local backend re-resolved the
 *  claude binary on every workspace:ping (once a minute), and the process
 *  spawn behind findClaude blocks the main loop ~1.5 s on Windows. Policy:
 *  a non-null result is cached until invalidate(); null (claude not found)
 *  is cached for nullTtlMs so a later install is picked up; concurrent gets
 *  share one in-flight probe; a rejected probe is not cached. */
export function cachedNullableResolver<T>(
  resolve: () => Promise<T | null>,
  opts: { nullTtlMs: number; now?: () => number }
): { get(): Promise<T | null>; invalidate(): void } {
  const now = opts.now ?? Date.now;
  let cached: { value: T | null; at: number } | null = null;
  let inFlight: Promise<T | null> | null = null;
  return {
    get(): Promise<T | null> {
      if (cached && (cached.value !== null || now() - cached.at < opts.nullTtlMs)) {
        return Promise.resolve(cached.value);
      }
      if (!inFlight) {
        inFlight = resolve().then(
          (value) => {
            cached = { value, at: now() };
            inFlight = null;
            return value;
          },
          (err) => {
            inFlight = null;
            throw err;
          }
        );
      }
      return inFlight;
    },
    invalidate(): void {
      cached = null;
    }
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/claudeResolve.test.ts`
Expected: all PASS (pre-existing resolveClaudeBin tests included).

- [ ] **Step 5: Commit**

```bash
git add src/main/claudeResolve.ts src/main/claudeResolve.test.ts
git commit -m "feat(local): memoizing nullable resolver helper for the claude binary lookup"
```

---

### Task 2: Adopt the cache in `local.ts`

No new unit tests (`local.ts` imports node-pty/electron-adjacent modules and is not vitest-loadable here); the policy logic was TDD'd in Task 1 and this is thin delegation. Gate: typecheck.

**Files:**
- Modify: `src/main/local.ts:239-241` (resolveClaude), `local.ts:149-170` (localPtyFactory spawn), import block

**Interfaces:**
- Consumes: `cachedNullableResolver` (Task 1); existing `findClaude`, `execFileAsync`, `homedir`.
- Produces: unchanged exported surface (`ping()` etc. keep their signatures).

- [ ] **Step 1: Import.** Extend the existing import from `./claudeResolve.js` (search for `findClaude`) with `cachedNullableResolver`.

- [ ] **Step 2: Wrap the resolver.** Replace (line ~239):

```ts
/** Resolve the host `claude` binary (see claudeResolve.ts for the strategy). */
function resolveClaude(): Promise<string | null> {
  return findClaude((file, args) => execFileAsync(file, args), homedir());
}
```

with:

```ts
/** Resolve the host `claude` binary (see claudeResolve.ts for the strategy).
 *  Cached: the uncached lookup spawned where.exe/login-shell probes on every
 *  workspace:ping (once a minute) and blocked the main loop ~1.5 s per call
 *  on Windows (perf_events finding, 2026-08-11). Null re-probes after 5 min;
 *  a spawn failure invalidates so a moved binary is re-resolved. */
const claudeResolver = cachedNullableResolver(
  () => findClaude((file, args) => execFileAsync(file, args), homedir()),
  { nullTtlMs: 5 * 60_000 }
);
function resolveClaude(): Promise<string | null> {
  return claudeResolver.get();
}
```

- [ ] **Step 3: Invalidate on spawn failure.** In `localPtyFactory` (line ~149), the body currently does `const p = pty.spawn(file, args, { ... });`. Wrap exactly that call:

```ts
  let p: NodePty.IPty;
  try {
    p = pty.spawn(file, args, {
      // (existing options object unchanged)
    });
  } catch (err) {
    // Stale resolution (binary moved/uninstalled since we cached it): force
    // the next resolveClaude() to re-probe instead of failing forever.
    claudeResolver.invalidate();
    throw err;
  }
```

Keep every existing option and subsequent use of `p` unchanged (only the declaration form changes from `const p = ...` to the `let` + try/catch above).

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/main/local.ts
git commit -m "fix(local): cache the claude binary resolution — stop per-minute ping spawns blocking the loop"
```

---

### Task 3: Renderer wall-clock stamps

No new tests (pure clock-source swap; the renderer suite pins the sampling logic already). Gate: renderer vitest + typecheck + build.

**Files:**
- Modify: `src/renderer/src/components/TerminalSession.tsx:440,450,488`

**Interfaces:**
- Consumes/produces: none changed — payload shapes and `echoRtt.ts` are untouched.

- [ ] **Step 1: Swap the three sites.** In the attach effect:

(a) Line ~440 (output arrival):

```ts
            const arrival = Date.now();
```

(b) Line ~450 (output-hop measurement inside the `term.write` callback):

```ts
                    durMs: Date.now() - ts
```

(c) Line ~488 (keystroke stamp) — replace the `const ts = performance.timeOrigin + performance.now();` line and add the why-comment above it:

```ts
            // Date.now(), NOT performance.timeOrigin + performance.now():
            // timeOrigin drifts from the wall clock on long-lived renderers
            // (sleep/NTP) — observed ~4 s of skew, which inflated output_hop
            // and made main's `dur >= 0` guard silently drop every input_hop.
            // Main stamps with Date.now(); the renderer must use the same
            // clock. (2026-08-11 perf_events finding.)
            const ts = Date.now();
```

- [ ] **Step 2: Verify no timeOrigin remains**

Run: `grep -n "timeOrigin" src/renderer/src/components/TerminalSession.tsx`
Expected: no matches.

- [ ] **Step 3: Gate**

Run: `npx vitest run src/renderer/src && npm run typecheck && npm run build`
Expected: all green/clean.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/TerminalSession.tsx
git commit -m "fix(perf): stamp renderer latency samples with Date.now — timeOrigin drift corrupted the hops"
```

---

### Task 4: Suspend filtering (perf.ts, TDD) + powerMonitor wiring + SPEC

**Files:**
- Modify: `src/main/perf.ts` (Runtime interface, initPerf sampler ~line 297-305, new export near `setPerfStateListener`)
- Modify: `src/main/ipc.ts` (wiring next to the existing `setPerfStateListener(...)` call in `registerIpc`)
- Modify: `docs/SPEC.md` (§6 stall-detector bullet)
- Test: `src/main/perf.test.ts`

**Interfaces:**
- Consumes: existing `PerfInitHooks` test seams (`delaySource`, `sampleIntervalMs`).
- Produces: `perfNotePowerEvent(event: 'suspend' | 'resume'): void` — called only by the ipc.ts wiring.

- [ ] **Step 1: Write the failing tests** — append a describe block to `src/main/perf.test.ts` (add `perfNotePowerEvent` to the `from './perf.js'` import):

```ts
describe('perfNotePowerEvent (suspend filtering)', () => {
  it('discards windows between suspend and shortly after resume', async () => {
    initPerf(store, ON, { delaySource: () => ({ p50: 2, p99: 8, max: 30000 }), sampleIntervalMs: 20 });
    perfNotePowerEvent('suspend');
    await sleep(100); // several would-be "stall" windows while suspended
    perfNotePowerEvent('resume');
    await sleep(15); // still inside the one-interval discard horizon
    store.flush(); // rows are buffered — flush before counting
    const midCount = (db.prepare(`SELECT COUNT(*) AS n FROM perf_events WHERE kind='stall'`).get() as { n: number }).n;
    expect(midCount).toBe(0);
    await sleep(200); // past the horizon: real windows record again
    await shutdownPerf();
    const after = (db.prepare(`SELECT COUNT(*) AS n FROM perf_events WHERE kind='stall'`).get() as { n: number }).n;
    expect(after).toBeGreaterThanOrEqual(1);
  });

  it('is a no-op before initPerf', () => {
    expect(() => perfNotePowerEvent('resume')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/perf.test.ts -t 'perfNotePowerEvent'`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement in `src/main/perf.ts`:**

(a) Add to the `Runtime` interface: `sampleIntervalMs: number;` and set it in `initPerf`'s `rt = { ... }` literal to `hooks?.sampleIntervalMs ?? SAMPLE_INTERVAL_MS` (add the field; the literal currently has no such key).

(b) Module state + export, directly after the `setPerfStateListener` block:

```ts
// OS-suspend awareness (spec 2026-08-11-perf-stall-fixes-design.md F3).
// While the machine sleeps no code runs, but the sampler's next read sees
// the whole gap as one giant "delay" — six ~66 s phantom stalls per night
// in the first dogfood. ipc.ts wires Electron powerMonitor to this (perf.ts
// stays Electron-free); windows overlapping suspend→resume, plus the first
// window after resume, are read-and-discarded instead of recorded.
let suspendedAtWall: number | null = null;
let discardUntilWall = 0;
export function perfNotePowerEvent(event: 'suspend' | 'resume'): void {
  if (event === 'suspend') {
    suspendedAtWall = Date.now();
  } else {
    suspendedAtWall = null;
    discardUntilWall = Date.now() + (rt?.sampleIntervalMs ?? SAMPLE_INTERVAL_MS);
  }
}
```

(c) In the sampler callback (line ~297), insert the discard check between `readDelay()` (which must still run — it resets the native histogram) and the recording:

```ts
  rt.sampleTimer = setInterval(() => {
    const w = readDelay();
    if (suspendedAtWall !== null || Date.now() < discardUntilWall) return; // sleep gap, not a block
    Object.assign(lastWindow, w);
    if (w.max > STALL_THRESHOLD_MS) {
      rt?.store.enqueue({ ts: Date.now(), kind: 'stall', durMs: w.max, meta: { ...w } });
    }
  }, hooks?.sampleIntervalMs ?? SAMPLE_INTERVAL_MS);
```

- [ ] **Step 4: Run the perf suite**

Run: `npx vitest run src/main/perf.test.ts`
Expected: all PASS.

- [ ] **Step 5: Wire powerMonitor.** In `src/main/ipc.ts`, directly after the existing `setPerfStateListener((recording) => { ... });` block in `registerIpc`, add (extend the perf import with `perfNotePowerEvent`, and add `powerMonitor` to the existing `electron` import):

```ts
  // OS suspend/resume → stall-sampler discard (perf.ts stays Electron-free).
  powerMonitor.on('suspend', () => perfNotePowerEvent('suspend'));
  powerMonitor.on('resume', () => perfNotePowerEvent('resume'));
```

- [ ] **Step 6: SPEC §6.** In `docs/SPEC.md`, find the stall-detector bullet (search for `claude_fleet.stall` or "Event-loop stall detector") and append this sentence to it:

`Windows overlapping an OS suspend (Electron powerMonitor suspend/resume, plus one sample interval after resume) are discarded, so stall rows measure the loop blocked while the machine was awake — not sleep gaps.`

- [ ] **Step 7: Gate + commit**

Run: `npm run typecheck && npx vitest run src/main/perf.test.ts`
Expected: clean/green.

```bash
git add src/main/perf.ts src/main/perf.test.ts src/main/ipc.ts docs/SPEC.md
git commit -m "fix(perf): discard stall windows spanning OS suspend via powerMonitor"
```

---

### Task 5: Full gate + PR

**Files:** none new.

- [ ] **Step 1: Full local gate**

Run: `npm run typecheck && npm run test:unit && npm run build`
Expected: all three succeed.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin fix/perf-stall-round1
gh pr create --head fix/perf-stall-round1 --title "fix(perf): stall fixes round 1 — resolveClaude cache, wall-clock stamps, suspend filtering" --body "$(cat <<'EOF'
## Summary
First fixes driven by the perf_events dogfood (3 days of data, analysis 2026-08-11):
- **Cache the local claude resolution** — `workspace:ping` re-ran the uncached `where.exe`/login-shell lookup every minute, and the spawn blocked the main loop 1.4–1.9 s each time (~1,400 freezes/day; every idle stall matched its ping span to within a few ms). Non-null cached until invalidated (spawn failure re-probes), null re-probes after 5 min, concurrent gets share one probe.
- **Renderer latency stamps switch to `Date.now()`** — `performance.timeOrigin` drifted ~4 s on a long-lived window, inflating every `output_hop` (mean 4.19 s vs echo_rtt 478 ms) and silently suppressing all `input_hop` samples via the `dur >= 0` guard.
- **Suspend filtering** — stall windows overlapping Electron `powerMonitor` suspend/resume (plus one interval after resume) are discarded; the six ~66 s phantom "stalls" per night were sleep gaps, not hangs.

Not touched (deliberate): the sync-SQLite summary/rollingSpend poller cost — re-measure after these land; JSONL ingest was falsified as a suspect (41 slow instances, max 203 ms, in 3 days).

Spec: `docs/superpowers/specs/2026-08-11-perf-stall-fixes-design.md`.

## Verification
Gated with typecheck + unit tests + build in the dev container (no display); Playwright runs in CI. Post-merge dogfood check: idle-hour `stall` rows should drop from ~60/h to ~0, `workspace:ping` slow-op spans should disappear after the first resolution, and `input_hop` rows should start appearing for long-lived windows.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR URL printed.

---

## Self-review notes (already applied)

- **Spec coverage:** F1 → Tasks 1–2; F2 → Task 3; F3 → Task 4. Non-goals respected (no poller changes, no new kinds).
- **Type consistency:** `cachedNullableResolver` name and option shape identical in Tasks 1–2; `perfNotePowerEvent` signature identical in Task 4 steps 1/3/5.
- **Test-timing note:** Task 4's test uses generous sleeps (100/15/200 ms against a 20 ms interval) — same tolerance style as the existing stall-sampler test.
