# Perf stall fixes round 1: resolveClaude cache, wall-clock stamps, suspend filtering

**Date:** 2026-08-11
**Status:** Approved (findings + fixes reviewed with Troy over the first 3-day perf_events dogfood)
**Repo:** claude-fleet
**Follows:** `2026-08-07-perf-telemetry-design.md` (Phase 1), `2026-08-08-perf-tracing-expansion-design.md` (PR A/B)

## Findings driving this work (2026-08-11 analysis of 3 days of perf_events)

1. **A ~1.4–1.9 s main-loop freeze once per minute, 24/7** (~1,400/day). Every
   idle `stall` row aligns with a `claude_fleet.ipc.workspace:ping` span to
   within a few ms (15/15 sampled) — causal identity. The local backend's
   `ping()` re-runs `resolveClaude()` → `findClaude()` **uncached on every
   call**, spawning `where.exe`/login-shell lookups; on Windows the process
   creation blocks the loop for essentially the whole span. This is the prime
   suspect for the felt "intermittent hangs with no pattern".

   **Post-review correction (2026-08-11, whole-branch review):** the causal chain above is wrong — `workspace:ping` routes to dockerode's ping, and the local backend's `ping()` (the only resolveClaude caller on a poll path) is currently dead code. The ping-span⋈stall alignment is equally consistent with ping being a *victim*: a stall stretches every concurrent async span. Leading remaining hypotheses: (a) dockerode's Windows named-pipe connect blocking the loop inside libuv, (b) Chromium background-throttling coalescing the renderer's 5 s polls into per-minute bursts that hit the synchronous better-sqlite3 read handlers. F1's cache is kept (it is correct and removes per-spawn lookups) but the per-minute stall finding STAYS OPEN pending post-merge re-measurement.

2. **Cross-process latency hops are corrupted by renderer clock drift.**
   `output_hop` mean 4.19 s vs `echo_rtt` mean 478 ms is physically
   inconsistent: `performance.timeOrigin + performance.now()` in a long-lived
   renderer drifted ~4.2 s ahead of `Date.now()` (sleep/NTP), inflating every
   output_hop and suppressing **all** input_hop samples via the `dur >= 0`
   guard. The Phase 2 assumption "both processes share the machine wall
   clock" is wrong for `timeOrigin`-based stamps.
3. **OS suspend pollutes stall stats.** Six ~66 s "stalls" at hourly
   boundaries overnight are Windows suspend/resume gaps (the sampler's timer
   fires late because the machine was asleep), not event-loop blocks.

Falsified along the way: JSONL ingest (Phase 1's prime suspect) is a
non-factor — 41 slow instances, max 203 ms, over 3 days.

## Fixes (one PR, three independent commits)

### F1. Cache the local claude resolution

- New pure helper in `src/main/claudeResolve.ts`:
  `cachedNullableResolver<T>(resolve: () => Promise<T | null>, opts: { nullTtlMs: number; now?: () => number })`
  returning `{ get(): Promise<T | null>; invalidate(): void }`.
  Policy: a **non-null resolution is cached indefinitely**; a **null
  resolution is cached for `nullTtlMs`** (re-probe later — claude may get
  installed); concurrent `get()`s share one in-flight promise; a rejected
  probe is not cached.
- `src/main/local.ts` wraps its `resolveClaude` in the helper with
  `nullTtlMs = 5 * 60_000`. `ping()` and the spawn path both go through the
  cache. The spawn path **invalidates on spawn failure** (stale path — e.g.
  claude was moved/uninstalled) so the next call re-probes.
- Effect (revised per the post-review correction above): session spawns stop
  re-running the lookup. This does NOT fix the once-a-minute freeze — that
  finding stays open.

### F2. Renderer stamps switch to Date.now()

- `TerminalSession.tsx`: all three timestamp sites (keystroke stamp, output
  arrival, output-hop measurement) switch from
  `performance.timeOrigin + performance.now()` to `Date.now()` — the same
  wall clock main uses, immune to timeOrigin drift. Sub-ms precision is not
  worth multi-second skew; hop values are ms-scale.
- `echoRtt.ts` is unchanged (single-clock, already trustworthy) — it simply
  receives `Date.now()` values now.
- A code comment at the stamp site records why `Date.now()` is load-bearing
  (timeOrigin drifts on long-lived renderers; input_hop's `dur >= 0` guard
  silently discards skewed stamps).

### F3. Suspend filtering in the stall sampler

- `perf.ts` (stays Electron-free) exports
  `perfNotePowerEvent(event: 'suspend' | 'resume'): void`. The sampler
  **discards** (reads and resets, records nothing — not even gauges) any
  window that overlaps a suspend→resume span, plus the first window read
  after a `resume`, since its measured max is the sleep gap, not a block.
  No new `perf_events` kind; suspend visibility is a non-goal.
- Wiring in `registerIpc` (with the other perf plumbing): Electron
  `powerMonitor.on('suspend'|'resume', ...)` → `perfNotePowerEvent(...)`.
- Effect: `stall` rows mean "the event loop was blocked while the machine
  was awake". Residual small artifacts from unsignaled standby dozing are
  accepted; powerMonitor is the ground truth we act on.

## Non-goals

- Restructuring the sync-SQLite summary/rollingSpend pollers (the read-side
  cost found in the analysis). Re-measure after F1–F3 land; the felt problem
  may drop below the threshold worth an architecture change.
- Backfilling/correcting historical skewed hop rows (they age out with the
  7-day retention).
- New MCP tools, schema changes, or new perf_events kinds.

## Testing

- F1: pure unit tests for `cachedNullableResolver` (caches non-null forever,
  null for TTL, shares in-flight probe, rejection not cached, invalidate
  re-probes). `local.ts` is not vitest-loadable; its integration is
  typecheck + the behavior being a thin delegation.
- F2: no new tests (pure clock-source swap; renderer suite + typecheck +
  build must stay green).
- F3: unit tests via the existing `delaySource`/`sampleIntervalMs` hooks —
  a window with a huge max after `perfNotePowerEvent('resume')` records no
  stall row; the following window records normally; suspend→resume spanning
  multiple windows discards them all.

## SPEC.md (same-commit rule)

- §6 Perf telemetry, stall-detector bullet: one sentence — windows
  overlapping OS suspend (via `powerMonitor`) are discarded, so stall rows
  exclude sleep gaps. (F1/F2 change no documented contracts: ping semantics
  and the IPC timestamp descriptions in SPEC remain accurate.)
