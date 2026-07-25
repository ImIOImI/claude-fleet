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
import { costFor } from './pricing.js';
import { contextWindowFor } from './contextWindow.js';
import { isSyntheticPromptText } from './userPromptText.js';

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
    // The prepared-statement cache is bound to the now-closed handle; drop it
    // so a subsequent openDb() re-prepares against the fresh connection.
    stmts = null;
  }
}

function migrate(d: Database.Database): void {
  const current = (d.pragma('user_version', { simple: true }) as number) ?? 0;
  if (current < 1) {
    d.exec(`
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
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
      CREATE INDEX idx_events_workspace ON events(workspace_id);
      CREATE INDEX idx_events_type ON events(type);

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        cwd TEXT,
        started_at INTEGER,
        last_active_at INTEGER,
        ai_title TEXT,
        first_user_message TEXT,
        user_set_name TEXT
      );
      CREATE INDEX idx_sessions_workspace ON sessions(workspace_id);
    `);
    d.pragma('user_version = 1');
  }
  if (current < 2) {
    // broker_sessions: maps each renderer-owned broker session id (the
    // stable per-tab uid in sessions.json) to the claude-generated
    // session UUID claude writes its JSONL under. Learned passively by
    // the JsonlWatcher's onNewSession hook + a pending-attach map kept
    // in docker.ts — see §11 "Per-tab mapping" in docs/SPEC.md.
    // Persisted because mappings need to survive app restarts: when the
    // broker still has the claude alive across restart, no new JSONL
    // appears for us to re-learn from.
    d.exec(`
      CREATE TABLE broker_sessions (
        workspace_id TEXT NOT NULL,
        broker_session_id TEXT NOT NULL,
        claude_session_id TEXT NOT NULL,
        learned_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, broker_session_id)
      );
      CREATE INDEX idx_broker_sessions_claude ON broker_sessions(claude_session_id);
    `);
    d.pragma('user_version = 2');
  }
  if (current < 3) {
    // Workspace identity moved from mutable name → immutable ULID id
    // (workspace-modal redesign, Foundation PR). Pre-existing rows refer
    // to workspaces by name which no longer matches anything in the new
    // state-dir layout, so we cut history rather than carry stale
    // foreign keys. Matches the "clean slate" migration documented in
    // docs/design/workspace-modal.md.
    d.exec(`
      DROP TABLE IF EXISTS events;
      DROP TABLE IF EXISTS sessions;
      DROP TABLE IF EXISTS broker_sessions;

      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
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
      CREATE INDEX idx_events_workspace ON events(workspace_id);
      CREATE INDEX idx_events_type ON events(type);

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        cwd TEXT,
        started_at INTEGER,
        last_active_at INTEGER,
        ai_title TEXT,
        first_user_message TEXT,
        user_set_name TEXT
      );
      CREATE INDEX idx_sessions_workspace ON sessions(workspace_id);

      CREATE TABLE broker_sessions (
        workspace_id TEXT NOT NULL,
        broker_session_id TEXT NOT NULL,
        claude_session_id TEXT NOT NULL,
        learned_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, broker_session_id)
      );
      CREATE INDEX idx_broker_sessions_claude ON broker_sessions(claude_session_id);
    `);
    d.pragma('user_version = 3');
  }
  if (current < 4) {
    // Tool-call detail (Phase B observability): tool_use_id links a
    // tool_use event to its tool_result so we can compute call duration;
    // tool_input is a short arg summary; tool_result_is_error is 1/0 on the
    // result event. Additive ALTER (not a clean-slate) so existing token /
    // cost history survives — tool detail populates as new calls land.
    d.exec(`
      ALTER TABLE events ADD COLUMN tool_use_id TEXT;
      ALTER TABLE events ADD COLUMN tool_input TEXT;
      ALTER TABLE events ADD COLUMN tool_result_is_error INTEGER;
      CREATE INDEX idx_events_tool_use ON events(session_id, tool_use_id);
    `);
    d.pragma('user_version = 4');
  }
  if ((d.pragma('user_version', { simple: true }) as number) < 5) {
    d.exec(`
      CREATE TABLE errors (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        ts           INTEGER NOT NULL,
        workspace_id TEXT,
        session_id   TEXT,
        source       TEXT NOT NULL,
        level        TEXT NOT NULL,
        type         TEXT NOT NULL,
        message      TEXT NOT NULL,
        stack        TEXT,
        extra        TEXT
      );
      CREATE INDEX idx_errors_workspace_ts ON errors(workspace_id, ts);
      CREATE INDEX idx_errors_session ON errors(session_id);
    `);
    d.pragma('user_version = 5');
  }
  if ((d.pragma('user_version', { simple: true }) as number) < 6) {
    // Semantic transcript search (rebuildable from JSONL — additive).
    d.exec(`
      CREATE TABLE embeddings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL,
        session_id   TEXT NOT NULL,
        kind         TEXT NOT NULL,          -- 'turn' | 'summary'
        ref_event_id INTEGER,
        ts           INTEGER,
        text         TEXT NOT NULL,
        model_id     TEXT NOT NULL,
        dim          INTEGER NOT NULL,
        vec          BLOB NOT NULL,
        dedup_key    TEXT NOT NULL,
        UNIQUE(session_id, kind, dedup_key)
      );
      CREATE INDEX idx_emb_workspace ON embeddings(workspace_id);
      CREATE INDEX idx_emb_session   ON embeddings(session_id);
      CREATE INDEX idx_emb_ref_event ON embeddings(ref_event_id);

      CREATE TABLE session_summaries (
        session_id          TEXT PRIMARY KEY,
        workspace_id        TEXT NOT NULL,
        summary             TEXT NOT NULL,
        source_max_event_id INTEGER NOT NULL,
        model               TEXT,
        generated_at        INTEGER NOT NULL
      );
    `);
    d.pragma('user_version = 6');
  }
  if ((d.pragma('user_version', { simple: true }) as number) < 7) {
    // Verified resume mappings (#195 follow-up). Rows minted by the pre-#198
    // FIFO guess are indistinguishable from facts, and a tab Refresh that
    // trusts one resumes the WRONG conversation. New learns are deterministic
    // (host-assigned --session-id / explicit --resume) and marked verified=1;
    // every pre-existing row stays verified=0 — still fine for observability
    // attribution, but never again a resume target.
    d.exec(`ALTER TABLE broker_sessions ADD COLUMN verified INTEGER NOT NULL DEFAULT 0`);
    d.pragma('user_version = 7');
  }
  if ((d.pragma('user_version', { simple: true }) as number) < 8) {
    // Phase 2 (#207): chaptered summaries + tags + value-signal collection.
    // session_summaries becomes append-only chapters (one per summarized
    // window); a wandering multi-day session gets topical chapters instead
    // of one over-generalized replaced blurb. Old rows migrate as chapters.
    d.exec(`
      CREATE TABLE session_summaries_v8 (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id          TEXT NOT NULL,
        workspace_id        TEXT NOT NULL,
        summary             TEXT NOT NULL,
        tags                TEXT,
        source_max_event_id INTEGER NOT NULL,
        from_ts             INTEGER,
        to_ts               INTEGER,
        model               TEXT,
        generated_at        INTEGER NOT NULL,
        UNIQUE(session_id, source_max_event_id)
      );
      INSERT INTO session_summaries_v8
        (session_id, workspace_id, summary, source_max_event_id, model, generated_at)
        SELECT session_id, workspace_id, summary, source_max_event_id, model, generated_at
        FROM session_summaries;
      DROP TABLE session_summaries;
      ALTER TABLE session_summaries_v8 RENAME TO session_summaries;
      CREATE INDEX idx_session_summaries_session ON session_summaries(session_id, generated_at);

      CREATE TABLE session_tags (
        workspace_id TEXT NOT NULL,
        session_id   TEXT NOT NULL,
        tag          TEXT NOT NULL,
        PRIMARY KEY (session_id, tag)
      );
      CREATE INDEX idx_session_tags_workspace ON session_tags(workspace_id, tag);

      CREATE TABLE usage_events (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        ts           INTEGER NOT NULL,
        workspace_id TEXT NOT NULL,
        session_id   TEXT,
        kind         TEXT NOT NULL,
        detail       TEXT
      );
      CREATE INDEX idx_usage_events_session ON usage_events(session_id, kind);
      CREATE INDEX idx_usage_events_workspace_ts ON usage_events(workspace_id, ts);
    `);
    d.pragma('user_version = 8');
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
      session_id, workspace_id, ts, type, subtype, uuid, parent_uuid,
      model, input_tokens, output_tokens,
      cache_read_input_tokens, cache_creation_input_tokens,
      service_tier, tool_name, tool_use_id, tool_input, tool_result_is_error,
      raw_jsonl, dedup_key
    ) VALUES (
      @session_id, @workspace_id, @ts, @type, @subtype, @uuid, @parent_uuid,
      @model, @input_tokens, @output_tokens,
      @cache_read_input_tokens, @cache_creation_input_tokens,
      @service_tier, @tool_name, @tool_use_id, @tool_input, @tool_result_is_error,
      @raw_jsonl, @dedup_key
    )
  `);

const upsertSession = (d: Database.Database) =>
  d.prepare(`
    INSERT INTO sessions (id, workspace_id, started_at, last_active_at)
    VALUES (@id, @workspace_id, @ts, @ts)
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

const insertSessionChapter = (d: Database.Database) =>
  d.prepare(`
    INSERT OR IGNORE INTO session_summaries
      (session_id, workspace_id, summary, tags, source_max_event_id, from_ts, to_ts, model, generated_at)
    VALUES (@session_id, @workspace_id, @summary, @tags, @source_max_event_id, @from_ts, @to_ts, @model, @generated_at)
  `);
const insertSessionTag = (d: Database.Database) =>
  d.prepare(`INSERT OR IGNORE INTO session_tags (workspace_id, session_id, tag) VALUES (?, ?, ?)`);

interface Cache {
  insertEvent: ReturnType<typeof insertEvent>;
  upsertSession: ReturnType<typeof upsertSession>;
  updateSessionCwd: ReturnType<typeof updateSessionCwd>;
  updateSessionAiTitle: ReturnType<typeof updateSessionAiTitle>;
  updateSessionLastPrompt: ReturnType<typeof updateSessionLastPrompt>;
  insertSessionChapter: ReturnType<typeof insertSessionChapter>;
  insertSessionTag: ReturnType<typeof insertSessionTag>;
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
      insertSessionChapter: insertSessionChapter(d),
      insertSessionTag: insertSessionTag(d),
    };
  }
  return stmts;
}

