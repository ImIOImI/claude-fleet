// The desktop's fleet-state MCP transport: one Unix listener per workspace
// (Windows: one loopback TCP listener, token per workspace) over mcpCore.ts,
// plus the tools that reach Electron (perf). SPEC §11 *Fleet-state MCP*.
//
// Unix: `<userData>/mcp/<id>/mcp.sock` (#117), bind-mounted into only that
// container at `/fleet/mcp/mcp.sock`; in-container `claude` reaches it over a
// stdio bridge configured in the workspace's ~/.claude.json. The caller id is
// the listener that accepted the connection, never anything the client sends.
import { createServer, type Server, type Socket } from 'node:net';
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { sqliteReadSource } from './sqliteReadSource.js';
import { lineSplitter } from './mcpLines.js';
import type { OwnedReadSource, ReadSource } from './store/readSource.js';
import { logError } from './errorLog.js';
import { ensureContainerBridgeScript } from './mcpContainerBridge.js';
import { describeListenerError, type ListenerScope } from './mcpListenerError.js';
import { type McpStatus } from './mcpStatusBroadcast.js';
import { mcpWorkspaceSocketDir, mcpWorkspaceSocketPath, mcpWorkspaceTokenPath, MCP_TCP_PORT } from './mcpSocket.js';
import { getPerfStatus, reconfigurePerf, getEffectivePerf } from './perf.js';
import { getPerfTelemetry, setPerfTelemetry, getPerfOtlp } from './config.js';
import { resolvePerfConfig } from './perfConfig.js';
import { armSentinel, disarmSentinel } from './perfSentinel.js';
import {
  currentReadSource, dispatchLine, initReadSource, OVERSIZE_ERROR, releaseReadSource, send, serveMcpConnection, setMcpLogSink, trackConnection,
  _setReadSourceForTests, TOOLS, type Tool
} from './mcpCore.js';

export * from './mcpCore.js';

setMcpLogSink(logError);

// A Windows host can't listen() on a unix-domain socket at a Windows path
// (EACCES), so the per-workspace-socket transport (#117) can't work there. On
// win32 the server instead runs ONE loopback-TCP listener for all workspaces
// and authenticates each connection by a per-workspace token (see mcpSocket.ts
// mcpWorkspaceTokenPath). Linux/macOS keep the per-workspace unix sockets
// unchanged. See docs/design/windows-broker-tcp.md (Phase 2).
const isWindows = process.platform === 'win32';

/** Route a host MCP listener `error` event to BOTH the console (live dev
 *  visibility) and `error.log` (durable trace — #159). Without the durable sink
 *  a swallowed bind failure — chiefly EADDRINUSE from a stale/duplicate
 *  claude-fleet still holding 127.0.0.1:7071 — left no record of why a
 *  container's claude-fleet-state MCP shows "Failed to connect". */
function reportListenerError(where: ListenerScope, err: unknown): void {
  const report = describeListenerError(where, err);
  console.warn(`[mcp] ${report.message}`);
  logError({ source: 'main', ...report });
}

let userDataDir: string | null = null;
// One listening socket per workspace, keyed by workspace id. The id is captured
// in each listener's accept callback and becomes the connection's caller id.
// (Unix transport — Linux/macOS.)
const listeners = new Map<string, Server>();

// Windows TCP transport: a single shared loopback listener plus a token→id map.
// A connection's caller id is resolved from the token it presents on its first
// line, since the TCP source address (always 127.0.0.1 via host.docker.internal)
// carries no identity. tokenToId is the authority; idToToken makes token
// issuance idempotent and lets removeWorkspaceSocket revoke.
let tcpListener: Server | null = null;
const tokenToId = new Map<string, string>();
const idToToken = new Map<string, string>();

// Host MCP listener health, surfaced to renderers as the "MCP unreachable"
// sticky toast (#159 follow-up). Defaults healthy; the win32 TCP listener flips
// it on bind success/failure. On non-win32 there is no single listener, so it
// stays healthy (per-workspace unix-socket failures still log durably via
// reportListenerError, but aren't a global "MCP down"). A failed TCP bind has
// no in-process recovery (no auto-retry — the single-instance lock is the real
// fix); it clears when the app restarts and binds cleanly.
let mcpStatus: McpStatus = { ok: true };
let statusListener: ((s: McpStatus) => void) | null = null;
/** Wire a callback fired whenever host MCP listener health changes; index.ts
 *  broadcasts it to renderers on the `mcp:status` channel. */
