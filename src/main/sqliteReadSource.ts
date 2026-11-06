// The MCP read path on SQLite (SPEC §11): the server's own read-only
// connection; `query`'s per-call isolation snapshot runs off the main thread
// in queryWorker.ts (#476).
import Database from 'better-sqlite3';
import { searchVectorsSqlite } from './transcriptIndex.js';
import { runQueryInWorker } from './queryWorker.js';
import {
  NOT_AUTHORIZED, checkEventColumns, type OwnedReadSource, type Row, type Scope, type TokenGroup,
} from './store/readSource.js';

/** SQL `IN (?,…)` fragment + params for an allowed-workspace set (#122). */
function inClause(col: string, allowed: Scope): { sql: string; params: string[] } {
  const ids = [...allowed];
  if (ids.length === 0) return { sql: '0 = 1', params: [] }; // match nothing (self is always present, so unreachable)
  return { sql: `${col} IN (${ids.map(() => '?').join(',')})`, params: ids };
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
    // Snapshot build + caller SQL run in a worker thread with a hard timeout
    // (#476): on a multi-GB state.db the copy took minutes and froze the main
    // process. The worker ATTACHes the live state.db, copies only the caller's
    // allowed-workspace rows, DETACHes it, then runs the caller's SQL (#146).
    async query(caller, q) {
      return runQueryInWorker({
        srcPath: db.name,
        allowed: [...caller.scope],
        includeRaw: q.includeRaw,
        sql: q.sql,
        params: q.params,
        maxRows: q.maxRows,
      });
    },
    async forgetCaller() {},
    async close() {
      if (db.open) db.close();
    },
  };
}
