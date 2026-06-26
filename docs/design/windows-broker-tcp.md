# Windows support: broker (and MCP) over loopback TCP

**Status:** **implemented** (Phase 1 broker-over-TCP — PR #141, on `main`;
Phase 2 MCP-over-TCP — this change). Verified on native Windows: `pty:attach`
succeeds over loopback TCP, and claude's in-container `claude-fleet-state` MCP
server connects over loopback TCP with per-workspace token auth.
**Why this doc:** the work must be done and verified on **native Windows** (Docker
Desktop, native Electron, Windows-ABI native modules). This captures the full
plan so a Windows-native Claude Code session can execute it without re-deriving
the architecture from scratch — it won't have the chat this came from.

---

## The problem

A native-Windows build of the app (the new unsigned Windows CI installer) fails
on `pty:attach`:

```
Error: broker socket not reachable at
  C:\Users\…\AppData\Roaming\claude-fleet\state\<id>\broker\broker.sock:
  connect EACCES …\broker.sock
```

The runner image is fine — the broker is in it and listening. The failure is the
**transport**:

- The broker (`broker/cmd/broker/main.go`) listens on a **Unix-domain socket**,
  `lc.Listen(ctx, "unix", "/run/broker/broker.sock")`.
- The host reaches it through a **bind mount**: `docker.ts` mounts
  `<userData>/state/<id>/broker/` → `/run/broker` (`${brokerDir}:/run/broker:rw`),
  and `BrokerClient` does `net.createConnection(socketPath)` against the host-side
  path (`workspaceBrokerSocket(id)` = `<stateDir>/broker/broker.sock`).

This works on Linux and macOS (and in the WSL2 dev setup, because there the app
*is* a Linux process). It **cannot** work for a native-Windows app + Docker
Desktop:

- Docker Desktop runs containers in a Linux VM (WSL2/Hyper-V).
- The broker's AF_UNIX socket lives inside that VM. The AppData path is surfaced
  to Windows via the 9P/virtiofs file share.
