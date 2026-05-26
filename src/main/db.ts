// SQLite cache for JSONL transcript events.
//
// JSONL is the source of truth; this DB is rebuildable from the JSONLs at any
// time. `events` mirrors raw lines with fast-access extract columns;
// `sessions` carries derived per-session metadata. The watcher ingests every
// JSONL line through `ingestEvent`; duplicate ingestions (re-tail after
// restart) are silently dropped via the UNIQUE(session_id, dedup_key)
// constraint — `dedup_key` is the event's uuid when present, otherwise a
// hash of the raw line so light events without uuids also dedupe cleanly.

import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';

let db: Database.Database | null = null;

export function openDb(userDataDir: string): Database.Database {
  if (db) return db;
  const path = join(userDataDir, 'state.db');
  mkdirSync(dirname(path), { recursive: true });
  db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

function migrate(d: Database.Database): void {
  const current = (d.pragma('user_version', { simple: true }) as number) ?? 0;
  if (current < 1) {
    d.exec(`
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        workspace_name TEXT NOT NULL,
        ts INTEGER,
        type TEXT NOT NULL,
        subtype TEXT,
        uuid TEXT,
        parent_uuid TEXT,
        model TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_input_tokens INTEGER,
        cache_creation_input_tokens INTEGER,
        service_tier TEXT,
        tool_name TEXT,
        raw_jsonl TEXT NOT NULL,
        dedup_key TEXT NOT NULL,
        UNIQUE(session_id, dedup_key)
      );
      CREATE INDEX idx_events_session_ts ON events(session_id, ts);
      CREATE INDEX idx_events_workspace ON events(workspace_name);
      CREATE INDEX idx_events_type ON events(type);

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        workspace_name TEXT NOT NULL,
        cwd TEXT,
        started_at INTEGER,
        last_active_at INTEGER,
        ai_title TEXT,
        first_user_message TEXT,
        user_set_name TEXT
      );
      CREATE INDEX idx_sessions_workspace ON sessions(workspace_name);
    `);
    d.pragma('user_version = 1');
  }
}

// ── Ingest ────────────────────────────────────────────────────────────────

export interface IngestResult {
  inserted: boolean;       // false when the event was a duplicate
  sessionId: string;
  type: string;
}

const insertEvent = (d: Database.Database) =>
  d.prepare(`
    INSERT OR IGNORE INTO events (
      session_id, workspace_name, ts, type, subtype, uuid, parent_uuid,
      model, input_tokens, output_tokens,
      cache_read_input_tokens, cache_creation_input_tokens,
      service_tier, tool_name, raw_jsonl, dedup_key
    ) VALUES (
      @session_id, @workspace_name, @ts, @type, @subtype, @uuid, @parent_uuid,
      @model, @input_tokens, @output_tokens,
      @cache_read_input_tokens, @cache_creation_input_tokens,
      @service_tier, @tool_name, @raw_jsonl, @dedup_key
    )
  `);

const upsertSession = (d: Database.Database) =>
  d.prepare(`
    INSERT INTO sessions (id, workspace_name, started_at, last_active_at)
    VALUES (@id, @workspace_name, @ts, @ts)
    ON CONFLICT(id) DO UPDATE SET
      last_active_at = MAX(COALESCE(last_active_at, 0), excluded.last_active_at),
      started_at = COALESCE(started_at, excluded.started_at)
  `);

const updateSessionCwd = (d: Database.Database) =>
  d.prepare(`UPDATE sessions SET cwd = ? WHERE id = ? AND cwd IS NULL`);
const updateSessionAiTitle = (d: Database.Database) =>
  d.prepare(`UPDATE sessions SET ai_title = ? WHERE id = ?`);
const updateSessionLastPrompt = (d: Database.Database) =>
  d.prepare(`UPDATE sessions SET first_user_message = COALESCE(first_user_message, ?) WHERE id = ?`);

interface Cache {
  insertEvent: ReturnType<typeof insertEvent>;
  upsertSession: ReturnType<typeof upsertSession>;
  updateSessionCwd: ReturnType<typeof updateSessionCwd>;
  updateSessionAiTitle: ReturnType<typeof updateSessionAiTitle>;
  updateSessionLastPrompt: ReturnType<typeof updateSessionLastPrompt>;
}
let stmts: Cache | null = null;
function getStmts(d: Database.Database): Cache {
  if (!stmts) {
    stmts = {
      insertEvent: insertEvent(d),
      upsertSession: upsertSession(d),
      updateSessionCwd: updateSessionCwd(d),
      updateSessionAiTitle: updateSessionAiTitle(d),
      updateSessionLastPrompt: updateSessionLastPrompt(d),
    };
  }
  return stmts;
}

/**
 * Ingest a single JSONL line. Caller passes `workspaceName` and `sessionId`
 * (both derived from the file path on disk — JSONL light events sometimes
 * omit sessionId, so the path is authoritative). The line is parsed,
 * extracts pulled out for fast access, the raw line stored verbatim, and the
 * sessions table updated with any derived metadata.
 *
 * Returns whether the row was inserted (false = duplicate, already present).
 */
export function ingestLine(
  workspaceName: string,
  sessionId: string,
  rawLine: string,
): IngestResult {
  const d = openDbOrThrow();
  const s = getStmts(d);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawLine) as Record<string, unknown>;
  } catch {
    // Malformed line — skip silently. JSONL writers occasionally produce
    // partial lines mid-write; the watcher will re-read on the next change.
    return { inserted: false, sessionId, type: 'malformed' };
  }

  const type = String(parsed.type ?? 'unknown');
  const subtype = typeof parsed.subtype === 'string' ? parsed.subtype : null;
  const uuid = typeof parsed.uuid === 'string' ? parsed.uuid : null;
  const parentUuid = typeof parsed.parentUuid === 'string' ? parsed.parentUuid : null;
  const ts = parseTimestamp(parsed.timestamp);
  const dedupKey = uuid ?? hashLine(rawLine);

  // Token usage + model (assistant events only).
  const message = (parsed.message ?? null) as Record<string, unknown> | null;
  const usage = (message?.usage ?? null) as Record<string, unknown> | null;
  const model = typeof message?.model === 'string' ? message.model : null;
  const inputTokens = numOrNull(usage?.input_tokens);
  const outputTokens = numOrNull(usage?.output_tokens);
  const cacheReadInputTokens = numOrNull(usage?.cache_read_input_tokens);
  const cacheCreationInputTokens = numOrNull(usage?.cache_creation_input_tokens);
  const serviceTier = typeof usage?.service_tier === 'string' ? usage.service_tier : null;

  // First tool name in the event's content[] (assistant or user/tool_result events).
  const toolName = extractFirstToolName(message);

  const info = s.insertEvent.run({
    session_id: sessionId,
    workspace_name: workspaceName,
    ts,
    type,
    subtype,
    uuid,
    parent_uuid: parentUuid,
    model,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_input_tokens: cacheReadInputTokens,
    cache_creation_input_tokens: cacheCreationInputTokens,
    service_tier: serviceTier,
    tool_name: toolName,
    raw_jsonl: rawLine,
    dedup_key: dedupKey,
  });

  // Touch the sessions row for every event with a known ts so last_active_at
  // tracks reality; events without ts (light events) get the upsert too but
  // contribute NULL.
  s.upsertSession.run({ id: sessionId, workspace_name: workspaceName, ts });

  // Derive per-event metadata into the sessions row.
  if (type === 'system' && typeof parsed.cwd === 'string') {
    s.updateSessionCwd.run(parsed.cwd, sessionId);
  } else if (type === 'ai-title' && typeof parsed.aiTitle === 'string') {
    s.updateSessionAiTitle.run(parsed.aiTitle, sessionId);
  } else if (type === 'last-prompt' && typeof parsed.lastPrompt === 'string') {
    s.updateSessionLastPrompt.run(parsed.lastPrompt, sessionId);
  } else if (type === 'user' && typeof message?.content === 'string') {
    s.updateSessionLastPrompt.run(message.content, sessionId);
  }

  return { inserted: info.changes > 0, sessionId, type };
}

