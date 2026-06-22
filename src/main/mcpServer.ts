// Read-only MCP server exposing the state DB to the agent inside each
// container (issue #12, SPEC §11). Hand-rolled JSON-RPC over a Unix-domain
// socket — no SDK dep, matching the broker's "own the protocol" approach.
//
// Transport: one listener **per workspace** at `<userData>/mcp/<id>/mcp.sock`
// (#117), bind-mounted into only that container at `/fleet/mcp/mcp.sock`.
// In-container `claude` reaches it over a stdio bridge
// (`socat - UNIX-CONNECT:/fleet/mcp/mcp.sock`) configured in the workspace's
// ~/.claude.json — wired in the container-side slice (docker.ts / runner image).
//
// Caller identity (#117, the security spine): because each workspace has its
// own listener, the host derives the caller's workspace id from *which listener
// accepted the connection*, not from anything the client sends. There is no
// `caller_id` argument, token, or env var to forge or steal — identity is
// ambient from the mount. Tools receive that id via `ToolCtx`; cross-workspace
// scoping of reads rides on it in a later phase (#122).
//
// Safety: a single connection opened `{ readonly: true }` is the hard guarantee
// that nothing here can mutate the DB; the typed tools use parameterized SQL,
// and the raw `query` escape hatch is additionally gated by isReadOnlySql.
// Visibility is currently fleet-global (a session row from one workspace is
// queryable by another) — narrowing to the caller + read-granted targets is
// #122, gated behind a flag.

import { createServer, type Server, type Socket } from 'node:net';
import { existsSync, mkdirSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { costFor } from './pricing.js';
import { isReadOnlySql } from './mcpReadonlySql.js';
import { mcpWorkspaceSocketDir, mcpWorkspaceSocketPath } from './mcpSocket.js';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'claude-fleet-state', version: '1.0.0' };
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

/** Context handed to every tool call. `callerId` is the workspace id of the
 *  listener that accepted the connection — host-assigned, never from the wire. */
interface ToolCtx {
  callerId: string;
}

/**
 * Cross-workspace committee effects (#119+). Injected by `ipc.ts` at startup so
 * the `committee_*` tools can drive pause/unpause (and later post/collect)
 * without mcpServer importing the docker/backend module graph. Each takes the
 * host-assigned `callerId` (never a wire value) and the target workspace id;
 * the implementation enforces `assertControl` before any effect.
 */
export interface CommitteeHandlers {
  pause(callerId: string, targetId: string): Promise<unknown>;
  unpause(callerId: string, targetId: string): Promise<unknown>;
  post(callerId: string, targetId: string, text: string): Promise<unknown>;
  collect(callerId: string, targetId: string, since: number): Promise<unknown>;
}
let committeeHandlers: CommitteeHandlers | null = null;
export function setCommitteeHandlers(h: CommitteeHandlers): void {
  committeeHandlers = h;
}

let userDataDir: string | null = null;
let rodb: Database.Database | null = null;
// One listening socket per workspace, keyed by workspace id. The id is captured
// in each listener's accept callback and becomes the connection's caller id.
const listeners = new Map<string, Server>();

/** Open the shared read-only DB connection. Per-workspace listeners are created
 *  lazily via {@link ensureWorkspaceSocket}. No-op if already started. */
export function startMcpServer(dir: string): void {
  if (rodb) return;
  const dbPath = join(dir, 'state.db');
  rodb = new Database(dbPath, { readonly: true, fileMustExist: true });
  userDataDir = dir;
}

/** Ensure a listener exists for `id` at `<userData>/mcp/<id>/mcp.sock`.
 *  Idempotent; safe to call before the workspace's container starts (the
 *  in-container socat bridge reconnects until the listener is up). No-op if the
 *  server hasn't been started (e.g. mock mode / tests without a DB). */
export function ensureWorkspaceSocket(id: string): void {
  if (!rodb || !userDataDir) return;
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
  const server = createServer((sock) => handleConnection(sock, id));
  server.on('error', (err) => console.warn(`[mcp] listener error (${id}):`, err));
  server.listen(sockPath, () => console.log(`[mcp] listening for ${id} on ${sockPath}`));
  listeners.set(id, server);
}

/** Tear down a workspace's listener + remove its socket dir. Best-effort
 *  cleanup on workspace removal; surviving listeners are harmless and get
 *  rebuilt from the manifest list on next launch. */
export function removeWorkspaceSocket(id: string): void {
  const server = listeners.get(id);
  if (server) {
    try {
      server.close();
    } catch {
      /* ignore */
    }
    listeners.delete(id);
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
  try {
    rodb?.close();
  } catch {
    /* ignore */
  }
  rodb = null;
  userDataDir = null;
}

function handleConnection(sock: Socket, callerId: string): void {
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) dispatchLine(line, sock, callerId);
    }
  });
  sock.on('error', () => sock.destroy());
}