/**
 * Ingest a single JSONL line. Caller passes `workspaceId` and `sessionId`
 * (both derived from the file path on disk — JSONL light events sometimes
 * omit sessionId, so the path is authoritative). The line is parsed,
 * extracts pulled out for fast access, the raw line stored verbatim, and the
 * sessions table updated with any derived metadata.
 *
 * Returns whether the row was inserted (false = duplicate, already present).
 */
export function ingestLine(
  workspaceId: string,
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

  // Tool detail from the event's content[]: a tool_use carries name + id +
  // input; a tool_result carries the matching tool_use_id + error flag.
  const tool = extractToolDetail(message);

  const info = s.insertEvent.run({
    session_id: sessionId,
    workspace_id: workspaceId,
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
    tool_name: tool.name,
    tool_use_id: tool.useId,
    tool_input: tool.input,
    tool_result_is_error: tool.resultIsError,
    raw_jsonl: rawLine,
    dedup_key: dedupKey,
  });

  // Touch the sessions row for every event with a known ts so last_active_at
  // tracks reality; events without ts (light events) get the upsert too but
  // contribute NULL.
  s.upsertSession.run({ id: sessionId, workspace_id: workspaceId, ts });

  // Derive per-event metadata into the sessions row.
  if (type === 'system' && typeof parsed.cwd === 'string') {
    s.updateSessionCwd.run(parsed.cwd, sessionId);
  } else if (type === 'ai-title' && typeof parsed.aiTitle === 'string') {
    s.updateSessionAiTitle.run(parsed.aiTitle, sessionId);
  } else if (
    type === 'last-prompt' &&
    typeof parsed.lastPrompt === 'string' &&
    !isSyntheticPromptText(parsed.lastPrompt)
  ) {
    s.updateSessionLastPrompt.run(parsed.lastPrompt, sessionId);
  } else if (
    type === 'user' &&
    typeof message?.content === 'string' &&
    !isSyntheticPromptText(message.content)
  ) {
    s.updateSessionLastPrompt.run(message.content, sessionId);
  } else if (type === 'session-summary' && typeof parsed.summary === 'string') {
    const toEpoch = (v: unknown): number | null => {
      const t = typeof v === 'string' ? Date.parse(v) : NaN;
      return Number.isFinite(t) ? t : null;
    };
    s.insertSessionChapter.run({
      session_id: sessionId,
      workspace_id: workspaceId,
      summary: parsed.summary,
      tags: Array.isArray(parsed.tags) ? JSON.stringify(parsed.tags) : null,
      source_max_event_id: maxEventId(sessionId),
      from_ts: toEpoch(parsed.fromEventTs),
      to_ts: toEpoch(parsed.toEventTs),
      model: typeof parsed.model === 'string' ? parsed.model : null,
      generated_at: ts ?? Date.now(),
    });
    if (Array.isArray(parsed.tags)) {
      for (const tag of parsed.tags) {
        if (typeof tag === 'string' && tag.trim()) s.insertSessionTag.run(workspaceId, sessionId, tag.trim().toLowerCase());
      }
    }
  }

  return { inserted: info.changes > 0, sessionId, type };
}