// ── Queries ───────────────────────────────────────────────────────────────

export interface EventRow {
  id: number;
  sessionId: string;
  workspaceName: string;
  ts: number | null;
  type: string;
  subtype: string | null;
  uuid: string | null;
  parentUuid: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  serviceTier: string | null;
  toolName: string | null;
  rawJsonl: string;
}

interface EventRowSql {
  id: number;
  session_id: string;
  workspace_name: string;
  ts: number | null;
  type: string;
  subtype: string | null;
  uuid: string | null;
  parent_uuid: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  service_tier: string | null;
  tool_name: string | null;
  raw_jsonl: string;
}

function rowFromSql(r: EventRowSql): EventRow {
  return {
    id: r.id,
    sessionId: r.session_id,
    workspaceName: r.workspace_name,
    ts: r.ts,
    type: r.type,
    subtype: r.subtype,
    uuid: r.uuid,
    parentUuid: r.parent_uuid,
    model: r.model,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheReadInputTokens: r.cache_read_input_tokens,
    cacheCreationInputTokens: r.cache_creation_input_tokens,
    serviceTier: r.service_tier,
    toolName: r.tool_name,
    rawJsonl: r.raw_jsonl,
  };
}

export function eventsForSession(sessionId: string, sinceEventId = 0, limit = 500): EventRow[] {
  const d = openDbOrThrow();
  const rows = d
    .prepare(`
      SELECT * FROM events
      WHERE session_id = ? AND id > ?
      ORDER BY id ASC
      LIMIT ?
    `)
    .all(sessionId, sinceEventId, limit) as EventRowSql[];
  return rows.map(rowFromSql);
}