export function setMcpStatusListener(fn: (s: McpStatus) => void): void {
  statusListener = fn;
}
/** Current host MCP listener health — for a window mounting mid-outage. */
export function currentMcpStatus(): McpStatus {
  return mcpStatus;
}
function setMcpHealth(ok: boolean, detail?: string): void {
  if (mcpStatus.ok === ok && mcpStatus.detail === detail) return; // change-only
  mcpStatus = { ok, detail };
  statusListener?.(mcpStatus);
}

/** Open the shared read-only DB connection. Per-workspace listeners are created
 *  lazily via {@link ensureWorkspaceSocket}. No-op if already started. On
 *  Windows this also binds the single loopback-TCP listener that fronts every
 *  workspace (identity comes from the per-connection token, not the socket). */
export function startMcpServer(dir: string, opts: { readSource?: OwnedReadSource | null } = {}): void {
  if (userDataDir) return;
  initReadSource(opts.readSource === null ? null : opts.readSource ?? sqliteReadSource(new Database(join(dir, 'state.db'), { readonly: true, fileMustExist: true })));
  userDataDir = dir;

  if (isWindows && !tcpListener) {
    // 127.0.0.1 only — never 0.0.0.0. Docker Desktop NATs host.docker.internal
    // through the host loopback, so containers still reach it while the LAN
    // cannot. callerId is resolved from the first-line token in handleTcp.
    const srv = createServer((sock) => handleTcpConnection(sock));
    srv.on('error', (err) => {
      reportListenerError({ scope: 'tcp', port: MCP_TCP_PORT }, err);
      setMcpHealth(false, (err as NodeJS.ErrnoException).code ?? 'error');
    });
    srv.listen(MCP_TCP_PORT, '127.0.0.1', () => {
      console.log(`[mcp] tcp listening on 127.0.0.1:${MCP_TCP_PORT}`);
      setMcpHealth(true);
    });
    tcpListener = srv;
  }
}

/** Ensure `id` is reachable from its container. Idempotent; safe to call before
 *  the workspace's container starts (the in-container bridge reconnects until
 *  the server is up). No-op if the server hasn't been started (e.g. mock mode /
 *  tests without a DB).
 *
 *  Unix (Linux/macOS): a per-workspace listener at `<userData>/mcp/<id>/mcp.sock`.
 *  Windows: ensure a per-workspace token exists on disk (in the same per-id
 *  leaf dir, bind-mounted into only that container) and is registered, so the
 *  shared TCP listener can map an incoming token to this id. */
export function ensureWorkspaceSocket(id: string): void {
  if (!userDataDir) return;
  // Refresh the container-side bridge script in the per-id dir (bind-mounted
  // into exactly that container) so an app upgrade updates every workspace's
  // bridge without a runner-image rebuild. Best-effort: a failed write leaves
  // the previous bridge in place.
  try {
    ensureContainerBridgeScript(mcpWorkspaceSocketDir(userDataDir, id));
  } catch (err) {
    console.warn(`[mcp] bridge script write failed (${id}):`, err);
  }
  if (isWindows) {
    ensureWorkspaceToken(id);
    return;
  }
  if (listeners.has(id)) return;
  const dir = mcpWorkspaceSocketDir(userDataDir, id);
  const sockPath = mcpWorkspaceSocketPath(userDataDir, id);
  try {
    mkdirSync(dir, { recursive: true });
    // A stale socket file from a previous run blocks listen() with EADDRINUSE.
    // (The unlink also means a fresh inode each run — why containers bind the
    // *directory*, not this file; see mcpSocket.ts.)
    if (existsSync(sockPath)) unlinkSync(sockPath);
  } catch {
    /* best effort */
  }
  const server = createServer((sock) => serveMcpConnection(sock, id));
  server.on('error', (err) => reportListenerError({ scope: 'unix', workspaceId: id }, err));
  server.listen(sockPath, () => console.log(`[mcp] listening for ${id} on ${sockPath}`));
  listeners.set(id, server);
}

