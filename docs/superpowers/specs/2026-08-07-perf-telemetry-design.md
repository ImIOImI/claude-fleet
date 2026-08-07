# Always-on perf telemetry for CLI responsiveness

**Date:** 2026-08-07
**Status:** Approved (design review with Troy)
**Repo:** claude-fleet

## Problem

Terminal responsiveness is the #1 UX issue: keystrokes occasionally echo with
visible delay, and sessions intermittently hang for a beat before catching up.
There is no reproduction recipe ("no pattern noticed") and **zero
instrumentation anywhere in the terminal path** — no perf marks, no timing
logs, no latency metrics. We cannot optimize what we cannot see.

## Background: the keystroke round trip

A keypress travels renderer → main → broker → claude and back before the user
sees anything (claude's TUI does app-level echo):

```
xterm.js onData → pty:input IPC invoke → main stream.write() → unix socket
→ Go broker → PTY → claude redraws → PTY → broker pump (16 KiB reads)
→ socket → main ('data' handler + activity-detector scan)
→ webContents.send per chunk → term.write() → xterm rAF paint
```

Audit findings (2026-08-07, against v0.10.0):

1. **Main-process event loop is the prime hang suspect.** Main both forwards
   PTY traffic and runs the JSONL→SQLite observability pipeline, and
   `better-sqlite3` is fully synchronous (`db.ts` `ingestLine()`, driven by the
   chokidar watcher). Heavy transcript ingestion coincides exactly with heavy
   claude output, so a large ingest batch stalls keystroke *and* output
   forwarding simultaneously — matching the "hangs then catches up" symptom.
2. **No coalescing or backpressure anywhere.** Every broker chunk becomes its
   own `webContents.send` (`ipc.ts` pty:attach data handler); `stream.write()`
   return values are ignored; flow control is kernel socket buffers only.
3. The broker side (Go) is simple and unlikely to be the bottleneck; it is out
   of scope until data implicates it.

## Goals

- Quantify user-perceived keystroke→echo latency during normal dogfooding.
- Catch main-process event-loop stalls **with automatic attribution** to the
  operation that caused them.
- Make the data queryable from workspaces via the fleet-state MCP server, so
  the analysis loop is "dogfood for a few days, then ask a session to analyze
  `perf_events`".
- User control: a Settings toggle in the app **and** a lever on the
  fleet-state MCP server to check/flip telemetry from inside a workspace.

## Non-goals

- Fixing anything yet (worker-threading the DB, coalescing IPC, etc. are
  *conclusions* this data should drive, not part of this work).
- Go broker instrumentation (phase 3, only if implicated).
- Renderer paint profiling (Chrome DevTools when the data points there).
- Telemetry ever leaving the machine. Local SQLite only.

## Design

### 1. Main-process health monitor — new module `src/main/perf.ts` (Phase 1)

- **Event-loop stall detector:** `perf_hooks.monitorEventLoopDelay`
  (`resolution: 10`), sampled every 5 s. A window whose max delay exceeds
  50 ms records a `stall` event carrying p50/p99/max for the window. Native
  histogram; effectively free.
- **Slow-op tracer:** `perfSpan(name, fn)` (sync and async variants) records
  any wrapped operation slower than 25 ms as a `slow_op` event (name, dur_ms,
  ts). Wrapped around the known synchronous suspects:
  - the JSONL ingest batch in `jsonlWatcher.ts` (the `ingestLine` chain),
  - dockerode calls in `docker.ts`,
  - vault operations,
  - every `ipcMain.handle` callback, generically, at registration in `ipc.ts`
    (span name = channel name).
  A `stall` that coincides with a `slow_op` is self-attributing at query time.
- **PTY throughput counters:** per-session bytes/chunks forwarded per 5 s
  window, recorded as `pty_window` events only when nonzero, so stalls can be
  correlated with output load.

### 2. User-perceived latency hops (Phase 2)

- **Input hop:** renderer stamps epoch-ms at `term.onData` and sends it in the
  `pty:input` payload; main stamps receipt → renderer→main IPC latency.
- **Output hop:** `pty:data:*` payload changes from raw chunk to
  `{ ts, chunk }` (main stamps before `webContents.send`); renderer stamps
  after `term.write` completes → forwarding + write latency.
- **Echo round-trip (the headline number):** renderer timestamps each
  keystroke; the next `pty:data` arrival within 2 s closes the sample. Noisy
  per-sample, meaningful as a histogram over a day of use.
- Renderer batches its samples to main every ~5 s over a new one-way
  `perf:samples` channel (`ipcRenderer.send`, not invoke).

Both processes share the machine wall clock, so epoch-ms stamps
(`performance.timeOrigin + performance.now()`) are directly comparable.

### 3. Storage

New table in the existing history DB, added via the `user_version` migration
chain in `db.ts`:

```sql
CREATE TABLE perf_events (
  id         INTEGER PRIMARY KEY,
  ts         INTEGER NOT NULL,          -- epoch ms
  kind       TEXT NOT NULL,             -- stall | slow_op | pty_window | input_hop | output_hop | echo_rtt
  session_id TEXT,                      -- nullable; broker session where applicable
  name       TEXT,                      -- span/channel name for slow_op, else NULL
  dur_ms     REAL,                      -- primary measurement
  meta       TEXT                       -- JSON: p50/p99/max, bytes, chunks, …
);
CREATE INDEX idx_perf_events_ts ON perf_events(ts);
CREATE INDEX idx_perf_events_kind_ts ON perf_events(kind, ts);
```

- Inserts are **batched every 5 s in a single transaction**, never on the hot
  path. The batch insert is itself wrapped in `perfSpan('perf.flush')`, so the
  telemetry self-reports if it ever becomes the problem.
- Retention: rows older than 7 days deleted at startup.

### 4. Controls (settings toggle + MCP lever)

- **App setting:** `perfTelemetry?: boolean` on `AppConfig`
  (`<userData>/config.json`), **default `true`**. New
  `config:setPerfTelemetry` IPC handler following the existing `config:set*`
  pattern, and a toggle in the Settings screen (with the other app-level
  switches, e.g. hardware acceleration).
- **Env override:** `CLAUDE_FLEET_PERF=0` forces telemetry off regardless of
  the setting (dev/e2e escape hatch, mirroring existing dev flags). It never
  forces it *on*.
- **MCP lever** on the fleet-state server:
  - `perf_status` (read) → `{ enabled, source: 'settings' | 'env-override',
    eventCounts: { kind → count, last 24 h } }`.
  - `perf_set` (write, mediated) → `{ enabled: boolean }`; flips the
    `perfTelemetry` app setting through the same main-process code path as the
    Settings UI, and returns the resulting `perf_status`. Rejected with a
    clear error while the env override is active.
  - Both tools are available to every workspace (no grant required): they
    control diagnostics collection only and expose no cross-workspace data.
    **Security note:** `perf_set` is the first mutating fleet-state tool
    outside the committee family. It stays within the SPEC §9 invariant
    (writes mediated by the main process, no filesystem/DB path exposed), but
    SPEC §11 must document it explicitly as a global, ungated switch.
- Live toggling: turning telemetry off stops sampling and flushes; turning it
  on restarts monitors. No app restart required.

### 5. MCP query surface

`perf_events` (all columns) is added to the `query` tool's per-call snapshot
alongside `events` / `sessions` / `broker_sessions`. Snapshot rows are
workspace-scoped where `session_id` maps to an allowed workspace; app-global
rows (`stall`, `slow_op` with no session) are visible to every caller — they
describe the shared host process, not another workspace's content.

### 6. Testing

- Vitest units: span threshold behavior, batching/flush, retention pruning,
  live enable/disable, migration bump, env-override precedence.
- MCP contract tests: `mcpServer.test.ts` for `perf_status`/`perf_set` and the
  snapshot allowlist; matching `tests/mcp-*.spec.ts` e2e additions (CI-only)
  per the MCP contract-test convention.
- Phase 2's `pty:input`/`pty:data` payload changes must keep the existing
  Playwright terminal specs green.

### 7. SPEC.md updates (same-commit rule)

- §6 Observability: `perf_events` table, collection pipeline, retention.
- §11 Fleet-state MCP: `perf_status`, `perf_set`, snapshot addition, the
  ungated-write security note.
- IPC surface: `config:setPerfTelemetry`, `perf:samples`, and the Phase 2
  payload shape changes to `pty:input` / `pty:data:*`.
- Dev env flags: `CLAUDE_FLEET_PERF`.

## Phasing

- **PR 1 (Phase 1):** `perf.ts` (stall detector, slow-op tracer, PTY
  counters), `perf_events` storage, settings toggle + Settings UI, env
  override, MCP `perf_status`/`perf_set`, snapshot allowlist, tests, SPEC.
- **PR 2 (Phase 2):** latency hops (`pty:input` ts, `{ts, chunk}` output
  envelope, echo-RTT sampling, `perf:samples` batching), tests, SPEC.

## Success criterion

After a few days of dogfooding: either ≥80 % of `stall` events are attributed
to a named `slow_op` (then fix that — most likely moving JSONL ingestion to a
worker thread), or the main-loop hypothesis is falsified and external
profilers (DevTools / `--inspect` / pprof) are aimed at whichever hop the
Phase 2 histograms implicate.
