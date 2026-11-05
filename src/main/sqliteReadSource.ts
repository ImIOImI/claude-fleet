// The MCP read path on SQLite (SPEC §11): the server's own read-only
// connection, and the per-call in-memory snapshot that isolates `query`.
import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { searchVectorsSqlite } from './transcriptIndex.js';
import {
  NOT_AUTHORIZED, SNAPSHOT_EVENT_COLS, checkEventColumns, type OwnedReadSource, type Row, type Scope, type TokenGroup,
} from './store/readSource.js';

/** SQL `IN (?,…)` fragment + params for an allowed-workspace set (#122). */
function inClause(col: string, allowed: Scope): { sql: string; params: string[] } {
  const ids = [...allowed];
  if (ids.length === 0) return { sql: '0 = 1', params: [] }; // match nothing (self is always present, so unreachable)
  return { sql: `${col} IN (${ids.map(() => '?').join(',')})`, params: ids };
}

/** Build a throwaway in-memory DB containing ONLY the caller's allowed-workspace
 *  rows, copied from the source DB at `srcPath` (the live state.db). The source
 *  is DETACHed before the caller's SQL ever runs, so isolation is structural:
 *  no subquery/UNION/sqlite_master trick can reach unfiltered rows (#146). The
 *  caller owns the returned DB and must close it. */
