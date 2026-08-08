# Perf Tracing Expansion PR B (Phase 2 Latency Hops) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure user-perceived terminal latency per hop — renderer→main input latency, main→renderer output latency, and keystroke→echo round trip — recorded as `input_hop`/`output_hop`/`echo_rtt` rows in `perf_events`.

**Architecture:** The renderer stamps keystrokes and pairs them with output arrivals (pure `echoRtt.ts` module), batching samples to main every 5 s over a one-way `perf:samples` channel; main measures the input hop itself at `pty:input` receipt and stamps `pty:data` sends with an epoch-ms second argument. All samples flow through OTel histograms (`claude_fleet.terminal.*`) into an extended `SqliteMetricExporter` that maps histogram data points to rows — the kinds already exist in the schema (no migration). Sampling is gated renderer-side by a `perf:state` push fired from `initPerf` via an injected listener (perf.ts stays Electron-free).

**Tech Stack:** TypeScript (Electron main + preload + React renderer), `@opentelemetry/api` histograms, OTel JS SDK 2.x, vitest, xterm.js.

**Spec:** `docs/superpowers/specs/2026-08-08-perf-tracing-expansion-design.md` sections B1–B5 (binding, including the two reviewed deviations: timestamp as separate IPC arg; renderer-side gating). PR A (#280) is merged — `perfSetSpanContext`, context propagation, and the channel map already exist.

## Global Constraints

- Branch: `feat/perf-latency-hops` (from origin/main incl. #280), worktree `/workspace/claude-fleet/.claude/worktrees/perf-tracing-expansion`. Run all commands from the worktree root; never `cd /workspace/claude-fleet`.
- No display / no compiler in this container: gate = `npm run typecheck` + `npm run test:unit` + `npm run build`; Playwright terminal specs run in CI only — say so in the PR body.
- **No schema migration, no new deps, no MCP tool changes.** `PerfKind` already includes `'input_hop' | 'output_hop' | 'echo_rtt'` (`src/main/perfStore.ts:8`).
- Metric names exactly: `claude_fleet.terminal.input_hop`, `claude_fleet.terminal.output_hop`, `claude_fleet.terminal.echo_rtt` (unit `ms`). Attribute names exactly `workspace_id` / `session_id` (snake_case); `session_id` carries the **broker session id**.
- Echo pairing window: `2000` ms. Renderer batch flush: every `5000` ms. Renderer timestamps: `performance.timeOrigin + performance.now()` (epoch ms, sub-ms precision); main uses `Date.now()`.
- The `pty:data:<id>` chunk stays a raw `Buffer`; the timestamp is an ADDITIONAL send argument (approved deviation). `pty:input` gains an OPTIONAL trailing `ts` argument — missing/invalid timestamps are skipped, never recorded as 0.
- Gating: renderer collects/stamps only while recording (`perf:state` push + initial `perf:status` pull); main additionally drops `perf:samples` while recording is off (belt and braces). Mock mode (`CLAUDE_FLEET_MOCK=1`) never calls `initPerf` → `perf:status` reports all-off → renderer never stamps; `recordLatencySample` no-ops without a runtime.
- `docs/SPEC.md` edits land in the same commit as the behavior they describe: IPC-surface rows with Task 4, §6 kinds sentence with Task 2.
- Container test env: if `npx vitest run src/main/perf.test.ts` fails to load better-sqlite3/electron, redo the recipe from PR A's plan Task 1 (`docs/superpowers/plans/2026-08-08-perf-tracing-expansion-pr-a.md`) — same one-command extras install.

---

### Task 1: `echoRtt.ts` — pure keystroke↔echo pairing module

**Files:**
- Create: `src/renderer/src/echoRtt.ts`
- Test: `src/renderer/src/echoRtt.test.ts`

**Interfaces:**
- Consumes: nothing (pure module — no imports, no xterm, no window).
- Produces: `ECHO_WINDOW_MS = 2000` and `class EchoRttTracker { keystroke(ts: number): void; output(ts: number): number[] }` — Task 5 constructs one per terminal session, calls `keystroke` from `term.onData`, calls `output` on each `pty:data` arrival and pushes the returned round-trip durations into the sample batch.

- [ ] **Step 1: Write the failing tests** — create `src/renderer/src/echoRtt.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ECHO_WINDOW_MS, EchoRttTracker } from './echoRtt.js';

describe('EchoRttTracker', () => {
  it('closes a pending keystroke on the next output within the window', () => {
    const t = new EchoRttTracker();
    t.keystroke(1000);
    expect(t.output(1080)).toEqual([80]);
  });

  it('one output closes ALL pending keystrokes, oldest first', () => {
    const t = new EchoRttTracker();
    t.keystroke(1000);
    t.keystroke(1030);
    expect(t.output(1100)).toEqual([100, 70]);
    // Consumed: a second output produces no further samples.
    expect(t.output(1200)).toEqual([]);
  });

  it('drops keystrokes older than ECHO_WINDOW_MS instead of sampling them', () => {
    const t = new EchoRttTracker();
    t.keystroke(1000);
    t.keystroke(2500);
    expect(t.output(1000 + ECHO_WINDOW_MS + 1)).toEqual([501]); // only the 2500 keystroke closes
  });

  it('output with nothing pending returns an empty array', () => {
    expect(new EchoRttTracker().output(1234)).toEqual([]);
  });

  it('caps pending keystrokes so paste storms cannot grow unbounded', () => {
    const t = new EchoRttTracker();
    for (let i = 0; i < 5000; i += 1) t.keystroke(1000 + i);
    expect(t.output(6100).length).toBeLessThanOrEqual(256);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/renderer/src/echoRtt.test.ts`
Expected: FAIL — module `./echoRtt.js` not found.

- [ ] **Step 3: Implement** — create `src/renderer/src/echoRtt.ts`:

```ts
// Keystroke → echo round-trip pairing (perf telemetry Phase 2, spec B3).
// Pure: no xterm/IPC/window imports, so vitest covers it directly. One
// tracker per terminal session. Each pty:data arrival closes every pending
// keystroke inside the window — noisy per-sample, meaningful as a histogram.

export const ECHO_WINDOW_MS = 2000;

/** Paste storms enqueue one "keystroke" per chunk; anything beyond this is
 *  not typing latency worth sampling, and an unbounded queue is a leak. */
const MAX_PENDING = 256;

export class EchoRttTracker {
  private pending: number[] = [];

  keystroke(ts: number): void {
    if (this.pending.length >= MAX_PENDING) return;
    this.pending.push(ts);
  }

  /** Close all pending keystrokes against this output arrival. Returns the
   *  round-trip durations (oldest first); expired keystrokes are dropped. */
  output(ts: number): number[] {
    if (this.pending.length === 0) return [];
    const closed = this.pending
      .filter((k) => ts - k <= ECHO_WINDOW_MS && ts >= k)
      .map((k) => ts - k);
    this.pending = [];
    return closed;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/src/echoRtt.test.ts`
Expected: 5/5 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/echoRtt.ts src/renderer/src/echoRtt.test.ts
git commit -m "feat(perf): pure echo round-trip pairing tracker for terminal latency sampling"
```

---

### Task 2: `perf.ts` — latency histograms + histogram→row export (+ SPEC §6 sentence)

**Files:**
- Modify: `src/main/perf.ts` (Runtime fields ~line 116-127; `initPerf` metrics block ~line 205-208; `SqliteMetricExporter.export` ~line 77-99; new export after `recordPtyChunk`)
- Modify: `docs/SPEC.md` §6 Perf telemetry (~line 286 area)
- Test: `src/main/perf.test.ts`

**Interfaces:**
- Consumes: existing `Runtime`/`initPerf`/`PerfStore` internals; `@opentelemetry/api` `Histogram` type.
- Produces: `recordLatencySample(kind: 'input_hop' | 'output_hop' | 'echo_rtt', workspaceId: string | null, sessionId: string | null, durMs: number): void` — Tasks 4 (ipc.ts) calls it for input hops and for renderer sample batches. No-op while recording is off or before `initPerf`.

- [ ] **Step 1: Write the failing test** — append to the `stall sampler + pty counters` describe block in `src/main/perf.test.ts` (imports: add `recordLatencySample` to the `from './perf.js'` list):

```ts
  it('aggregates latency samples into per-session rows with histogram meta', async () => {
    initPerf(store, ON, { delaySource: () => ({ p50: 0, p99: 0, max: 0 }), sampleIntervalMs: 20 });
    recordLatencySample('echo_rtt', 'ws-1', 'sess-a', 120);
    recordLatencySample('echo_rtt', 'ws-1', 'sess-a', 80);
    recordLatencySample('input_hop', null, 'sess-a', 3);
    await sleep(150);
    await shutdownPerf();
    const rtt = db.prepare(
      `SELECT workspace_id, session_id, dur_ms, meta FROM perf_events WHERE kind = 'echo_rtt'`
    ).get() as { workspace_id: string; session_id: string; dur_ms: number; meta: string };
    expect(rtt.workspace_id).toBe('ws-1');
    expect(rtt.session_id).toBe('sess-a');
    expect(rtt.dur_ms).toBe(120); // max of the window
    const meta = JSON.parse(rtt.meta);
    expect(meta.count).toBe(2);
    expect(meta.sum).toBe(200);
    expect(meta.min).toBe(80);
    expect(meta.max).toBe(120);
    const hop = db.prepare(
      `SELECT workspace_id, session_id FROM perf_events WHERE kind = 'input_hop'`
    ).get() as { workspace_id: string | null; session_id: string };
    expect(hop.workspace_id).toBeNull(); // '' normalizes to NULL
    expect(hop.session_id).toBe('sess-a');
  });

  it('recordLatencySample while disabled or uninitialized is a no-op', async () => {
    initPerf(store, OFF);
    recordLatencySample('echo_rtt', 'ws-1', 'sess-a', 50);
    await shutdownPerf();
    recordLatencySample('echo_rtt', 'ws-1', 'sess-a', 50); // after shutdown: no runtime
    expect(db.prepare(`SELECT COUNT(*) AS n FROM perf_events WHERE kind = 'echo_rtt'`).get()).toEqual({ n: 0 });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/perf.test.ts -t 'latency'`
Expected: FAIL — `recordLatencySample` is not exported.

- [ ] **Step 3: Implement in `src/main/perf.ts`:**

(a) Import the `Histogram` type (extend the existing `import type { Counter } from '@opentelemetry/api';`):

```ts
import type { Counter, Histogram } from '@opentelemetry/api';
```

(b) Add to the `Runtime` interface after `ptyChunks: Counter | null;`:

```ts
  latencyHists: Record<LatencyKind, Histogram> | null;
```

and add the type + name constant near `TRACER_NAME`:

```ts
export type LatencyKind = 'input_hop' | 'output_hop' | 'echo_rtt';
const TERMINAL_METRIC_PREFIX = 'claude_fleet.terminal.';
const LATENCY_KINDS: readonly LatencyKind[] = ['input_hop', 'output_hop', 'echo_rtt'];
```

(c) Initialize the field to `null` in the `rt = { ... }` literal in `initPerf`, and after the `ptyBytes`/`ptyChunks` counter creation add:

```ts
  rt.latencyHists = Object.fromEntries(
    LATENCY_KINDS.map((k) => [
      k,
      meter.createHistogram(`${TERMINAL_METRIC_PREFIX}${k}`, {
        unit: 'ms',
        description: 'User-perceived terminal latency hop (perf telemetry Phase 2)'
      })
    ])
  ) as Record<LatencyKind, Histogram>;
```

(d) In `SqliteMetricExporter.export`, replace the pty-only guard body. Current shape:

```ts
        if (!metric.descriptor.name.startsWith('claude_fleet.pty.')) continue;
        for (const dp of metric.dataPoints) { /* counter mapping */ }
```

New shape — route by prefix, keeping the counter branch byte-identical and adding a histogram branch:

```ts
        const name = metric.descriptor.name;
        if (name.startsWith('claude_fleet.pty.')) {
          for (const dp of metric.dataPoints) {
            const value = typeof dp.value === 'number' ? dp.value : 0;
            if (value === 0) continue;
            const attrs = dp.attributes as Record<string, unknown>;
            const workspaceIdRaw = typeof attrs.workspace_id === 'string' ? attrs.workspace_id : null;
            this.store.enqueue({
              ts: Date.now(),
              kind: 'pty_window',
              name,
              // Normalize '' workspace_id to null
              workspaceId: workspaceIdRaw === '' ? null : workspaceIdRaw,
              sessionId: typeof attrs.session_id === 'string' ? attrs.session_id : null,
              meta: { value }
            });
          }
        } else if (name.startsWith(TERMINAL_METRIC_PREFIX)) {
          const kind = name.slice(TERMINAL_METRIC_PREFIX.length) as LatencyKind;
          if (!LATENCY_KINDS.includes(kind)) continue;
          for (const dp of metric.dataPoints) {
            // Histogram data point: { count, sum, min?, max?, buckets: { boundaries, counts } }
            const v = dp.value as {
              count: number; sum?: number; min?: number; max?: number;
              buckets?: { boundaries: number[]; counts: number[] };
            };
            if (!v || typeof v.count !== 'number' || v.count === 0) continue;
            const attrs = dp.attributes as Record<string, unknown>;
            const ws = typeof attrs.workspace_id === 'string' && attrs.workspace_id !== '' ? attrs.workspace_id : null;
            const sess = typeof attrs.session_id === 'string' && attrs.session_id !== '' ? attrs.session_id : null;
            this.store.enqueue({
              ts: Date.now(),
              kind,
              name,
              workspaceId: ws,
              sessionId: sess,
              durMs: v.max ?? null,
              meta: {
                count: v.count,
                sum: v.sum ?? null,
                min: v.min ?? null,
                max: v.max ?? null,
                buckets: v.buckets ?? null
              }
            });
          }
        }
```

Also update the class JSDoc's first line to: `/** Maps DELTA counter data points → pty_window rows and terminal-latency histogram points → input_hop/output_hop/echo_rtt rows. Gauge metrics ... (rest unchanged) */`

(e) Add the recording entry point after `recordPtyChunk`:

```ts
/** Terminal latency sample (perf telemetry Phase 2). Sources: main's
 *  pty:input receipt (input_hop) and the renderer's perf:samples batches
 *  (output_hop, echo_rtt). No-op while recording is off. */
export function recordLatencySample(
  kind: LatencyKind,
  workspaceId: string | null,
  sessionId: string | null,
  durMs: number
): void {
  const r = rt;
  if (!r?.effective.recording || !r.latencyHists) return;
  if (!Number.isFinite(durMs) || durMs < 0) return;
  r.latencyHists[kind].record(durMs, {
    workspace_id: workspaceId ?? '',
    session_id: sessionId ?? ''
  });
}
```

- [ ] **Step 4: Run the full perf suite**

Run: `npx vitest run src/main/perf.test.ts src/main/perfStore.test.ts`
Expected: all PASS (including the untouched pty_window tests — the counter branch must be byte-identical).

- [ ] **Step 5: SPEC §6.** In `docs/SPEC.md`, in the Perf telemetry section (after the slow-op spans bullet, ~line 286), add a new bullet:

```
- **Terminal latency hops (Phase 2)** — `input_hop` (renderer keystroke → main `pty:input` receipt), `output_hop` (main `pty:data` send → renderer `term.write` completion), and `echo_rtt` (keystroke → next `pty:data` arrival within 2 s) are recorded as `claude_fleet.terminal.*` OTel histograms with broker-session attribution and persisted one row per (kind, session) per ~5 s flush window: `dur_ms` = window max, `meta` = `{ count, sum, min, max, buckets }`. Renderer samples batch to main every ~5 s over the one-way `perf:samples` channel, gated renderer-side by the `perf:state` push; main drops batches while recording is off.
```

- [ ] **Step 6: Commit**

```bash
git add src/main/perf.ts src/main/perf.test.ts docs/SPEC.md
git commit -m "feat(perf): terminal latency histograms + histogram-to-row export"
```

---

### Task 3: `perf:state` listener hook + `perfSamples.ts` payload sanitizer

**Files:**
- Modify: `src/main/perf.ts` (listener hook — perf.ts stays Electron-free, the broadcaster is injected)
- Create: `src/main/perfSamples.ts`
- Test: `src/main/perf.test.ts`, `src/main/perfSamples.test.ts`

**Interfaces:**
- Consumes: Task 2's `LatencyKind` type (import from `./perf.js`).
- Produces:
  - `setPerfStateListener(cb: ((recording: boolean) => void) | null): void` (perf.ts) — fired with the effective recording state at the END of every `initPerf` (both on and off paths, hence also after every `reconfigurePerf`). Task 4 injects the window broadcaster.
  - `sanitizePerfSamples(payload: unknown): { sessionId: string; samples: Array<{ kind: 'output_hop' | 'echo_rtt'; durMs: number }> } | null` (perfSamples.ts) — Task 4's `perf:samples` handler validates renderer input through this. Returns null for malformed payloads; silently drops invalid entries (bad kind, non-finite/negative/absurd durations) from `samples`. `input_hop` is NOT an accepted kind here (it is measured in main, never sent by the renderer).

- [ ] **Step 1: Write the failing tests.**

Append to `src/main/perf.test.ts` (add `setPerfStateListener` to the `from './perf.js'` import; add an `afterEach(() => setPerfStateListener(null));` line inside the new describe):

```ts
describe('setPerfStateListener', () => {
  afterEach(() => setPerfStateListener(null));

  it('fires with the effective recording state on init and reconfigure', async () => {
    const seen: boolean[] = [];
    setPerfStateListener((r) => seen.push(r));
    initPerf(store, ON);
    await reconfigurePerf(OFF);
    await reconfigurePerf(ON);
    expect(seen).toEqual([true, false, true]);
  });
});
```

Create `src/main/perfSamples.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { sanitizePerfSamples } from './perfSamples.js';

describe('sanitizePerfSamples', () => {
  it('passes a well-formed payload through', () => {
    expect(
      sanitizePerfSamples({ sessionId: 'handle-1', samples: [{ kind: 'echo_rtt', durMs: 42.5 }, { kind: 'output_hop', durMs: 3 }] })
    ).toEqual({ sessionId: 'handle-1', samples: [{ kind: 'echo_rtt', durMs: 42.5 }, { kind: 'output_hop', durMs: 3 }] });
  });

  it('rejects malformed payloads outright', () => {
    expect(sanitizePerfSamples(null)).toBeNull();
    expect(sanitizePerfSamples('x')).toBeNull();
    expect(sanitizePerfSamples({ sessionId: 7, samples: [] })).toBeNull();
    expect(sanitizePerfSamples({ sessionId: 's', samples: 'nope' })).toBeNull();
  });

  it('drops invalid entries but keeps valid ones', () => {
    expect(
      sanitizePerfSamples({
        sessionId: 's',
        samples: [
          { kind: 'input_hop', durMs: 5 },        // renderer may not claim input_hop
          { kind: 'echo_rtt', durMs: -1 },         // negative
          { kind: 'echo_rtt', durMs: Infinity },   // non-finite
          { kind: 'echo_rtt', durMs: 999999 },     // absurd (> 60s)
          { kind: 'echo_rtt', durMs: 42 },         // valid
          'garbage'                                 // non-object
        ]
      })
    ).toEqual({ sessionId: 's', samples: [{ kind: 'echo_rtt', durMs: 42 }] });
  });

  it('caps a batch at 1000 samples', () => {
    const samples = Array.from({ length: 2000 }, () => ({ kind: 'echo_rtt', durMs: 1 }));
    expect(sanitizePerfSamples({ sessionId: 's', samples })!.samples).toHaveLength(1000);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/perf.test.ts -t 'setPerfStateListener' && npx vitest run src/main/perfSamples.test.ts`
Expected: both FAIL — missing export / missing module.

- [ ] **Step 3: Implement.**

(a) In `src/main/perf.ts`, near the `let rt: Runtime | null = null;` module state:

```ts
/** Injected broadcaster for the one-way perf:state push (ipc.ts wires it to
 *  BrowserWindow — perf.ts stays Electron-free for testability). Fired with
 *  the effective recording state at the end of every initPerf, which covers
 *  reconfigurePerf too (it delegates to shutdown+init). */
let stateListener: ((recording: boolean) => void) | null = null;
export function setPerfStateListener(cb: ((recording: boolean) => void) | null): void {
  stateListener = cb;
}
```

In `initPerf`, add `stateListener?.(effective.recording);` in BOTH exit paths: immediately before the early `return` in the `if (!effective.recording)` branch, and as the last line of the function.

(b) Create `src/main/perfSamples.ts`:

```ts
// Validation for renderer-originated perf:samples batches (perf telemetry
// Phase 2). The renderer is untrusted input to main: unknown shapes are
// rejected, invalid entries dropped, batches capped. input_hop is absent by
// design — main measures it itself at pty:input receipt; a renderer must not
// be able to fabricate main-side measurements.

const RENDERER_KINDS = ['output_hop', 'echo_rtt'] as const;
export type RendererSampleKind = (typeof RENDERER_KINDS)[number];
const MAX_BATCH = 1000;
const MAX_DUR_MS = 60_000;

export interface PerfSampleBatch {
  sessionId: string;
  samples: Array<{ kind: RendererSampleKind; durMs: number }>;
}

export function sanitizePerfSamples(payload: unknown): PerfSampleBatch | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as { sessionId?: unknown; samples?: unknown };
  if (typeof p.sessionId !== 'string' || !Array.isArray(p.samples)) return null;
  const samples: PerfSampleBatch['samples'] = [];
  for (const s of p.samples.slice(0, MAX_BATCH * 2)) {
    if (samples.length >= MAX_BATCH) break;
    if (typeof s !== 'object' || s === null) continue;
    const { kind, durMs } = s as { kind?: unknown; durMs?: unknown };
    if (!RENDERER_KINDS.includes(kind as RendererSampleKind)) continue;
    if (typeof durMs !== 'number' || !Number.isFinite(durMs) || durMs < 0 || durMs > MAX_DUR_MS) continue;
    samples.push({ kind: kind as RendererSampleKind, durMs });
  }
  return { sessionId: p.sessionId, samples };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/perf.test.ts src/main/perfSamples.test.ts`
Expected: all PASS. (Note the cap test expects exactly 1000 kept from 2000 valid — the `slice(MAX_BATCH * 2)` pre-trim plus the `samples.length >= MAX_BATCH` break satisfy it.)

- [ ] **Step 5: Commit**

```bash
git add src/main/perf.ts src/main/perf.test.ts src/main/perfSamples.ts src/main/perfSamples.test.ts
git commit -m "feat(perf): perf:state listener hook + renderer sample-batch sanitizer"
```

---

### Task 4: Main + preload wiring (+ SPEC IPC-surface rows)

No new unit tests — `ipc.ts`/preload aren't vitest-loadable here; the pieces they glue (sanitizer, recorder, listener) were TDD'd in Tasks 2–3. Gate: `npm run typecheck`.

**Files:**
- Modify: `src/main/ipc.ts` — imports (~line 37), `handleWorkspaceId` declaration area (line 232), `pty:attach` handler (~line 1487-1545), `pty:input` handler (~line 1560), registration area near `reapplyPerfConfig` (~line 156)
- Modify: `src/preload/index.ts` — `pty` block (~line 507-538), `perf` block (~line 678-680)
- Modify: `docs/SPEC.md` — lines 240, 246, and the perf IPC block near line 344

**Interfaces:**
- Consumes: `recordLatencySample`, `setPerfStateListener`, `getEffectivePerf` (perf.ts); `sanitizePerfSamples` (perfSamples.ts).
- Produces (renderer-facing, Task 5 relies on these exact shapes):
  - `window.api.pty.input(sessionId: string, data: string, ts?: number)`
  - `window.api.pty.onData(sessionId, cb: (chunk: Uint8Array, ts?: number) => void)`
  - `window.api.perf.samples(payload: { sessionId: string; samples: Array<{ kind: 'output_hop' | 'echo_rtt'; durMs: number }> }): void` (fire-and-forget)
  - `window.api.perf.onState(cb: (recording: boolean) => void): () => void`

- [ ] **Step 1: ipc.ts imports.** Extend the perf import (line 37) with `recordLatencySample, setPerfStateListener` and add:

```ts
import { sanitizePerfSamples } from './perfSamples.js';
```

- [ ] **Step 2: broker-session map.** Below `const handleWorkspaceId = new Map<string, string>();` (line 232) add:

```ts
// ptyHandleId → brokerSessionId, for latency-sample session attribution
// (mirrors handleWorkspaceId's lifecycle: set on attach, deleted on end).
const handleBrokerSessionId = new Map<string, string>();
```

In `pty:attach`, next to `if (owner) handleWorkspaceId.set(ptyHandleId, owner.id);` add:

```ts
      handleBrokerSessionId.set(ptyHandleId, brokerSessionId);
```

In the `handle.stream.on('end', ...)` cleanup, next to `handleWorkspaceId.delete(ptyHandleId);` add:

```ts
        handleBrokerSessionId.delete(ptyHandleId);
```

- [ ] **Step 3: output-hop stamp.** In the `pty:attach` data handler, change:

```ts
        win?.webContents.send(`pty:data:${ptyHandleId}`, chunk);
```

to:

```ts
        // Second arg = epoch-ms send stamp for the renderer's output-hop
        // measurement (perf Phase 2). The chunk stays a raw Buffer.
        win?.webContents.send(`pty:data:${ptyHandleId}`, chunk, Date.now());
```

- [ ] **Step 4: input hop.** Replace the `pty:input` handler:

```ts
  ipcMain.handle('pty:input', (_e, sessionId: string, data: string, ts?: number) => {
    perfSetSpanContext({ workspaceId: handleWorkspaceId.get(sessionId) });
    ptySessions.get(sessionId)?.stream.write(data);
    // Renderer stamps only while recording (perf:state gate); skip missing
    // or future-skewed stamps rather than recording zeros.
    if (typeof ts === 'number') {
      const dur = Date.now() - ts;
      if (dur >= 0) {
        recordLatencySample(
          'input_hop',
          handleWorkspaceId.get(sessionId) ?? null,
          handleBrokerSessionId.get(sessionId) ?? null,
          dur
        );
      }
    }
  });
```

- [ ] **Step 5: samples channel + state broadcast.** Directly after the `reapplyPerfConfig` function definition (~line 164), add a registration inside `registerIpc` near where other `ipcMain.on`-style listeners live (search `ipcMain.on(` for the idiom; if none exists in ipc.ts, place it next to the `perf:status` handler at ~line 1343):

```ts
  // One-way renderer→main latency sample batches (perf Phase 2). Not an
  // invoke: no response, no span (instrumentIpcHandle wraps handle() only).
  ipcMain.on('perf:samples', (_e, payload: unknown) => {
    if (!getEffectivePerf()?.recording) return; // belt and braces — renderer also gates
    const batch = sanitizePerfSamples(payload);
    if (!batch) return;
    const ws = handleWorkspaceId.get(batch.sessionId) ?? null;
    const sess = handleBrokerSessionId.get(batch.sessionId) ?? null;
    for (const s of batch.samples) recordLatencySample(s.kind, ws, sess, s.durMs);
  });

  // One-way main→renderer recording-state push (perf Phase 2): fires on
  // every initPerf/reconfigurePerf — Settings toggle, MCP perf_set, and
  // startup all funnel through there. Windows created later pull the
  // initial state via perf:status.
  setPerfStateListener((recording) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('perf:state', recording);
    }
  });
```

- [ ] **Step 6: preload.** In `src/preload/index.ts`:

(a) `pty.input` (line ~518):

```ts
    input: (sessionId: string, data: string, ts?: number) =>
      ipcRenderer.invoke('pty:input', sessionId, data, ts),
```

(b) `pty.onData` (line ~526):

```ts
    onData: (sessionId: string, cb: (chunk: Uint8Array, ts?: number) => void) => {
      const channel = `pty:data:${sessionId}`;
      const handler = (_e: IpcRendererEvent, chunk: Buffer, ts?: number) => cb(new Uint8Array(chunk), ts);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
```

(c) `perf` block (line ~678):

```ts
  perf: {
    status: (): Promise<PerfStatusPayload> => ipcRenderer.invoke('perf:status'),
    /** Fire-and-forget latency sample batch (perf Phase 2). */
    samples: (payload: {
      sessionId: string;
      samples: Array<{ kind: 'output_hop' | 'echo_rtt'; durMs: number }>;
    }): void => ipcRenderer.send('perf:samples', payload),
    /** Subscribe to recording-state pushes. Returns an unsubscribe fn. */
    onState: (cb: (recording: boolean) => void): (() => void) => {
      const handler = (_e: IpcRendererEvent, recording: boolean): void => cb(recording);
      ipcRenderer.on('perf:state', handler);
      return () => ipcRenderer.removeListener('perf:state', handler);
    }
  }
```

- [ ] **Step 7: SPEC IPC rows.** In `docs/SPEC.md`:

(a) Line 240, replace:

`` - `pty:input(ptyHandleId, data: string)` → `void` — write user input to the broker as an INPUT frame on the channel. ``

with:

`` - `pty:input(ptyHandleId, data: string, ts?: number)` → `void` — write user input to the broker as an INPUT frame on the channel. `ts` is the renderer's epoch-ms keystroke stamp (present only while perf recording is on); main records `receipt − ts` as an `input_hop` latency sample. ``

(b) Line 246, replace:

`` - `pty:data:${sessionId}` — `Buffer` chunks from the container's stdout/stderr. ``

with:

`` - `pty:data:${sessionId}` — `Buffer` chunks from the container's stdout/stderr, plus an epoch-ms send stamp as a second argument (the chunk itself stays a raw Buffer) for the renderer's `output_hop` measurement. ``

(c) After the `perf:status` bullet (~line 344), add two bullets:

```
- `perf:samples` (one-way, renderer → main via `ipcRenderer.send`) — `{ sessionId: ptyHandleId, samples: [{ kind: 'output_hop'|'echo_rtt', durMs }] }` batches, ~5 s cadence per terminal session. Validated by `sanitizePerfSamples` (unknown shapes rejected, entries capped, `input_hop` deliberately not accepted from the renderer); dropped entirely while recording is off.
- `perf:state` (one-way, main → renderer via `webContents.send`) — `boolean` recording state, pushed to every window on each perf init/reconfigure (Settings toggle, MCP `perf_set`, startup). The renderer gates all latency stamping/batching on it; windows pull the initial value from `perf:status`.
```

- [ ] **Step 8: Typecheck + commit**

Run: `npm run typecheck`
Expected: clean.

```bash
git add src/main/ipc.ts src/preload/index.ts docs/SPEC.md
git commit -m "feat(perf): latency-hop wiring — pty timestamps, perf:samples/perf:state channels"
```

---

### Task 5: Renderer wiring — `perfState.ts` + `TerminalSession.tsx` sampling

**Files:**
- Create: `src/renderer/src/perfState.ts`
- Modify: `src/renderer/src/components/TerminalSession.tsx` (attach effect, ~lines 407-462 and cleanup ~line 531)
- Test: `src/renderer/src/perfState.test.ts`

**Interfaces:**
- Consumes: `EchoRttTracker` (Task 1); `window.api.pty.input/onData` new shapes and `window.api.perf.samples/onState/status` (Task 4).
- Produces: `initPerfState(): void` (idempotent) and `perfRecording(): boolean` — consulted per keystroke/chunk.

- [ ] **Step 1: Write the failing test** — create `src/renderer/src/perfState.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initPerfState, perfRecording, __resetPerfStateForTests } from './perfState.js';

interface FakeApi {
  perf: {
    status: () => Promise<{ enabled: boolean }>;
    onState: (cb: (recording: boolean) => void) => () => void;
  };
}

describe('perfState', () => {
  let stateCb: ((recording: boolean) => void) | null = null;

  beforeEach(() => {
    __resetPerfStateForTests();
    stateCb = null;
    (globalThis as unknown as { window: { api: FakeApi } }).window = {
      api: {
        perf: {
          status: vi.fn(async () => ({ enabled: true })),
          onState: (cb) => {
            stateCb = cb;
            return () => {};
          }
        }
      }
    };
  });

  it('defaults to off, pulls initial state, and follows pushes', async () => {
    expect(perfRecording()).toBe(false);
    initPerfState();
    await Promise.resolve(); // let the status() promise settle
    await Promise.resolve();
    expect(perfRecording()).toBe(true);
    stateCb!(false);
    expect(perfRecording()).toBe(false);
    stateCb!(true);
    expect(perfRecording()).toBe(true);
  });

  it('init is idempotent (one subscription, one status pull)', async () => {
    initPerfState();
    initPerfState();
    const api = (globalThis as unknown as { window: { api: FakeApi } }).window.api;
    expect(api.perf.status).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/perfState.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — create `src/renderer/src/perfState.ts`:

```ts
// Renderer-side perf recording gate (perf telemetry Phase 2). Module
// singleton: one perf:state subscription + one initial perf:status pull for
// the whole window; terminal sessions consult perfRecording() per event.
// Defaults to OFF until told otherwise — worst case the first seconds of
// samples after startup are lost, never spurious work while disabled.

let recording = false;
let initialized = false;

export function initPerfState(): void {
  if (initialized) return;
  initialized = true;
  window.api.perf.onState((r) => {
    recording = r;
  });
  void window.api.perf
    .status()
    .then((s) => {
      recording = s.enabled;
    })
    .catch(() => {});
}

export function perfRecording(): boolean {
  return recording;
}

/** Test seam: perfState is module-global; tests must reset between cases. */
export function __resetPerfStateForTests(): void {
  recording = false;
  initialized = false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/perfState.test.ts`
Expected: 2/2 PASS.

- [ ] **Step 5: Wire `TerminalSession.tsx`.** All edits are inside the attach effect (the `async` block that calls `window.api.pty.attach`, ~line 398) and its cleanup.

(a) Imports (top of file, alongside the other `../` imports):

```ts
import { EchoRttTracker } from '../echoRtt';
import { initPerfState, perfRecording } from '../perfState';
```

(b) Declare the sampling state next to the effect's existing locals (where `unsubData`/`unsubEnd` are declared — same scope, so cleanup can reach the timer):

```ts
      let sampleTimer: ReturnType<typeof setInterval> | null = null;
```

(c) After `ptyHandleRef.current = sid;` (~line 419) add:

```ts
        // Latency sampling (perf Phase 2): keystroke→echo pairing + output
        // hop, batched to main every 5s. Gated on perfRecording() per event.
        initPerfState();
        const echoTracker = new EchoRttTracker();
        const sampleBatch: Array<{ kind: 'output_hop' | 'echo_rtt'; durMs: number }> = [];
        sampleTimer = setInterval(() => {
          if (sampleBatch.length === 0) return;
          window.api.perf.samples({ sessionId: sid, samples: sampleBatch.splice(0) });
        }, 5000);
```

(d) Replace the `onData` registration (~line 424-429):

```ts
        unsubData = window.api.pty.onData(sid, (chunk, ts) => {
          if (perfRecording()) {
            const arrival = performance.timeOrigin + performance.now();
            for (const rtt of echoTracker.output(arrival)) {
              sampleBatch.push({ kind: 'echo_rtt', durMs: rtt });
            }
            if (typeof ts === 'number') {
              // Completion callback fires after xterm has processed the chunk.
              term.write(chunk, () => {
                sampleBatch.push({
                  kind: 'output_hop',
                  durMs: performance.timeOrigin + performance.now() - ts
                });
              });
            } else {
              term.write(chunk);
            }
          } else {
            term.write(chunk);
          }
          // Watch the title glyph for busy/idle; report only on a flip.
          const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
          if (activity.push(text)) onActivityChange?.(sessionId, activity.isBusy);
        });
```

(e) Replace the `term.onData` registration (~line 449-454):

```ts
        term.onData((data) => {
          // First user keystroke ⇒ they're interacting; cancel any pending
          // repaint nudge so we never inject Ctrl+L into an active session.
          disarmNudge();
          if (perfRecording()) {
            const ts = performance.timeOrigin + performance.now();
            echoTracker.keystroke(ts);
            window.api.pty.input(sid, data, ts);
          } else {
            window.api.pty.input(sid, data);
          }
        });
```

(f) In the effect cleanup (where `unsubData`/`unsubEnd` are disposed and `window.api.pty.detach` is called, ~line 531), add:

```ts
      if (sampleTimer) clearInterval(sampleTimer);
```

- [ ] **Step 6: Full renderer gate**

Run: `npm run typecheck && npx vitest run src/renderer/src && npm run build`
Expected: all clean/green.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/perfState.ts src/renderer/src/perfState.test.ts src/renderer/src/components/TerminalSession.tsx
git commit -m "feat(perf): renderer latency sampling — echo pairing, output hop, gated batching"
```

---

### Task 6: Full gate + PR

**Files:** none new.

- [ ] **Step 1: Full local gate**

Run: `npm run typecheck && npm run test:unit && npm run build`
Expected: all three succeed.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin feat/perf-latency-hops
gh pr create --head feat/perf-latency-hops --title "feat(perf): terminal latency hops — input/output hop + echo RTT (tracing expansion PR B)" --body "$(cat <<'EOF'
## Summary
- Phase 2 of the perf-telemetry design: user-perceived terminal latency, per hop
- **input_hop**: renderer stamps keystrokes (`pty:input` gains an optional trailing epoch-ms `ts`); main records receipt − ts
- **output_hop**: main stamps `pty:data` sends with a second epoch-ms argument (the chunk stays a raw Buffer); renderer measures after `term.write` completes
- **echo_rtt**: pure `echoRtt.ts` tracker pairs each keystroke with the next output arrival within 2 s
- Renderer batches samples every 5 s over a new one-way `perf:samples` channel; gating is renderer-side via the new `perf:state` push (fired from initPerf/reconfigurePerf — covers the Settings toggle and the MCP `perf_set` lever); main additionally sanitizes (`sanitizePerfSamples`: shape validation, batch cap, renderer cannot claim `input_hop`) and drops batches while recording is off
- Persisted via histogram support in `SqliteMetricExporter`: one row per (kind, session) per ~5 s window, `dur_ms` = max, `meta` = `{count, sum, min, max, buckets}` — the kinds were reserved in the Phase 1 schema, so **no migration**

Spec: `docs/superpowers/specs/2026-08-08-perf-tracing-expansion-design.md` (PR B sections B1–B5). PR A was #280.

## Verification
Gated with typecheck + unit tests + build in the dev container (no display); the Playwright terminal specs in CI are the regression gate for the pty payload changes. First dogfood check after merge: `SELECT kind, COUNT(*), MAX(dur_ms) FROM perf_events WHERE kind IN ('input_hop','output_hop','echo_rtt') GROUP BY kind` after a few minutes of typing in any session.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR URL printed.

---

## Self-review notes (already applied)

- **Spec coverage:** B1 → Task 4 Step 4 (+ preload); B2 → Task 4 Step 3 + Task 5 Step 5d; B3 → Task 1 + Task 5; B4 → Task 3 (listener + sanitizer) + Task 4 Step 5 + Task 5 (gating); B5 → Task 2. SPEC edits split per same-commit rule (Task 2 = §6, Task 4 = IPC rows).
- **Type consistency:** `LatencyKind` (perf.ts) is the superset; `RendererSampleKind` (perfSamples.ts) is the renderer-allowed subset — `recordLatencySample` accepts both. `window.api.perf.samples` payload shape matches `sanitizePerfSamples` input and Task 5's batch type.
- **Deliberate choices:** `pty:data` ts always sent (constant shape, `Date.now()` per chunk is negligible) while renderer gates measurement; `input_hop` skipped (not zeroed) when `ts` missing or clock-skew-negative; echo tracker caps pending at 256 to bound paste storms.
