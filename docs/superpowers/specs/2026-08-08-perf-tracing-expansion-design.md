# Perf tracing expansion: span attribution, child spans, latency hops

**Date:** 2026-08-08
**Status:** Approved (design review with Troy)
**Repo:** claude-fleet
**Builds on:** `2026-08-07-perf-telemetry-design.md` (Phase 1, shipped as PR #274)

## Problem

Phase 1 telemetry is live and already exposing its own blind spots. First
dogfood queries (2026-08-08, ~15 min of data) show:

- **99% of `slow_op` rows are unattributed.** 2,631 of 2,649 slow-op spans
  have `workspace_id = NULL` — the generic IPC wrapper sets no span
  attributes, and only the JSONL-ingest span passes them. Inherently
  per-workspace operations (`observability:summaryForBrokerSession` alone is
  1,961 rows, plus `pty:attach`, `sessions:write`, …) cannot be tied to the
  workspace that caused them, which undermines the stall⋈slow_op analysis
  loop the whole pipeline exists for.
- **Attribution stops at the IPC channel.** A slow `pty:attach` span cannot
  distinguish dockerode time from vault time from broker-socket time — the
  Phase 1 design explicitly deferred child spans "if stall data demands finer
  attribution grain". It does.
- **The headline number is still missing.** Real stalls are firing (max
  event-loop pauses of 2.6–6.3 s observed during heavy
  `summaryForBrokerSession` traffic), but there is no measurement of what the
  user actually feels: keystroke→echo latency. That was always Phase 2.

## Goals

- Attribute slow-op spans (and, transitively, stalls) to the workspace and
  session that caused them.
- Break slow IPC spans into child spans for the known heavy calls (dockerode,
  vault).
- Measure user-perceived latency per hop: renderer→main input, main→renderer
  output, and keystroke→echo round trip (Phase 2 of the original design).

## Non-goals

- Go broker instrumentation (still Phase 3, still not implicated).
- Fixing whatever the data implicates (separate work, driven by this data).
- New MCP tools, new `perf_events` kinds, or schema migrations — the Phase 1
  schema already reserved `input_hop` / `output_hop` / `echo_rtt`.
- Renderer OTel SDK. The renderer stays thin; main records on its behalf.

## Shipping shape: two PRs

**PR A (attribution + child spans)** is additive main-process-only work — no
payload, schema, or renderer changes — and immediately upgrades the data being
collected during the current dogfood window. **PR B (latency hops)** touches
the pty hot path and the renderer, so it rides separately and is
independently revertable. Decision: attribution first, so the
stall-attribution analysis isn't blind while the most interesting dogfood
data accumulates.

## PR A — span attribution + child spans

### A1. Per-channel context map (`perfIpc.ts`)

`instrumentIpcHandle` gains a static map from channel name to the argument
positions (0-based, after the `event` arg) that carry ids:

```ts
const CHANNEL_CONTEXT: Record<string, { workspaceArg?: number; sessionArg?: number }> = {
  'observability:summaryForBrokerSession': { workspaceArg: 0, sessionArg: 1 },
  'sessions:write': { workspaceArg: 0 },
  'sessions:read': { workspaceArg: 0 },
  // … every channel whose args carry a workspace/broker-session id
};
```

At dispatch, the wrapper stamps `workspace_id` / `session_id` span attributes
when the mapped arg is a string. The Phase 1 SQLite exporter already lifts
exactly these attributes into the `perf_events` columns
(`SqliteSpanExporter`, perf.ts), so **no exporter changes**. The map is
populated by auditing `ipc.ts` handler signatures at implementation time;
channels with no id in their args (e.g. `workspace:list`) are correctly
absent and stay app-global.

`session_id` here is the **broker session id** (stable per-tab key), matching
what `pty_window` rows already record; joining to the claude session UUID
goes through `broker_sessions` at query time, as today.

### A2. `perfSetSpanContext()` for post-lookup attribution

Some handlers only learn the workspace after work starts. New helper in
`perf.ts`:

```ts
export function perfSetSpanContext(ctx: { workspaceId?: string; sessionId?: string }): void
// sets workspace_id / session_id attributes on the active OTel span; no-op when disabled
```

Call sites:
- `pty:attach` — after the existing `listAllWorkspaces().find()` owner lookup.
- `pty:input` — via the existing `handleWorkspaceId` map keyed by pty handle id.

This keeps the arg map honest: it only describes ids that are literally in
the arguments.

### A3. Child spans for known heavy calls

Wrap the operations that dominate IPC handler bodies in `perfSpan` /
`perfSpanAsync` at their call sites:

- `claude_fleet.docker.attach_pty`, `claude_fleet.docker.create`,
  `claude_fleet.docker.start`, `claude_fleet.docker.stop` — around the
  dockerode-backed calls in `docker.ts`.
- `claude_fleet.vault.resolve_env` — around secret resolution during
  container creation.

OTel context propagation parents them under the enclosing
`claude_fleet.ipc.<channel>` span automatically; children slower than the
existing 25 ms threshold persist as their own `slow_op` rows sharing the
parent's `trace_id`, so "which part of the slow attach was docker?" is a
query-time join. Child spans inherit no attributes automatically — the
wrapper call sites pass `workspace_id` where it's in scope.

### A4. Scoping consequence (intentional)

Once IPC spans carry `workspace_id`, those rows become **workspace-scoped**
in the MCP `query` snapshot instead of NULL rows visible to every workspace.
This is strictly tighter isolation: a workspace stops seeing timing rows for
operations another workspace triggered. Genuinely global rows (stalls,
`claude_fleet.perf.flush`, id-less channels) remain NULL/visible-to-all.
SPEC.md §11's description of perf-row scoping gets a sentence to this effect.

## PR B — Phase 2 latency hops

Implements §2 of the Phase 1 design with two reviewed deviations (B2, B4).

### B1. Input hop

`pty:input` gains a renderer epoch-ms timestamp
(`performance.timeOrigin + performance.now()`), added as a trailing argument
through preload (`window.api.pty.input(sessionId, data, ts)`). Main measures
`receipt − ts` per message. Older/absent timestamps (e.g. during a
mixed-version dev reload) are skipped, not recorded as zero.

### B2. Output hop — timestamp as a separate IPC argument

Main stamps epoch-ms as a **second argument** on the existing send —
`webContents.send('pty:data:<id>', chunk, ts)` — instead of the
`{ ts, chunk }` envelope sketched in the Phase 1 design. The chunk stays a
raw Buffer end-to-end: no per-chunk object wrap, and no changes to anything
that consumes the chunk. The renderer computes `after term.write() − ts`.
(Deviation approved 2026-08-08.)

### B3. Echo round trip

The renderer timestamps each keystroke; the next `pty:data` arrival within
2 s closes the sample (per the Phase 1 design — noisy per-sample, meaningful
as a histogram). The pairing state machine lives in a pure module,
`src/renderer/src/echoRtt.ts`, with no xterm/IPC imports, so it is directly
vitest-testable: `TerminalSession.tsx` feeds it keystroke/data events and
reads back completed samples.

### B4. Sample batching and the off switch

- The renderer batches its samples (input-hop stamps are main-side; echo-RTT
  and output-hop samples are renderer-side) and sends them every ~5 s over a
  new **one-way** `perf:samples` channel (`ipcRenderer.send`, not invoke).
- **Gating is renderer-side** (decision 2026-08-08, chosen over
  main-drops-silently): a new one-way `perf:state` push
  (`webContents.send`) tells every window the current recording state — sent
  on window creation and on every recording flip, from the same
  `reconfigurePerf` path used by the Settings toggle and the MCP `perf_set`
  lever, so all entry points stay in sync. While off, the renderer skips
  stamping, pairing, and batching entirely. The renderer defaults to **off**
  until the first push arrives (worst case: the first seconds of samples are
  lost, never spurious work while disabled). Main additionally drops
  `perf:samples` batches that arrive while recording is off (belt and
  braces — the push is async).

### B5. Recording and persistence

Main records input-hop measurements directly at `pty:input` receipt, and the
renderer-batched samples (echo-RTT, output-hop) on arrival — all as OTel
histograms
(`claude_fleet.terminal.input_hop` / `output_hop` / `echo_rtt`, ms) with
`workspace_id` / `session_id` attributes resolved via the existing
`handleWorkspaceId` map. `SqliteMetricExporter` — which today maps only DELTA
counters — is extended to map **histogram data points** to rows: kind from
the metric name, one row per (metric, session) per ~5 s flush window when
`count > 0`, `dur_ms` = max, `meta` = `{ count, sum, min, max, buckets }`.
The reserved kinds mean **no migration**; the OTLP exporter (when enabled)
receives the same histograms natively.

## Testing

**PR A (vitest):**
- `perfIpc.test.ts` — mapped channels stamp `workspace_id`/`session_id` from
  args; unmapped channels stamp nothing; non-string args are skipped.
- `perf.test.ts` — `perfSetSpanContext` sets attributes on the active span,
  no-ops with no active span / recording off.
- Child-span units where the seams allow (docker/vault wrappers produce
  correctly named+parented spans against a stubbed backend).

**PR B (vitest):**
- `echoRtt.test.ts` — pairing: close-within-2 s, expiry, interleaved
  keystrokes, no-output case.
- Exporter: histogram point → row mapping (kind, dur_ms=max, meta shape,
  count=0 windows skipped).
- `perf:samples` handler: batches recorded when on, dropped when off;
  `perf:state` pushed on flip from both the settings and `perf_set` paths.

**e2e:** the existing Playwright terminal specs (`multi-session.spec.ts`,
`terminal-fonts.spec.ts`) must stay green over the PR B payload changes —
they are the regression gate for the hot path. No MCP surface changes in
either PR, so the MCP contract tests (`mcpServer.test.ts`,
`tests/mcp-*.spec.ts`) are untouched.

**Verification split:** work happens in a worktree; the in-container gate is
`typecheck + test:unit + build` (no display here — noted in each PR); Troy
eyeballs anything user-visible on the host.

## SPEC.md updates (same-commit rule)

- **PR A:** §6 Observability — slow-op rows now carry workspace/session
  attribution; child-span naming (`claude_fleet.docker.*`,
  `claude_fleet.vault.*`). §11 Fleet-state MCP — perf-row scoping note (A4).
- **PR B:** IPC surface — `pty:input` trailing timestamp, `pty:data:<id>`
  second argument, new one-way `perf:samples` (renderer→main) and
  `perf:state` (main→renderer) channels. §6 — the three latency-hop kinds
  and their aggregation shape.

## Success criterion

With PR A dogfooded: the Phase 1 success bar becomes actually evaluable —
≥80% of `stall` events attributable to a *named, workspace-attributed*
`slow_op` (or a docker/vault child under it). With PR B dogfooded: a
keystroke→echo histogram over a normal day of use, per session, queryable
via the fleet-state MCP — the number that tells us whether whatever we fix
next actually moved what Troy feels.
