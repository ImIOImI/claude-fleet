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
- Telemetry leaving the machine **by default**. Local SQLite is the primary
  store; OTLP export happens only when the user explicitly enables it (§0,
  §4).
- The OTel **logs** signal. This design exports traces + metrics only;
  streaming `error.log` (or other app logs) to a collector is a conscious
  cut, revisit later if wanted.

## Design

### 0. Recording pipeline: OpenTelemetry-native

All instrumentation goes through the **OpenTelemetry API**
(`@opentelemetry/api`), with the OTel Node SDK (tracer + meter providers)
running in the main process, owned by `src/main/perf.ts`:

- Timed operations are real OTel **spans**; measurements are OTel **metrics**
  (histograms/counters). Names follow OTel semantic conventions where they
  exist (e.g. the `nodejs.eventloop.delay.*` metric names); everything custom
  lives under a `claude_fleet.*` namespace.
- Two exporters, both fed by the SDK's batch processors (~5 s interval):
  1. **SQLite exporter (always on):** custom `SpanExporter` + metric exporter
     that map finished spans/metric points into the local `perf_events` table
     (§3). This keeps the fleet-state MCP analysis loop fully local.
  2. **OTLP/HTTP exporter (opt-in):** streams the same traces + metrics to
     any OTel backend (Jaeger, Grafana, Datadog, …). Enabled either by the
     Settings-UI export toggle + endpoint field (§4 — the primary interface;
     env vars are hostile UX for a desktop app) or by the standard
     `OTEL_EXPORTER_OTLP_ENDPOINT` env var, which **overrides** the setting
     when present (OTel-standard compat + dev/e2e escape hatch; auth headers
     via `OTEL_EXPORTER_OTLP_HEADERS`). With export off and no env var,
     nothing leaves the machine.
- The kill switch (§4) works by starting/shutting down the SDK: with no
  provider registered, the OTel API no-ops, so instrumentation sites cost
  effectively nothing while disabled.
- The **renderer stays thin**: it does not run an OTel web SDK. Phase 2
  renderer samples arrive over `perf:samples` and main records them through
  the OTel API on the renderer's behalf.

### 1. Main-process health monitor — `src/main/perf.ts` (Phase 1)

- **Event-loop stall detector:** `perf_hooks.monitorEventLoopDelay`
  (`resolution: 10`), sampled every 5 s into OTel gauges/histograms
  (`nodejs.eventloop.delay.p50/p99/max`). A window whose max delay exceeds
  50 ms additionally records a `claude_fleet.stall` event carrying p50/p99/max
  for the window. Native histogram; effectively free.
- **Slow-op tracer:** `perfSpan(name, fn)` (sync and async variants) wraps an
  operation in an OTel span. Spans slower than 25 ms are persisted by the
  SQLite exporter as `slow_op` rows (the OTLP exporter, when enabled, receives
  all spans and applies its own sampling). Wrapped around the known
  synchronous suspects:
  - the JSONL ingest batch in `jsonlWatcher.ts` (the `ingestLine` chain),
  - dockerode calls in `docker.ts`,
  - vault operations,
  - every `ipcMain.handle` callback, generically, at registration in `ipc.ts`
    (span name = `claude_fleet.ipc.<channel>`).
  A `stall` that coincides with a `slow_op` is self-attributing at query time.
- **PTY throughput counters:** OTel counters for bytes/chunks forwarded, with
  a `session_id` attribute, aggregated per 5 s window and persisted as
  `pty_window` rows only when nonzero, so stalls can be correlated with
  output load.

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
  `perf:samples` channel (`ipcRenderer.send`, not invoke); main records them
  as `claude_fleet.terminal.*` histograms via the OTel API (§0).

Both processes share the machine wall clock, so epoch-ms stamps
(`performance.timeOrigin + performance.now()`) are directly comparable.

### 3. Storage (the SQLite exporter's target)

New table in the existing history DB, added via the `user_version` migration
chain in `db.ts`:

```sql
CREATE TABLE perf_events (
  id         INTEGER PRIMARY KEY,
  ts         INTEGER NOT NULL,          -- epoch ms
  kind       TEXT NOT NULL,             -- stall | slow_op | pty_window | input_hop | output_hop | echo_rtt
  session_id TEXT,                      -- nullable; broker session where applicable
  name       TEXT,                      -- span/metric name for slow_op etc., else NULL
  dur_ms     REAL,                      -- primary measurement
  trace_id   TEXT,                      -- OTel trace id (spans only)
  span_id    TEXT,                      -- OTel span id (spans only)
  meta       TEXT                       -- JSON: span attributes, p50/p99/max, bytes, chunks, …
);
CREATE INDEX idx_perf_events_ts ON perf_events(ts);
CREATE INDEX idx_perf_events_kind_ts ON perf_events(kind, ts);
```

- The exporter batch-inserts **in a single transaction per flush (~5 s)**,
  never on the hot path. The flush is itself wrapped in
  `perfSpan('claude_fleet.perf.flush')`, so the telemetry self-reports if it
  ever becomes the problem.
- `trace_id`/`span_id` let local rows be correlated with an external OTLP
  backend when one is configured.
- Retention: rows older than 7 days deleted at startup (local table only;
  external backends own their own retention).

### 4. Controls (settings toggle + MCP lever)

- **App settings** on `AppConfig` (`<userData>/config.json`):
  - `perfTelemetry?: boolean` — record locally, **default `true`**.
  - `perfOtlp?: { enabled: boolean; endpoint: string }` — export, **default
    off/empty**.
  New `config:setPerfTelemetry` + `config:setPerfOtlp` IPC handlers following
  the existing per-field `config:set*` pattern.
