// MCP bridge for local (non-container) workspaces (#16).
//
// The read-only MCP server (mcpServer.ts) listens on a Unix socket; claude
// speaks MCP over stdio. Containers bridge that with `socat` (shipped in the
// runner image). On the host, `socat` may not be installed (it isn't on WSL),
// so for local workspaces we ship our own tiny stdio↔socket bridge and run it
// via **Electron-as-node** (`process.execPath` + `ELECTRON_RUN_AS_NODE=1`) —
// needing neither host `socat` nor a host `node`.
//
// The script is written to disk at runtime (a self-contained .cjs using only
// the `net` builtin) so there's no bundling/asar pathing to worry about, and
// it's referenced from a per-workspace `--mcp-config` file (session-scoped and
// auto-trusted, so it never touches the user's real ~/.claude.json and never
// triggers the MCP approval gate). Local claude shares the app's lifetime with
// the MCP server, so a plain connect (with a short startup retry) suffices —
// no reconnect loop like the container bridge needs.
//
// **Transport (#295).** A Windows host can't `listen()` on a unix socket, so
// there the MCP server runs ONE loopback-TCP listener fronting every workspace
// and caller identity comes from a per-workspace token rather than from which
// socket accepted (see mcpSocket.ts and `handleTcpConnection` in mcpServer.ts).
// This bridge therefore speaks both transports, selected by env — mirroring
// `mcpContainerBridge.ts`, which already had to solve exactly this:
//   CLAUDE_FLEET_MCP_TCP         host:port  (Windows hosts — loopback TCP)
//   CLAUDE_FLEET_MCP_SOCKET      socket path (Linux/macOS hosts)
//   CLAUDE_FLEET_MCP_TOKEN_FILE  first-line auth token path (TCP only)

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { windowsPathToWslPath } from './localLauncher.js';

const BRIDGE_FILENAME = 'local-bridge.cjs';

/** How the bridge reaches the MCP server: a per-workspace unix socket, or (on
 *  a Windows host) the shared loopback-TCP listener plus the token file that
 *  names this workspace to it (#117/#295). */
export type McpTransport =
  | { kind: 'unix'; socketPath: string }
  | { kind: 'tcp'; host: string; port: number; tokenPath: string };

const BRIDGE_SOURCE = `'use strict';
// stdio <-> claude-fleet MCP server bridge (#16, #295): a unix socket, or
// loopback TCP with a first-line auth token on Windows hosts.
const net = require('net');
const fs = require('fs');
const tcp = process.env.CLAUDE_FLEET_MCP_TCP || '';
const sock = process.env.CLAUDE_FLEET_MCP_SOCKET || '';
const tokenFile = process.env.CLAUDE_FLEET_MCP_TOKEN_FILE || '';
let connected = false;
let tries = 0;
// The server (and, on Windows, the token file) comes up at app launch, so a
// failed attempt just means "not yet" — retry briefly. Only a connection that
// also AUTHENTICATED counts as connected, so a socket that opens but has no
// token to send keeps retrying instead of piping a claude request into a
// connection the server is about to drop.
function retry() {
  if (connected) return;
  if (++tries <= 50) setTimeout(connect, 100);
  else process.exit(1);
}
function connect() {
  let c;
  if (tcp) {
    const i = tcp.lastIndexOf(':');
    c = net.connect(Number(tcp.slice(i + 1)), tcp.slice(0, i));
  } else {
    c = net.connect(sock);
  }
  c.on('connect', () => {
    if (tokenFile) {
      let tok = '';
      try { tok = fs.readFileSync(tokenFile, 'utf8').trim(); } catch { /* not there yet */ }
      if (!tok) { c.destroy(); retry(); return; }
      c.write(tok + '\\n');
    }
    connected = true;
    process.stdin.pipe(c);
    c.pipe(process.stdout);
  });
  c.on('error', () => { retry(); });
  // Once connected, a close means the stream broke — exit cleanly. Before that
  // it's just a failed attempt, and retry() (from 'error' / no-token) owns it;
  // exiting here would kill the retry loop on the very first miss.
  c.on('close', () => { if (connected) process.exit(0); });
}
connect();
`;

/**
 * Write the bridge script into the MCP socket dir and return its path. Cheap
 * and idempotent (overwrites with the current source each call).
 */
export async function ensureLocalBridgeScript(mcpDir: string): Promise<string> {
  await mkdir(mcpDir, { recursive: true });
  const path = join(mcpDir, BRIDGE_FILENAME);
  await writeFile(path, BRIDGE_SOURCE, 'utf8');
  return path;
}

/** The env that selects the bridge's transport. Windows gets TCP + the token
 *  file the shared listener maps back to a workspace id; every other host keeps
 *  the per-workspace unix socket, which *is* its own identity. */
function bridgeEnv(transport: McpTransport): Record<string, string> {
  return transport.kind === 'tcp'
    ? {
        ELECTRON_RUN_AS_NODE: '1',
        CLAUDE_FLEET_MCP_TCP: `${transport.host}:${transport.port}`,
        CLAUDE_FLEET_MCP_TOKEN_FILE: transport.tokenPath
      }
    : { ELECTRON_RUN_AS_NODE: '1', CLAUDE_FLEET_MCP_SOCKET: transport.socketPath };
}

/** The `mcpServers` entry pointing claude at the bridge via Electron-as-node. */
export function localMcpServerEntry(
  electronBin: string,
  bridgePath: string,
  transport: McpTransport
): { type: string; command: string; args: string[]; env: Record<string, string> } {
  return {
    type: 'stdio',
    command: electronBin,
    args: [bridgePath],
    env: bridgeEnv(transport)
  };
}

/**
 * The `mcpServers` entry for a WSL-launcher workspace (#253). claude runs
 * INSIDE the distro, but WSL Windows-interop lets it exec the app's own exe
 * directly (binfmt_misc), with stdio piped across the boundary — so the same
 * Electron-as-node bridge works with only the *command* path translated to
 * its /mnt/c form. `args`/env stay Windows paths: the bridge runs as a
 * Windows process and dials the same host listener as native local, so caller
 * identity (the token, or which listener accepted) is untouched — and the
 * token file must NOT be translated to /mnt/c either, since the Windows-side
 * bridge is what reads it. Plain env vars flow into interop-launched Windows
 * processes, so ELECTRON_RUN_AS_NODE and the transport vars ride through
 * unchanged. Null when the exe isn't on a drive letter (no automount form) —
 * caller then skips MCP wiring.
 */
export function wslMcpServerEntry(
  electronBin: string,
  bridgePath: string,
  transport: McpTransport
): { type: string; command: string; args: string[]; env: Record<string, string> } | null {
  const command = windowsPathToWslPath(electronBin);
  if (!command) return null;
  return {
    type: 'stdio',
    command,
    args: [bridgePath],
    env: bridgeEnv(transport)
  };
}
