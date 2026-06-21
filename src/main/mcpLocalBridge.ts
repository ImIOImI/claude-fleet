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

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const BRIDGE_FILENAME = 'local-bridge.cjs';

const BRIDGE_SOURCE = `'use strict';
// stdio <-> unix-socket bridge for claude-fleet's read-only MCP server (#16).
const net = require('net');
const sock = process.env.CLAUDE_FLEET_MCP_SOCKET;
let connected = false;
let tries = 0;
function connect() {
  const c = net.connect(sock);
  c.on('connect', () => {
    connected = true;
    process.stdin.pipe(c);
    c.pipe(process.stdout);
  });
  c.on('error', () => {
    // Server not up yet: retry briefly (it starts at app launch). Once we've
    // connected, an error means the stream broke — let 'close' handle exit.
    if (!connected && ++tries <= 50) setTimeout(connect, 100);
    else if (!connected) process.exit(1);
  });
  c.on('close', () => process.exit(connected ? 0 : 1));
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

/** The `mcpServers` entry pointing claude at the bridge via Electron-as-node. */
export function localMcpServerEntry(
  electronBin: string,
  bridgePath: string,
  socketPath: string
): { type: string; command: string; args: string[]; env: Record<string, string> } {
  return {
    type: 'stdio',
    command: electronBin,
    args: [bridgePath],
    env: { ELECTRON_RUN_AS_NODE: '1', CLAUDE_FLEET_MCP_SOCKET: socketPath }
  };
}