/** Windows: ensure a stable per-workspace token exists and is registered.
 *  Reuses the token already on disk (so it survives app restarts and matches a
 *  paused container's baked-in bridge) — otherwise mints a fresh 256-bit one.
 *  Writing it into the per-id leaf dir is what bounds its visibility to the one
 *  container that dir is bind-mounted into. */
function ensureWorkspaceToken(id: string): void {
  if (!userDataDir) return;
  if (idToToken.has(id)) return;
  const dir = mcpWorkspaceSocketDir(userDataDir, id);
  const tokenPath = mcpWorkspaceTokenPath(userDataDir, id);
  let token: string | null = null;
  try {
    mkdirSync(dir, { recursive: true });
    if (existsSync(tokenPath)) {
      const existing = readFileSync(tokenPath, 'utf8').trim();
      if (existing) token = existing;
    }
    if (!token) {
      token = randomBytes(32).toString('hex');
      writeFileSync(tokenPath, token, { encoding: 'utf8', mode: 0o600 });
    }
  } catch (err) {
    console.warn(`[mcp] token setup failed (${id}):`, err);
    return;
  }
  tokenToId.set(token, id);
  idToToken.set(id, token);
}

/** Tear down a workspace's listener + remove its socket dir. Best-effort
 *  cleanup on workspace removal; surviving listeners are harmless and get
 *  rebuilt from the manifest list on next launch. */
