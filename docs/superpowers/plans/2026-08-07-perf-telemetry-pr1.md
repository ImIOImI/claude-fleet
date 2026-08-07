# Perf Telemetry PR 1 (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Always-on OpenTelemetry-native perf telemetry in the Electron main process — event-loop stall detection with slow-op attribution, PTY throughput counters, local SQLite storage, a Diagnostics Settings section, and fleet-state MCP `perf_status`/`perf_set` tools.

**Architecture:** All instrumentation goes through `@opentelemetry/api`; the OTel trace + metrics SDKs run in main, owned by a new `src/main/perf.ts`. A custom SQLite span/metric exporter pair writes into a new `perf_events` table (batched, 5 s); an OTLP/HTTP exporter pair is registered only when export is enabled via settings or standard OTel env vars. Spec: `docs/superpowers/specs/2026-08-07-perf-telemetry-design.md` (read it before starting).

**Tech Stack:** TypeScript (Electron main), `@opentelemetry/api` + `sdk-trace-base` + `sdk-metrics` + OTLP HTTP exporters, `better-sqlite3`, vitest, React renderer (Settings UI).

## Global Constraints

- **Work in the worktree** `/workspace/claude-fleet/.claude/worktrees/perf-telemetry` (branch `feat/perf-telemetry`). NEVER `cd /workspace/claude-fleet` — that is the main checkout on a different branch. Run all commands from inside the worktree (`cd` into it in your shell, or `git -C <worktree>`).
- All commands below assume cwd = the worktree root unless stated.
- **Spec-maintenance rule** (`.claude/rules/spec-maintenance.md`): IPC/data-model/security changes MUST update `docs/SPEC.md` in the same PR — Task 9 does this; do not skip it.
- **`perf_events` schema (final, from the design spec + this plan):** columns `id, ts, kind, workspace_id, session_id, name, dur_ms, trace_id, span_id, meta`. (`workspace_id` was added during planning so MCP snapshot scoping is uniform; Task 9 syncs the design doc.)
- Thresholds: slow-op ≥ **25 ms** persisted; stall window max > **50 ms**; flush/export interval **5000 ms**; retention **7 days**.
- Defaults: recording **on** (`perfTelemetry !== false`); export **off**. `CLAUDE_FLEET_PERF=0` forces recording off (never on). `OTEL_EXPORTER_OTLP_ENDPOINT` forces export on (source `'env'`), beating the `perfOtlp` setting.
- MCP `perf_set` can only toggle recording. It must reject while `CLAUDE_FLEET_PERF=0` is set, and must never accept export/endpoint arguments.
- **No UI verification in this container** (no display): renderer changes are gated by `npm run typecheck` + `npm run test:unit` + `npm run build`, and the PR must say so (Troy eyeballs on host).
- If `npm run test:unit` fails to load `better-sqlite3` (Electron-ABI native build), apply the known env fix: copy the prebuilt `better-sqlite3` binary into place and stub the electron `path.txt` in base `node_modules` (see memory note `run-unit-tests-env`; the repo's existing unit tests pass in this container once applied — verify with `npx vitest run src/main/pricing.test.ts` before blaming your change).
- Commit after every task (Troy's convention: commit freely). Every commit message ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Dependencies + `perf_events` migration + PerfStore

**Files:**
- Modify: `package.json` (via npm install)
- Modify: `src/main/db.ts` (migration v11, after the v10 block at ~line 344)
- Create: `src/main/perfStore.ts`
- Test: `src/main/perfStore.test.ts`

**Interfaces:**
- Produces: `class PerfStore { constructor(db: Database.Database); enqueue(row: PerfRow): void; flush(): number; prune(olderThanMs?: number, now?: number): number; counts24h(now?: number): Record<string, number>; pending(): number }` and `interface PerfRow { ts: number; kind: PerfKind; workspaceId?: string | null; sessionId?: string | null; name?: string | null; durMs?: number | null; traceId?: string | null; spanId?: string | null; meta?: Record<string, unknown> | null }` with `type PerfKind = 'stall' | 'slow_op' | 'pty_window' | 'input_hop' | 'output_hop' | 'echo_rtt'`. Tasks 3, 4, 6, 8 consume these.

- [ ] **Step 1: Install OTel dependencies** (pure JS, no native rebuild concerns)

```bash
npm install @opentelemetry/api @opentelemetry/core @opentelemetry/sdk-trace-base @opentelemetry/sdk-metrics @opentelemetry/exporter-trace-otlp-http @opentelemetry/exporter-metrics-otlp-http
```

Expected: package.json gains the six deps under `dependencies`. Run `npm run typecheck` — still green.

- [ ] **Step 2: Write the failing test**

`src/main/perfStore.test.ts` (pattern: open a real temp-dir DB through `openDb` so the migration runs, like other db-touching tests):

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, openDb } from './db.js';
import { PerfStore } from './perfStore.js';
import type Database from 'better-sqlite3';

describe('PerfStore', () => {
  let dir: string;
  let db: Database.Database;
  let store: PerfStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'perfstore-'));
    db = openDb(dir);
    store = new PerfStore(db);
  });
  afterEach(() => {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  it('migration creates perf_events with the expected columns', () => {
    const cols = db.prepare(`PRAGMA table_info(perf_events)`).all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toEqual([
      'id', 'ts', 'kind', 'workspace_id', 'session_id', 'name', 'dur_ms', 'trace_id', 'span_id', 'meta'
    ]);
  });

  it('enqueue is buffered; flush writes one transaction and empties the buffer', () => {
    store.enqueue({ ts: 1000, kind: 'slow_op', name: 'claude_fleet.ingest', durMs: 40 });
    store.enqueue({ ts: 1001, kind: 'stall', durMs: 80, meta: { p50: 1, p99: 60, max: 80 } });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM perf_events`).get()).toEqual({ n: 0 });
    expect(store.flush()).toBe(2);
    expect(store.pending()).toBe(0);
    const rows = db.prepare(`SELECT kind, name, dur_ms, meta FROM perf_events ORDER BY id`).all();
    expect(rows).toEqual([
      { kind: 'slow_op', name: 'claude_fleet.ingest', dur_ms: 40, meta: null },
      { kind: 'stall', name: null, dur_ms: 80, meta: JSON.stringify({ p50: 1, p99: 60, max: 80 }) }
    ]);
    expect(store.flush()).toBe(0); // idempotent when empty
  });

  it('prune deletes rows older than the retention window', () => {
    const now = 10 * 24 * 60 * 60 * 1000;
    store.enqueue({ ts: now - 8 * 24 * 60 * 60 * 1000, kind: 'stall', durMs: 60 });
    store.enqueue({ ts: now - 1000, kind: 'stall', durMs: 60 });
    store.flush();
    expect(store.prune(7 * 24 * 60 * 60 * 1000, now)).toBe(1);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM perf_events`).get()).toEqual({ n: 1 });
  });

  it('counts24h groups by kind within the window', () => {
    const now = 2 * 24 * 60 * 60 * 1000;
    store.enqueue({ ts: now - 1000, kind: 'stall', durMs: 60 });
    store.enqueue({ ts: now - 2000, kind: 'slow_op', name: 'x', durMs: 30 });
    store.enqueue({ ts: now - 3000, kind: 'slow_op', name: 'y', durMs: 30 });
    store.enqueue({ ts: now - 30 * 60 * 60 * 1000, kind: 'slow_op', name: 'old', durMs: 30 });
    store.flush();
    expect(store.counts24h(now)).toEqual({ stall: 1, slow_op: 2 });
  });

  it('buffer is capped so a runaway producer cannot exhaust memory', () => {
    for (let i = 0; i < 11_000; i++) store.enqueue({ ts: i, kind: 'stall', durMs: 60 });
    expect(store.pending()).toBe(10_000);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run src/main/perfStore.test.ts`
Expected: FAIL — cannot resolve `./perfStore.js`, and (after creating an empty module) missing `perf_events` table.

- [ ] **Step 4: Add migration v11 to `src/main/db.ts`**

Append inside `migrate()`, directly after the v10 block (`d.pragma('user_version = 10');` at ~line 345):

```ts
  if ((d.pragma('user_version', { simple: true }) as number) < 11) {
    // Perf telemetry (docs/superpowers/specs/2026-08-07-perf-telemetry-design.md):
    // event-loop stalls, slow-op spans, PTY throughput windows, and (Phase 2)
    // terminal latency samples. Local-only; 7-day retention enforced by
    // PerfStore.prune at startup. workspace_id scopes MCP snapshot copies;
    // NULL = app-global row (stalls, slow ops) visible to every caller.
    d.exec(`
      CREATE TABLE perf_events (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        ts           INTEGER NOT NULL,
        kind         TEXT NOT NULL,      -- stall | slow_op | pty_window | input_hop | output_hop | echo_rtt
        workspace_id TEXT,
        session_id   TEXT,
        name         TEXT,               -- span/metric name for slow_op / pty_window
        dur_ms       REAL,
        trace_id     TEXT,
        span_id      TEXT,
        meta         TEXT                -- JSON: span attrs, p50/p99/max, window values
      );
      CREATE INDEX idx_perf_events_ts ON perf_events(ts);
      CREATE INDEX idx_perf_events_kind_ts ON perf_events(kind, ts);
    `);
    d.pragma('user_version = 11');
  }
```

- [ ] **Step 5: Create `src/main/perfStore.ts`**

```ts
// Buffered writer for the perf_events table. Producers (span/metric
// exporters, the stall sampler) enqueue rows in memory; a single flush()
// writes them in one transaction so telemetry never adds per-event
// synchronous SQLite work to the hot path. perf.ts owns the flush timer.

import type Database from 'better-sqlite3';

export type PerfKind = 'stall' | 'slow_op' | 'pty_window' | 'input_hop' | 'output_hop' | 'echo_rtt';

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

export class PerfStore {
  private buf: PerfRow[] = [];

  constructor(private readonly db: Database.Database) {}

  enqueue(row: PerfRow): void {
    this.buf.push(row);
    if (this.buf.length > BUFFER_CAP) this.buf.splice(0, this.buf.length - BUFFER_CAP);
  }

  pending(): number {
    return this.buf.length;
  }

  /** Write all buffered rows in one transaction. Returns rows written. */
  flush(): number {
    if (this.buf.length === 0) return 0;
    const rows = this.buf;
    this.buf = [];
    const ins = this.db.prepare(`
      INSERT INTO perf_events (ts, kind, workspace_id, session_id, name, dur_ms, trace_id, span_id, meta)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.db.transaction((rs: PerfRow[]) => {
      for (const r of rs) {
        ins.run(
          r.ts, r.kind, r.workspaceId ?? null, r.sessionId ?? null, r.name ?? null,
          r.durMs ?? null, r.traceId ?? null, r.spanId ?? null,
          r.meta ? JSON.stringify(r.meta) : null
        );
      }
    })(rows);
    return rows.length;
  }

  /** Delete rows older than the retention window. Returns rows deleted. */
  prune(olderThanMs: number = RETENTION_MS, now: number = Date.now()): number {
    return this.db.prepare(`DELETE FROM perf_events WHERE ts < ?`).run(now - olderThanMs).changes;
  }

  /** Row counts per kind over the trailing 24 h (perf_status / Settings UI). */
  counts24h(now: number = Date.now()): Record<string, number> {
    const rows = this.db
      .prepare(`SELECT kind, COUNT(*) AS n FROM perf_events WHERE ts >= ? GROUP BY kind`)
      .all(now - DAY_MS) as Array<{ kind: string; n: number }>;
    return Object.fromEntries(rows.map((r) => [r.kind, r.n]));
  }
}
```

- [ ] **Step 6: Run tests to verify pass**

Run: `npx vitest run src/main/perfStore.test.ts` → all 5 PASS. Then `npx vitest run src/main` (no regressions in db-adjacent suites) and `npm run typecheck`.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/main/db.ts src/main/perfStore.ts src/main/perfStore.test.ts
git commit -m "feat(perf): OTel deps, perf_events migration (v11), buffered PerfStore

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Config fields + pure effective-config resolution

**Files:**
- Modify: `src/main/config.ts` (AppConfig at ~line 54, `read()` at ~line 94; new getters/setters after `setAutoReloadLoadouts` ~line 179)
- Create: `src/main/perfConfig.ts`
- Test: `src/main/perfConfig.test.ts`, extend `src/main/config.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `config.ts`: `getPerfTelemetry(): Promise<boolean>` (default true), `setPerfTelemetry(enabled: boolean): Promise<void>`, `getPerfOtlp(): Promise<{ enabled: boolean; endpoint: string }>` (default `{enabled:false, endpoint:''}`), `setPerfOtlp(enabled: boolean, endpoint: string): Promise<void>` (throws on enabled=true with non-http(s) endpoint).
  - `perfConfig.ts`: `interface EffectivePerfConfig { recording: boolean; recordingSource: 'settings' | 'env-override'; otlp: { enabled: boolean; endpoint: string | null; source: 'settings' | 'env' } }` and `resolvePerfConfig(stored: { perfTelemetry: boolean; perfOtlp: { enabled: boolean; endpoint: string } }, env: Record<string, string | undefined>): EffectivePerfConfig`. Tasks 3–8 consume `EffectivePerfConfig`.

- [ ] **Step 1: Write the failing tests**

`src/main/perfConfig.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { resolvePerfConfig } from './perfConfig.js';

const stored = (perfTelemetry: boolean, enabled = false, endpoint = '') => ({
  perfTelemetry,
  perfOtlp: { enabled, endpoint }
});

describe('resolvePerfConfig', () => {
  it('defaults: recording on from settings, export off', () => {
    expect(resolvePerfConfig(stored(true), {})).toEqual({
      recording: true,
      recordingSource: 'settings',
      otlp: { enabled: false, endpoint: null, source: 'settings' }
    });
  });

  it('setting off turns recording off', () => {
    expect(resolvePerfConfig(stored(false), {}).recording).toBe(false);
  });

  it('CLAUDE_FLEET_PERF=0 forces recording off even when the setting is on', () => {
    const r = resolvePerfConfig(stored(true), { CLAUDE_FLEET_PERF: '0' });
    expect(r.recording).toBe(false);
    expect(r.recordingSource).toBe('env-override');
  });

  it('CLAUDE_FLEET_PERF=1 does NOT force recording on over an off setting', () => {
    expect(resolvePerfConfig(stored(false), { CLAUDE_FLEET_PERF: '1' }).recording).toBe(false);
  });

  it('settings-driven export requires enabled + endpoint + recording', () => {
    expect(resolvePerfConfig(stored(true, true, 'http://localhost:4318'), {}).otlp).toEqual({
      enabled: true, endpoint: 'http://localhost:4318', source: 'settings'
    });
    expect(resolvePerfConfig(stored(true, true, ''), {}).otlp.enabled).toBe(false);
    expect(resolvePerfConfig(stored(false, true, 'http://x:4318'), {}).otlp.enabled).toBe(false);
  });

  it('OTEL_EXPORTER_OTLP_ENDPOINT overrides the setting (source env)', () => {
    const r = resolvePerfConfig(stored(true, false, ''), { OTEL_EXPORTER_OTLP_ENDPOINT: ' http://collector:4318 ' });
    expect(r.otlp).toEqual({ enabled: true, endpoint: 'http://collector:4318', source: 'env' });
  });

  it('env endpoint does not export while recording is forced off', () => {
    const r = resolvePerfConfig(stored(true), {
      CLAUDE_FLEET_PERF: '0',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318'
    });
    expect(r.otlp.enabled).toBe(false);
  });
});
```

Append to `src/main/config.test.ts` (follow its existing setup — it already mocks `electron`'s `app.getPath` and uses `_resetConfigCacheForTests`; add to the existing describe or a new one):

```ts
describe('perf telemetry config', () => {
  it('getPerfTelemetry defaults true; explicit false persists', async () => {
    expect(await getPerfTelemetry()).toBe(true);
    await setPerfTelemetry(false);
    _resetConfigCacheForTests();
    expect(await getPerfTelemetry()).toBe(false);
  });

  it('getPerfOtlp defaults off/empty; setPerfOtlp round-trips', async () => {
    expect(await getPerfOtlp()).toEqual({ enabled: false, endpoint: '' });
    await setPerfOtlp(true, 'http://localhost:4318');
    _resetConfigCacheForTests();
    expect(await getPerfOtlp()).toEqual({ enabled: true, endpoint: 'http://localhost:4318' });
  });

  it('setPerfOtlp rejects enabling with a non-http endpoint', async () => {
    await expect(setPerfOtlp(true, 'ftp://nope')).rejects.toThrow(/http/i);
    await expect(setPerfOtlp(true, '')).rejects.toThrow(/endpoint/i);
    await expect(setPerfOtlp(false, '')).resolves.toBeUndefined(); // disabling never validates
  });
});
```

(Import the four new functions in the test's import list.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/main/perfConfig.test.ts src/main/config.test.ts`
Expected: FAIL — module/exports missing.

- [ ] **Step 3: Implement**

Create `src/main/perfConfig.ts`:

```ts
// Pure resolution of the *effective* perf-telemetry state from the persisted
// settings + env overrides. Kept Electron-free so it unit-tests directly.
// Precedence (docs/superpowers/specs/2026-08-07-perf-telemetry-design.md §4):
//   recording: CLAUDE_FLEET_PERF=0 forces off → else the perfTelemetry setting.
//   export:    OTEL_EXPORTER_OTLP_ENDPOINT forces on (source 'env') → else the
//              perfOtlp setting. Export never runs while recording is off.

export interface EffectivePerfConfig {
  recording: boolean;
  recordingSource: 'settings' | 'env-override';
  otlp: { enabled: boolean; endpoint: string | null; source: 'settings' | 'env' };
}

export function resolvePerfConfig(
  stored: { perfTelemetry: boolean; perfOtlp: { enabled: boolean; endpoint: string } },
  env: Record<string, string | undefined>
): EffectivePerfConfig {
  const envOff = env.CLAUDE_FLEET_PERF === '0';
  const recording = envOff ? false : stored.perfTelemetry;
  const envEndpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  const otlp = envEndpoint
    ? { enabled: recording, endpoint: envEndpoint, source: 'env' as const }
    : {
        enabled: recording && stored.perfOtlp.enabled && stored.perfOtlp.endpoint !== '',
        endpoint: stored.perfOtlp.endpoint || null,
        source: 'settings' as const
      };
  return { recording, recordingSource: envOff ? 'env-override' : 'settings', otlp };
}
```

In `src/main/config.ts`:

1. Extend `AppConfig`:

```ts
  /** Perf telemetry recording (docs/superpowers/specs/2026-08-07-perf-telemetry-design.md).
   *  Absent ⇒ default ON. CLAUDE_FLEET_PERF=0 overrides at resolve time (perfConfig.ts). */
  perfTelemetry?: boolean;
  /** OTLP export of perf traces/metrics. Default off; OTEL_EXPORTER_OTLP_ENDPOINT overrides. */
  perfOtlp?: { enabled: boolean; endpoint: string };
```

2. In `read()`, after the `usageBudget` line, add (with a `parsePerfOtlp` helper mirroring `parseUsageBudget`'s defensive style):

```ts
      perfTelemetry: typeof parsed.perfTelemetry === 'boolean' ? parsed.perfTelemetry : undefined,
      perfOtlp: parsePerfOtlp(parsed.perfOtlp)
```

```ts
/** Defensively parse the persisted perfOtlp block (untrusted JSON on disk). */
function parsePerfOtlp(v: unknown): { enabled: boolean; endpoint: string } | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  return {
    enabled: o.enabled === true,
    endpoint: typeof o.endpoint === 'string' ? o.endpoint : ''
  };
}
```

3. New accessors after `setAutoReloadLoadouts`:

```ts
/** Perf-telemetry recording setting. Default on. (Env override lives in perfConfig.ts.) */
export async function getPerfTelemetry(): Promise<boolean> {
  const cfg = await read();
  return cfg.perfTelemetry !== false; // default true
}

export async function setPerfTelemetry(enabled: boolean): Promise<void> {
  const cfg = await read();
  await write({ ...cfg, perfTelemetry: enabled });
}

/** OTLP export setting (endpoint kept even while disabled — the Settings UI
 *  shows it greyed out rather than losing it). */
export async function getPerfOtlp(): Promise<{ enabled: boolean; endpoint: string }> {
  const cfg = await read();
  return cfg.perfOtlp ?? { enabled: false, endpoint: '' };
}

export async function setPerfOtlp(enabled: boolean, endpoint: string): Promise<void> {
  const trimmed = endpoint.trim();
  if (enabled) {
    if (!trimmed) throw new Error('OTLP export needs an endpoint URL');
    if (!/^https?:\/\//.test(trimmed)) throw new Error('OTLP endpoint must be an http(s) URL');
  }
  const cfg = await read();
  await write({ ...cfg, perfOtlp: { enabled, endpoint: trimmed } });
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run src/main/perfConfig.test.ts src/main/config.test.ts` → PASS. `npm run typecheck` → green.

- [ ] **Step 5: Commit**

```bash
git add src/main/config.ts src/main/config.test.ts src/main/perfConfig.ts src/main/perfConfig.test.ts
git commit -m "feat(perf): perfTelemetry/perfOtlp settings + pure effective-config resolution

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: perf.ts — tracer pipeline, SQLite span exporter, perfSpan, lifecycle

**Files:**
- Create: `src/main/perf.ts`
- Test: `src/main/perf.test.ts`

**Interfaces:**
- Consumes: `PerfStore`, `PerfRow` (Task 1); `EffectivePerfConfig` (Task 2).
- Produces (Tasks 4–8 consume):
  - `initPerf(store: PerfStore, effective: EffectivePerfConfig): void` — idempotent-safe via internal shutdown-first.
  - `shutdownPerf(): Promise<void>` — flushes processors + store, disables global providers.
  - `reconfigurePerf(effective: EffectivePerfConfig): Promise<void>` — shutdown + re-init with the same store.
  - `perfSpan<T>(name: string, fn: () => T, attrs?: Record<string, string | number>): T`
  - `perfSpanAsync<T>(name: string, fn: () => Promise<T> | T, attrs?: Record<string, string | number>): Promise<T>`
  - `getEffectivePerf(): EffectivePerfConfig | null` — the currently applied config (null before init).
  - `SLOW_OP_MS = 25`, `FLUSH_INTERVAL_MS = 5000` constants.
  - `class SqliteSpanExporter implements SpanExporter` (exported for tests).

- [ ] **Step 1: Write the failing test**

`src/main/perf.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, openDb } from './db.js';
import { PerfStore } from './perfStore.js';
import {
  initPerf, shutdownPerf, reconfigurePerf, perfSpan, perfSpanAsync, getEffectivePerf
} from './perf.js';
import type { EffectivePerfConfig } from './perfConfig.js';
import type Database from 'better-sqlite3';

const ON: EffectivePerfConfig = {
  recording: true, recordingSource: 'settings',
  otlp: { enabled: false, endpoint: null, source: 'settings' }
};
const OFF: EffectivePerfConfig = {
  recording: false, recordingSource: 'settings',
  otlp: { enabled: false, endpoint: null, source: 'settings' }
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('perf tracer pipeline', () => {
  let dir: string;
  let db: Database.Database;
  let store: PerfStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'perf-'));
    db = openDb(dir);
    store = new PerfStore(db);
  });
  afterEach(async () => {
    await shutdownPerf();
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  it('records spans >= 25ms as slow_op rows and drops fast spans', async () => {
    initPerf(store, ON);
    perfSpan('claude_fleet.test.slow', () => { const end = Date.now() + 40; while (Date.now() < end) { /* busy */ } });
    perfSpan('claude_fleet.test.fast', () => undefined);
    await shutdownPerf(); // forces span-processor + store flush
    const rows = db.prepare(`SELECT kind, name FROM perf_events WHERE kind = 'slow_op'`).all();
    expect(rows).toEqual([{ kind: 'slow_op', name: 'claude_fleet.test.slow' }]);
    const slow = db.prepare(`SELECT dur_ms, trace_id, span_id FROM perf_events WHERE name = 'claude_fleet.test.slow'`).get() as { dur_ms: number; trace_id: string; span_id: string };
    expect(slow.dur_ms).toBeGreaterThanOrEqual(25);
    expect(slow.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(slow.span_id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('perfSpanAsync covers awaited work and rethrows', async () => {
    initPerf(store, ON);
    await expect(
      perfSpanAsync('claude_fleet.test.async', async () => { await sleep(40); throw new Error('boom'); })
    ).rejects.toThrow('boom');
    await shutdownPerf();
    const row = db.prepare(`SELECT dur_ms FROM perf_events WHERE name = 'claude_fleet.test.async'`).get() as { dur_ms: number };
    expect(row.dur_ms).toBeGreaterThanOrEqual(25);
  });

  it('while disabled, perfSpan still runs fn and records nothing', async () => {
    initPerf(store, OFF);
    expect(perfSpan('claude_fleet.test.noop', () => 7)).toBe(7);
    await shutdownPerf();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM perf_events`).get()).toEqual({ n: 0 });
  });

  it('reconfigure flips live without restart', async () => {
    initPerf(store, OFF);
    await reconfigurePerf(ON);
    expect(getEffectivePerf()?.recording).toBe(true);
    perfSpan('claude_fleet.test.slow2', () => { const end = Date.now() + 40; while (Date.now() < end) { /* busy */ } });
    await reconfigurePerf(OFF); // shutdown path flushes
    expect(db.prepare(`SELECT COUNT(*) AS n FROM perf_events WHERE name = 'claude_fleet.test.slow2'`).get()).toEqual({ n: 1 });
  });

  it('shutdown is idempotent', async () => {
    initPerf(store, ON);
    await shutdownPerf();
    await expect(shutdownPerf()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/main/perf.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `src/main/perf.ts`**

```ts
// Perf telemetry runtime (docs/superpowers/specs/2026-08-07-perf-telemetry-design.md).
// Owns the OTel SDK lifecycle in main. All instrumentation goes through the
// @opentelemetry/api globals, so when no provider is registered (recording
// off) every perfSpan/metric call is a no-op — instrumentation sites cost
// ~nothing while disabled. Two export paths per signal: the SQLite exporters
// (always on while recording) feed the local perf_events table; OTLP HTTP
// exporters are added only when effective.otlp.enabled.

import { hrTimeToMilliseconds } from '@opentelemetry/core';
import type { ExportResult } from '@opentelemetry/core';
import { ExportResultCode } from '@opentelemetry/core';
import { metrics, trace, type Attributes } from '@opentelemetry/api';
import {
  BasicTracerProvider, BatchSpanProcessor,
  type ReadableSpan, type SpanExporter
} from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import type { EffectivePerfConfig } from './perfConfig.js';
import type { PerfStore } from './perfStore.js';
import { RETENTION_MS } from './perfStore.js';

export const SLOW_OP_MS = 25;
export const FLUSH_INTERVAL_MS = 5000;
const TRACER_NAME = 'claude-fleet';

/** Maps finished spans → slow_op rows. Spans faster than SLOW_OP_MS are
 *  dropped here (the OTLP exporter, when registered, still gets them all). */
export class SqliteSpanExporter implements SpanExporter {
  constructor(private readonly store: PerfStore) {}

  export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    for (const s of spans) {
      const durMs = hrTimeToMilliseconds(s.duration);
      if (durMs < SLOW_OP_MS) continue;
      const attrs = s.attributes as Record<string, unknown>;
      this.store.enqueue({
        ts: hrTimeToMilliseconds(s.startTime),
        kind: 'slow_op',
        name: s.name,
        durMs,
        traceId: s.spanContext().traceId,
        spanId: s.spanContext().spanId,
        workspaceId: typeof attrs.workspace_id === 'string' ? attrs.workspace_id : null,
        sessionId: typeof attrs.session_id === 'string' ? attrs.session_id : null,
        meta: Object.keys(attrs).length > 0 ? attrs : null
      });
    }
    done({ code: ExportResultCode.SUCCESS });
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

interface Runtime {
  store: PerfStore;
  effective: EffectivePerfConfig;
  tracerProvider: BasicTracerProvider | null;
  flushTimer: NodeJS.Timeout | null;
}
let rt: Runtime | null = null;

export function getEffectivePerf(): EffectivePerfConfig | null {
  return rt?.effective ?? null;
}

export function initPerf(store: PerfStore, effective: EffectivePerfConfig): void {
  if (rt) throw new Error('initPerf called twice — use reconfigurePerf');
  rt = { store, effective, tracerProvider: null, flushTimer: null };
  store.prune(RETENTION_MS);
  if (!effective.recording) return; // globals stay no-op

  const processors = [
    new BatchSpanProcessor(new SqliteSpanExporter(store), { scheduledDelayMillis: FLUSH_INTERVAL_MS })
  ];
  if (effective.otlp.enabled && effective.otlp.endpoint) {
    processors.push(
      new BatchSpanProcessor(
        new OTLPTraceExporter({ url: otlpSignalUrl(effective.otlp.endpoint, 'traces') }),
        { scheduledDelayMillis: FLUSH_INTERVAL_MS }
      )
    );
  }
  rt.tracerProvider = new BasicTracerProvider({ spanProcessors: processors });
  trace.setGlobalTracerProvider(rt.tracerProvider);

  rt.flushTimer = setInterval(() => {
    perfSpan('claude_fleet.perf.flush', () => rt?.store.flush());
  }, FLUSH_INTERVAL_MS);
  rt.flushTimer.unref();
}

export async function shutdownPerf(): Promise<void> {
  if (!rt) return;
  const r = rt;
  rt = null;
  if (r.flushTimer) clearInterval(r.flushTimer);
  await r.tracerProvider?.shutdown().catch(() => undefined); // flushes batch processors
  trace.disable();
  metrics.disable();
  r.store.flush();
}

export async function reconfigurePerf(effective: EffectivePerfConfig): Promise<void> {
  const store = rt?.store;
  if (!store) throw new Error('reconfigurePerf before initPerf');
  await shutdownPerf();
  initPerf(store, effective);
}

/** OTLP/HTTP per-signal URL: `<endpoint>/v1/<signal>` (standard layout). */
export function otlpSignalUrl(endpoint: string, signal: 'traces' | 'metrics'): string {
  return `${endpoint.replace(/\/+$/, '')}/v1/${signal}`;
}

export function perfSpan<T>(name: string, fn: () => T, attrs?: Attributes): T {
  const span = trace.getTracer(TRACER_NAME).startSpan(name, { attributes: attrs });
  try {
    return fn();
  } catch (err) {
    if (err instanceof Error) span.recordException(err);
    throw err;
  } finally {
    span.end();
  }
}

export async function perfSpanAsync<T>(
  name: string,
  fn: () => Promise<T> | T,
  attrs?: Attributes
): Promise<T> {
  const span = trace.getTracer(TRACER_NAME).startSpan(name, { attributes: attrs });
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Error) span.recordException(err);
    throw err;
  } finally {
    span.end();
  }
}
```

Note: if the installed `sdk-trace-base` major does not accept `spanProcessors` in the constructor (v1 API), fall back to `provider.addSpanProcessor(p)` per processor — check the installed version's types and use whichever compiles; do NOT downgrade the package.

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run src/main/perf.test.ts` → PASS. `npm run typecheck` → green.

- [ ] **Step 5: Commit**

```bash
git add src/main/perf.ts src/main/perf.test.ts
git commit -m "feat(perf): OTel tracer pipeline with SQLite slow-op exporter + lifecycle

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Stall sampler + PTY counters (metrics pipeline)

**Files:**
- Modify: `src/main/perf.ts`
- Test: extend `src/main/perf.test.ts`

**Interfaces:**
- Consumes: Task 3's `Runtime`/lifecycle.
- Produces (Tasks 6, 8 consume):
  - `recordPtyChunk(workspaceId: string | null, sessionId: string, byteLength: number): void`
  - `STALL_THRESHOLD_MS = 50`, `SAMPLE_INTERVAL_MS = 5000`
  - `initPerf` gains optional test seams: `initPerf(store, effective, hooks?: { delaySource?: () => { p50: number; p99: number; max: number }; sampleIntervalMs?: number })`.

- [ ] **Step 1: Write the failing tests** (append to `src/main/perf.test.ts`)

```ts
describe('stall sampler + pty counters', () => {
  // dir/db/store/afterEach identical to the tracer describe — reuse via the same outer scope.

  it('records a stall row when the sampled window max exceeds 50ms', async () => {
    let max = 10;
    initPerf(store, ON, { delaySource: () => ({ p50: 2, p99: 8, max }), sampleIntervalMs: 20 });
    await sleep(50); // ≥1 quiet window — below threshold, no row
    max = 120;
    await sleep(50); // ≥1 stalled window
    await shutdownPerf();
    const rows = db.prepare(`SELECT dur_ms, meta FROM perf_events WHERE kind = 'stall'`).all() as Array<{ dur_ms: number; meta: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].dur_ms).toBe(120);
    expect(JSON.parse(rows[0].meta)).toEqual({ p50: 2, p99: 8, max: 120 });
  });

  it('aggregates pty chunks into per-session pty_window rows', async () => {
    initPerf(store, ON, { delaySource: () => ({ p50: 0, p99: 0, max: 0 }), sampleIntervalMs: 20 });
    recordPtyChunk('ws-1', 'sess-a', 1000);
    recordPtyChunk('ws-1', 'sess-a', 500);
    recordPtyChunk('ws-2', 'sess-b', 42);
    await sleep(50);
    await shutdownPerf();
    const rows = db.prepare(
      `SELECT session_id, workspace_id, meta FROM perf_events WHERE kind = 'pty_window' AND name = 'claude_fleet.pty.bytes' ORDER BY session_id`
    ).all() as Array<{ session_id: string; workspace_id: string; meta: string }>;
    expect(rows.map((r) => [r.workspace_id, r.session_id, JSON.parse(r.meta).value])).toEqual([
      ['ws-1', 'sess-a', 1500],
      ['ws-2', 'sess-b', 42]
    ]);
    const chunks = db.prepare(
      `SELECT meta FROM perf_events WHERE kind = 'pty_window' AND name = 'claude_fleet.pty.chunks' AND session_id = 'sess-a'`
    ).get() as { meta: string };
    expect(JSON.parse(chunks.meta).value).toBe(2);
  });

  it('recordPtyChunk while disabled is a no-op', async () => {
    initPerf(store, OFF);
    recordPtyChunk('ws-1', 'sess-a', 1000);
    await shutdownPerf();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM perf_events WHERE kind = 'pty_window'`).get()).toEqual({ n: 0 });
  });
});
```

(Import `recordPtyChunk` in the test's import list.)

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/main/perf.test.ts` → new tests FAIL.

- [ ] **Step 3: Implement in `src/main/perf.ts`**

Add imports:

```ts
import { monitorEventLoopDelay } from 'node:perf_hooks';
import {
  AggregationTemporality, MeterProvider, PeriodicExportingMetricReader,
  type PushMetricExporter, type ResourceMetrics
} from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import type { Counter } from '@opentelemetry/api';
```

Add constants + exporter + sampler:

```ts
export const STALL_THRESHOLD_MS = 50;
export const SAMPLE_INTERVAL_MS = 5000;
const METER_NAME = 'claude-fleet';

/** Maps DELTA counter data points → pty_window rows. Gauge metrics (the
 *  event-loop delay percentiles, exported for OTLP dashboards) are skipped:
 *  their local representation is the thresholded stall row the sampler
 *  writes directly. */
export class SqliteMetricExporter implements PushMetricExporter {
  constructor(private readonly store: PerfStore) {}

  selectAggregationTemporality(): AggregationTemporality {
    return AggregationTemporality.DELTA;
  }

  export(resourceMetrics: ResourceMetrics, done: (result: ExportResult) => void): void {
    for (const scope of resourceMetrics.scopeMetrics) {
      for (const metric of scope.metrics) {
        if (!metric.descriptor.name.startsWith('claude_fleet.pty.')) continue;
        for (const dp of metric.dataPoints) {
          const value = typeof dp.value === 'number' ? dp.value : 0;
          if (value === 0) continue;
          const attrs = dp.attributes as Record<string, unknown>;
          this.store.enqueue({
            ts: Date.now(),
            kind: 'pty_window',
            name: metric.descriptor.name,
            workspaceId: typeof attrs.workspace_id === 'string' ? attrs.workspace_id : null,
            sessionId: typeof attrs.session_id === 'string' ? attrs.session_id : null,
            meta: { value }
          });
        }
      }
    }
    done({ code: ExportResultCode.SUCCESS });
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

export interface PerfInitHooks {
  /** Test seam: replaces the monitorEventLoopDelay read (values in ms). */
  delaySource?: () => { p50: number; p99: number; max: number };
  sampleIntervalMs?: number;
}
```

Extend `Runtime` with `meterProvider: MeterProvider | null; sampleTimer: NodeJS.Timeout | null; loopHistogram: ReturnType<typeof monitorEventLoopDelay> | null; ptyBytes: Counter | null; ptyChunks: Counter | null;` and extend `initPerf(store, effective, hooks?: PerfInitHooks)`; in the `effective.recording` branch, after the tracer wiring:

```ts
  const readers = [
    new PeriodicExportingMetricReader({
      exporter: new SqliteMetricExporter(store),
      exportIntervalMillis: hooks?.sampleIntervalMs ?? FLUSH_INTERVAL_MS
    })
  ];
  if (effective.otlp.enabled && effective.otlp.endpoint) {
    readers.push(
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: otlpSignalUrl(effective.otlp.endpoint, 'metrics') }),
        exportIntervalMillis: FLUSH_INTERVAL_MS
      })
    );
  }
  rt.meterProvider = new MeterProvider({ readers });
  metrics.setGlobalMeterProvider(rt.meterProvider);

  const meter = metrics.getMeter(METER_NAME);
  rt.ptyBytes = meter.createCounter('claude_fleet.pty.bytes', { description: 'PTY output bytes forwarded to the renderer' });
  rt.ptyChunks = meter.createCounter('claude_fleet.pty.chunks', { description: 'PTY output chunks forwarded to the renderer' });

  // Event-loop delay: gauges follow OTel semconv naming for OTLP dashboards;
  // the local record is the thresholded stall row.
  const lastWindow = { p50: 0, p99: 0, max: 0 };
  for (const [pct, key] of [['p50', 'p50'], ['p99', 'p99'], ['max', 'max']] as const) {
    meter
      .createObservableGauge(`nodejs.eventloop.delay.${pct}`, { unit: 'ms' })
      .addCallback((r) => r.observe(lastWindow[key]));
  }

  let readDelay: () => { p50: number; p99: number; max: number };
  if (hooks?.delaySource) {
    readDelay = hooks.delaySource;
    rt.loopHistogram = null;
  } else {
    const h = monitorEventLoopDelay({ resolution: 10 });
    h.enable();
    rt.loopHistogram = h;
    readDelay = () => {
      const w = { p50: h.percentile(50) / 1e6, p99: h.percentile(99) / 1e6, max: h.max / 1e6 };
      h.reset();
      return w;
    };
  }
  rt.sampleTimer = setInterval(() => {
    const w = readDelay();
    Object.assign(lastWindow, w);
    if (w.max > STALL_THRESHOLD_MS) {
      rt?.store.enqueue({ ts: Date.now(), kind: 'stall', durMs: w.max, meta: { ...w } });
    }
  }, hooks?.sampleIntervalMs ?? SAMPLE_INTERVAL_MS);
  rt.sampleTimer.unref();
```

In `shutdownPerf`, before `trace.disable()`:

```ts
  if (r.sampleTimer) clearInterval(r.sampleTimer);
  r.loopHistogram?.disable();
  await r.meterProvider?.shutdown().catch(() => undefined); // final metric collection → exporter
```

Add:

```ts
/** PTY throughput instrumentation point (ipc.ts pty:attach data handler).
 *  No-op while recording is off. */
export function recordPtyChunk(workspaceId: string | null, sessionId: string, byteLength: number): void {
  if (!rt?.effective.recording) return;
  const attrs = { workspace_id: workspaceId ?? '', session_id: sessionId };
  rt.ptyBytes?.add(byteLength, attrs);
  rt.ptyChunks?.add(1, attrs);
}
```

(Also null the new Runtime fields at construction, and reset them in the disabled path. If `workspace_id: ''` lands in rows as `''`, normalize in the exporter: treat `''` as null.)

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run src/main/perf.test.ts` → PASS (both describes). `npm run typecheck` → green.

- [ ] **Step 5: Commit**

```bash
git add src/main/perf.ts src/main/perf.test.ts
git commit -m "feat(perf): event-loop stall sampler + PTY throughput metrics pipeline

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: perf status snapshot (shared by MCP + Settings UI)

**Files:**
- Modify: `src/main/perf.ts`
- Test: extend `src/main/perf.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces (Tasks 6, 7, 8 consume):

```ts
export interface PerfStatus {
  enabled: boolean;
  source: 'settings' | 'env-override';
  otlp: { enabled: boolean; endpoint: string | null; source: 'settings' | 'env' };
  eventCounts: Record<string, number>; // per kind, trailing 24h
}
export function getPerfStatus(): PerfStatus;
```

- [ ] **Step 1: Write the failing test** (append to `perf.test.ts`)

```ts
describe('getPerfStatus', () => {
  it('reflects effective config + 24h counts (flushing pending rows first)', () => {
    initPerf(store, ON);
    store.enqueue({ ts: Date.now(), kind: 'stall', durMs: 60 });
    const s = getPerfStatus();
    expect(s.enabled).toBe(true);
    expect(s.source).toBe('settings');
    expect(s.otlp).toEqual({ enabled: false, endpoint: null, source: 'settings' });
    expect(s.eventCounts.stall).toBe(1);
  });

  it('throws before init', async () => {
    await shutdownPerf();
    expect(() => getPerfStatus()).toThrow(/init/i);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/main/perf.test.ts`.

- [ ] **Step 3: Implement** in `perf.ts`:

```ts
export interface PerfStatus {
  enabled: boolean;
  source: 'settings' | 'env-override';
  otlp: { enabled: boolean; endpoint: string | null; source: 'settings' | 'env' };
  eventCounts: Record<string, number>;
}

/** One-call status for perf_status (MCP) and perf:status (Settings UI). */
export function getPerfStatus(): PerfStatus {
  if (!rt) throw new Error('perf not initialized');
  rt.store.flush(); // counts include anything still buffered
  return {
    enabled: rt.effective.recording,
    source: rt.effective.recordingSource,
    otlp: rt.effective.otlp,
    eventCounts: rt.store.counts24h()
  };
}
```

- [ ] **Step 4: Run tests** — `npx vitest run src/main/perf.test.ts` → PASS; `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/main/perf.ts src/main/perf.test.ts
git commit -m "feat(perf): getPerfStatus snapshot for MCP + Settings

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Wire into main — startup init, IPC instrumentation, ingest span, PTY counters, config/status IPC, preload

**Files:**
- Modify: `src/main/index.ts` (perf init after `openDb`; find the `openDb(` call site)
- Modify: `src/main/ipc.ts` (config handlers ~line 1222; pty:attach data handler ~line 1440; new perf:status)
- Modify: `src/main/jsonlWatcher.ts` (ingest loop ~line 430)
- Modify: `src/preload/index.ts` (~line 409 config api) and `src/preload/index.d.ts` (matching types)
- Create: `src/main/perfIpc.ts` + test `src/main/perfIpc.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–5; `getPerfTelemetry`/`setPerfTelemetry`/`getPerfOtlp`/`setPerfOtlp` (Task 2).
- Produces:
  - `instrumentIpcHandle(ipc: { handle: Function })` in `perfIpc.ts` — patches `ipcMain.handle` so every later-registered handler runs inside `perfSpanAsync('claude_fleet.ipc.<channel>', …)`.
  - IPC channels: `config:setPerfTelemetry(enabled) → PerfStatus`, `config:setPerfOtlp(enabled, endpoint) → PerfStatus`, `perf:status() → PerfStatus`; `config:get` result gains `perfTelemetry: boolean` and `perfOtlp: { enabled, endpoint }`.
  - `window.api.config.setPerfTelemetry(enabled)`, `window.api.config.setPerfOtlp(enabled, endpoint)`, `window.api.perf.status()` for Task 7.

- [ ] **Step 1: Write the failing test** — `src/main/perfIpc.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { instrumentIpcHandle } from './perfIpc.js';

describe('instrumentIpcHandle', () => {
  it('wraps handlers, preserves args/return, and keeps channel registration', async () => {
    const registered = new Map<string, (...a: unknown[]) => unknown>();
    const fake = { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { registered.set(ch, fn); } };
    instrumentIpcHandle(fake);
    fake.handle('x:y', (_e: unknown, a: number, b: number) => a + b);
    expect(registered.has('x:y')).toBe(true);
    await expect(registered.get('x:y')!({}, 2, 3)).resolves.toBe(5);
  });

  it('propagates rejections', async () => {
    const registered = new Map<string, (...a: unknown[]) => unknown>();
    const fake = { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { registered.set(ch, fn); } };
    instrumentIpcHandle(fake);
    fake.handle('x:err', () => { throw new Error('nope'); });
    await expect(registered.get('x:err')!({})).rejects.toThrow('nope');
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/main/perfIpc.test.ts`.

- [ ] **Step 3: Create `src/main/perfIpc.ts`**

```ts
// Generic IPC instrumentation: patch `ipcMain.handle` once, before ipc.ts
// registers anything, so every invoke handler runs inside a
// `claude_fleet.ipc.<channel>` span. With recording off the tracer is a
// no-op, so the wrapper's cost is one extra async frame per invoke.

import { perfSpanAsync } from './perf.js';

export function instrumentIpcHandle(ipc: {
  handle: (channel: string, listener: (...args: never[]) => unknown) => void;
}): void {
  const raw = ipc.handle.bind(ipc);
  ipc.handle = (channel: string, listener: (...args: never[]) => unknown) =>
    raw(channel, ((...args: never[]) =>
      perfSpanAsync(`claude_fleet.ipc.${channel}`, () => listener(...args))) as never);
}
```

- [ ] **Step 4: Run the unit test** — `npx vitest run src/main/perfIpc.test.ts` → PASS.

- [ ] **Step 5: Wire startup in `src/main/index.ts`**

Locate the `openDb(` call. Immediately after it:

```ts
import { initPerf, reconfigurePerf } from './perf.js';
import { PerfStore } from './perfStore.js';
import { resolvePerfConfig } from './perfConfig.js';
import { getPerfTelemetry, getPerfOtlp } from './config.js';
import { instrumentIpcHandle } from './perfIpc.js';
import { ipcMain } from 'electron'; // already imported — reuse
```

```ts
  const perfStore = new PerfStore(db); // db = openDb(...) return value
  initPerf(
    perfStore,
    resolvePerfConfig(
      { perfTelemetry: await getPerfTelemetry(), perfOtlp: await getPerfOtlp() },
      process.env
    )
  );
  instrumentIpcHandle(ipcMain); // BEFORE registerIpc(...) so every handler is wrapped
```

(Match the file's actual structure: if `openDb` is called without capturing the return, capture it. `instrumentIpcHandle` must run before the `registerIpc`/`setupIpc` call — read the file and place accordingly. Also call `await shutdownPerf()` in the app's `before-quit`/`will-quit` handler alongside `closeDb()` so buffered rows land.)

- [ ] **Step 6: IPC handlers in `src/main/ipc.ts`**

Extend `config:get` (~line 1222) result object with:

```ts
    perfTelemetry: await getPerfTelemetry(),
    perfOtlp: await getPerfOtlp(),
```

After `config:setHardwareAccelDisabled` (~line 1253) add:

```ts
  ipcMain.handle('config:setPerfTelemetry', async (_e, enabled: boolean) => {
    await setPerfTelemetry(enabled === true);
    await reapplyPerfConfig();
    return getPerfStatus();
  });

  ipcMain.handle('config:setPerfOtlp', async (_e, enabled: boolean, endpoint: string) => {
    await setPerfOtlp(enabled === true, String(endpoint ?? ''));
    await reapplyPerfConfig();
    return getPerfStatus();
  });

  ipcMain.handle('perf:status', async () => getPerfStatus());
```

with a local helper (top of the file near other helpers):

```ts
async function reapplyPerfConfig(): Promise<void> {
  await reconfigurePerf(
    resolvePerfConfig(
      { perfTelemetry: await getPerfTelemetry(), perfOtlp: await getPerfOtlp() },
      process.env
    )
  );
}
```

and imports for `getPerfTelemetry, setPerfTelemetry, getPerfOtlp, setPerfOtlp` (config.js), `getPerfStatus, reconfigurePerf, recordPtyChunk` (perf.js), `resolvePerfConfig` (perfConfig.js).

In the pty:attach data handler (~line 1440), add one line inside the existing `handle.stream.on('data', …)` callback:

```ts
      handle.stream.on('data', (chunk: Buffer) => {
        win?.webContents.send(`pty:data:${ptyHandleId}`, chunk);
        recordPtyChunk(owner?.id ?? handleWorkspaceId.get(ptyHandleId) ?? null, brokerSessionId, chunk.length);
        if (owner && detector.push(chunk.toString('utf8'))) {
          committeeBusy.set(owner.id, { busy: detector.isBusy, since: Date.now() });
        }
      });
```

(Use whatever workspace-id variable is actually in scope at that site — `handleWorkspaceId.get(ptyHandleId)` exists per the detach handler; verify while editing.)

- [ ] **Step 7: Ingest span in `src/main/jsonlWatcher.ts`**

Wrap the per-read ingest loop (~line 430). Replace:

```ts
    let insertedCount = 0;
    let mirrorBuf = '';
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const result = ingestLine(state.workspaceId, state.sessionId, trimmed);
```

with:

```ts
    let insertedCount = 0;
    let mirrorBuf = '';
    const lines = text.split('\n');
    perfSpan(
      'claude_fleet.ingest',
      () => {
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const result = ingestLine(state.workspaceId, state.sessionId, trimmed);
          // …existing body of the loop unchanged (insertedCount++, mirrorBuf append)…
        }
      },
      { workspace_id: state.workspaceId, session_id: state.sessionId, lines: lines.length }
    );
```

(Move the existing loop body inside verbatim; add `import { perfSpan } from './perf.js';`.)

- [ ] **Step 8: Preload surface**

In `src/preload/index.ts` after `setAutoReloadLoadouts` (~line 413):

```ts
    setPerfTelemetry: (enabled: boolean): Promise<PerfStatusPayload> =>
      ipcRenderer.invoke('config:setPerfTelemetry', enabled),
    setPerfOtlp: (enabled: boolean, endpoint: string): Promise<PerfStatusPayload> =>
      ipcRenderer.invoke('config:setPerfOtlp', enabled, endpoint),
```

and a sibling top-level namespace next to the existing api groups:

```ts
  perf: {
    status: (): Promise<PerfStatusPayload> => ipcRenderer.invoke('perf:status')
  },
```

with the payload type (in `src/preload/index.d.ts`, matching however the file declares its types — mirror an existing payload interface):

```ts
export interface PerfStatusPayload {
  enabled: boolean;
  source: 'settings' | 'env-override';
  otlp: { enabled: boolean; endpoint: string | null; source: 'settings' | 'env' };
  eventCounts: Record<string, number>;
}
```

plus the `config:get` return-type additions (`perfTelemetry: boolean; perfOtlp: { enabled: boolean; endpoint: string }`).

- [ ] **Step 9: Verify**

Run: `npm run typecheck` → green. `npm run test:unit` → green (jsonlWatcher suites still pass — the span wrapper must not change loop semantics). `npm run build` → green.

- [ ] **Step 10: Commit**

```bash
git add src/main/index.ts src/main/ipc.ts src/main/jsonlWatcher.ts src/main/perfIpc.ts src/main/perfIpc.test.ts src/preload/index.ts src/preload/index.d.ts
git commit -m "feat(perf): wire telemetry into main — startup init, IPC spans, ingest span, PTY counters, perf IPC surface

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Settings UI — Diagnostics section

**Files:**
- Modify: `src/renderer/src/components/SettingsModal.tsx` (Plan usage section ends ~line 380; add Diagnostics after it)
- Modify: `src/renderer/src/styles.css` (after the `.setting-custom-budget` rules ~line 1500)

**Interfaces:**
- Consumes: `window.api.perf.status()`, `window.api.config.setPerfTelemetry/setPerfOtlp`, `config:get`'s `perfTelemetry`/`perfOtlp` fields (Task 6).
- Produces: UI only. Mockup to match: `docs/superpowers/specs/assets/2026-08-07-perf-telemetry/settings-mockups.html` — Option B, all four states.

- [ ] **Step 1: Read the mockup + current modal.** Open the mockup HTML and `SettingsModal.tsx` in full. The modal's existing convention: form state lives in component state, persisted on **Save** via the footer. Follow it — the two new checkboxes + endpoint input are local state initialized from `config:get`, persisted in the existing save handler by awaiting `setPerfTelemetry`/`setPerfOtlp` alongside the other setters.

- [ ] **Step 2: Add state + status polling** to `SettingsModal.tsx`:

```tsx
  const [perfTelemetry, setPerfTelemetryState] = useState(true);
  const [perfOtlpEnabled, setPerfOtlpEnabled] = useState(false);
  const [perfOtlpEndpoint, setPerfOtlpEndpoint] = useState('');
  const [perfStatus, setPerfStatus] = useState<PerfStatusPayload | null>(null);

  // Live status line (fed by the same data perf_status returns over MCP).
  useEffect(() => {
    let alive = true;
    const tick = () => window.api.perf.status().then((s) => { if (alive) setPerfStatus(s); }).catch(() => undefined);
    tick();
    const t = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(t); };
  }, []);
```

Initialize the three settings fields wherever the component loads `config:get` (find the existing effect that seeds `disableHardwareAcceleration` etc. and extend it). Extend the existing save handler to persist both (`setPerfTelemetry` first, then `setPerfOtlp`; surface thrown endpoint-validation errors through the modal's existing error display).

- [ ] **Step 3: Render the section** after the Plan usage `settings-section` div:

```tsx
            <div className="settings-section">
              <div className="settings-section-header">Diagnostics</div>
              <div className={`setting-row${perfStatus?.source === 'env-override' ? ' disabled' : ''}`}>
                <div className="setting-row-text">
                  <label className="setting-title" htmlFor="perf-telemetry">Performance telemetry</label>
                  <p className="setting-desc">
                    Record event-loop stalls, slow operations, and terminal latency to the local
                    history DB (OpenTelemetry). Queryable from any workspace via the fleet-state
                    MCP; 7-day retention.
                  </p>
                  {perfStatus && <PerfStatusLine s={perfStatus} />}
                </div>
                <input
                  id="perf-telemetry" type="checkbox" checked={perfTelemetry}
                  disabled={perfStatus?.source === 'env-override'}
                  onChange={(e) => setPerfTelemetryState(e.target.checked)}
                />
              </div>
              <div className={`setting-row${perfTelemetry ? '' : ' disabled'}`}>
                <div className="setting-row-text">
                  <label className="setting-title" htmlFor="perf-otlp">Export via OTLP</label>
                  <p className="setting-desc">
                    Also stream traces and metrics to an OpenTelemetry collector. Local recording
                    continues either way. Not changeable from workspaces.
                  </p>
                </div>
                <input
                  id="perf-otlp" type="checkbox" checked={perfOtlpEnabled}
                  disabled={!perfTelemetry}
                  onChange={(e) => setPerfOtlpEnabled(e.target.checked)}
                />
              </div>
              <div className="setting-custom-budget">
                <input
                  type="text" value={perfOtlpEndpoint} placeholder="http://localhost:4318"
                  disabled={!perfTelemetry || !perfOtlpEnabled}
                  onChange={(e) => setPerfOtlpEndpoint(e.target.value)}
                />
                <p className={`setting-desc${!perfTelemetry || !perfOtlpEnabled ? ' setting-desc-dim' : ''}`}>
                  OTLP/HTTP endpoint. <code>OTEL_EXPORTER_OTLP_ENDPOINT</code> overrides this when
                  set; auth headers via <code>OTEL_EXPORTER_OTLP_HEADERS</code>.
                </p>
              </div>
            </div>
```

with the status-line subcomponent (same file):

```tsx
function PerfStatusLine({ s }: { s: PerfStatusPayload }): JSX.Element {
  if (s.source === 'env-override') {
    return (
      <p className="setting-status">
        <span className="perf-dot override" /> forced off by <code>CLAUDE_FLEET_PERF=0</code> — setting ignored
      </p>
    );
  }
  if (!s.enabled) {
    return <p className="setting-status"><span className="perf-dot off" /> off</p>;
  }
  const total = Object.values(s.eventCounts).reduce((a, b) => a + b, 0);
  const exporting = s.otlp.enabled && s.otlp.endpoint
    ? <> · exporting → <code>{s.otlp.endpoint.replace(/^https?:\/\//, '')}</code></>
    : <> · OTLP export off</>;
  return (
    <p className="setting-status">
      <span className="perf-dot recording" /> recording · {total.toLocaleString()} events / 24 h{exporting}
    </p>
  );
}
```

- [ ] **Step 4: CSS** — append to `styles.css` after the `.setting-custom-budget` block:

```css
/* ── SettingsModal: Diagnostics status line (perf telemetry) ─────────── */
.setting-status {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--ink-2);
  margin: 6px 0 0;
  display: flex;
  align-items: center;
  gap: 6px;
}
.setting-status code { font-size: inherit; }
.perf-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.perf-dot.recording { background: var(--ok); box-shadow: 0 0 6px oklch(70% 0.16 145 / 0.5); }
.perf-dot.off { background: var(--ink-3); }
.perf-dot.override { background: var(--warn); }
.setting-row.disabled .setting-title,
.setting-row.disabled .setting-desc { opacity: 0.55; }
.setting-desc-dim { opacity: 0.55; }
```

- [ ] **Step 5: Verify (no display available)**

Run: `npm run typecheck && npm run test:unit && npm run build` → all green. This is the full UI gate in this container; the PR description must state that visual verification is pending Troy's eyeball on host.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/SettingsModal.tsx src/renderer/src/styles.css
git commit -m "feat(perf): Diagnostics settings section — telemetry toggle, live status line, OTLP export controls

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: MCP tools `perf_status` / `perf_set` + query-snapshot allowlist + contract tests

**Files:**
- Modify: `src/main/mcpServer.ts` (`buildSnapshot` ~line 770; `TOOLS` array — insert after the `query` tool entry ~line 1090; `query` tool description tables list)
- Test: `src/main/mcpServer.test.ts` (contract), plus the e2e MCP spec — find it with `grep -rl "list_sessions" tests/*.spec.ts` and mirror the tool-list additions (CI-only suite; update the expected-tools array).

**Interfaces:**
- Consumes: `getPerfStatus`, `reconfigurePerf` (perf.js), `setPerfTelemetry`, `getPerfTelemetry`, `getPerfOtlp` (config.js), `resolvePerfConfig` (perfConfig.js).
- Produces: MCP tools `perf_status` (no args) and `perf_set` (`{ enabled: boolean }`), both returning the `PerfStatus` shape; `perf_events` table inside `query` snapshots scoped to `workspace_id IS NULL OR workspace_id IN (allowed)`.

- [ ] **Step 1: Write the failing contract tests** — add to `src/main/mcpServer.test.ts` (follow its existing structure; it exercises `TOOLS` directly and has snapshot-isolation tests):

```ts
describe('perf tools', () => {
  it('perf_status and perf_set are registered with the pinned schemas', () => {
    const status = TOOLS.find((t) => t.name === 'perf_status');
    const set = TOOLS.find((t) => t.name === 'perf_set');
    expect(status).toBeDefined();
    expect(set).toBeDefined();
    expect(set!.inputSchema).toEqual({
      type: 'object',
      properties: { enabled: { type: 'boolean' } },
      required: ['enabled']
    });
  });

  it('perf_set rejects export-config arguments', async () => {
    const set = TOOLS.find((t) => t.name === 'perf_set')!;
    await expect(
      set.run(db, { enabled: true, endpoint: 'http://evil:4318' }, ctx)
    ).rejects.toThrow(/export/i);
    await expect(
      set.run(db, { enabled: true, otlp: { enabled: true } }, ctx)
    ).rejects.toThrow(/export/i);
  });

  it('query snapshot exposes perf_events scoped to allowed workspaces + app-global rows', () => {
    // Seed: one row for an allowed workspace, one for a foreign workspace, one app-global.
    liveDb.prepare(`INSERT INTO perf_events (ts, kind, workspace_id, name, dur_ms) VALUES (1, 'pty_window', 'ws-allowed', 'claude_fleet.pty.bytes', NULL)`).run();
    liveDb.prepare(`INSERT INTO perf_events (ts, kind, workspace_id, name, dur_ms) VALUES (2, 'pty_window', 'ws-foreign', 'claude_fleet.pty.bytes', NULL)`).run();
    liveDb.prepare(`INSERT INTO perf_events (ts, kind, dur_ms) VALUES (3, 'stall', 80)`).run();
    const rows = runQueryTool(`SELECT kind, workspace_id FROM perf_events ORDER BY ts`, ['ws-allowed']);
    expect(rows).toEqual([
      { kind: 'pty_window', workspace_id: 'ws-allowed' },
      { kind: 'stall', workspace_id: null }
    ]);
  });
});
```

(Adapt `db`/`liveDb`/`ctx`/`runQueryTool` to the file's actual fixtures — it already has helpers that build a seeded DB and invoke the `query` tool with an allowed-set; reuse them. The `perf_set` env/enabled paths need `initPerf` — if the fixture has no perf runtime, initialize one with an in-test PerfStore as the suite's beforeEach, mirroring `perf.test.ts`.)

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/main/mcpServer.test.ts`.

- [ ] **Step 3: Implement in `mcpServer.ts`**

In `buildSnapshot`, after the `usage_events` copy:

```ts
      // perf_events: app-global rows (workspace_id NULL — stalls, slow ops)
      // are host-process facts visible to every caller; workspace-tagged rows
      // (pty windows, terminal latency) are scoped like everything else.
      mem.prepare(
        `CREATE TABLE perf_events AS SELECT * FROM ${alias}.perf_events WHERE workspace_id IS NULL OR ${scope}`
      ).run(...params);
```

Append to `TOOLS` after the `query` entry (and add `perf_events` to the `query` tool's description's table list):

```ts
  {
    name: 'perf_status',
    description:
      'Perf-telemetry state: recording on/off + which source controls it (settings vs CLAUDE_FLEET_PERF), ' +
      'OTLP export state, and perf_events counts per kind over the trailing 24h.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => getPerfStatus()
  },
  {
    name: 'perf_set',
    description:
      'Enable or disable perf-telemetry recording (app-global; mediated by the host). ' +
      'Cannot change OTLP export config — export is Settings-UI/env only. ' +
      'Fails while CLAUDE_FLEET_PERF=0 pins recording off.',
    inputSchema: {
      type: 'object',
      properties: { enabled: { type: 'boolean' } },
      required: ['enabled']
    },
    run: async (_db, args) => {
      const extras = Object.keys(args).filter((k) => k !== 'enabled');
      if (extras.length > 0) {
        throw new Error(`perf_set cannot change export config (unexpected: ${extras.join(', ')})`);
      }
      if (process.env.CLAUDE_FLEET_PERF === '0') {
        throw new Error('recording is forced off by CLAUDE_FLEET_PERF=0 — the setting is ignored until the override is removed');
      }
      await setPerfTelemetry(args.enabled === true);
      await reconfigurePerf(
        resolvePerfConfig(
          { perfTelemetry: await getPerfTelemetry(), perfOtlp: await getPerfOtlp() },
          process.env
        )
      );
      return getPerfStatus();
    }
  },
```

with imports at top: `import { getPerfStatus, reconfigurePerf } from './perf.js';`, `import { getPerfTelemetry, setPerfTelemetry, getPerfOtlp } from './config.js';`, `import { resolvePerfConfig } from './perfConfig.js';`. (Match the `run` signature of neighboring tools exactly — `(rodb, args, ctx)`.)

- [ ] **Step 4: Update the e2e MCP contract spec** — `grep -rl "list_sessions" tests/*.spec.ts`, add `perf_status` and `perf_set` to its expected tool list (these run CI-only; do not attempt to run them here).

- [ ] **Step 5: Run tests** — `npx vitest run src/main/mcpServer.test.ts` → PASS; `npm run test:unit` → green.

- [ ] **Step 6: Commit**

```bash
git add src/main/mcpServer.ts src/main/mcpServer.test.ts tests/
git commit -m "feat(perf): fleet-state MCP perf_status/perf_set + perf_events in query snapshots

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: SPEC.md + design-doc sync

**Files:**
- Modify: `docs/SPEC.md` (§4 Stack, §6 Observability, §11 Fleet-state MCP, IPC channel table, data model / env flags — read each section and edit in place per the spec-maintenance rule: current state, no changelog prose)
- Modify: `docs/superpowers/specs/2026-08-07-perf-telemetry-design.md` (two planning-time deltas)

- [ ] **Step 1: SPEC.md edits** (concise, in the spec's existing voice):
  - **§4 Stack:** add the OTel packages (`@opentelemetry/api`, `sdk-trace-base`, `sdk-metrics`, `core`, OTLP HTTP trace+metric exporters) with one-line rationale: perf telemetry is OTel-native so the same instrumentation feeds the local `perf_events` store and any standard OTLP backend; API no-ops when disabled.
  - **§6 Observability:** new subsection *Perf telemetry*: what's recorded (event-loop stall windows >50 ms with p50/p99/max; spans ≥25 ms as slow_ops — every IPC handler as `claude_fleet.ipc.<channel>`, the JSONL ingest batch as `claude_fleet.ingest`; per-session PTY bytes/chunks per 5 s window), the `perf_events` schema (all 10 columns), batching (5 s single-transaction flush via PerfStore), 7-day retention pruned at startup, defaults + precedence (`perfTelemetry` default on; `CLAUDE_FLEET_PERF=0` forces off; `perfOtlp` settings vs `OTEL_EXPORTER_OTLP_ENDPOINT` override), and that dockerode/vault work is attributed via its enclosing IPC-channel span in Phase 1.
  - **IPC surface:** add `config:setPerfTelemetry`, `config:setPerfOtlp`, `perf:status`; note `config:get` gained `perfTelemetry`/`perfOtlp`.
  - **§11 Fleet-state MCP:** document `perf_status` + `perf_set` (available to every workspace, no grant; `perf_set` toggles recording only, rejects export changes and rejects under `CLAUDE_FLEET_PERF=0` — first mutating tool outside the committee family, still mediated-by-main per §9) and `perf_events` in `query` snapshots (app-global NULL-workspace rows visible to all callers; workspace-tagged rows scoped).
  - **Dev env flags:** `CLAUDE_FLEET_PERF=0`; `OTEL_EXPORTER_OTLP_ENDPOINT`/`OTEL_EXPORTER_OTLP_HEADERS` standard-OTel behavior.
- [ ] **Step 2: Design-doc sync** in `2026-08-07-perf-telemetry-design.md`:
  - §3 schema: add the `workspace_id` column (uniform MCP snapshot scoping).
  - §1: note that dockerode/vault attribution in PR 1 comes via the enclosing `claude_fleet.ipc.<channel>` spans; dedicated spans are a follow-up if stall data demands finer grain.
- [ ] **Step 3: Verify + commit**

```bash
npm run typecheck   # unchanged, but cheap sanity
git add docs/SPEC.md docs/superpowers/specs/2026-08-07-perf-telemetry-design.md
git commit -m "docs(spec): perf telemetry — stack, observability pipeline, IPC + MCP surface, env flags

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Full gate + PR

- [ ] **Step 1: Full verification**

```bash
npm run typecheck && npm run test:unit && npm run build
```

Expected: all green. (Playwright e2e needs a display — runs in CI, not here.)

- [ ] **Step 2: Smoke the DB migration against a copy** (paranoia for v11 on a real profile is unnecessary — additive CREATE TABLE — but confirm a fresh openDb reaches user_version 11):

```bash
node -e "const {openDb,closeDb}=await import('./out/main/index.js').catch(()=>({})); " 2>/dev/null || npx vitest run src/main/perfStore.test.ts
```

(The perfStore migration test is the real check; this step just re-runs it standalone.)

- [ ] **Step 3: Push + PR**

```bash
git push -u origin feat/perf-telemetry
gh pr create --title "feat: always-on perf telemetry (Phase 1) — stall detection, slow-op attribution, Diagnostics settings, MCP lever" --body "$(cat <<'EOF'
Implements PR 1 of docs/superpowers/specs/2026-08-07-perf-telemetry-design.md.

- OTel-native pipeline in main (`perf.ts`): event-loop stall sampler (>50ms windows), slow-op spans (≥25ms) over every IPC handler + JSONL ingest, per-session PTY throughput counters
- `perf_events` table (migration v11), batched 5s flush, 7-day retention
- Diagnostics section in Settings: telemetry toggle + live status line + OTLP export toggle/endpoint (greyed when off); env overrides `CLAUDE_FLEET_PERF=0` / `OTEL_EXPORTER_OTLP_ENDPOINT`
- fleet-state MCP: `perf_status` / `perf_set` (recording only — export config is deliberately not reachable from workspaces), `perf_events` in `query` snapshots
- SPEC.md §4/§6/§11 + IPC surface updated in-repo

Verification: `npm run typecheck` + `npm run test:unit` + `npm run build` all green in the workspace container. **No visual verification** (no display here) — Settings UI needs an eyeball on host; mockup reference: `docs/superpowers/specs/assets/2026-08-07-perf-telemetry/settings-mockups.html`. e2e (incl. CI-only MCP contract specs) runs in CI.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review notes (already applied)

- Spec coverage: §0 pipeline (T3/T4/T5), §1 monitors (T3/T4 + T6 wiring), §3 storage (T1), §4 controls incl. all mockup states (T2/T6/T7), §5 snapshot (T8), §6 testing (each task + T8 contract/e2e), §7 SPEC (T9). Phase 2 items (latency hops, `perf:samples`, `pty:data` envelope) are deliberately absent — PR 2.
- Deviation from design doc, made explicit: `workspace_id` column added; dockerode/vault spans attributed via IPC spans in Phase 1. Both synced into the design doc by Task 9.
- Type consistency: `PerfStatus`/`PerfStatusPayload` shapes match across perf.ts, preload, SettingsModal, and the MCP tool; `EffectivePerfConfig` is the single effective-config type everywhere.
