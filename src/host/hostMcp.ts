// The fleet-state MCP tools for this workspace's sessions, on the holder (SPEC §7 *Host MCP*).
import { createServer, type Server, type Socket } from 'node:net';
import { getSession, recordUsageEvent } from '../main/db.js';
import {
  initReadSource, releaseReadSource, serveMcpConnection, setExposedTools, setMcpLogSink, setQueryEmbedder, setReadScopeResolver,
  setUsageRecorder, type McpLogEntry, type UsageRecorder
} from '../main/mcpCore.js';
import type { OwnedReadSource } from '../main/store/readSource.js';
import type { EmbedFn } from '../main/vectors.js';
import { listenOn, type ListenTarget } from './endpoint.js';
import type { Logger } from './log.js';
import { finishSocket, prepareSocketPath } from './socketDir.js';

export const HOST_MCP_TOOLS: ReadonlySet<string> = new Set([
  'list_sessions', 'get_session', 'get_cost', 'list_events', 'session_summary', 'query', 'mark_useful',
  'post_todo', 'update_todo', 'list_todos',
  'list_automations', 'get_automation', 'list_runs', 'run_automation', 'schedule_next'
]);
export const HOST_SEARCH_TOOL = 'search_transcripts';
const HOST_TOOLS_WITH_SEARCH: ReadonlySet<string> = new Set([...HOST_MCP_TOOLS, HOST_SEARCH_TOOL]);
/** D79: search_transcripts exists only where the holder runs an embedder. */
export function hostMcpTools(search: boolean): ReadonlySet<string> {
  return search ? HOST_TOOLS_WITH_SEARCH : HOST_MCP_TOOLS;
}

/** The workspace of the session a signal is about is its origin: the hosted id or a publish partition. */
export const hostUsageRecorder: UsageRecorder = async (e) => {
  const origin = e.sessionId ? (await getSession(e.sessionId))?.workspaceId ?? null : null;
  await recordUsageEvent({ ...e, origin });
};
export const MAX_HOST_MCP_CONNECTIONS = 64;
/** A session's bridge reconnects in a loop; these stay off stdout at the default level. */
const QUIET = new Set(['mcp-conn', 'mcp-conn-closed']);

const REFUSAL_LOG_MS = 60_000;

export interface HostMcp { close(): Promise<void>; port: number | null }

/** The core's handler state is per process, so one instance at a time. */
let active = false;

/** Takes ownership of `readSource`: close() and a failed start both close it. */
export async function startHostMcp(o: {
  /** A Unix socket (single) or a TCP port (host pod; the mesh admits only the workspace pod). */
  listen: ListenTarget;
  workspaceId: string;
  readSource: OwnedReadSource;
  log: Logger;
  maxConnections?: number;
  now?: () => number;
  /** The holder's sidecar; without it search_transcripts isn't served. */
  embed?: EmbedFn;
  /** Read scope beyond the hosted workspace (publish partitions), read on every call. */
  scope?: () => Promise<readonly string[]>;
  /** Writes usage_events; without it mark_useful answers unavailable. */
  recordUsage?: UsageRecorder;
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
  setReadScopeResolver(async () => [o.workspaceId, ...((await o.scope?.()) ?? [])]);
  setUsageRecorder(o.recordUsage ?? null);
  setExposedTools(hostMcpTools(!!o.embed));
  initReadSource(o.readSource);
  setQueryEmbedder(o.embed ?? null);
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
    serveMcpConnection(sock, o.workspaceId, 'path' in o.listen ? 'unix' : 'tcp');
  });
  function reset(): void {
    releaseReadSource();
    setQueryEmbedder(null);
    setUsageRecorder(null);
    setExposedTools(null);
    setMcpLogSink(null);
    active = false;
  }
  let port: number | null = null;
  try {
    if ('path' in o.listen) await prepareSocketPath(o.listen.path);
    port = await listenOn(server, o.listen);
    if ('path' in o.listen) await finishSocket(o.listen.path);
  } catch (err) {
    server.close();
    reset();
    throw err;
  }
  server.on('error', (err) => o.log.log('warn', 'mcp listener error', { error: err.message }));
  o.log.log('info', 'mcp serving', 'path' in o.listen ? { socket: o.listen.path } : { port });
  let closing: Promise<void> | null = null;
  return {
    port,
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

/** Where a session's bridge dials: the private socket (single) or the host pod's MCP port. */
export type McpDial = { unix: string } | { tcp: string };

/** Appended to every claude fleet-host creates; the name is the prefix INBOX_TOOLS uses.
 *  `--mcp-config` is variadic: the `=` form keeps a later positional from being read as a config. */
export function hostMcpArgs(dial: McpDial, bridge: string = HOST_MCP_BRIDGE): string[] {
  // No CLAUDE_FLEET_MCP_TOKEN_FILE: on TCP the mesh establishes the caller (D73).
  const env = 'tcp' in dial
    ? { CLAUDE_FLEET_MCP_TCP: dial.tcp, CLAUDE_FLEET_MCP_UNIX: '' }
    : { CLAUDE_FLEET_MCP_UNIX: dial.unix, CLAUDE_FLEET_MCP_TCP: '' };
  const entry = { type: 'stdio', command: 'node', args: [bridge], env };
  return [`--mcp-config=${JSON.stringify({ mcpServers: { 'claude-fleet-state': entry } })}`];
}
