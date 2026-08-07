# Serving-ports rail section — design

**Date:** 2026-08-07
**Status:** approved (brainstorm with Troy)
**Builds on:** #272 (probe-gated dev-server preview toast)

## Problem

Port preview today is a single sticky toast per detected port. Once dismissed
(or missed), there is no way to see what is still serving, who is serving it,
or to reopen the preview — the only workaround is killing the server and
restarting it to re-trigger the toast. Stale servers also accumulate with no
in-app way to stop them.

## Goal

A **Serving** section on the observability rail: a durable, live list of
HTTP-serving ports with per-row **open preview** and **kill** actions, visible
in both rail scopes (workspace and fleet), with process attribution
(workspace + command line).

Non-goals: listing non-HTTP listeners (databases etc.), per-session/tab
attribution, port history in SQLite, copy-URL action.

## Approach (chosen: main-process snapshot)

The main process owns an authoritative live-ports snapshot per workspace,
derived from the existing poll/probe loop; the renderer just renders broadcast
snapshots. Rejected alternatives: renderer-accumulated toast events (dies on
reload, duplicates liveness logic) and SQLite persistence (ports are ephemeral
runtime state, not history).

## 1. Broker changes (`broker/`)

### Enriched `PORTS` payload

`portscan` grows owner resolution: for each LISTEN row in
`/proc/net/tcp[6]`, capture the socket **inode**, then scan `/proc/*/fd/*`
symlinks for `socket:[inode]` to find the owning PID, and read
`/proc/<pid>/cmdline` (joined with spaces, truncated to 120 chars).
`proto.PortInfo` becomes:

```go
type PortInfo struct {
    Port    uint16 `json:"port"`
    Pid     int    `json:"pid,omitempty"`
    Cmdline string `json:"cmdline,omitempty"`
}
```

Resolution runs on each `LISTPORTS` request (every ~3 s per workspace);
container process counts are small, no caching. A port whose owner can't be
resolved (fd race, permissions) is still reported, with `pid`/`cmdline`
omitted.

### New `KILLPORT` / `KILLED` frames

- `FrameKillPort = 0x18` (host → broker): JSON `{ "port": <uint16> }`.
- `FrameKilled  = 0x19` (broker → host): JSON `{ "ok": bool, "error": "" }`.

The broker re-resolves port → PID **at kill time** — it never accepts a PID
from the host, which removes any PID-reuse hazard. It sends SIGTERM, waits up
to 2 s, then SIGKILL if the process is still alive. `ok:false` + `error` if
the port has no resolvable owner or the signal fails.

### Version skew

The broker ships in the pinned runner image, so an app can face an older
broker. Capability detection is structural: if `PORTS` entries carry no `pid`
field, the host treats owner info as unknown and the renderer hides the kill
button. No version handshake.

## 2. Main process (`src/main/portforward.ts` + IPC)

`PortForwardManager` is promoted from fire-and-forget detection to owning
state per running workspace:

```ts
type ServingPort = {
  port: number;
  pid: number | null;
  cmdline: string | null;
  firstSeenAt: number;   // epoch ms
};
// per workspace: Map<port, ServingPort> of ports that PASSED the HTTP probe
```

Probe logic from #272 is unchanged (GET / over broker DIAL, 1.5 s timeout,
3 attempts, non-HTTP ports silently discarded). Transitions:

- probe passes → row added, `firstSeenAt = now`, toast cue fires as today;
- port absent from `LISTPORTS` → row removed (≤ 3 s staleness);
- same port, different PID (server restarted) → row updated, `firstSeenAt`
  reset;
- workspace pause/stop/remove → monitor stops, snapshot cleared.

Every transition broadcasts a full per-workspace snapshot (no deltas).

### IPC surface

- `ports:changed` (main → renderer, one-way broadcast):
  `{ workspaceId: string, ports: ServingPort[] }`.
- `ports:list()` → `Array<{ workspaceId, ports: ServingPort[] }>` — all
  running workspaces; seeds the renderer on mount/reload.
- `ports:kill(workspaceId, port)` → `{ ok: boolean, error?: string }` —
  forwards `KILLPORT` over that workspace's broker socket.
- `ports:detected` and `ports:open` are unchanged; the toast remains the push
  cue, the rail is the durable state, both fed by the same manager.

## 3. Renderer (`ObservabilityPane.tsx`)

A `usePorts` hook at the App level seeds from `ports:list()` on mount and
applies `ports:changed` broadcasts; `ObservabilityPane` receives the
snapshot as a prop.

New **Serving** section, rendered only when at least one port is live (no
empty state):

- **Workspace scope:** between Recent tools and the workspace-metadata card.
  Row: `:<port>` (mono, bold) · truncated cmdline (full text in `title`
  tooltip) · relative uptime from `firstSeenAt` · two icon buttons revealed
  on hover, `↗` open preview and `✕` kill. Rows use the `.obs-tool-row`
  idiom with an `--info` (blue) left accent to distinguish from green tool
  rows. Class family: `.obs-port-row`, `.obs-port-num`, `.obs-port-cmd`,
  `.obs-port-up`, `.obs-port-btn`.
- **Fleet scope:** same section below the fleet cost rows; each row prefixed
  with the workspace's colored dot (`.obs-fleet-dot` hue) + name; uptime
  moves into the tooltip to make room. Actions work regardless of the
  selected workspace.
- **Open preview** calls `ports:open` (existing liveness re-check → loopback
  forward → system browser); `null` → error toast, row clears on next poll.
- **Kill** is a two-step inline confirm: first click swaps the row's actions
  for a red `kill?` chip that auto-reverts after ~3 s; second click calls
  `ports:kill`. No modal. Failure → error toast; the row's fate is settled
  by the next poll either way.
- Kill button hidden when the row has no `pid` (old broker image).

Approved mockups (three states: workspace scope, kill-confirm, fleet scope)
were rendered against the real `styles.css` tokens during brainstorming.

### Mock fleet

`CLAUDE_FLEET_MOCK=1` emits fake `ports:changed` data (one port ~10 s after a
workspace starts, a second later), so the UI is iterable with no Docker.

## 4. Edge cases

- **Renderer reload** — re-seeded by `ports:list()`.
- **Server dies between polls** — row gone within ~3 s; a click in the window
  is caught by `ports:open`'s existing re-probe.
- **PID reuse** — killing a stale PID is avoided by design: the broker
  resolves port → PID at kill time from the live socket, never from a
  host-supplied PID.
- **Kill failure** (EPERM, already-gone) — surfaced as an error toast only.
- **Old runner image** — port-only rows, no kill button.

## 5. Testing

- **Broker (Go):** portscan owner-resolution test has the test process
  `net.Listen` and asserts its own PID/cmdline round-trip; `KILLPORT` test
  spawns a listening child and asserts TERM→KILL escalation. `go test -race
  ./...` as usual (no creds needed).
- **Main (vitest):** extend `src/main/portforward.test.ts` — snapshot add /
  remove / pid-change transitions, `ports:changed` emission per transition,
  kill plumbing, capability gating on missing `pid`.
- **UI:** no display in the authoring container — gate with typecheck + unit
  + build; visual check on the host via mock fleet.

## 6. SPEC.md updates (same commit as the implementation)

- §5 broker protocol: `PortInfo` shape, `KILLPORT`/`KILLED` frames.
- IPC surface: `ports:changed`, `ports:list`, `ports:kill`.
- Observability-rail description: Serving section in both scopes.
- §9 security: kill is host-mediated and scoped to the target workspace's own
  broker socket — no cross-workspace control path.
