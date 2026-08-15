# Serving rail: session attribution + always-visible kill

**Date:** 2026-08-15
**Status:** Approved

## Problem

The "Serving" section of the observability rail (PR #276) has two gaps:

1. **The kill button is invisible in practice.** `PortRow` hides ✕ when
   `pid === null`, which is the permanent state on any workspace whose runner
   image predates the enriched broker. The gate is also unnecessary: the
   broker's `KILLPORT` resolves the port's owner itself at kill time — the
   host-visible pid was only ever a proxy for "broker is new enough".
2. **A port can't be traced to the session that started it.** `ServingPort`
   is `{port, pid, cmdline, firstSeenAt}`. The broker attributes a port to a
   pid (socket inode → `/proc/*/fd`), but never to a PTY session, even though
   the same broker owns every claude PTY and knows their root pids.

## Approach

Broker-side ancestry walk (chosen over host-side timing/cmdline correlation,
which is fragile, and a per-pid RPC, which is strictly more round trips for
the same rebuild cost): for each attributed port owner, walk the ppid chain
in `/proc` until it hits a live session's PTY root pid; stamp the port with
that session id.

## Components

### Broker (`broker/internal/portscan`, `internal/server`, `internal/proto`)

- `portscan.Detail` gains `Session string` ("" when unresolved).
- Ancestry walk: bounded (~32 hops), reads `/proc/<pid>/stat` ppid per hop,
  matched against a `map[rootPid]sessionID` snapshot supplied by the session
  manager. Any read error or hop limit → unresolved, never an error.
- `proto.PortInfo` gains `Session string \`json:"session,omitempty"\``.
  JSON payload: old hosts ignore the field, new hosts tolerate its absence.
- Orphaned servers (owning session ended, process reparented to init) fall
  out naturally: the walk reaches pid 1 without a match → no session.

### Host (`src/main/portforward.ts`, `ipc.ts`, `src/preload/index.ts`)

- `ServingPort` gains `sessionId: string | null` — the **broker** session id
  (the same id used for tab attachment and `learnMirrorMapping`).
- Snapshot change detection includes `sessionId`, so a row updates when
  ownership resolves late (e.g. first poll raced the fd scan).
- `PortForwardManager.killPort` keeps the serving-snapshot membership gate
  (defense-in-depth) but no longer requires an attributed pid.
- Mock feed (`mockPorts.ts`) stamps fake session ids so the UI is iterable
  under `CLAUDE_FLEET_MOCK=1`.

### Renderer (`PortsSection.tsx`, `ObservabilityPane.tsx`, `App.tsx`)

- Each row resolves `sessionId` against the workspace's open tabs. Found →
  a session chip (tab title) renders on the row; clicking it selects the
  workspace and focuses that tab. Not found / null → no chip; the row looks
  exactly as today.
- Fleet scope keeps the workspace dot + name; the chip renders after them.
- **Kill is always visible.** The `pid !== null` gate is removed. The
  two-step confirm ("kill?") is unchanged.

## Error handling

- Kill failure (old broker that doesn't speak `KILLPORT`, or kill error):
  error toast — "Couldn't kill — runner image too old; recreate the
  workspace." (exact copy may be tuned). The row stays; the next poll is the
  source of truth for whether the server died.
- Attribution is best-effort at every layer: no pid still gets a row and a
  kill button; a pid with no session still shows cmdline. No new failure
  mode blocks the rail.

## Rollout

- Kill-always + toast works immediately on app update (host-only change).
- Session chips require the runner-image republish and workspace recreation
  — same rebuild the pending #302 summarizer fix is waiting on; ride it.

## Testing

- Broker: `go test` for the ancestry walk (fake /proc tree + session map):
  direct child, deep chain, orphan-to-init, hop-limit, unreadable stat.
- Host: vitest for snapshot diffing with `sessionId` transitions and for
  kill-error propagation.
- Renderer: vitest for chip / no-chip / kill-visible-without-pid states.
- e2e: mock-fleet spec asserting the chip renders and click focuses the tab.
- `docs/SPEC.md` updated in the same commit (proto + data-model change).

## Non-goals

- No attribution for servers whose owning session has ended.
- No per-session grouping of the Serving section; it stays one flat list.
- No change to port detection, probing, or the preview-toast flow.
