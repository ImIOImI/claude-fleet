# Stall Sentinel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A worker-thread co-stall detector, armed/disarmed/inspected via the fleet-state MCP server, that annotates stall rows with `meta.sentinel` (did a second event loop stall in the same window?) and `meta.cpu` (system utilization) — discriminating OS-level starvation from main-loop blocks.

**Architecture:** New Electron-free `perfSentinel.ts` owns a worker thread (inline `eval` script running its own `monitorEventLoopDelay`, posting windows every 5 s; `unref`'d so it can never keep the app alive). `perf.ts`'s stall sampler consults it per stall row and always stamps CPU utilization from `os.cpus()` deltas. MCP gains `perf_sentinel_set({enabled, ttlHours?})` in the `perf_set` family; `perf_status` gains a `sentinel` block. Never persisted: every app start is disarmed; `shutdownPerf` (and thus recording-off and app quit) disarms.

**Tech Stack:** TypeScript (Electron main), node:worker_threads, node:os, vitest, MCP contract tests (unit + Playwright e2e).

**Spec:** `docs/superpowers/specs/2026-08-19-stall-sentinel-design.md` (binding, incl. lifetime policy: until restart/manual stop, optional ttlHours ≤ 168).

## Global Constraints

- Branch: `perf/stall-sentinel` (from origin/main @ e7f6409; spec commit already on it). Worktree `/workspace/claude-fleet/.claude/worktrees/perf-tracing-expansion`; never `cd /workspace/claude-fleet`.
- Gate = `npm run typecheck` + `npm run test:unit` + `npm run build`; Playwright CI-only (flake #305 may need a rerun).
- `perfSentinel.ts` must NOT import `perf.ts` (perf.ts imports it — no cycles). It defines its own `SENTINEL_STALL_THRESHOLD_MS = 50` and `SENTINEL_SAMPLE_INTERVAL_MS = 5000`, documented as mirrors of perf.ts's values.
- MCP surface change ⇒ update `mcpServer.test.ts` AND `tests/mcp-server.spec.ts` in the same task (repo contract-test convention); SPEC §6/§11 in the same commits as the behavior.
- `ttlHours` validation: number in (0, 168]; extra args rejected (same hardening as `perf_set`); arming requires recording enabled.
- perf.ts stays Electron-free; `db.ts` untouched.
- No schema migration (meta is JSON), no new deps, no Settings-UI work.

---

### Task 1: `src/main/perfSentinel.ts` (TDD)

**Files:**
- Create: `src/main/perfSentinel.ts`
- Test: `src/main/perfSentinel.test.ts`

**Interfaces:**
- Consumes: node:worker_threads only.
- Produces (Tasks 2–3 rely on these exactly):
  ```ts
  export interface SentinelStatus {
    enabled: boolean;
    startedAt: number | null;
    expiresAt: number | null;
    lastWorkerWindow: { p50: number; p99: number; max: number; ageMs: number } | null;
  }
  export type SentinelWindowVerdict =
    | { workerMaxMs: number; aligned: boolean; ageMs: number }
    | { stale: true; ageMs: number };
  export interface SentinelHooks {
    workerFactory?: () => SentinelWorkerLike;   // test seam
    sampleIntervalMs?: number;
    now?: () => number;
  }
  export interface SentinelWorkerLike {
    on(event: 'message', cb: (win: { p50: number; p99: number; max: number }) => void): void;
    unref(): void;
    terminate(): Promise<unknown> | void;
  }
  export function armSentinel(opts?: { ttlHours?: number }, hooks?: SentinelHooks): void
  export function disarmSentinel(): void
  export function sentinelStatus(): SentinelStatus
  export function sentinelWindowFor(nowMs: number): SentinelWindowVerdict | null  // null = not armed
  ```

- [ ] **Step 1: Write the failing tests** — create `src/main/perfSentinel.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import {
  armSentinel, disarmSentinel, sentinelStatus, sentinelWindowFor,
  type SentinelWorkerLike
} from './perfSentinel.js';

type MsgCb = (win: { p50: number; p99: number; max: number }) => void;
function fakeWorker(): { worker: SentinelWorkerLike; emit: MsgCb; terminated: () => boolean } {
  let cb: MsgCb = () => {};
  let terminated = false;
  return {
    worker: {
      on: (_e, c) => { cb = c; },
      unref: () => {},
      terminate: () => { terminated = true; }
    },
    emit: (w) => cb(w),
    terminated: () => terminated
  };
}

afterEach(() => disarmSentinel());

describe('stall sentinel', () => {
  it('disarmed by default; sentinelWindowFor is null; status is empty', () => {
    expect(sentinelStatus()).toEqual({ enabled: false, startedAt: null, expiresAt: null, lastWorkerWindow: null });
    expect(sentinelWindowFor(1000)).toBeNull();
  });

  it('armed: fresh worker windows produce aligned/unaligned verdicts', () => {
    const f = fakeWorker();
    let clock = 10_000;
    armSentinel(undefined, { workerFactory: () => f.worker, sampleIntervalMs: 5000, now: () => clock });
    f.emit({ p50: 2, p99: 10, max: 120 }); // worker stalled too
    clock = 11_000;
    expect(sentinelWindowFor(clock)).toEqual({ workerMaxMs: 120, aligned: true, ageMs: 1000 });
    f.emit({ p50: 2, p99: 10, max: 12 }); // worker healthy
    expect(sentinelWindowFor(clock)).toEqual({ workerMaxMs: 12, aligned: false, ageMs: 0 });
  });

  it('armed but window older than 2 intervals reports stale (starvation evidence itself)', () => {
    const f = fakeWorker();
    let clock = 10_000;
    armSentinel(undefined, { workerFactory: () => f.worker, sampleIntervalMs: 5000, now: () => clock });
    f.emit({ p50: 1, p99: 2, max: 3 });
    clock = 10_000 + 10_001; // > 2 × 5000
    expect(sentinelWindowFor(clock)).toEqual({ stale: true, ageMs: 10_001 });
  });

  it('armed with no window yet reports stale with age since start', () => {
    const f = fakeWorker();
    let clock = 10_000;
    armSentinel(undefined, { workerFactory: () => f.worker, sampleIntervalMs: 5000, now: () => clock });
    clock = 30_001; // silence > 2 intervals — worker never reported
    expect(sentinelWindowFor(clock)).toEqual({ stale: true, ageMs: 20_001 });
  });

  it('ttlHours sets expiresAt and re-arming resets it; disarm terminates the worker', () => {
    const f = fakeWorker();
    const clock = 50_000;
    armSentinel({ ttlHours: 1 }, { workerFactory: () => f.worker, now: () => clock });
    expect(sentinelStatus().expiresAt).toBe(clock + 3_600_000);
    const f2 = fakeWorker();
    armSentinel(undefined, { workerFactory: () => f2.worker, now: () => clock });
    expect(f.terminated()).toBe(true); // re-arm replaced the old worker
    expect(sentinelStatus().expiresAt).toBeNull();
    disarmSentinel();
    expect(f2.terminated()).toBe(true);
    expect(sentinelStatus().enabled).toBe(false);
  });

  it('smoke: a real worker thread reports at least one window', async () => {
    armSentinel(undefined, { sampleIntervalMs: 50 });
    await new Promise((r) => setTimeout(r, 400));
    const s = sentinelStatus();
    expect(s.enabled).toBe(true);
    expect(s.lastWorkerWindow).not.toBeNull();
    expect(s.lastWorkerWindow!.max).toBeGreaterThanOrEqual(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/perfSentinel.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — create `src/main/perfSentinel.ts`:

```ts
// Stall sentinel (spec 2026-08-19-stall-sentinel-design.md): a second event
// loop in a worker thread. Main-and-worker stalling in the same window is
// the OS-starvation signature; main-only means a genuine main-loop blocker.
// Electron-free and perf.ts-free (perf.ts imports us — no cycles); the two
// constants mirror perf.ts's STALL_THRESHOLD_MS / SAMPLE_INTERVAL_MS.
// NEVER persisted: every app start is disarmed; the worker and the TTL
// timer are unref'd so the sentinel can never keep the app alive.

import { Worker } from 'node:worker_threads';

const SENTINEL_STALL_THRESHOLD_MS = 50;
const SENTINEL_SAMPLE_INTERVAL_MS = 5000;
const MAX_TTL_HOURS = 168;

const WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const h = monitorEventLoopDelay({ resolution: 10 });
h.enable();
setInterval(() => {
  parentPort.postMessage({ p50: h.percentile(50) / 1e6, p99: h.percentile(99) / 1e6, max: h.max / 1e6 });
  h.reset();
}, workerData.sampleIntervalMs);
`;

export interface SentinelStatus {
  enabled: boolean;
  startedAt: number | null;
  expiresAt: number | null;
  lastWorkerWindow: { p50: number; p99: number; max: number; ageMs: number } | null;
}

export type SentinelWindowVerdict =
  | { workerMaxMs: number; aligned: boolean; ageMs: number }
  | { stale: true; ageMs: number };

export interface SentinelWorkerLike {
  on(event: 'message', cb: (win: { p50: number; p99: number; max: number }) => void): void;
  unref(): void;
  terminate(): Promise<unknown> | void;
}

export interface SentinelHooks {
  workerFactory?: () => SentinelWorkerLike;
  sampleIntervalMs?: number;
  now?: () => number;
}

interface State {
  worker: SentinelWorkerLike;
  startedAt: number;
  expiresAt: number | null;
  ttlTimer: NodeJS.Timeout | null;
  sampleIntervalMs: number;
  now: () => number;
  lastWindow: { p50: number; p99: number; max: number; at: number } | null;
}
let state: State | null = null;

export function armSentinel(opts?: { ttlHours?: number }, hooks?: SentinelHooks): void {
  const ttl = opts?.ttlHours;
  if (ttl !== undefined && (!Number.isFinite(ttl) || ttl <= 0 || ttl > MAX_TTL_HOURS)) {
    throw new Error(`ttlHours must be in (0, ${MAX_TTL_HOURS}]`);
  }
  disarmSentinel(); // idempotent re-arm: replace worker, reset TTL
  const now = hooks?.now ?? Date.now;
  const sampleIntervalMs = hooks?.sampleIntervalMs ?? SENTINEL_SAMPLE_INTERVAL_MS;
  const worker: SentinelWorkerLike =
    hooks?.workerFactory?.() ??
    new Worker(WORKER_SRC, { eval: true, workerData: { sampleIntervalMs } });
  const s: State = {
    worker,
    startedAt: now(),
    expiresAt: ttl !== undefined ? now() + ttl * 3_600_000 : null,
    ttlTimer: null,
    sampleIntervalMs,
    now,
    lastWindow: null
  };
  worker.on('message', (win) => {
    s.lastWindow = { ...win, at: s.now() };
  });
  worker.unref();
  if (ttl !== undefined) {
    s.ttlTimer = setTimeout(() => disarmSentinel(), ttl * 3_600_000);
    s.ttlTimer.unref();
  }
  state = s;
}

export function disarmSentinel(): void {
  const s = state;
  state = null;
  if (!s) return;
  if (s.ttlTimer) clearTimeout(s.ttlTimer);
  void s.worker.terminate();
}

export function sentinelStatus(): SentinelStatus {
  if (!state) return { enabled: false, startedAt: null, expiresAt: null, lastWorkerWindow: null };
  const { lastWindow, now } = state;
  return {
    enabled: true,
    startedAt: state.startedAt,
    expiresAt: state.expiresAt,
    lastWorkerWindow: lastWindow
      ? { p50: lastWindow.p50, p99: lastWindow.p99, max: lastWindow.max, ageMs: now() - lastWindow.at }
      : null
  };
}

/** Verdict for a stall observed at nowMs; null when not armed. A window
 *  older than 2 sample intervals (or never received) reports stale — an
 *  armed-but-silent worker is itself starvation evidence. */
export function sentinelWindowFor(nowMs: number): SentinelWindowVerdict | null {
  const s = state;
  if (!s) return null;
  const w = s.lastWindow;
  if (!w) return { stale: true, ageMs: nowMs - s.startedAt };
  const ageMs = nowMs - w.at;
  if (ageMs > 2 * s.sampleIntervalMs) return { stale: true, ageMs };
  return { workerMaxMs: w.max, aligned: w.max > SENTINEL_STALL_THRESHOLD_MS, ageMs };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/perfSentinel.test.ts`
Expected: 6/6 PASS (the smoke test spawns a real worker — allow its ~400 ms).

- [ ] **Step 5: Commit**

```bash
git add src/main/perfSentinel.ts src/main/perfSentinel.test.ts
git commit -m "feat(perf): worker-thread stall sentinel — co-stall detector with TTL and never-persisted lifecycle"
```

---

### Task 2: `perf.ts` integration — meta.sentinel + meta.cpu on stall rows (TDD)

**Files:**
- Modify: `src/main/perf.ts` — imports; `PerfStatus` interface + `getPerfStatus`; the stall sampler (`rt.sampleTimer = setInterval(...)` block); `shutdownPerf`
- Test: `src/main/perf.test.ts`

**Interfaces:**
- Consumes: `sentinelWindowFor`, `sentinelStatus`, `disarmSentinel`, `armSentinel` (tests), `type SentinelStatus` from `./perfSentinel.js`; `node:os` `cpus`.
- Produces: `PerfStatus` gains `sentinel: SentinelStatus` (Task 3's `perf_status` inherits it); stall rows' meta gains `cpu: { utilization }` always and `sentinel: <verdict>` when armed.

- [ ] **Step 1: Write the failing tests** — append to `src/main/perf.test.ts` (extend imports: `armSentinel, disarmSentinel, sentinelStatus` from `./perfSentinel.js`):

```ts
describe('stall rows: cpu + sentinel enrichment', () => {
  afterEach(() => disarmSentinel());

  it('every stall row carries meta.cpu.utilization in [0,1]', async () => {
    initPerf(store, ON, { delaySource: () => ({ p50: 2, p99: 8, max: 120 }), sampleIntervalMs: 20 });
    await sleep(100);
    await shutdownPerf();
    const rows = db.prepare(`SELECT meta FROM perf_events WHERE kind='stall'`).all() as Array<{ meta: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const r of rows) {
      const u = JSON.parse(r.meta).cpu?.utilization;
      expect(typeof u).toBe('number');
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThanOrEqual(1);
    }
  });

  it('armed sentinel annotates stall rows; disarmed leaves meta.sentinel absent', async () => {
    let cb: (w: { p50: number; p99: number; max: number }) => void = () => {};
    armSentinel(undefined, {
      workerFactory: () => ({ on: (_e, c) => { cb = c; }, unref: () => {}, terminate: () => {} }),
      sampleIntervalMs: 20
    });
    cb({ p50: 1, p99: 2, max: 200 }); // worker co-stalled
    initPerf(store, ON, { delaySource: () => ({ p50: 2, p99: 8, max: 120 }), sampleIntervalMs: 20 });
    await sleep(60);
    disarmSentinel();
    await sleep(60);
    await shutdownPerf();
    const rows = db.prepare(`SELECT meta FROM perf_events WHERE kind='stall' ORDER BY id`).all() as Array<{ meta: string }>;
    const metas = rows.map((r) => JSON.parse(r.meta));
    expect(metas.some((m) => m.sentinel?.aligned === true)).toBe(true); // while armed
    expect(metas.some((m) => m.sentinel === undefined)).toBe(true);     // after disarm
  });

  it('shutdownPerf disarms the sentinel (covers recording-off via reconfigure)', async () => {
    armSentinel(undefined, {
      workerFactory: () => ({ on: () => {}, unref: () => {}, terminate: () => {} })
    });
    initPerf(store, ON);
    await shutdownPerf();
    expect(sentinelStatus().enabled).toBe(false);
  });

  it('getPerfStatus includes the sentinel block', () => {
    initPerf(store, ON);
    const s = getPerfStatus();
    expect(s.sentinel).toEqual({ enabled: false, startedAt: null, expiresAt: null, lastWorkerWindow: null });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/perf.test.ts -t 'sentinel'`
Expected: FAIL — meta.cpu/meta.sentinel missing, PerfStatus lacks sentinel.

- [ ] **Step 3: Implement in `src/main/perf.ts`:**

(a) Imports:

```ts
import { cpus } from 'node:os';
import { disarmSentinel, sentinelStatus, sentinelWindowFor, type SentinelStatus } from './perfSentinel.js';
```

(b) `PerfStatus` interface: add `sentinel: SentinelStatus;` and in `getPerfStatus` return `sentinel: sentinelStatus()`.

(c) CPU sampling helper — module scope near the sampler:

```ts
/** System-wide busy fraction since the previous call (0..1, 3 decimals).
 *  Starving hosts show sustained ~1.0 — stamped on every stall row so
 *  starvation is diagnosable even without the sentinel armed. */
function makeCpuSampler(): () => number {
  let prev = cpus();
  return () => {
    const cur = cpus();
    let idle = 0;
    let total = 0;
    for (let i = 0; i < cur.length; i += 1) {
      const c = cur[i].times;
      const p = prev[i]?.times ?? { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 };
      idle += c.idle - p.idle;
      total += c.user - p.user + c.nice - p.nice + c.sys - p.sys + c.idle - p.idle + c.irq - p.irq;
    }
    prev = cur;
    if (total <= 0) return 0;
    return Math.round((1 - idle / total) * 1000) / 1000;
  };
}
```

(d) In `initPerf`, before the sampler interval: `const cpuSample = makeCpuSampler();`. In the sampler callback, build the stall meta as:

```ts
    if (w.max > STALL_THRESHOLD_MS) {
      const nowMs = Date.now();
      const sv = sentinelWindowFor(nowMs);
      rt?.store.enqueue({
        ts: nowMs,
        kind: 'stall',
        durMs: w.max,
        meta: { ...w, cpu: { utilization: cpuSample() }, ...(sv ? { sentinel: sv } : {}) }
      });
    }
```

NOTE: `cpuSample()` must be called ONLY on the stall path (not every window) so the busy-fraction window spans stall-to-stall; that is fine for diagnosis (document with the one-line comment above). Keep the existing suspend-discard guard and `Object.assign(lastWindow, w)` untouched.

(e) `shutdownPerf`: add `disarmSentinel();` alongside the suspend-state resets.

- [ ] **Step 4: Run the perf suites**

Run: `npx vitest run src/main/perf.test.ts src/main/perfSentinel.test.ts`
Expected: all PASS (pre-existing stall tests must still pass — meta gains keys, and existing assertions like `JSON.parse(meta)).toEqual({p50,p99,max})` may now FAIL: if so, update those assertions to `expect(JSON.parse(rows[0].meta)).toMatchObject({ p50: 2, p99: 8, max: 120 })` — adapting the pre-existing exact-equality to a superset match is the correct fix, note it in the report).

- [ ] **Step 5: Commit**

```bash
git add src/main/perf.ts src/main/perf.test.ts
git commit -m "feat(perf): stamp stall rows with cpu utilization + sentinel verdicts; sentinel in PerfStatus"
```

---

### Task 3: MCP `perf_sentinel_set` + contract tests + SPEC

**Files:**
- Modify: `src/main/mcpServer.ts` (perf tool block, ~line 1151–1193): new tool after `perf_set`; update `perf_status` description; extend the `./perf.js` import with `getEffectivePerf` and add `armSentinel, disarmSentinel` from `./perfSentinel.js`
- Modify: `src/main/mcpServer.test.ts` (~line 640 perf block)
- Modify: `tests/mcp-server.spec.ts` (~line 125 tool-name pin)
- Modify: `docs/SPEC.md` (§6 + §11)

**Interfaces:**
- Consumes: `armSentinel(opts?)`, `disarmSentinel()` (Task 1); `getPerfStatus` now sentinel-bearing (Task 2); `getEffectivePerf` (existing perf.ts export).

- [ ] **Step 1: Write the failing unit tests** — append to the perf describe in `src/main/mcpServer.test.ts` (mirror the fixture style of the existing `perf_set` tests there — they initialize perf; reuse that setup; import `sentinelStatus, disarmSentinel` from `./perfSentinel.js` and add an `afterEach(() => disarmSentinel())`):

```ts
  it('perf_sentinel_set is registered with the pinned schema', () => {
    const t = TOOLS.find((x) => x.name === 'perf_sentinel_set')!;
    expect(t.inputSchema).toEqual({
      type: 'object',
      properties: { enabled: { type: 'boolean' }, ttlHours: { type: 'number' } },
      required: ['enabled']
    });
  });

  it('perf_sentinel_set arms (with ttl), reports via perf_status, and disarms', async () => {
    const t = TOOLS.find((x) => x.name === 'perf_sentinel_set')!;
    const armed = await t.run(db, { enabled: true, ttlHours: 1 });
    expect((armed as { sentinel: { enabled: boolean; expiresAt: number | null } }).sentinel.enabled).toBe(true);
    expect((armed as { sentinel: { expiresAt: number | null } }).sentinel.expiresAt).not.toBeNull();
    const disarmed = await t.run(db, { enabled: false });
    expect((disarmed as { sentinel: { enabled: boolean } }).sentinel.enabled).toBe(false);
  });

  it('perf_sentinel_set validates ttlHours and rejects extra args', async () => {
    const t = TOOLS.find((x) => x.name === 'perf_sentinel_set')!;
    await expect(t.run(db, { enabled: true, ttlHours: 0 })).rejects.toThrow(/ttlHours/);
    await expect(t.run(db, { enabled: true, ttlHours: 169 })).rejects.toThrow(/ttlHours/);
    await expect(t.run(db, { enabled: true, endpoint: 'http://evil' })).rejects.toThrow(/unexpected/);
  });

  it('perf_sentinel_set refuses to arm while recording is disabled', async () => {
    // adapt to the fixture: reconfigure perf OFF (or shutdown) the way the existing perf_set tests do, then:
    const t = TOOLS.find((x) => x.name === 'perf_sentinel_set')!;
    await expect(t.run(db, { enabled: true })).rejects.toThrow(/recording/);
    // disarm must still work while recording is off:
    await expect(t.run(db, { enabled: false })).resolves.toBeTruthy();
  });
```

(Adapt `t.run(db, …)` argument shapes to the file's existing perf_set test invocations — copy their calling convention exactly.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/main/mcpServer.test.ts -t 'perf_sentinel'`
Expected: FAIL — tool not found.

- [ ] **Step 3: Implement in `src/main/mcpServer.ts`** — insert after the `perf_set` tool object (~line 1193), and extend the perf imports:

```ts
  {
    name: 'perf_sentinel_set',
    description:
      'Arm or disarm the stall sentinel: a worker-thread co-stall detector that annotates stall rows ' +
      'with meta.sentinel, discriminating OS-level starvation (worker stalled too) from main-loop blocks. ' +
      'Armed until app restart, manual disarm, or optional ttlHours (max 168); never persisted. ' +
      'Requires perf recording to be enabled. Returns the resulting perf_status.',
    inputSchema: {
      type: 'object',
      properties: { enabled: { type: 'boolean' }, ttlHours: { type: 'number' } },
      required: ['enabled']
    },
    run: async (_db: Database.Database, args: Record<string, unknown>) => {
      const extras = Object.keys(args).filter((k) => k !== 'enabled' && k !== 'ttlHours');
      if (extras.length > 0) {
        throw new Error(`perf_sentinel_set: unexpected arguments: ${extras.join(', ')}`);
      }
      if (args.enabled === true) {
        const ttl = args.ttlHours;
        if (ttl !== undefined && (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl <= 0 || ttl > 168)) {
          throw new Error('ttlHours must be a number in (0, 168]');
        }
        if (!getEffectivePerf()?.recording) {
          throw new Error('perf recording is disabled — enable it (perf_set) before arming the sentinel');
        }
        armSentinel(ttl !== undefined ? { ttlHours: ttl } : undefined);
      } else {
        disarmSentinel();
      }
      return getPerfStatus();
    }
  },
```

Also update `perf_status`'s `description` string: append `' Includes the stall-sentinel status (see perf_sentinel_set).'`

- [ ] **Step 4: e2e contract pin.** In `tests/mcp-server.spec.ts` (~line 125), add `'perf_sentinel_set'` to the expected tool-name list (keep the list's existing ordering convention — insert after `'perf_set'`).

- [ ] **Step 5: SPEC.md.**

(a) §11, after the `perf_set` bullet, add:

`` - `perf_sentinel_set({ enabled, ttlHours? })` — arm/disarm the stall sentinel (worker-thread co-stall detector; stall rows gain `meta.sentinel` while armed). **No grant required** — same class as `perf_set`: a mediated, app-global diagnostics switch exposing no cross-workspace data. Arming requires recording enabled; `ttlHours` (0, 168] auto-disarms; **never persisted** — every app start comes up disarmed, and disabling recording disarms too. Returns the resulting `perf_status`, which now includes `sentinel: { enabled, startedAt, expiresAt, lastWorkerWindow }`. ``

(b) §6, after the stall-detector bullet's suspend sentence, add:

`` A worker-thread **stall sentinel** (armed via MCP `perf_sentinel_set`, never persisted) runs a second event-loop delay monitor; while armed, stall rows carry `meta.sentinel` (`{workerMaxMs, aligned, ageMs}` or `{stale:true}` when the worker itself went silent) — main-and-worker stalling together is the OS-starvation signature. Every stall row also carries `meta.cpu.utilization` (system-wide busy fraction between stalls, from `os.cpus()` deltas). ``

- [ ] **Step 6: Run the contract suites + typecheck**

Run: `npx vitest run src/main/mcpServer.test.ts && npm run typecheck`
Expected: green/clean.

- [ ] **Step 7: Commit**

```bash
git add src/main/mcpServer.ts src/main/mcpServer.test.ts tests/mcp-server.spec.ts docs/SPEC.md
git commit -m "feat(mcp): perf_sentinel_set — arm/disarm/status for the stall sentinel"
```

---

### Task 4: Full gate + PR

- [ ] **Step 1: Full local gate**

Run: `npm run typecheck && npm run test:unit && npm run build`
Expected: all three succeed.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin perf/stall-sentinel
gh pr create --head perf/stall-sentinel --title "feat(perf): MCP-controlled stall sentinel — starvation vs main-loop-block discriminator" --body "$(cat <<'EOF'
## Summary
The 2026-08-19 verdict falsified every in-process stall suspect (GC: 2 pauses ≥25 ms in 19 h; broadcast: 22 s total; ping_dispatch: 0 loop blocks in 1,711 pings) — ~90% of big stalls have no in-process cause. Leading hypothesis: OS-level starvation (WSL2/Docker pressure). This adds the discriminator:
- **Stall sentinel** (`perfSentinel.ts`): a worker thread running its own event-loop delay monitor. While armed, stall rows gain `meta.sentinel` — `aligned: true` (worker stalled in the same window) is the starvation signature; `{stale: true}` (worker went silent) is starvation evidence too.
- **Every stall row now carries `meta.cpu.utilization`** (system busy fraction from os.cpus() deltas), sentinel or not.
- **MCP control per Troy's requirement**: new `perf_sentinel_set({enabled, ttlHours?})` (ungated mediated write, same class as `perf_set`; arming requires recording on; ttlHours ≤ 168 auto-disarms) and `perf_status` gains the `sentinel` block. **Never persisted** — app start is always disarmed, recording-off disarms, the worker + TTL timer are unref'd so the sentinel can never keep the app alive or outlive attention.

Contract tests updated (unit + e2e pin); SPEC §6/§11 in the behavior commits. No migration (meta is JSON), no new deps.

## Reading the result
Arm via MCP, dogfood, then: `SELECT json_extract(meta,'$.sentinel.aligned') aligned, COUNT(*), ROUND(AVG(json_extract(meta,'$.cpu.utilization')),2) FROM perf_events WHERE kind='stall' AND ts >= <armed> GROUP BY aligned`. Majority aligned/high-cpu ⇒ resource governance, not app code. Majority unaligned ⇒ a real blocker remains; next step is a host-side sampling profiler.

## Verification
typecheck + unit tests + build in the dev container (no display; Playwright in CI — flake #305 may need a rerun). Sentinel logic unit-tested via an injected worker factory + one real-worker smoke test.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review notes (already applied)

- **Spec coverage:** §1 → Task 1; §2 → Task 2; §3 → Task 3 (tool + status + contract tests + SPEC); §4 reading-guide → PR body. Lifetime policy (until-restart default, ttlHours cap, never persisted, recording-off disarms) implemented in Tasks 1–3.
- **Type consistency:** `SentinelStatus`/`SentinelWindowVerdict`/`SentinelHooks`/`SentinelWorkerLike` defined once in Task 1 and consumed by name in Tasks 2–3; `perf_sentinel_set` schema identical in Task 3 steps 1/3.
- **Known adaptation points (flagged, not placeholders):** perf.test.ts pre-existing exact-equality meta assertions may need `toMatchObject` (Task 2 Step 4); mcpServer.test.ts invocation convention to be copied from the existing perf_set tests (Task 3 Step 1).