function buildSnapshot(srcPath: string, allowed: Scope, includeRaw: boolean): Database.Database {
  const mem = new Database(':memory:');
  try {
    const alias = 'src_' + randomBytes(6).toString('hex');
    const { sql: scope, params } = inClause('workspace_id', allowed);
    // ATTACH filename is not reliably bindable; double any single quote.
    const attached = srcPath.replace(/'/g, "''");
    mem.exec(`ATTACH DATABASE '${attached}' AS ${alias}`);
    try {
      const eventCols = includeRaw ? `${SNAPSHOT_EVENT_COLS}, raw_jsonl` : SNAPSHOT_EVENT_COLS;
      mem.prepare(
        `CREATE TABLE events AS SELECT ${eventCols} FROM ${alias}.events WHERE ${scope}`
      ).run(...params);
      mem.prepare(`CREATE TABLE sessions AS SELECT * FROM ${alias}.sessions WHERE ${scope}`).run(...params);
      mem.prepare(
        `CREATE TABLE broker_sessions AS SELECT * FROM ${alias}.broker_sessions WHERE ${scope}`
      ).run(...params);
      mem.prepare(
        `CREATE TABLE session_summaries AS SELECT * FROM ${alias}.session_summaries WHERE ${scope}`
      ).run(...params);
      mem.prepare(
        `CREATE TABLE session_tags AS SELECT * FROM ${alias}.session_tags WHERE ${scope}`
      ).run(...params);
      mem.prepare(
        `CREATE TABLE usage_events AS SELECT * FROM ${alias}.usage_events WHERE ${scope}`
      ).run(...params);
      // perf_events: app-global rows (workspace_id NULL — stalls, slow ops)
      // are host-process facts visible to every caller; workspace-tagged rows
      // (pty windows, terminal latency) are scoped like everything else.
      try {
        mem.prepare(
          `CREATE TABLE perf_events AS SELECT * FROM ${alias}.perf_events WHERE workspace_id IS NULL OR ${scope}`
        ).run(...params);
      } catch (e) {
        // Pre-v11 DB (no perf_events yet): an empty, correctly-shaped table.
        // Anything else is a real failure and must surface.
        if (!(e instanceof Error && /no such table/i.test(e.message))) throw e;
        mem.exec(`CREATE TABLE perf_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, workspace_id TEXT, session_id TEXT, name TEXT, dur_ms REAL, trace_id TEXT, span_id TEXT, meta TEXT)`);
      }
      try {
        mem.prepare(
          `CREATE TABLE port_exposures AS SELECT * FROM ${alias}.port_exposures WHERE ${scope}`
        ).run(...params);
      } catch (e) {
        // Pre-v15 DB: an empty, correctly-shaped table instead of an error.
        if (!(e instanceof Error && /no such table/i.test(e.message))) throw e;
        mem.exec(
          `CREATE TABLE port_exposures (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, session_id TEXT, ` +
            `port INTEGER NOT NULL, cmdline TEXT, label TEXT, reason TEXT, source TEXT NOT NULL, ` +
            `first_scanned_at INTEGER, declared_at INTEGER, popup_shown_at INTEGER, outcome TEXT, ` +
            `opened_via TEXT, open_count INTEGER NOT NULL DEFAULT 0, ended_at INTEGER)`
        );
      }
    } finally {
      mem.exec(`DETACH ${alias}`);
    }
    return mem;
  } catch (e) {
    mem.close();
    throw e;
  }
}

function tokenGroups(db: Database.Database, sessionId: string): TokenGroup[] {
  return db
    .prepare(
      `SELECT model, service_tier,
              SUM(COALESCE(input_tokens,0)) AS input,
              SUM(COALESCE(output_tokens,0)) AS output,
              SUM(COALESCE(cache_read_input_tokens,0)) AS cacheRead,
              SUM(COALESCE(cache_creation_input_tokens,0)) AS cacheCreate
       FROM events WHERE session_id = ? AND type = 'assistant'
       GROUP BY model, service_tier`
    )
    .all(sessionId) as TokenGroup[];
}

function distinctInputs(db: Database.Database, sessionId: string, names: string[]): string[] {
  const placeholders = names.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT DISTINCT tool_input FROM events
       WHERE session_id = ? AND tool_name IN (${placeholders}) AND tool_input IS NOT NULL
       ORDER BY tool_input`
    )
    .all(sessionId, ...names) as Array<{ tool_input: string }>;
  return rows.map((r) => r.tool_input);
}

function sessionWorkspace(db: Database.Database, scope: Scope, id: string): string | null {
  const row = db.prepare('SELECT workspace_id FROM sessions WHERE id = ?').get(id) as { workspace_id?: unknown } | undefined;
  return typeof row?.workspace_id === 'string' && scope.has(row.workspace_id) ? row.workspace_id : null;
}

function assertInScope(db: Database.Database, scope: Scope, id: string): void {
  if (sessionWorkspace(db, scope, id) === null) throw new Error(NOT_AUTHORIZED);
}

/** `db` is the MCP server's `{ readonly: true }` connection to state.db. */
export function sqliteReadSource(db: Database.Database): OwnedReadSource {
  return {
    queryFlavor: 'sqlite',
    async listSessions(scope, f) {
      const where: string[] = [];
      const p: unknown[] = [];
      if (f.workspaceId !== undefined) { where.push('workspace_id = ?'); p.push(f.workspaceId); }
      if (f.since !== undefined) { where.push('last_active_at >= ?'); p.push(f.since); }
      if (f.until !== undefined) { where.push('last_active_at <= ?'); p.push(f.until); }
      const { sql: scopeSql, params } = inClause('workspace_id', scope);
      where.push(scopeSql);
      p.push(...params);
      const sql = `SELECT * FROM sessions WHERE ${where.join(' AND ')} ORDER BY last_active_at DESC LIMIT ?`;
      return db.prepare(sql).all(...p, f.limit) as Row[];
    },
    async getSession(scope, id) {
      const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Row | undefined;
      return row && typeof row.workspace_id === 'string' && scope.has(row.workspace_id) ? row : null;
    },
    async sessionWorkspace(scope, id) {
      return sessionWorkspace(db, scope, id);
    },
    async tokenGroups(scope, sessionId) {
      assertInScope(db, scope, sessionId);
      return tokenGroups(db, sessionId);
    },
    async listEvents(scope, sessionId, f) {
      checkEventColumns(f.columns);
      assertInScope(db, scope, sessionId);
      const where = ['session_id = ?'];
      const p: unknown[] = [sessionId];
      if (f.type !== undefined) { where.push('type = ?'); p.push(f.type); }
      if (f.toolName !== undefined) { where.push('tool_name = ?'); p.push(f.toolName); }
      if (f.since !== undefined) { where.push('ts >= ?'); p.push(f.since); }
      const sql = `SELECT ${f.columns.join(', ')} FROM events WHERE ${where.join(' AND ')} ORDER BY id ASC LIMIT ?`;
      return db.prepare(sql).all(...p, f.limit) as Row[];
    },
    async summaryParts(scope, sessionId) {
      assertInScope(db, scope, sessionId);
      const span = db
        .prepare(`SELECT MIN(ts) AS started_at, MAX(ts) AS last_active_at FROM events WHERE session_id = ?`)
        .get(sessionId) as { started_at: number | null; last_active_at: number | null };
      return {
        files: distinctInputs(db, sessionId, ['Write', 'Edit', 'NotebookEdit']),
        commands: distinctInputs(db, sessionId, ['Bash']),
        tokens: tokenGroups(db, sessionId),
        span,
      };
    },
    async listErrors(scope, f) {
      const where: string[] = [];
      const p: unknown[] = [];
      // Always: own workspace(s) OR a global (NULL-workspace) crash row.
      const { sql: scopeSql, params } = inClause('workspace_id', scope);
      where.push(`(${scopeSql} OR workspace_id IS NULL)`);
      p.push(...params);
      if (f.workspaceId !== undefined) { where.push('(workspace_id = ? OR workspace_id IS NULL)'); p.push(f.workspaceId); }
      if (f.sessionId !== undefined) { where.push('session_id = ?'); p.push(f.sessionId); }
      if (f.level !== undefined) { where.push('level = ?'); p.push(f.level); }
      if (f.type !== undefined) { where.push('type = ?'); p.push(f.type); }
      if (f.since !== undefined) { where.push('ts >= ?'); p.push(f.since); }
      const sql = `SELECT * FROM errors WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`;
      return db.prepare(sql).all(...p, f.limit) as Row[];
    },
    async searchEmbeddings(qvec, scope, o) {
      return searchVectorsSqlite(db, qvec, [...scope], o);
    },
    async query(caller, q) {
      const snap = buildSnapshot(db.name, caller.scope, q.includeRaw);
      try {
        const stmt = snap.prepare(q.sql);
        if (!stmt.reader) throw new Error('read-only SELECT statements only');
        return (stmt.all(...q.params) as unknown[]).slice(0, q.maxRows);
      } finally {
        snap.close();
      }
    },
    async forgetCaller() {},
    async close() {
      if (db.open) db.close();
    },
  };
}
