# Naming the unattributed stalls: GC rows + ingest-broadcast span

**Date:** 2026-08-17
**Status:** Approved (next round agreed with Troy after the 0.12.3 A/B analysis)
**Repo:** claude-fleet
**Follows:** `2026-08-15-summary-read-caches-design.md` and the 2026-08-17 A/B results

## Problem

The 0.12.3 A/B confirmed the cache round (input_hop 144→8 ms, stall rate
6.3→2.3/min, rollingSpend slow-ops gone, npipe falsified via ping_dispatch).
What remains: **84% of the surviving big stalls (avg 2.9 s) overlap no
instrumented operation at all** — the blocker has no span. Two prime
suspects are structurally invisible today:

1. **V8 garbage collection in main.** Nothing records GC pauses; a major GC
   is a multi-hundred-ms synchronous stop that no span can capture.
2. **The per-ingest observability broadcast** (`ipc.ts:755`): the
   `jsonlWatcher.on('ingest')` listener recomputes the workspace summary
   (one real query per batch post-caches) and `webContents.send`s it to
   every window — each send **synchronously structured-clones** the payload
   (costSeries/recentToolCalls arrays). It runs from a watcher emit, not an
   IPC handler, so the generic IPC span wrapper never covered it. It has
   been invisible to every stall-attribution query to date.

## Design

### F1. GC pause rows (`kind: 'gc'`)

- `PerformanceObserver` (node:perf_hooks) observing `entryTypes: ['gc']`,
  created in `initPerf` while recording, disconnected in `shutdownPerf`.
- Entries with `duration >= SLOW_OP_MS` (25 ms — same threshold as slow-op
  persistence) become `perf_events` rows:
  `kind='gc'`, `name='claude_fleet.gc.<kindName>'` (major | minor |
  incremental | weakcb, decoded from the entry's Node GC-kind constant),
  `dur_ms=duration`, `ts` = `performance.timeOrigin + entry.startTime`
  rounded to ms, `meta={ gcKind, flags }`. Workspace/session NULL —
  app-global rows, visible to every workspace in the MCP snapshot exactly
  like `stall` rows (they describe the shared host process).
- **`PerfKind` gains `'gc'`** — the first new kind since the v11 schema.
  The `kind` column is TEXT with no constraint, so **no migration**; the
  schema comment in the v11 migration SQL, the SPEC schema block, and the
  MCP `query`/`perf_status` docs that enumerate kinds get the new value.
- Testability: the observer callback delegates to an exported
  `recordGcEntries(entries: Array<{ startTime, duration, detail? }>)`;
  tests call it directly with fakes (no way to force a real GC entry
  deterministically). No-op while recording is off / before init.

### F2. Span the ingest broadcast

Wrap the whole listener body in a **sync** span with workspace attribution:

```ts
jsonlWatcher.on('ingest', ({ workspaceId }) => {
  perfSpan(
    'claude_fleet.observability.ingest_broadcast',
    () => {
      const summary = summaryForWorkspace(workspaceId);
      broadcastObservabilitySummary({ workspaceId, summary }, BrowserWindow.getAllWindows());
    },
    { workspace_id: workspaceId }
  );
});
```

Covers the summary compute AND the per-window structured-clone cost in one
named span; ≥25 ms instances persist as attributed `slow_op` rows. If the
clone cost turns out to dominate, a follow-up can split compute/fan-out —
YAGNI until the data says so.

## Acceptance

After a dogfood window on a build with this: re-run the big-stall
overlap query. Success = the formerly-unattributed share (84%) drops
decisively — stalls now name either `claude_fleet.gc.*` rows or the
`ingest_broadcast` span (or something else new that the data surfaces).
Whatever they name becomes the next fix target.

## Non-goals

- Fixing GC pressure or the broadcast cost (measure first).
- Renderer GC (main-process loop is the felt path).
- New MCP tools; grant changes.

## Testing

- `recordGcEntries` units: threshold filter (≥25 ms), kind-name decoding,
  timeOrigin→epoch ts conversion, no-op when off/uninitialized, observer
  connected on init and disconnected on shutdown (lifecycle via the runtime
  handle).
- Broadcast span: `ipc.ts` isn't unit-loadable; the span machinery is
  already covered — typecheck + the existing observability e2e in CI.
- MCP contract: `perf_status` eventCounts is a generic kind→count map (no
  test change needed); verify `mcpServer.test.ts` has no kind allowlist
  that would exclude `gc` (if one exists, update unit + e2e together per
  the contract-test convention).

## SPEC.md (same-commit rule)

- §6 stall-detector/slow-op area: `gc` kind bullet (threshold, naming,
  app-global scoping) + the `claude_fleet.observability.ingest_broadcast`
  span added to the named-span list.
- Schema block: add `gc` to the kind comment enumeration.