- A Windows process cannot `connect()` to a Linux socket that only exists inside
  the VM, surfaced as a shared file → **`EACCES`** (path resolves, but Windows
  can't speak AF_UNIX to it).

The in-container **MCP socket** (#12) uses the identical mechanism and fails the
same way (secondary — terminal works without it).

There are currently **zero** `process.platform === 'win32'` guards in the
broker/docker path.

## The fix

Switch the broker transport to **loopback TCP on Windows only**. Docker Desktop
reliably publishes a container port to the Windows host's `127.0.0.1`, and Node
`net` speaks TCP identically on every platform.

**Invariant: do not change the Linux/macOS path.** Gate every change on
`process.platform === 'win32'`. On non-Windows the unix-socket path stays
byte-for-byte as today (the existing e2e suite must still pass unchanged).

### Phase 1 — broker over TCP (unblocks `pty:attach`)

**1. Broker (Go) — `broker/cmd/broker/main.go`**

Add a TCP listen mode, selected by env, default unix (so the image stays
backward-compatible and Linux/macOS are untouched). The `net.ListenConfig`
already takes the network as a string.

- New env (pick one): `CLAUDE_FLEET_BROKER_TCP_PORT` (e.g. `7070`). When set:
  - `ln, err := lc.Listen(ctx, "tcp", "0.0.0.0:"+port)` (0.0.0.0 is
    container-internal only; host exposure is controlled by Docker — see below).
  - **Skip** the unix-only setup: `os.MkdirAll(dir)`, `os.Remove(stale)`, and
    `os.Chmod(socket, 0o666)` are meaningless/incorrect for TCP. Guard them.
  - Keep everything else (signal handling, `srv.Serve`, ring buffer) identical.
- When the env is unset → exactly today's unix path.
- Update the header doc comment listing the env vars.

> The broker change means the **runner image must be rebuilt** (the broker
> binary is baked in). See "Building/verifying" below — the Windows session needs
> an image that contains the TCP-capable broker.

**2. docker.ts — `createWorkspace` (around line 386 / 456–488)**

On Windows, publish the broker port and tell the broker to listen on TCP:

- `envArr` (line 386): when `process.platform === 'win32'`, append
  `CLAUDE_FLEET_BROKER_TCP_PORT=7070` (a fixed *container* port).
- HostConfig (line 456): on Windows add port publishing —
  ```ts
  // container 7070 → 127.0.0.1:<ephemeral> on the host (loopback only).
  hostCfg.PortBindings = { '7070/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] };
  ```
  and on the top-level create opts add `ExposedPorts: { '7070/tcp': {} }`.
  Empty `HostPort` lets Docker pick a free ephemeral host port (avoids
  collisions across multiple workspaces).
- On non-Windows: leave the `${brokerDir}:/run/broker:rw` bind exactly as is, no
  port publishing. (On Windows the broker bind-mount is unused; you can keep it —
  harmless — or skip it.)

> **Security:** bind the host side to `127.0.0.1` only, never `0.0.0.0` — the
> broker has no auth, so it must not be reachable off-box. The container-internal
> `0.0.0.0:7070` is fine (only Docker's port proxy reaches it).

**3. Endpoint resolver — docker.ts (+ paths.ts)**

Today `workspaceBrokerSocket(id)` returns a path string used in three places:
`waitForBroker` probe (line 645/688), `attachPty` (line 754). Introduce a
resolver that returns a *connect target*:

```ts
type BrokerEndpoint = { kind: 'unix'; path: string } | { kind: 'tcp'; host: string; port: number };

async function brokerEndpoint(workspaceId: string): Promise<BrokerEndpoint> {
  if (process.platform !== 'win32') {
    return { kind: 'unix', path: workspaceBrokerSocket(workspaceId) };
  }
  // Resolve the published host port from the running container.
  const c = docker.getContainer(containerNameFor(workspaceId)); // or by id label
  const info = await c.inspect();
  const binding = info.NetworkSettings?.Ports?.['7070/tcp']?.[0];
  if (!binding?.HostPort) throw new Error('broker TCP port not published yet');
  return { kind: 'tcp', host: '127.0.0.1', port: Number(binding.HostPort) };
}
```

Note: on Windows `attachPty`/`waitForBroker` receive a `containerId`/`workspaceId`
already; confirm how to map to the container for `inspect` (there's a
container-by-id-label lookup used elsewhere — reuse it).

**4. broker.ts — `BrokerClient` (constructor, line 166)**

Accept an endpoint instead of only a path:

```ts
constructor(endpoint: string | { host: string; port: number }) {
  super();
  this.socket = typeof endpoint === 'string'
    ? net.createConnection(endpoint)              // unix path (today)
    : net.createConnection(endpoint.port, endpoint.host); // tcp loopback
  …
}
```

Everything downstream (FrameReader, waiters, events) is transport-agnostic and
needs no change. Update the three call sites to pass the resolved endpoint.

### Phase 2 — MCP over TCP (#12) — **implemented**

Same root cause as Phase 1, reversed direction: here the **host** is the server
and the **container** is the client. The host MCP server (`mcpServer.ts`) can't
`listen()` on a unix socket at a Windows path (EACCES), so the per-id
unix-socket transport (`<userData>/mcp/<id>/mcp.sock`, bind-mounted per-id,
reached by a reconnecting `socat - UNIX-CONNECT:/fleet/mcp/mcp.sock` bridge in
`~/.claude.json`) can't work on Windows.

**As implemented (win32-gated; Linux/macOS unchanged):**
- **Transport:** the host runs **one** loopback-TCP listener on
  `127.0.0.1:7071` (`MCP_TCP_PORT`, override via `CLAUDE_FLEET_MCP_TCP_PORT`) —
  bound to `127.0.0.1` only (verified reachable from containers via
  `host.docker.internal`, which Docker Desktop NATs through the host loopback, so
  it's **not** LAN-exposed). The in-container bridge dials
  `socat - TCP:host.docker.internal:7071`.
- **Caller identity (#117 preserved):** the TCP source address is always
  `127.0.0.1` (NAT'd) and carries no identity, so "which listener accepted" is
  replaced by a **per-workspace token**. Each workspace gets a random 256-bit
  token written to `<userData>/mcp/<id>/token` — the **same per-id leaf dir** the
  socket used, bind-mounted into only that container, so a container only ever
  sees its own token and can't read a sibling's or guess one. The bridge sends
  the token as the **first line**; the host maps token→workspace id = `callerId`
  and drops any connection presenting an unknown token. The reconnecting bridge
  re-sends the token on every reconnect (so socat is single-shot per connection,
  not `forever`).
- Bridge command (seeded by `managedMcpServerEntry` in `docker.ts`):
  `TOK=$(cat /fleet/mcp/token); { printf '%s\n' "$TOK"; exec cat; } | socat - TCP:host.docker.internal:7071`
  inside the existing reconnect `while` loop.

## Building / verifying (native Windows)

This is why it must be done on Windows:

1. **Native clone + deps:** clone to e.g. `C:\src\claude-fleet`, `npm install`
   (rebuilds `better-sqlite3` + `node-pty` for the Windows/Electron ABI). Docker
   Desktop running with the WSL2 backend.
2. **Runner image with the TCP broker:** the Go broker change must be in the
   image the workspace runs. Either rebuild locally
   (`docker build -f docker/Dockerfile -t ghcr.io/imioimi/claude-fleet/runner:latest .`
   from the **repo root**) or republish via the `publish-runner` workflow and
   `docker pull`. Confirm the running container's broker logs show
   `listening on 0.0.0.0:7070` (TCP), not the unix path.
3. **Run:** `npm run dev`, create a **container** workspace, open a terminal tab.
   `pty:attach` should connect over TCP — no EACCES. Verify:
   - terminal I/O works, history replay on reattach works;
   - `docker inspect <container>` shows `7070/tcp` published to `127.0.0.1:<port>`;
   - the port is **not** reachable from another machine (loopback only).
4. **Pause/resume + app restart** (the #18 continuity property): pause, quit app,
   relaunch, resume — the republished port may change across container recreation,
   so the resolver must re-`inspect` on each attach (don't cache the port across
   restarts).

## Regression safety (Linux/macOS)

Every change is `win32`-gated, so the existing Linux path is unchanged. Before
pushing, on Linux/WSL run `npm run typecheck` + the e2e suite
(`CLAUDE_FLEET_MOCK=1 npx playwright test`) — the broker e2e (`committee-post.real`
when Docker is present, plus the mock paths) must still pass. The TCP branch
itself can only be exercised on Windows.

## Decisions to lock before coding

- **Fixed container port 7070** (simple) vs ephemeral both sides. Fixed
  container port + ephemeral host port (Docker-assigned) is recommended — no
  in-container collisions (one broker per container) and no host collisions.
- **Resolve host port via `docker inspect` on each attach** (no persistence).
  Simpler and correct across restarts; the small inspect cost is fine.
- **Phase 2 caller-identity** (#117) — must be redesigned for TCP before MCP is
  ported; do not ship MCP-over-TCP that drops the per-workspace identity check.

## Touch list

| File | Change |
|---|---|
| `broker/cmd/broker/main.go` | TCP listen mode via `CLAUDE_FLEET_BROKER_TCP_PORT`; guard unix-only mkdir/remove/chmod |
| `src/main/docker.ts` | win32: `ExposedPorts` + `PortBindings` (127.0.0.1), broker env; `brokerEndpoint()` resolver; update `waitForBroker`/`attachPty` call sites |
| `src/main/broker.ts` | `BrokerClient` accepts `string \| {host,port}` |
| `src/main/paths.ts` | (optional) keep `workspaceBrokerSocket` for unix; no new path needed if the resolver lives in docker.ts |
| runner image | rebuild/republish so the container has the TCP-capable broker |
| `docs/SPEC.md` | document the Windows transport once it lands (§ broker / §11) |
