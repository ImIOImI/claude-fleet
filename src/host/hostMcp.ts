// The fleet-state MCP tools for this workspace's sessions, on the holder (SPEC §7 *Host MCP*).
import { createServer, type Server, type Socket } from 'node:net';
import {
  initReadSource, releaseReadSource, serveMcpConnection, setExposedTools, setMcpLogSink, setReadScopeResolver, type McpLogEntry
} from '../main/mcpCore.js';
import type { OwnedReadSource } from '../main/store/readSource.js';
import type { Logger } from './log.js';
import { finishSocket, prepareSocketPath } from './socketDir.js';

export const HOST_MCP_TOOLS: ReadonlySet<string> = new Set([
  'list_sessions', 'get_session', 'get_cost', 'list_events', 'session_summary',
  'post_todo', 'update_todo', 'list_todos',
  'list_automations', 'get_automation', 'list_runs', 'run_automation', 'schedule_next'
]);
export const MAX_HOST_MCP_CONNECTIONS = 64;
/** A session's bridge reconnects in a loop; these stay off stdout at the default level. */
const QUIET = new Set(['mcp-conn', 'mcp-conn-closed']);

const REFUSAL_LOG_MS = 60_000;

export interface HostMcp { close(): Promise<void> }

/** The core's handler state is per process, so one instance at a time. */
let active = false;

/** Takes ownership of `readSource`: close() and a failed start both close it. */
export async function startHostMcp(o: {
  socketPath: string;
  socketGroup: number | null;
  workspaceId: string;
  readSource: OwnedReadSource;
  log: Logger;
  maxConnections?: number;
  now?: () => number;
}): Promise<HostMcp> {
  if (active) throw new Error('the host MCP is already serving in this process');
  active = true;
  const max = o.maxConnections ?? MAX_HOST_MCP_CONNECTIONS;
  const now = o.now ?? Date.now;
  let refused = 0;
  let refusalLoggedAt = -Infinity;
  setMcpLogSink((e: McpLogEntry) =>
    o.log.log(QUIET.has(e.type) ? 'debug' : e.level ?? 'error', e.type, {
      message: e.message,
      ...(e.sessionId ? { sessionId: e.sessionId } : {}),
      ...(e.extra ? { extra: e.extra } : {}),
      ...(e.stack ? { stack: e.stack } : {})
    })
  );
  setReadScopeResolver(async () => [o.workspaceId]);
  setExposedTools(HOST_MCP_TOOLS);
  initReadSource(o.readSource);
  const socks = new Set<Socket>();
  const server: Server = createServer((sock) => {
    if (socks.size >= max) {
      sock.destroy();
      refused++;
      if (now() - refusalLoggedAt >= REFUSAL_LOG_MS) {
        o.log.log('warn', 'mcp connections refused: too many open', { max, refused });
        refused = 0;
        refusalLoggedAt = now();
      }
      return;
    }
    socks.add(sock);
    sock.on('close', () => socks.delete(sock));
    serveMcpConnection(sock, o.workspaceId);
  });
  function reset(): void {
    releaseReadSource();
    setExposedTools(null);
    setMcpLogSink(null);
    active = false;
  }
  try {
    await prepareSocketPath(o.socketPath, o.socketGroup);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(o.socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    await finishSocket(o.socketPath, o.socketGroup);
  } catch (err) {
    server.close();
    reset();
    throw err;
  }
  server.on('error', (err) => o.log.log('warn', 'mcp listener error', { error: err.message }));
  o.log.log('info', 'mcp serving', { socket: o.socketPath });
  let closing: Promise<void> | null = null;
  return {
    close() {
      closing ??= new Promise<void>((resolve) => {
        for (const s of socks) s.destroy();
        server.close(() => {
          reset();
          resolve();
        });
      });
      return closing;
    }
  };
}

/** Written into the image at build (`fleet-host write-mcp-bridge`). */
export const HOST_MCP_BRIDGE = '/usr/local/lib/fleet-host/mcp-bridge.cjs';

/** Appended to every claude fleet-host creates; the name is the prefix INBOX_TOOLS uses.
 *  `--mcp-config` is variadic: the `=` form keeps a later positional from being read as a config. */
export function hostMcpArgs(socketPath: string, bridge: string = HOST_MCP_BRIDGE): string[] {
  const entry = { type: 'stdio', command: 'node', args: [bridge], env: { CLAUDE_FLEET_MCP_UNIX: socketPath, CLAUDE_FLEET_MCP_TCP: '' } };
  return [`--mcp-config=${JSON.stringify({ mcpServers: { 'claude-fleet-state': entry } })}`];
}