// ── Queries ───────────────────────────────────────────────────────────────

export interface EventRow {
  id: number;
  sessionId: string;
  workspaceId: string;
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
  workspace_id: string;
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
    workspaceId: r.workspace_id,
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
  workspaceId: string;
  cwd: string | null;
  startedAt: number | null;
  lastActiveAt: number | null;
  aiTitle: string | null;
  firstUserMessage: string | null;
  userSetName: string | null;
}

interface SessionRowSql {
  id: string;
  workspace_id: string;
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
    workspaceId: row.workspace_id,
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

export interface ToolCall {
  name: string;
  /** Short input summary (command / path / pattern / …), or null. */
  input: string | null;
  /** tool_use→tool_result wall time in ms; null while still pending. */
  durationMs: number | null;
  /** 'ok' / 'error' once the result lands, 'pending' until then. */
  status: 'ok' | 'error' | 'pending';
  ts: number | null;
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
  /** Total USD across all events in the session — see `getCost`. */
  usd: number;
  /**
   * Context-window fullness proxy: the latest assistant event's
   * `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`.
   * Represents how much of the model's context window the most recent
   * turn used. Pair with `contextWindowTokens` for the displayed
   * percentage. Null when no assistant event has been seen yet.
   */
  lastTurnContextTokens: number | null;
  /**
   * Effective context window for this session in tokens — 200K for stock
   * Claude 4.x, 1M when the model id carries the `[1m]` marker OR when
   * any observed turn already exceeded 200K (the 1M beta is request-time
   * and doesn't always show up in the model string). The renderer
   * divides `lastTurnContextTokens` by this to position the
   * terminal-pane context-bar fill.
   */
  contextWindowTokens: number;
  /** Top tools called in this session, descending count. */
  topTools: ToolCallCount[];
  /** Recent tool calls with input/duration/status, newest first. */
  recentToolCalls: ToolCall[];
  /** Per-turn USD cost over recent turns, oldest→newest (sparkline series). */
  costSeries: number[];
  /** Per-turn total tokens over recent turns, oldest→newest — the cost
   *  sparkline's sibling, shown when the rail's graph is toggled to tokens. */
  tokenSeries: number[];
}

/**
 * Single-shot query for the renderer's right-rail pane: pick the
 * most-recently-active session in this workspace, then assemble its
 * token totals + top tools + metadata. Returns null when the workspace
 * has no JSONL events at all yet.
 */
export function summaryForWorkspace(workspaceId: string, topToolsLimit = 5): WorkspaceSummary | null {
  const d = openDbOrThrow();
  const latest = d
    .prepare(`
      SELECT id
      FROM sessions
      WHERE workspace_id = ?
      ORDER BY COALESCE(last_active_at, 0) DESC
      LIMIT 1
    `)
    .get(workspaceId) as { id: string } | undefined;
  if (!latest) return null;
  return summaryForSession(latest.id, topToolsLimit);
}

/**
 * Total tokens spent across the **whole fleet** within a trailing time window —
 * the numerator for the observability rail's plan-usage bar. Sums every token
 * type (input + output + cache create + cache read), since Anthropic's rolling
 * subscription limit meters against all of them. `sinceMs` is an absolute epoch
 * floor in ms (the caller passes `Date.now() - windowMs`); as the oldest events
 * age past it they drop out of the sum, mirroring the real rolling reset.
 */
export function tokensSpentSince(sinceMs: number): number {
  const d = openDbOrThrow();
  const row = d
    .prepare(`
      SELECT COALESCE(SUM(
        COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) +
        COALESCE(cache_read_input_tokens, 0) + COALESCE(cache_creation_input_tokens, 0)
      ), 0) AS total
      FROM events
      WHERE ts IS NOT NULL AND ts >= ?
    `)
    .get(sinceMs) as { total: number };
  return row.total;
}

/**
 * Same shape as `summaryForWorkspace`, but scoped to one specific claude
 * session UUID — the per-tab endpoint reaches here via
 * `summaryForBrokerSession` after resolving the broker→claude mapping.
 * Returns null when the session id has no rows in `sessions` (mapping
 * stale, claude exited and the user wiped state, etc.).
 */
export function summaryForSession(sessionId: string, topToolsLimit = 5): WorkspaceSummary | null {
  const d = openDbOrThrow();
  const session = d
    .prepare(`
      SELECT id, ai_title, first_user_message, started_at, last_active_at
      FROM sessions
      WHERE id = ?
    `)
    .get(sessionId) as
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

  // Latest assistant event drives both the displayed model and the
  // context-window fullness proxy. Pull both in a single query — the
  // index on (session_id, id DESC) lets sqlite jump straight to the
  // tail without scanning.
  const latestAssistant = d
    .prepare(`
      SELECT model,
             COALESCE(input_tokens, 0)                AS input_tokens,
             COALESCE(cache_read_input_tokens, 0)     AS cache_read_input_tokens,
             COALESCE(cache_creation_input_tokens, 0) AS cache_creation_input_tokens
      FROM events
      WHERE session_id = ? AND type = 'assistant' AND model IS NOT NULL
      ORDER BY id DESC LIMIT 1
    `)
    .get(session.id) as
    | {
        model: string;
        input_tokens: number;
        cache_read_input_tokens: number;
        cache_creation_input_tokens: number;
      }
    | undefined;
  const lastTurnContextTokens = latestAssistant
    ? latestAssistant.input_tokens +
      latestAssistant.cache_read_input_tokens +
      latestAssistant.cache_creation_input_tokens
    : null;

  // Observed-max context tokens across all assistant events in the
  // session. Drives the 1M auto-upgrade in contextWindowFor when the
  // session's running on the 1M beta header (which doesn't show up in
  // the model string Claude Code writes to JSONL).
  const observedMax = d
    .prepare(`
      SELECT COALESCE(MAX(
        COALESCE(input_tokens, 0)
        + COALESCE(cache_read_input_tokens, 0)
        + COALESCE(cache_creation_input_tokens, 0)
      ), 0) AS max_context_tokens
      FROM events
      WHERE session_id = ? AND type = 'assistant'
    `)
    .get(session.id) as { max_context_tokens: number };
  const contextWindowTokens = contextWindowFor(
    latestAssistant?.model ?? null,
    observedMax.max_context_tokens,
  );

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

  const cost = costForSession(session.id);

  return {
    sessionId: session.id,
    title:
      session.ai_title ??
      (session.first_user_message ? session.first_user_message.slice(0, 80) : null),
    model: latestAssistant?.model ?? null,
    startedAt: session.started_at,
    lastActiveAt: session.last_active_at,
    eventCount: aggregates.event_count,
    inputTokens: aggregates.input_tokens,
    outputTokens: aggregates.output_tokens,
    cacheReadInputTokens: aggregates.cache_read_input_tokens,
    cacheCreationInputTokens: aggregates.cache_creation_input_tokens,
    usd: cost.usd,
    lastTurnContextTokens,
    contextWindowTokens,
    topTools,
    recentToolCalls: recentToolCallsForSession(session.id, 10),
    costSeries: costSeriesForSession(session.id),
    tokenSeries: tokenSeriesForSession(session.id),
  };
}

/**
 * Recent tool calls in a session, newest first. Each tool_use is matched to
 * its tool_result by tool_use_id (within the session) to derive duration and
 * ok/error status; calls still awaiting a result come back 'pending'.
 */
export function recentToolCallsForSession(sessionId: string, limit = 10): ToolCall[] {
  const d = openDbOrThrow();
  const rows = d
    .prepare(`
      SELECT u.tool_name AS name,
             u.tool_input AS input,
             u.ts         AS start_ts,
             r.ts         AS end_ts,
             r.tool_result_is_error AS is_error
      FROM events u
      LEFT JOIN events r
        ON r.session_id = u.session_id
       AND r.tool_use_id = u.tool_use_id
       AND r.tool_result_is_error IS NOT NULL
      WHERE u.session_id = ? AND u.tool_name IS NOT NULL AND u.tool_use_id IS NOT NULL
      ORDER BY u.id DESC
      LIMIT ?
    `)
    .all(sessionId, limit) as Array<{
    name: string;
    input: string | null;
    start_ts: number | null;
    end_ts: number | null;
    is_error: number | null;
  }>;
  return rows.map((r) => ({
    name: r.name,
    input: r.input,
    durationMs: r.start_ts != null && r.end_ts != null ? r.end_ts - r.start_ts : null,
    status: r.is_error == null ? 'pending' : r.is_error ? 'error' : 'ok',
    ts: r.start_ts,
  }));
}

/**
 * Per-turn USD cost over the last `limit` assistant turns, oldest→newest —
 * the series a cost sparkline plots. Each assistant event with usage is one
 * turn; cost is computed per row so mixed models/tiers price correctly.
 */
export function costSeriesForSession(sessionId: string, limit = 20): number[] {
  const d = openDbOrThrow();
  const rows = d
    .prepare(`
      SELECT model, service_tier,
             COALESCE(input_tokens, 0)                AS input_tokens,
             COALESCE(output_tokens, 0)               AS output_tokens,
             COALESCE(cache_read_input_tokens, 0)     AS cache_read_input_tokens,
             COALESCE(cache_creation_input_tokens, 0) AS cache_creation_input_tokens
      FROM events
      WHERE session_id = ? AND type = 'assistant' AND output_tokens IS NOT NULL
      ORDER BY id DESC
      LIMIT ?
    `)
    .all(sessionId, limit) as Array<{
    model: string | null;
    service_tier: string | null;
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  }>;
  return rows
    .reverse()
    .map((r) =>
      costFor(r.model, r.service_tier, {
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        cacheReadInputTokens: r.cache_read_input_tokens,
        cacheCreationInputTokens: r.cache_creation_input_tokens,
      }),
    );
}

/**
 * Per-turn total tokens (input + output + cache create + cache read) over the
 * last `limit` assistant turns, oldest→newest — the sibling of
 * `costSeriesForSession` that the observability sparkline plots when toggled
 * from cost to tokens. Same per-turn definition (one assistant event with
 * usage = one turn), so the two graphs line up bar-for-bar.
 */
export function tokenSeriesForSession(sessionId: string, limit = 20): number[] {
  const d = openDbOrThrow();
  const rows = d
    .prepare(`
      SELECT COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)
           + COALESCE(cache_read_input_tokens, 0) + COALESCE(cache_creation_input_tokens, 0) AS total
      FROM events
      WHERE session_id = ? AND type = 'assistant' AND output_tokens IS NOT NULL
      ORDER BY id DESC
      LIMIT ?
    `)
    .all(sessionId, limit) as Array<{ total: number }>;
  return rows.reverse().map((r) => r.total);
}

// ── broker_sessions: per-tab mapping ──────────────────────────────────────
//
// Each terminal tab carries a renderer-owned `broker_session_id` (the
// uid from sessions.json the broker uses as its session map key). When
// the broker spawns claude for that tab, claude writes its JSONL under
// a different UUID — the `claude_session_id`. We learn the mapping
// once per tab (see the JsonlWatcher's onNewSession hook in ipc.ts)
// and persist it so it survives app restart.

/** Append-only value signal (#207). Scores are derived at read time (Phase 3). */
export function recordUsageEvent(e: {
  workspaceId: string;
  sessionId?: string | null;
  kind: 'search-impression' | 'clickthrough' | 'marked-useful' | 'resumed';
  detail?: Record<string, unknown>;
}): void {
  const d = openDbOrThrow();
  d.prepare(`INSERT INTO usage_events (ts, workspace_id, session_id, kind, detail) VALUES (?, ?, ?, ?, ?)`)
    .run(Date.now(), e.workspaceId, e.sessionId ?? null, e.kind, e.detail ? JSON.stringify(e.detail) : null);
}

/** Persist a (workspace, broker_session) → claude_session mapping.
 *  Returns the claude_session_id that was previously stored for this broker
 *  session (null on first learn) so callers can log a remap — an overwrite
 *  with a DIFFERENT claude id is the #195 cross-wiring event and must never
 *  happen silently. */
export function learnBrokerSessionMapping(
  workspaceId: string,
  brokerSessionId: string,
  claudeSessionId: string,
): string | null {
  const d = openDbOrThrow();
  const previous = (d.prepare(`
    SELECT claude_session_id FROM broker_sessions
    WHERE workspace_id = ? AND broker_session_id = ?
  `).get(workspaceId, brokerSessionId) as { claude_session_id: string } | undefined)
    ?.claude_session_id ?? null;
  d.prepare(`
    INSERT INTO broker_sessions (workspace_id, broker_session_id, claude_session_id, learned_at, verified)
    VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(workspace_id, broker_session_id) DO UPDATE SET
      claude_session_id = excluded.claude_session_id,
      learned_at = excluded.learned_at,
      verified = 1
  `).run(workspaceId, brokerSessionId, claudeSessionId, Date.now());
  return previous;
}

/** Resume-grade lookup: returns the claude session id only when the mapping
 *  was learned deterministically (verified=1). Pre-#198 rows were FIFO
 *  guesses — good enough to attribute cost/summaries, never good enough to
 *  `claude --resume` from: resuming a guess silently swaps the tab onto a
 *  different conversation (#195). */
export function lookupVerifiedBrokerSession(
  workspaceId: string,
  brokerSessionId: string,
): string | null {
  const d = openDbOrThrow();
  const row = d.prepare(`
    SELECT claude_session_id FROM broker_sessions
    WHERE workspace_id = ? AND broker_session_id = ? AND verified = 1
  `).get(workspaceId, brokerSessionId) as { claude_session_id: string } | undefined;
  return row?.claude_session_id ?? null;
}

/** Look up the claude_session_id for a broker session, or null if unmapped. */
export function lookupBrokerSession(
  workspaceId: string,
  brokerSessionId: string,
): string | null {
  const d = openDbOrThrow();
  const row = d.prepare(`
    SELECT claude_session_id FROM broker_sessions
    WHERE workspace_id = ? AND broker_session_id = ?
  `).get(workspaceId, brokerSessionId) as { claude_session_id: string } | undefined;
  return row?.claude_session_id ?? null;
}

/**
 * Per-tab summary. Resolves the broker→claude mapping and returns that
 * session's summary, or null when no mapping is known.
 *
 * **No workspace fallback here.** A brand-new tab the user just opened
 * carries an unmapped broker session id but legitimately has no data;
 * returning the workspace's most-recently-active session in that case
 * surfaces the *previous* tab's numbers — confusing ("why does my new
 * tab already show 4K tokens?"). Renderer decides when to apply a
 * workspace fallback: tabs loaded from `sessions.json` get one (best
 * guess for tabs that pre-date this table or were skipped by the
 * concurrent-attach disambiguator); freshly-added tabs do not.
 */
export function summaryForBrokerSession(
  workspaceId: string,
  brokerSessionId: string,
  topToolsLimit = 5,
): WorkspaceSummary | null {
  const claudeId = lookupBrokerSession(workspaceId, brokerSessionId);
  if (!claudeId) return null;
  return summaryForSession(claudeId, topToolsLimit);
}

// ── Cost rollup ───────────────────────────────────────────────────────────
//
// Pricing varies by model and service_tier, so we can't just sum tokens once
// and multiply — different events within a session may use different models.
// Group by (model, service_tier), let pricing.ts compute USD per group,
// then sum.

export interface SessionCost {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  usd: number;
}

interface CostGroupRow {
  model: string | null;
  service_tier: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

const COST_COLUMNS = `
  COALESCE(SUM(input_tokens), 0)                AS input_tokens,
  COALESCE(SUM(output_tokens), 0)               AS output_tokens,
  COALESCE(SUM(cache_read_input_tokens), 0)     AS cache_read_input_tokens,
  COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens
`;

function rollupGroups(rows: CostGroupRow[]): SessionCost {
  let usd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadInputTokens = 0;
  let cacheCreationInputTokens = 0;
  for (const r of rows) {
    inputTokens += r.input_tokens;
    outputTokens += r.output_tokens;
    cacheReadInputTokens += r.cache_read_input_tokens;
    cacheCreationInputTokens += r.cache_creation_input_tokens;
    usd += costFor(r.model, r.service_tier, {
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cacheReadInputTokens: r.cache_read_input_tokens,
      cacheCreationInputTokens: r.cache_creation_input_tokens,
    });
  }
  return { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, usd };
}

export function costForSession(sessionId: string): SessionCost {
  const d = openDbOrThrow();
  const rows = d
    .prepare(`
      SELECT model, service_tier, ${COST_COLUMNS}
      FROM events
      WHERE session_id = ?
      GROUP BY model, service_tier
    `)
    .all(sessionId) as CostGroupRow[];
  return rollupGroups(rows);
}

export function costForWorkspace(workspaceId: string): SessionCost {
  const d = openDbOrThrow();
  const rows = d
    .prepare(`
      SELECT model, service_tier, ${COST_COLUMNS}
      FROM events
      WHERE workspace_id = ?
      GROUP BY model, service_tier
    `)
    .all(workspaceId) as CostGroupRow[];
  return rollupGroups(rows);
}

// ── Sessions table ──────────────────────────────────────────────────────
//
// Backs the left-rail Sessions list (#3): every claude session the watcher
// has ever ingested, with derived cost + event count. Workspace-eligibility
// (hiding sessions whose workspace was deleted) is applied in the IPC layer,
// which is the only place that knows about on-disk manifests.

export interface SessionListRow {
  id: string;
  workspaceId: string;
  /** LLM-generated title; dormant until the title hook lands — usually null. */
  aiTitle: string | null;
  /** Head of the first user message — the display title fallback. */
  firstUserMessage: string | null;
  /** Manual rename override; wins over the auto title when set. */
  userSetName: string | null;
  startedAt: number | null;
  lastActiveAt: number | null;
  eventCount: number;
  usd: number;
  /** Tags from the latest tagged summary chapter, in emitted (relevance)
   *  order; [] until the Phase-2 summarizer has produced one. */
  tags: string[];
}

interface SessionListSql {
  id: string;
  workspace_id: string;
  ai_title: string | null;
  first_user_message: string | null;
  user_set_name: string | null;
  started_at: number | null;
  last_active_at: number | null;
}

/**
 * All sessions, newest-active first. Optionally scoped to one workspace.
 * Two queries total regardless of session count: one for session metadata,
 * one grouped pass over `events` for per-session cost + event count (rolled
 * up in JS, since USD is per-(model, service_tier)). No N+1.
 */
export function listSessions(workspaceId?: string): SessionListRow[] {
  const d = openDbOrThrow();
  const sessRows = (
    workspaceId
      ? d
          .prepare(`
            SELECT id, workspace_id, ai_title, first_user_message, user_set_name,
                   started_at, last_active_at
            FROM sessions WHERE workspace_id = ?
            ORDER BY COALESCE(last_active_at, 0) DESC
          `)
          .all(workspaceId)
      : d
          .prepare(`
            SELECT id, workspace_id, ai_title, first_user_message, user_set_name,
                   started_at, last_active_at
            FROM sessions
            ORDER BY COALESCE(last_active_at, 0) DESC
          `)
          .all()
  ) as SessionListSql[];

  const costRows = (
    workspaceId
      ? d
          .prepare(`
            SELECT session_id, model, service_tier, ${COST_COLUMNS}, COUNT(id) AS event_count
            FROM events WHERE workspace_id = ?
            GROUP BY session_id, model, service_tier
          `)
          .all(workspaceId)
      : d
          .prepare(`
            SELECT session_id, model, service_tier, ${COST_COLUMNS}, COUNT(id) AS event_count
            FROM events
            GROUP BY session_id, model, service_tier
          `)
          .all()
  ) as Array<CostGroupRow & { session_id: string; event_count: number }>;

  const byId = new Map<string, { usd: number; eventCount: number }>();
  for (const r of costRows) {
    const agg = byId.get(r.session_id) ?? { usd: 0, eventCount: 0 };
    agg.eventCount += r.event_count;
    agg.usd += costFor(r.model, r.service_tier, {
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cacheReadInputTokens: r.cache_read_input_tokens,
      cacheCreationInputTokens: r.cache_creation_input_tokens,
    });
    byId.set(r.session_id, agg);
  }

  const tagRows = (
    workspaceId
      ? d
          .prepare(`
            SELECT session_id, tags, MAX(id) AS latest
            FROM session_summaries
            WHERE tags IS NOT NULL AND workspace_id = ?
            GROUP BY session_id
          `)
          .all(workspaceId)
      : d
          .prepare(`
            SELECT session_id, tags, MAX(id) AS latest
            FROM session_summaries
            WHERE tags IS NOT NULL
            GROUP BY session_id
          `)
          .all()
  ) as Array<{ session_id: string; tags: string }>;

  const tagsById = new Map<string, string[]>();
  for (const r of tagRows) {
    try {
      const parsed: unknown = JSON.parse(r.tags);
      if (Array.isArray(parsed)) {
        tagsById.set(r.session_id, parsed.filter((t): t is string => typeof t === 'string'));
      }
    } catch {
      /* malformed tags JSON — treat as untagged */
    }
  }

  return sessRows.map((s) => {
    const agg = byId.get(s.id) ?? { usd: 0, eventCount: 0 };
    return {
      id: s.id,
      workspaceId: s.workspace_id,
      aiTitle: s.ai_title,
      firstUserMessage: s.first_user_message,
      userSetName: s.user_set_name,
      startedAt: s.started_at,
      lastActiveAt: s.last_active_at,
      eventCount: agg.eventCount,
      usd: agg.usd,
      tags: tagsById.get(s.id) ?? [],
    };
  });
}

/**
 * Set (or clear) the manual name override for a session. An empty/whitespace
 * name clears it back to NULL so the auto title resurfaces.
 */
export function renameSession(id: string, name: string): void {
  const d = openDbOrThrow();
  const trimmed = name.trim();
  d.prepare(`UPDATE sessions SET user_set_name = ? WHERE id = ?`).run(
    trimmed.length ? trimmed : null,
    id
  );
}

/**
 * Drop a session from the cache entirely: its events, its broker mapping,
 * and the session row. The on-disk JSONL is removed by the caller (IPC
 * layer), which knows the host path. Idempotent.
 */
export function deleteSession(id: string): void {
  const d = openDbOrThrow();
  const tx = d.transaction((sid: string) => {
    d.prepare(`DELETE FROM events WHERE session_id = ?`).run(sid);
    d.prepare(`DELETE FROM broker_sessions WHERE claude_session_id = ?`).run(sid);
    d.prepare(`DELETE FROM sessions WHERE id = ?`).run(sid);
  });
  tx(id);
}

// ── Embeddings ────────────────────────────────────────────────────────────

export interface EmbeddingInsert {
  workspaceId: string;
  sessionId: string;
  kind: 'turn' | 'summary';
  refEventId: number | null;
  ts: number | null;
  text: string;
  modelId: string;
  dim: number;
  vec: Buffer;
  dedupKey: string;
}

/** Drop embedding rows keyed to any OTHER model id. Run before backfill so a
 *  model/dtype change (which re-keys EMBED_MODEL_ID) doesn't leave dead
 *  vectors accumulating under retired keys. Returns rows deleted. */
export function deleteEmbeddingsForOtherModels(modelId: string): number {
  const d = openDbOrThrow();
  return d.prepare('DELETE FROM embeddings WHERE model_id != ?').run(modelId).changes;
}

export function insertEmbedding(row: EmbeddingInsert): boolean {
  const d = openDbOrThrow();
  const info = d
    .prepare(`
      INSERT OR IGNORE INTO embeddings
        (workspace_id, session_id, kind, ref_event_id, ts, text, model_id, dim, vec, dedup_key)
      VALUES (@workspaceId, @sessionId, @kind, @refEventId, @ts, @text, @modelId, @dim, @vec, @dedupKey)
    `)
    .run(row);
  return info.changes > 0;
}

export interface UnembeddedTurn {
  id: number;
  workspaceId: string;
  ts: number | null;
  rawJsonl: string;
}

/** user/assistant events in a session with no 'turn' embedding for `modelId`. */
export function unembeddedTurnEvents(sessionId: string, modelId: string, limit = 200): UnembeddedTurn[] {
  const d = openDbOrThrow();
  const rows = d
    .prepare(`
      SELECT e.id AS id, e.workspace_id AS workspaceId, e.ts AS ts, e.raw_jsonl AS rawJsonl
      FROM events e
      LEFT JOIN embeddings em
        ON em.ref_event_id = e.id AND em.kind = 'turn' AND em.model_id = ?
      WHERE e.session_id = ? AND e.type IN ('user', 'assistant') AND em.id IS NULL
      ORDER BY e.id ASC
      LIMIT ?
    `)
    .all(modelId, sessionId, limit) as UnembeddedTurn[];
  return rows;
}

export function maxEventId(sessionId: string): number {
  const d = openDbOrThrow();
  const row = d.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM events WHERE session_id = ?`).get(sessionId) as { m: number };
  return row.m;
}

export interface PendingSummary {
  sessionId: string;
  workspaceId: string;
  summary: string;
  sourceMaxEventId: number;
  ts: number | null;
}

/** Summaries whose current (session, source_max_event_id) has no embedding. */
export function unembeddedSummaries(modelId: string, limit = 100): PendingSummary[] {
  const d = openDbOrThrow();
  return d
    .prepare(`
      SELECT s.session_id AS sessionId, s.workspace_id AS workspaceId, s.summary AS summary,
             s.source_max_event_id AS sourceMaxEventId, s.generated_at AS ts
      FROM session_summaries s
      LEFT JOIN embeddings em
        ON em.session_id = s.session_id AND em.kind = 'summary'
       AND em.model_id = ? AND em.dedup_key = CAST(s.source_max_event_id AS TEXT)
      WHERE em.id IS NULL
      ORDER BY s.generated_at DESC
      LIMIT ?
    `)
    .all(modelId, limit) as PendingSummary[];
}

// ── Error recording ───────────────────────────────────────────────────────

export const ERRORS_RETENTION = 2000;

export interface ErrorRow {
  ts: number;
  source: string;
  type: string;
  message: string;
  stack?: string;
  extra?: Record<string, unknown>;
  workspaceId?: string;
  sessionId?: string;
  level?: string;
}

export function recordError(row: ErrorRow): void {
  const d = openDbOrThrow();
  // Resolve the claude session UUID: prefer an explicit sessionId; else, if the
  // caller only knew the broker id, best-effort resolve it via the mapping
  // (NULL when unmapped — itself an honest signal).
  let sessionId = row.sessionId ?? null;
  if (!sessionId && row.workspaceId && typeof row.extra?.brokerSessionId === 'string') {
    sessionId = lookupBrokerSession(row.workspaceId, row.extra.brokerSessionId as string);
  }
  d.prepare(`
    INSERT INTO errors (ts, workspace_id, session_id, source, level, type, message, stack, extra)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.ts,
    row.workspaceId ?? null,
    sessionId,
    row.source,
    row.level ?? 'error',
    row.type,
    row.message,
    row.stack ?? null,
    row.extra ? JSON.stringify(row.extra) : null
  );
  d.prepare(`
    DELETE FROM errors WHERE id NOT IN (
      SELECT id FROM errors ORDER BY id DESC LIMIT ?
    )
  `).run(ERRORS_RETENTION);
}

// ── Helpers ───────────────────────────────────────────────────────────────

function openDbOrThrow(): Database.Database {
  if (!db) throw new Error('db not opened — call openDb(userDataDir) first');
  return db;
}

export function getDb(): Database.Database { return openDbOrThrow(); }

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

interface ToolDetail {
  name: string | null;
  useId: string | null;
  input: string | null;
  resultIsError: number | null;
}

/**
 * Pull tool-call detail from an event's `message.content[]`. An assistant
 * event's first `tool_use` block yields the name, its id, and a short input
 * summary; a user event's `tool_result` block yields the matching
 * `tool_use_id` and whether it errored. Events with neither return all-null.
 */
function extractToolDetail(message: Record<string, unknown> | null): ToolDetail {
  const empty: ToolDetail = { name: null, useId: null, input: null, resultIsError: null };
  if (!message) return empty;
  const content = message.content;
  if (!Array.isArray(content)) return empty;
  for (const block of content as Array<Record<string, unknown>>) {
    if (!block) continue;
    if (block.type === 'tool_use' && typeof block.name === 'string') {
      return {
        name: block.name,
        useId: typeof block.id === 'string' ? block.id : null,
        input: summarizeToolInput(block.input),
        resultIsError: null,
      };
    }
    if (block.type === 'tool_result') {
      return {
        name: null,
        useId: typeof block.tool_use_id === 'string' ? block.tool_use_id : null,
        input: null,
        resultIsError: block.is_error === true ? 1 : 0,
      };
    }
  }
  return empty;
}

/**
 * A compact, human-readable one-liner for a tool's input — prefers the most
 * identifying field (command/path/pattern/url/description), else a truncated
 * JSON dump. Capped so it stays a chip-sized label.
 */
function summarizeToolInput(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  const pick =
    (typeof o.command === 'string' && o.command) ||
    (typeof o.file_path === 'string' && o.file_path) ||
    (typeof o.path === 'string' && o.path) ||
    (typeof o.pattern === 'string' && o.pattern) ||
    (typeof o.url === 'string' && o.url) ||
    (typeof o.description === 'string' && o.description) ||
    '';
  const s = pick || JSON.stringify(o);
  return s.length > 160 ? s.slice(0, 159) + '…' : s;
}
