// Read-only MCP server exposing the state DB to the agent inside each
// container (issue #12, SPEC §11). Hand-rolled JSON-RPC over a Unix-domain
// socket — no SDK dep, matching the broker's "own the protocol" approach.
//
// Transport: the server speaks newline-delimited JSON-RPC 2.0 on a Unix socket
// at `<userData>/mcp.sock`. In-container `claude` reaches it over a stdio
// bridge (`socat - UNIX-CONNECT:/fleet/mcp.sock`) configured in the workspace's
// ~/.claude.json — wired in the container-side slice (docker.ts / runner image).
//
// Safety: a single connection opened `{ readonly: true }` is the hard guarantee
// that nothing here can mutate the DB; the typed tools use parameterized SQL,
// and the raw `query` escape hatch is additionally gated by isReadOnlySql.
// Visibility is fleet-global (a session row from one workspace is queryable by
// another) — matching the "sessions are global" goal; per-workspace scoping is
// a future option (SPEC §11).

import { createServer, type Server, type Socket } from 'node:net';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { costFor } from './pricing.js';
import { isReadOnlySql } from './mcpReadonlySql.js';
import { mcpSocketPath } from './mcpSocket.js';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'claude-fleet-state', version: '1.0.0' };
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

export { mcpSocketPath };

let server: Server | null = null;
let rodb: Database.Database | null = null;

/** Open the read-only DB connection + start listening. No-op if already up. */
export function startMcpServer(userDataDir: string): void {
  if (server) return;
  const dbPath = join(userDataDir, 'state.db');
  rodb = new Database(dbPath, { readonly: true, fileMustExist: true });
  const sockPath = mcpSocketPath(userDataDir);
  // A stale socket file from a previous run blocks listen() with EADDRINUSE.
  try {
    if (existsSync(sockPath)) unlinkSync(sockPath);
  } catch {
    /* best effort */
  }
  server = createServer((sock) => handleConnection(sock));
  server.on('error', (err) => console.warn('[mcp] server error:', err));
  server.listen(sockPath, () => console.log(`[mcp] listening on ${sockPath}`));
}

export function stopMcpServer(): void {
  try {
    server?.close();
  } catch {
    /* ignore */
  }
  try {
    rodb?.close();
  } catch {
    /* ignore */
  }
  server = null;
  rodb = null;
}

function handleConnection(sock: Socket): void {
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) dispatchLine(line, sock);
    }
  });
  sock.on('error', () => sock.destroy());
}

function dispatchLine(line: string, sock: Socket): void {
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

  try {
    const result = handleMethod(method ?? '', params ?? {});
    if (!isNotification && result !== NO_REPLY) {
      send(sock, { jsonrpc: '2.0', id, result });
    }
  } catch (err) {
    if (!isNotification) {
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof RpcError ? err.code : -32603;
      send(sock, { jsonrpc: '2.0', id, error: { code, message } });
    }
  }
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

function handleMethod(method: string, params: Record<string, unknown>): unknown {
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
      return callTool(params);
    default:
      if (method.startsWith('notifications/')) return NO_REPLY;
      throw new RpcError(-32601, `Method not found: ${method}`);
  }
}

function callTool(params: Record<string, unknown>): unknown {
  const name = params.name as string;
  const args = (params.arguments as Record<string, unknown>) ?? {};
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new RpcError(-32602, `Unknown tool: ${name}`);
  if (!rodb) throw new RpcError(-32603, 'Database not open');
  try {
    const result = tool.run(rodb, args);
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
  run: (db: Database.Database, args: Record<string, unknown>) => unknown;
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
  }
];