function dispatchLine(line: string, sock: Socket, callerId: string): void {
  let msg: { id?: unknown; method?: string; params?: Record<string, unknown> };
  try {
    msg = JSON.parse(line);
  } catch {
    send(sock, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const { id, method, params } = msg;
  // Notifications (no id) get no reply — e.g. notifications/initialized.
  const isNotification = id === undefined || id === null;

  // handleMethod may return a Promise (the committee_* tools call async backend
  // effects); Promise.resolve() funnels both sync throws and async rejections
  // through the single .catch below.
  Promise.resolve()
    .then(() => handleMethod(method ?? '', params ?? {}, callerId))
    .then((result) => {
      if (!isNotification && result !== NO_REPLY) {
        send(sock, { jsonrpc: '2.0', id, result });
      }
    })
    .catch((err) => {
      if (!isNotification) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof RpcError ? err.code : -32603;
        send(sock, { jsonrpc: '2.0', id, error: { code, message } });
      }
    });
}

const NO_REPLY = Symbol('no-reply');

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message);
  }
}

function handleMethod(method: string, params: Record<string, unknown>, callerId: string): unknown {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) };
    case 'tools/call':
      return callTool(params, callerId); // may be a Promise (committee_* tools)
    default:
      if (method.startsWith('notifications/')) return NO_REPLY;
      throw new RpcError(-32601, `Method not found: ${method}`);
  }
}

async function callTool(params: Record<string, unknown>, callerId: string): Promise<unknown> {
  const name = params.name as string;
  const args = (params.arguments as Record<string, unknown>) ?? {};
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new RpcError(-32602, `Unknown tool: ${name}`);
  if (!rodb) throw new RpcError(-32603, 'Database not open');
  try {
    // callerId is host-assigned (the accepting listener's workspace id), so it
    // is trustworthy here. Tools that scope by caller read it from ctx (#122);
    // the committee_* tools enforce assertControl before any effect. `await`
    // covers both sync DB tools and async committee effects.
    const result = await tool.run(rodb, args, { callerId });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    // Tool-level failures surface to the model as an error result (MCP
    // convention), not a protocol error, so it can read the message and adapt.
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
  }
}

function send(sock: Socket, obj: unknown): void {
  try {
    sock.write(JSON.stringify(obj) + '\n');
  } catch {
    /* connection went away mid-write */
  }
}

function clampLimit(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, n));
}

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  // ctx carries the host-assigned caller workspace id. Existing tools omit it
  // (a narrower fn satisfies the wider type); #122's scoped reads consume it.
  run: (db: Database.Database, args: Record<string, unknown>, ctx: ToolCtx) => unknown;
}

// Curated event columns (omit raw_jsonl by default — it's large and the
// extract columns cover the common needs).
const EVENT_COLS =
  'id, session_id, workspace_id, ts, type, subtype, model, tool_name, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, service_tier';

