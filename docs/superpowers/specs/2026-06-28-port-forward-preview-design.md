# Port-forward preview — design

## Problem

A `claude` session running inside a workspace container often starts a dev
server (Vite, Next, a Python server, …) and asks the user to preview it at some
port. claude-fleet runs workspace containers in bridge mode and publishes **no**
ports (only the broker's own TCP port, and only on Windows). On Docker Desktop
(macOS/Windows/WSL2) the container bridge is not routable from the host, so the
dev server's port is unreachable. There is no built-in path to preview it.

## Goal

Auto-detect a dev server listening inside a workspace container and let the user
open it in their normal browser at `http://127.0.0.1:<host-port>`, with the
traffic relayed over the **existing broker socket** — no new published ports, no
dependence on Docker bridge routing.

## Non-goals (v1)

- **Not a general port manager.** No manual port pinning, no list/close UI — the
  surface is a transient toast per newly-detected port.
- **No arbitrary `host:port` dialing.** The broker only dials
  `127.0.0.1:<port>` inside its own container.
- **No LAN exposure.** The host listener binds `127.0.0.1` only.
- **No in-app browser tab.** Preview opens in the system browser. (An in-app
  preview tab — and its e2e-testability benefit — is a possible later phase.)

## Architecture

A dev server inside a workspace container becomes reachable at
`http://127.0.0.1:<host-port>` on the host, relayed over the existing broker
connection. Three layers:

- **Broker (Go, in-container)** — gains (a) listening-port detection and (b) a
  TCP-dial channel kind, both over the existing frame protocol.
- **Main (host)** — a per-workspace `PortMonitor` that polls detection and fires
  a toast on newly-appeared ports, plus a `PortForward` that runs a loopback
  `net.Server` and relays each browser connection over a broker channel.
- **Renderer** — listens for a "port detected" event and shows a toast with an
  **Open preview** action.

No new published ports on any platform: Linux/macOS rides the existing
bind-mounted unix socket; Windows rides the existing loopback-TCP broker port.

## Broker protocol additions

Defined in `broker/internal/proto` (`proto.go`) and mirrored in
`src/main/broker.ts` (`FrameType` enum). The frame envelope is unchanged:
`[u32 totalLen BE][u8 type][payload]`.

| Frame | Dir | Payload | Meaning |
|---|---|---|---|
| `DIAL` (0x14) | host→broker | JSON `{channel, port}` | dial `127.0.0.1:<port>` in the container, bind it to `channel` |
| `DIALED` (0x15) | broker→host | JSON `{channel, ok, error?}` | dial result |
| `LISTPORTS` (0x16) | host→broker | empty | request current LISTEN ports |
| `PORTS` (0x17) | broker→host | JSON `{ports:[{port}]}` | listening-port snapshot |

The byte relay then **reuses the existing channel frames** on that channel:
`INPUT` (host→broker bytes), `OUTPUT` (broker→host bytes), `CLOSE`/`CLOSED`, and
`ENDED`. Because it is a raw byte relay, HTTP keep-alive and **WebSocket/HMR**
(Vite, Next) pass through untouched.

### Dial channels (broker session manager)

A channel currently maps to a PTY session. Add a parallel map of
channel → `net.Conn`:

- `DIAL{channel, port}` → `net.DialTimeout("tcp", "127.0.0.1:<port>", 5s)`. On
  success, register the conn under `channel` and start a goroutine copying
  conn → `OUTPUT` frames. Reply `DIALED{ok:true}`. On failure reply
  `DIALED{ok:false, error}`.
- `INPUT` on a dial channel writes to the conn.
- conn EOF, conn error, or `CLOSE` on the channel → close the conn, emit `ENDED`.

Channel numbers stay **host-allocated** from the existing monotonic counter, so
PTY channels and dial channels never collide.

### Port detection

Parse `/proc/net/tcp` and `/proc/net/tcp6`; keep rows whose state field is `0A`
(LISTEN); extract the local port (hex after the `:` in the local-address
column); dedupe across both files. Exclude the broker's own TCP port and the MCP
port when those are TCP (Windows only — on Linux/macOS they are unix sockets and
do not appear). Readable by the non-root `fleet` user; no privilege required.
`LISTPORTS` triggers a fresh parse and replies `PORTS{ports}`.

## Host side (`src/main/portforward.ts`, new)

- **`PortMonitor`** — one per *running* workspace. Opens a dedicated control
  connection (a lightweight `BrokerClient`), calls `listPorts()` every **3s**,
  diffs against the last-seen set, and on a **newly-appeared** port emits IPC
  `ports:detected {workspaceId, port}`. Started when the workspace reaches
  `running`; stopped on pause/stop/remove. Dedup is per-monitor: a port that
  stays open toasts once; if it disappears and reappears it toasts again.
- **`PortForward`** — created on demand per forwarded container port. A
  `net.Server` on `127.0.0.1:0` (ephemeral host port). Each inbound browser
  socket gets a fresh channel; main sends `DIAL`, then pipes socket ↔ channel
  using the existing `brokerPtyStream` duplex. Returns the bound host port.
  Torn down when the workspace pauses/stops/is removed.

`broker.ts` gains `dial(channel, port)` and `listPorts()` plus the four
`FrameType` enum entries; the relay reuses `brokerPtyStream` verbatim.

## IPC surface

- `ports:detected` (main→renderer event) — `{workspaceId, port}`. Fires the
  toast.
- `ports:open(workspaceId, containerPort)` → `{hostPort}` — creates (or reuses)
  the `PortForward` for that container port, then
  `shell.openExternal('http://127.0.0.1:<hostPort>')` and returns the host port.

No list/close channels in v1 — cleanup is automatic on workspace lifecycle
events.

## Renderer

On `ports:detected`, show a toast via the existing toast mechanism:
*"Dev server detected on port 3000"* + an **Open preview** button →
`api.ports.open(workspaceId, 3000)`. Main dedupes, so a port toasts once per
appearance.

## Security model

- Host listener binds **127.0.0.1 only**.
- Broker dials **`127.0.0.1:<port>` only** — never an arbitrary host/IP — so the
  tunnel cannot reach the container's LAN or other hosts; `port` is a constrained
  uint16.
- The new frames do not widen *who* can reach the broker (still only the
  host-owned unix socket, or loopback-TCP on Windows), so the broker's existing
  no-auth posture is preserved.

## Error handling

- Dial to a dead/refused port → `DIALED{ok:false}` → renderer toast *"Couldn't
  reach port N."*
- Server dies mid-session → channel `ENDED` → browser sees a closed connection.
- Workspace pause/stop or broker disconnect → `net.Server` closed, in-flight
  conns destroyed, monitor stopped.
- `/proc` parse errors → logged and skipped, never fatal.

## Testing

- **Broker Go tests** — dial-relay against an in-test echo TCP server
  (`DIAL` → pipe → assert echo round-trips); `LISTPORTS` returns an in-test
  listener's port; `/proc/net/tcp` parser against fixture rows.
- **Host unit (vitest)** — port diff/dedup logic (`PortMonitor`'s set diffing).
- **E2e (Playwright + `CLAUDE_FLEET_MOCK`)** — mock backend emits a
  `ports:detected`; assert the toast and **Open preview** render, click → assert
  `ports:open` returns a host URL. Real container dialing is not CI-runnable
  (covered by Go tests), matching the existing mock-for-UI / real-for-pipeline
  split.

## SPEC updates (same change)

Per `.claude/rules/spec-maintenance.md`, `docs/SPEC.md` is updated in the same
change:

- Broker-protocol section — the four new frames + the dial-channel kind.
- IPC section — `ports:detected`, `ports:open`.
- User flow — detect → toast → open preview in system browser.
- Security model — loopback-only listener, container-localhost-only dial.
- Non-goals — not a general port manager (no arbitrary `host:port`, no LAN
  exposure, no manual pinning in v1).