export interface SessionRow {
  id: string;
  workspaceName: string;
  cwd: string | null;
  startedAt: number | null;
  lastActiveAt: number | null;
  aiTitle: string | null;
  firstUserMessage: string | null;
  userSetName: string | null;
}

interface SessionRowSql {
  id: string;
  workspace_name: string;
  cwd: string | null;
  started_at: number | null;
  last_active_at: number | null;
  ai_title: string | null;
  first_user_message: string | null;
  user_set_name: string | null;
}

export function getSession(id: string): SessionRow | null {
  const d = openDbOrThrow();
  const row = d.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as SessionRowSql | undefined;
  if (!row) return null;
  return {
    id: row.id,
    workspaceName: row.workspace_name,
    cwd: row.cwd,
    startedAt: row.started_at,
    lastActiveAt: row.last_active_at,
    aiTitle: row.ai_title,
    firstUserMessage: row.first_user_message,
    userSetName: row.user_set_name,
  };
}

// ── Workspace summary ─────────────────────────────────────────────────────

export interface ToolCallCount {
  name: string;
  count: number;
}

export interface WorkspaceSummary {
  /** Latest active Claude session UUID in the workspace, or null if none. */
  sessionId: string | null;
  /** Display title — from `ai-title.aiTitle` if present, else the session's first user message head. */
  title: string | null;
  /** Latest assistant.message.model seen in this session. */
  model: string | null;
  startedAt: number | null;
  lastActiveAt: number | null;
  /** Row count for this session in `events`. */
  eventCount: number;
  /** Per-session token sums (assistant events only). */
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  /** Top tools called in this session, descending count. */
  topTools: ToolCallCount[];
}

/**
 * Single-shot query for the renderer's right-rail pane: pick the
 * most-recently-active session in this workspace, then assemble its
 * token totals + top tools + metadata. Returns null when the workspace
 * has no JSONL events at all yet.
 */
export function summaryForWorkspace(workspaceName: string, topToolsLimit = 5): WorkspaceSummary | null {
  const d = openDbOrThrow();
  const session = d
    .prepare(`
      SELECT id, ai_title, first_user_message, started_at, last_active_at
      FROM sessions
      WHERE workspace_name = ?
      ORDER BY COALESCE(last_active_at, 0) DESC
      LIMIT 1
    `)
    .get(workspaceName) as
    | {
        id: string;
        ai_title: string | null;
        first_user_message: string | null;
        started_at: number | null;
        last_active_at: number | null;
      }
    | undefined;
  if (!session) return null;

  const aggregates = d
    .prepare(`
      SELECT
        COUNT(*)                                                   AS event_count,
        COALESCE(SUM(input_tokens), 0)                             AS input_tokens,
        COALESCE(SUM(output_tokens), 0)                            AS output_tokens,
        COALESCE(SUM(cache_read_input_tokens), 0)                  AS cache_read_input_tokens,
        COALESCE(SUM(cache_creation_input_tokens), 0)              AS cache_creation_input_tokens
      FROM events
      WHERE session_id = ?
    `)
    .get(session.id) as {
    event_count: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };

  const latestModel = d
    .prepare(`
      SELECT model FROM events
      WHERE session_id = ? AND type = 'assistant' AND model IS NOT NULL
      ORDER BY id DESC LIMIT 1
    `)
    .get(session.id) as { model: string } | undefined;

  const topTools = d
    .prepare(`
      SELECT tool_name AS name, COUNT(*) AS count
      FROM events
      WHERE session_id = ? AND tool_name IS NOT NULL
      GROUP BY tool_name
      ORDER BY count DESC
      LIMIT ?
    `)
    .all(session.id, topToolsLimit) as ToolCallCount[];

  return {
    sessionId: session.id,
    title:
      session.ai_title ??
      (session.first_user_message ? session.first_user_message.slice(0, 80) : null),
    model: latestModel?.model ?? null,
    startedAt: session.started_at,
    lastActiveAt: session.last_active_at,
    eventCount: aggregates.event_count,
    inputTokens: aggregates.input_tokens,
    outputTokens: aggregates.output_tokens,
    cacheReadInputTokens: aggregates.cache_read_input_tokens,
    cacheCreationInputTokens: aggregates.cache_creation_input_tokens,
    topTools,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────

function openDbOrThrow(): Database.Database {
  if (!db) throw new Error('db not opened — call openDb(userDataDir) first');
  return db;
}

function parseTimestamp(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function hashLine(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function extractFirstToolName(message: Record<string, unknown> | null): string | null {
  if (!message) return null;
  const content = message.content;
  if (!Array.isArray(content)) return null;
  for (const block of content as Array<Record<string, unknown>>) {
    if (block && block.type === 'tool_use' && typeof block.name === 'string') {
      return block.name;
    }
  }
  return null;
}