const TOOLS: Tool[] = [
  {
    name: 'list_sessions',
    description:
      'List Claude sessions (newest first). Optional filters: workspace_id, since/until (epoch ms on last_active_at), limit.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string' },
        since: { type: 'number', description: 'epoch ms, last_active_at >= since' },
        until: { type: 'number', description: 'epoch ms, last_active_at <= until' },
        limit: { type: 'number', description: `default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}` }
      }
    },
    run: (db, a) => {
      const where: string[] = [];
      const p: unknown[] = [];
      if (typeof a.workspace_id === 'string') {
        where.push('workspace_id = ?');
        p.push(a.workspace_id);
      }
      if (typeof a.since === 'number') {
        where.push('last_active_at >= ?');
        p.push(a.since);
      }
      if (typeof a.until === 'number') {
        where.push('last_active_at <= ?');
        p.push(a.until);
      }
      const sql = `SELECT * FROM sessions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY last_active_at DESC LIMIT ?`;
      return db.prepare(sql).all(...p, clampLimit(a.limit));
    }
  },
  {
    name: 'get_session',
    description: 'Fetch one session row (all metadata) by its id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id']
    },
    run: (db, a) => {
      if (typeof a.id !== 'string') throw new Error('id is required');
      return db.prepare('SELECT * FROM sessions WHERE id = ?').get(a.id) ?? null;
    }
  },
  {
    name: 'get_cost',
    description:
      'Token totals + derived USD for a session. USD is computed from per-(model, tier) usage via the app pricing table.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' } },
      required: ['session_id']
    },
    run: (db, a) => {
      if (typeof a.session_id !== 'string') throw new Error('session_id is required');
      const rows = db
        .prepare(
          `SELECT model, service_tier,
                  SUM(COALESCE(input_tokens,0)) AS input,
                  SUM(COALESCE(output_tokens,0)) AS output,
                  SUM(COALESCE(cache_read_input_tokens,0)) AS cacheRead,
                  SUM(COALESCE(cache_creation_input_tokens,0)) AS cacheCreate
           FROM events WHERE session_id = ? AND type = 'assistant'
           GROUP BY model, service_tier`
        )
        .all(a.session_id) as Array<{
        model: string | null;
        service_tier: string | null;
        input: number;
        output: number;
        cacheRead: number;
        cacheCreate: number;
      }>;
      let usd = 0;
      const totals = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
      for (const r of rows) {
        const tokens = {
          inputTokens: r.input,
          outputTokens: r.output,
          cacheReadInputTokens: r.cacheRead,
          cacheCreationInputTokens: r.cacheCreate
        };
        usd += costFor(r.model, r.service_tier, tokens);
        totals.inputTokens += r.input;
        totals.outputTokens += r.output;
        totals.cacheReadInputTokens += r.cacheRead;
        totals.cacheCreationInputTokens += r.cacheCreate;
      }
      return { session_id: a.session_id, usd, ...totals };
    }
  },
  {
    name: 'list_events',
    description:
      'List events for a session in id order (omits the raw JSONL body). Optional filters: type, since (epoch ms on ts), limit.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        type: { type: 'string' },
        since: { type: 'number' },
        limit: { type: 'number', description: `default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}` }
      },
      required: ['session_id']
    },
    run: (db, a) => {
      if (typeof a.session_id !== 'string') throw new Error('session_id is required');
      const where = ['session_id = ?'];
      const p: unknown[] = [a.session_id];
      if (typeof a.type === 'string') {
        where.push('type = ?');
        p.push(a.type);
      }
      if (typeof a.since === 'number') {
        where.push('ts >= ?');
        p.push(a.since);
      }
      const sql = `SELECT ${EVENT_COLS} FROM events WHERE ${where.join(' AND ')} ORDER BY id ASC LIMIT ?`;
      return db.prepare(sql).all(...p, clampLimit(a.limit));
    }
  },
  {
    name: 'query',
    description:
      'Run an arbitrary read-only SQL statement against the state DB and return the rows ' +
      `(capped at ${MAX_LIMIT}). Writes are rejected. Tables: ` +
      'events(id, session_id, workspace_id, ts, type, subtype, uuid, parent_uuid, model, ' +
      'input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, ' +
      'service_tier, tool_name, raw_jsonl); ' +
      'sessions(id, workspace_id, cwd, started_at, last_active_at, ai_title, first_user_message, user_set_name); ' +
      'broker_sessions(workspace_id, broker_session_id, claude_session_id, learned_at).',
    inputSchema: {
      type: 'object',
      properties: { sql: { type: 'string' } },
      required: ['sql']
    },
    run: (db, a) => {
      const sql = a.sql as string;
      const check = isReadOnlySql(sql);
      if (!check.ok) throw new Error(check.reason ?? 'Rejected.');
      const rows = db.prepare(sql).all() as unknown[];
      if (rows.length > MAX_LIMIT) {
        return { truncated: true, returned: MAX_LIMIT, rows: rows.slice(0, MAX_LIMIT) };
      }
      return { truncated: false, returned: rows.length, rows };
    }
  },
  // Cross-workspace committee control (#119). These do NOT touch the read-only
  // DB connection — they proxy to the injected host handlers, which enforce
  // `assertControl(callerId, id, 'pause')` before any effect. `callerId` is the
  // host-assigned id of the accepting per-workspace socket, never a wire value.
  {
    name: 'committee_pause',
    description:
      'Pause a reachable expert workspace you hold a "pause" grant for. Freezes its container; ' +
      'the conversation is preserved. Arg: id (the target workspace id).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run: (_db, a, ctx) => {
      if (!committeeHandlers) throw new Error('committee control is unavailable');
      if (typeof a.id !== 'string') throw new Error('id is required');
      return committeeHandlers.pause(ctx.callerId, a.id);
    }
  },
  {
    name: 'committee_unpause',
    description:
      'Unpause (or cold-start) an expert workspace you hold a "pause" grant for, and wait until ' +
      'its in-container session manager is responsive before returning. Arg: id (the target workspace id).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run: (_db, a, ctx) => {
      if (!committeeHandlers) throw new Error('committee control is unavailable');
      if (typeof a.id !== 'string') throw new Error('id is required');
      return committeeHandlers.unpause(ctx.callerId, a.id);
    }
  },
  {
    name: 'committee_post',
    description:
      'Send a message into a reachable expert workspace you hold a "post" grant for — like typing ' +
      'it into that session. Args: id (target workspace id), message (text to send).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, message: { type: 'string' } },
      required: ['id', 'message']
    },
    run: (_db, a, ctx) => {
      if (!committeeHandlers) throw new Error('committee control is unavailable');
      if (typeof a.id !== 'string' || typeof a.message !== 'string') {
        throw new Error('id and message are required');
      }
      return committeeHandlers.post(ctx.callerId, a.id, a.message);
    }
  },
  {
    name: 'committee_collect',
    description:
      'Read new transcript turns from an expert workspace you hold a "read" grant for. Cursored by ' +
      '`since` (an event id): pass the previous reply\'s `cursor`, or omit/0 to start from the beginning. ' +
      'Returns { sessionId, cursor, turns: [{ id, role, text }] }. Args: id (target), since (optional number).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, since: { type: 'number' } },
      required: ['id']
    },
    run: (_db, a, ctx) => {
      if (!committeeHandlers) throw new Error('committee control is unavailable');
      if (typeof a.id !== 'string') throw new Error('id is required');
      const since = typeof a.since === 'number' ? a.since : 0;
      return committeeHandlers.collect(ctx.callerId, a.id, since);
    }
  }
];