export function removeWorkspaceSocket(id: string): void {
  void currentReadSource()?.forgetCaller(id).catch((e: unknown) =>
    logError({ source: 'main', type: 'mcp-forget-caller', level: 'warn', message: String(e), workspaceId: id }));
  const server = listeners.get(id);
  if (server) {
    try {
      server.close();
    } catch {
      /* ignore */
    }
    listeners.delete(id);
  }
  // Windows: revoke the token so the shared listener stops honoring it.
  const token = idToToken.get(id);
  if (token) {
    tokenToId.delete(token);
    idToToken.delete(id);
  }
  if (userDataDir) {
    try {
      rmSync(mcpWorkspaceSocketDir(userDataDir, id), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

export function stopMcpServer(): void {
  for (const server of listeners.values()) {
    try {
      server.close();
    } catch {
      /* ignore */
    }
  }
  listeners.clear();
  if (tcpListener) {
    try {
      tcpListener.close();
    } catch {
      /* ignore */
    }
    tcpListener = null;
  }
  tokenToId.clear();
  idToToken.clear();
  releaseReadSource();
  userDataDir = null;
}

/** Windows TCP connection handler. The first non-empty line authenticates the
 *  connection: it must be a registered per-workspace token, which resolves the
 *  caller id. The source address is always 127.0.0.1 (NAT'd through the host
 *  loopback) so it proves nothing — the token is the sole identity. Subsequent
 *  lines are the normal newline-delimited JSON-RPC stream. An unknown token
 *  drops the connection before any tool can run. */
function handleTcpConnection(sock: Socket): void {
  let callerId: string | null = null;
  let conn: { rpcCount: number } | null = null;
  sock.setEncoding('utf8');
  sock.on('error', () => sock.destroy());
  sock.on('data', lineSplitter((raw) => {
    const line = raw.trim();
    if (callerId === null) {
      if (!line) return; // tolerate leading blank lines before the token
      const id = tokenToId.get(line);
      if (!id) {
        console.warn('[mcp] tcp connection presented an unknown token; closing');
        logError({
          source: 'main',
          type: 'mcp-auth-failed',
          level: 'warn',
          message: 'mcp tcp connection presented an unknown token; closed'
        });
        sock.destroy();
        return false;
      }
      callerId = id;
      conn = trackConnection('tcp', callerId, sock);
      return;
    }
    if (line) {
      if (conn) conn.rpcCount++;
      dispatchLine(line, sock, callerId);
    }
  }, () => {
    if (callerId === null) sock.destroy();
    else send(sock, OVERSIZE_ERROR);
  }));
}

/** Test-only: swap the read-only DB handle without a real listener. */
export function _setDbForTests(db: Database.Database | null): void {
  _setReadSourceForTests(db ? sqliteReadSource(db) : null);
}

// Perf tools reach Electron and OpenTelemetry, so they live here, listed right after `query`.
const PERF_TOOLS: Tool[] = [
  // Perf-telemetry tools. perf_status is a read-only snapshot; perf_set
  // changes the recording toggle (app-global, settings-tier only — OTLP
  // export config is Settings-UI/env, never MCP-settable). Neither touches
  // the read-only `db` connection — they route through the in-process perf
  // runtime (getPerfStatus / reconfigurePerf) and the settings vault
  // (setPerfTelemetry) directly.
  {
    name: 'perf_status',
    description:
      'Perf-telemetry state: recording on/off + which source controls it (settings vs CLAUDE_FLEET_PERF), ' +
      'OTLP export state, and perf_events counts per kind over the trailing 24h. ' +
      'Includes the stall-sentinel status (see perf_sentinel_set).',
    inputSchema: { type: 'object', properties: {} },
    run: async () => getPerfStatus()
  },
  {
    name: 'perf_set',
    description:
      'Enable or disable perf-telemetry recording (app-global; mediated by the host). ' +
      'Cannot change OTLP export config — export is Settings-UI/env only. ' +
      'Fails while CLAUDE_FLEET_PERF=0 pins recording off.',
    inputSchema: {
      type: 'object',
      properties: { enabled: { type: 'boolean' } },
      required: ['enabled']
    },
    run: async (_rs: ReadSource | null, args: Record<string, unknown>) => {
      const extras = Object.keys(args).filter((k) => k !== 'enabled');
      if (extras.length > 0) {
        throw new Error(`perf_set cannot change export config (unexpected: ${extras.join(', ')})`);
      }
      if (process.env.CLAUDE_FLEET_PERF === '0') {
        throw new Error('recording is forced off by CLAUDE_FLEET_PERF=0 — the setting is ignored until the override is removed');
      }
      await setPerfTelemetry(args.enabled === true);
      await reconfigurePerf(
        resolvePerfConfig(
          { perfTelemetry: await getPerfTelemetry(), perfOtlp: await getPerfOtlp() },
          process.env
        )
      );
      return getPerfStatus();
    }
  },
  {
    name: 'perf_sentinel_set',
    description:
      'Arm or disarm the stall sentinel: a worker-thread co-stall detector that annotates stall rows ' +
      'with meta.sentinel, discriminating OS-level starvation (worker stalled too) from main-loop blocks. ' +
      'Armed until app restart, manual disarm, or optional ttlHours (max 168); never persisted. ' +
      'Requires perf recording to be enabled. Returns the resulting perf_status.',
    inputSchema: {
      type: 'object',
      properties: { enabled: { type: 'boolean' }, ttlHours: { type: 'number' } },
      required: ['enabled']
    },
    run: async (_rs: ReadSource | null, args: Record<string, unknown>) => {
      const extras = Object.keys(args).filter((k) => k !== 'enabled' && k !== 'ttlHours');
      if (extras.length > 0) {
        throw new Error(`perf_sentinel_set: unexpected arguments: ${extras.join(', ')}`);
      }
      if (args.enabled === true) {
        const ttl = args.ttlHours;
        if (ttl !== undefined && (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl <= 0 || ttl > 168)) {
          throw new Error('ttlHours must be a number in (0, 168]');
        }
        if (!getEffectivePerf()?.recording) {
          throw new Error('perf recording is disabled — enable it (perf_set) before arming the sentinel');
        }
        armSentinel(ttl !== undefined ? { ttlHours: ttl as number } : undefined);
      } else {
        disarmSentinel();
      }
      return getPerfStatus();
    }
  },
];
const queryAt = TOOLS.findIndex((t) => t.name === 'query');
if (queryAt < 0) throw new Error('mcpCore TOOLS has no query tool to list the perf tools after');
TOOLS.splice(queryAt + 1, 0, ...PERF_TOOLS);