- **Settings UI (decision 2026-08-07, chosen from rendered mockups —
  "Option B with C's state handling"):** a new **Diagnostics** section in the
  Settings modal, after Plan usage, using the established section-header +
  toggle-row idioms:
  - *Performance telemetry* row with a live mono status line beneath the
    description, fed by the same data `perf_status` returns. Render states:
    `● recording · <n> events / 24 h [· exporting → <endpoint>]` (green dot),
    `○ off` (grey), and `● forced off by CLAUDE_FLEET_PERF=0 — setting
    ignored` (amber, checkbox disabled). The status line — not the checkbox —
    is the source of truth, since the MCP lever can flip recording remotely.
  - *Export via OTLP* row (checkbox), greyed out while recording is off; when
    checked, the endpoint input reveals full-width below it (the
    Plan-usage-Custom idiom) with a hint noting the
    `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_HEADERS` env
    overrides. Archived rendering:
    `assets/2026-08-07-perf-telemetry/settings-mockups.html` (self-contained;
    open in a browser).
- **Env overrides:** `CLAUDE_FLEET_PERF=0` forces recording off regardless of
  the setting (dev/e2e escape hatch; it never forces it *on*).
  `OTEL_EXPORTER_OTLP_ENDPOINT` forces export on to that endpoint (§0).
- **MCP lever** on the fleet-state server:
  - `perf_status` (read) → `{ enabled, source: 'settings' | 'env-override',
    otlp: { enabled: boolean, endpoint: string | null,
    source: 'settings' | 'env' }, eventCounts: { kind → count, last 24 h } }`.
  - `perf_set` (write, mediated) → `{ enabled: boolean }`; flips the
    `perfTelemetry` app setting through the same main-process code path as the
    Settings UI, and returns the resulting `perf_status`. Rejected with a
    clear error while the `CLAUDE_FLEET_PERF` override is active.
    **`perf_set` deliberately cannot enable export or set the endpoint** — a
    workspace must never be able to redirect host telemetry to an arbitrary
    URL. Export config is Settings-UI or env only.
  - Both tools are available to every workspace (no grant required): they
    control diagnostics collection only and expose no cross-workspace data.
    **Security note:** `perf_set` is the first mutating fleet-state tool
    outside the committee family. It stays within the SPEC §9 invariant
    (writes mediated by the main process, no filesystem/DB path exposed), but
    SPEC §11 must document it explicitly as a global, ungated switch.
- Live toggling: turning telemetry off flushes and shuts down the OTel SDK
  (the API then no-ops at every instrumentation site); turning it on
  re-registers the providers. No app restart required.

### 5. MCP query surface

`perf_events` (all columns) is added to the `query` tool's per-call snapshot
alongside `events` / `sessions` / `broker_sessions`. Snapshot rows are
workspace-scoped where `session_id` maps to an allowed workspace; app-global
rows (`stall`, `slow_op` with no session) are visible to every caller — they
describe the shared host process, not another workspace's content.

### 6. Testing

- Vitest units: the SQLite exporter (span/metric point → `perf_events` row
  mapping, threshold filtering, single-transaction flush), retention pruning,
  live enable/disable (SDK shutdown → API no-ops), migration bump,
  env-override precedence (`CLAUDE_FLEET_PERF` beats setting; OTLP env beats
  the `perfOtlp` setting), OTLP exporter registration off by default / on via
  setting / on via env, and `perf_set` rejecting export-config changes.
- MCP contract tests: `mcpServer.test.ts` for `perf_status`/`perf_set` and the
  snapshot allowlist; matching `tests/mcp-*.spec.ts` e2e additions (CI-only)
  per the MCP contract-test convention.
- Phase 2's `pty:input`/`pty:data` payload changes must keep the existing
  Playwright terminal specs green.

### 7. SPEC.md updates (same-commit rule)

- §4 Stack: new runtime deps (`@opentelemetry/api`, SDK trace/metrics
  packages, OTLP/HTTP exporter) and the rationale for OTel-native recording.
- §6 Observability: `perf_events` table, OTel pipeline (SQLite exporter +
  opt-in OTLP via `OTEL_EXPORTER_OTLP_ENDPOINT`), retention.
- §11 Fleet-state MCP: `perf_status`, `perf_set`, snapshot addition, the
  ungated-write security note.
- IPC surface: `config:setPerfTelemetry`, `config:setPerfOtlp`,
  `perf:samples`, and the Phase 2 payload shape changes to `pty:input` /
  `pty:data:*`.
- Data model: the `perfTelemetry` / `perfOtlp` fields on `AppConfig`.
- Dev env flags: `CLAUDE_FLEET_PERF`, `OTEL_EXPORTER_OTLP_*` behavior.

## Phasing

- **PR 1 (Phase 1):** `perf.ts` (OTel SDK wiring, SQLite + opt-in OTLP
  exporters, stall detector, slow-op tracer, PTY counters), `perf_events`
  storage, settings toggle + Settings UI, env override, MCP
  `perf_status`/`perf_set`, snapshot allowlist, tests, SPEC.
- **PR 2 (Phase 2):** latency hops (`pty:input` ts, `{ts, chunk}` output
  envelope, echo-RTT sampling, `perf:samples` batching), tests, SPEC.

## Success criterion

After a few days of dogfooding: either ≥80 % of `stall` events are attributed
to a named `slow_op` (then fix that — most likely moving JSONL ingestion to a
worker thread), or the main-loop hypothesis is falsified and external
profilers (DevTools / `--inspect` / pprof) are aimed at whichever hop the
Phase 2 histograms implicate.
