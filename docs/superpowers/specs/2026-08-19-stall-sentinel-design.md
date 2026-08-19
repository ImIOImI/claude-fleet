# Stall sentinel: worker-thread co-stall detector, MCP-controlled

**Date:** 2026-08-19
**Status:** Approved (designed with Troy; lifetime policy: armed until app restart or manual stop, optional ttlHours cap)
**Repo:** claude-fleet
**Follows:** `2026-08-17-gc-and-broadcast-spans-design.md` and the 2026-08-19 verdict analysis

## Problem

Every in-process stall suspect is now instrumented and falsified (19 h on
0.12.5/0.13.0): GC ≥25 ms fired twice (max 62 ms); the ingest broadcast
peaks at 874 ms with ~22 s total; `ping_dispatch` proved ping never blocks
the loop (0 instances ≥25 ms across 1,711 pings averaging 2.3 s of *daemon*
latency). Yet big stalls persist (~90% of the top-200 have no honest
in-process explanation once ping victimhood is discounted) and continue
overnight while workspace containers keep computing.

**Leading hypothesis: OS-level starvation.** The Electron main process is
being descheduled (WSL2/Docker VM + N claude sessions consuming the host),
so timers fire seconds late with *nothing* running in our loop. No span can
see this from inside one event loop. The discriminator needs a second loop:
a worker thread with its own delay monitor. Main-and-worker stalling in the
same window ⇒ the machine, not our code; main-only ⇒ a real main-loop
blocker still hiding.

Troy's control requirement: the sentinel must be **start/stoppable and
inspectable from the fleet-state MCP server**, so no analysis session can
leave it running forgotten. Lifetime decision: armed until app restart or
manual stop; an optional `ttlHours` caps it earlier; **never persisted** —
every app start comes up disarmed.

## Design

### 1. `src/main/perfSentinel.ts` — worker-thread sentinel (new module)

- Electron-free (node:worker_threads). The worker is spawned from an inline
  `eval` script (no bundler config): it runs `monitorEventLoopDelay`
  (resolution 10) and posts `{ p50, p99, max }` (ms) every
  `sampleIntervalMs` (main's 5 s), then resets — mirroring main's sampler.
- Exported surface:
  ```ts
  export interface SentinelStatus {
    enabled: boolean;
    startedAt: number | null;      // epoch ms
    expiresAt: number | null;      // epoch ms; null = until restart/stop
    lastWorkerWindow: { p50: number; p99: number; max: number; ageMs: number } | null;
  }
  armSentinel(opts?: { ttlHours?: number }): void   // idempotent re-arm resets TTL
  disarmSentinel(): void                             // idempotent; terminates the worker
  sentinelStatus(): SentinelStatus
  sentinelWindowFor(nowMs: number): { workerMaxMs: number; aligned: boolean; ageMs: number } | null
  ```
- `aligned` = the worker's latest window max also exceeded
  `STALL_THRESHOLD_MS` (50) — the starvation signature.
- TTL via an `unref`'d timer calling `disarmSentinel()`. Worker is
  `unref`'d too — the sentinel can never keep the app alive.
- Test seam: `armSentinel` accepts an injectable worker factory +
  `sampleIntervalMs` via a hooks parameter (same pattern as `PerfInitHooks`).

### 2. `perf.ts` integration — enriched stall rows

- The stall sampler, when recording a stall row, attaches:
  - `meta.sentinel = { workerMaxMs, aligned, ageMs }` when the sentinel is
    armed and has a window ≤ 2 sample intervals old (else `meta.sentinel`
    absent — an armed-but-silent worker is itself starvation evidence, so
    also attach `{ stale: true, ageMs }` when armed but the window is old).
  - `meta.cpu = { utilization }` **always** (sentinel or not): system-wide
    CPU busy fraction since the previous sample, from `os.cpus()` time
    deltas — cheap, and starving hosts show up as sustained ~1.0.
- Recording toggled off (`perf_set`, settings, `CLAUDE_FLEET_PERF=0`) →
  `disarmSentinel()` (a sentinel without a recorder is pointless);
  `shutdownPerf` disarms too, which also covers app quit.

### 3. MCP surface (fleet-state server)

- **New tool `perf_sentinel_set({ enabled: boolean, ttlHours?: number })`**
  — mediated write in the `perf_set` family: available to every workspace,
  no grant (host diagnostics only, no cross-workspace data). Arming
  requires recording to be enabled (clear error otherwise, incl. mock
  mode); `ttlHours` validated (0 < ttlHours ≤ 168); extra args rejected
  (same hardening as `perf_set`). Returns the resulting `perf_status`.
- **`perf_status` gains `sentinel: SentinelStatus`** — one status surface,
  no third tool. (`perf:status` IPC inherits the field; the Settings UI
  ignores unknown fields — no UI work in this round, MCP-only per Troy.)
- Contract tests updated in the same commit: `mcpServer.test.ts` (unit) AND
  the `tests/mcp-*.spec.ts` e2e pair, per the repo convention.

### 4. Reading the results

With the sentinel armed during a dogfood window, the analysis becomes:
`SELECT json_extract(meta,'$.sentinel.aligned') AS aligned, COUNT(*) FROM
perf_events WHERE kind='stall' AND ts >= <armed-at> GROUP BY aligned` —
majority `aligned=1` (or high `meta.cpu.utilization`) ⇒ starvation
confirmed, and the fix conversation moves to resource governance (WSL2
memory/CPU caps, container cpu limits), not app code. Majority `aligned=0`
⇒ a real main-loop blocker remains; next step is `--inspect` sampling
profiler on the host, aimed by the stall timestamps.

## Non-goals

- Fixing starvation (resource governance is host configuration, decided by
  the data).
- Settings-UI control for the sentinel (MCP-only; revisit if it earns
  permanence).
- Persisting sentinel state across restarts (explicitly rejected: forgetting
  must be impossible).
- The smaller opportunities from the 2026-08-19 sweep (ping dedupe,
  broadcast coalescing) — separate rounds if the sentinel exonerates our
  code.

## Testing

- `perfSentinel.test.ts`: arm/disarm idempotency; TTL auto-disarm (fake
  timer or short ttl with injected clock); status shape; `sentinelWindowFor`
  alignment logic incl. the stale-window path; worker-factory injection (no
  real thread needed for logic tests) plus ONE real-worker smoke test
  (arm → receive ≥1 window → disarm).
- `perf.test.ts`: stall rows carry `meta.cpu.utilization` (0..1); with a
  fake sentinel window injected, stall rows carry `meta.sentinel` with
  correct `aligned`; recording-off path disarms.
- MCP contract: `perf_sentinel_set` arm/disarm/status round-trip, ttlHours
  validation, extra-arg rejection, recording-off error; `perf_status`
  includes the sentinel block (unit + e2e).

## SPEC.md (same-commit rule)

- §6: sentinel paragraph (what it is, meta.sentinel/meta.cpu on stall rows,
  disarm-on-recording-off, never persisted).
- §11: `perf_sentinel_set` tool (ungated-mediated-write security note, same
  class as `perf_set`) + the `perf_status` shape change.
