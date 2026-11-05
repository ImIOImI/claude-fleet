// The MCP read path on Postgres: the typed tools' SQL on the store's own pool,
// filtered by the caller's scope as on SQLite; `query` goes through the
// role + RLS isolation (pgQueryIsolation.ts).
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { searchEmbeddings, stateKysely } from '../db.js';
import { readTransaction } from './kysely.js';
import type { StateDb } from './stateSchema.js';
import type { QueryRunner, ReadSource, Row, Scope, SummaryParts, TokenGroup } from './readSource.js';

const inScope = (scope: Scope): RawBuilder<unknown> => sql`workspace_id IN (${sql.join([...scope])})`;
const and = (conds: RawBuilder<unknown>[]): RawBuilder<unknown> => sql.join(conds, sql` AND `);

export interface PgReadSourceOptions {
  /** null: `query` reports `unavailable` (why is in the message). */
  isolation: QueryRunner | null;
  unavailable?: string;
  k?: () => Kysely<StateDb>;
}

export function pgReadSource(o: PgReadSourceOptions): ReadSource {
  const k = o.k ?? stateKysely;
  const read = <T>(fn: (q: Kysely<StateDb>) => Promise<T>): Promise<T> => readTransaction(k(), fn);
  const tokenGroups = async (q: Kysely<StateDb>, sessionId: string): Promise<TokenGroup[]> =>
    (await sql<TokenGroup>`
      SELECT model, service_tier,
             SUM(COALESCE(input_tokens, 0)) AS input,
             SUM(COALESCE(output_tokens, 0)) AS output,
             SUM(COALESCE(cache_read_input_tokens, 0)) AS "cacheRead",
             SUM(COALESCE(cache_creation_input_tokens, 0)) AS "cacheCreate"
      FROM events WHERE session_id = ${sessionId} AND type = 'assistant'
      GROUP BY model, service_tier
      ORDER BY model NULLS FIRST, service_tier NULLS FIRST`.execute(q)).rows;
  const distinctInputs = async (q: Kysely<StateDb>, sessionId: string, names: string[]): Promise<string[]> =>
    (await sql<{ tool_input: string }>`
      SELECT DISTINCT tool_input FROM events
      WHERE session_id = ${sessionId} AND tool_name IN (${sql.join(names)}) AND tool_input IS NOT NULL
      ORDER BY tool_input`.execute(q)).rows.map((r) => r.tool_input);

  return {
    dialect: 'postgres',
    async listSessions(scope, f) {
      if (scope.size === 0) return [];
      const conds = [inScope(scope)];
      if (f.workspaceId !== undefined) conds.push(sql`workspace_id = ${f.workspaceId}`);
      if (f.since !== undefined) conds.push(sql`last_active_at >= ${f.since}`);
      if (f.until !== undefined) conds.push(sql`last_active_at <= ${f.until}`);
      // SQLite sorts NULL last under DESC; the id tiebreak makes the order total.
      return read(async (q) => (await sql<Row>`
        SELECT * FROM sessions WHERE ${and(conds)}
        ORDER BY last_active_at DESC NULLS LAST, id LIMIT ${f.limit}`.execute(q)).rows);
    },
    async getSession(id) {
      return read(async (q) => (await sql<Row>`SELECT * FROM sessions WHERE id = ${id}`.execute(q)).rows[0] ?? null);
    },
    async sessionWorkspace(id) {
      const r = await read(async (q) => (await sql<{ workspace_id: string }>`SELECT workspace_id FROM sessions WHERE id = ${id}`.execute(q)).rows[0]);
      return r?.workspace_id ?? null;
    },
    async tokenGroups(sessionId) {
      return read((q) => tokenGroups(q, sessionId));
    },
    async listEvents(sessionId, f) {
      const conds = [sql`session_id = ${sessionId}`];
      if (f.type !== undefined) conds.push(sql`type = ${f.type}`);
      if (f.toolName !== undefined) conds.push(sql`tool_name = ${f.toolName}`);
      if (f.since !== undefined) conds.push(sql`ts >= ${f.since}`);
      return read(async (q) => (await sql<Row>`
        SELECT ${sql.raw(f.columns)} FROM events WHERE ${and(conds)} ORDER BY id ASC LIMIT ${f.limit}`.execute(q)).rows);
    },
    async summaryParts(sessionId): Promise<SummaryParts> {
      return read(async (q) => {
        const files = await distinctInputs(q, sessionId, ['Write', 'Edit', 'NotebookEdit']);
        const commands = await distinctInputs(q, sessionId, ['Bash']);
        const span = (await sql<SummaryParts['span']>`
          SELECT MIN(ts) AS started_at, MAX(ts) AS last_active_at FROM events WHERE session_id = ${sessionId}`.execute(q)).rows[0];
        return { files, commands, tokens: await tokenGroups(q, sessionId), span };
      });
    },
    async listErrors(scope, f) {
      const conds = [sql`(${scope.size ? inScope(scope) : sql`false`} OR workspace_id IS NULL)`];
      if (f.workspaceId !== undefined) conds.push(sql`(workspace_id = ${f.workspaceId} OR workspace_id IS NULL)`);
      if (f.sessionId !== undefined) conds.push(sql`session_id = ${f.sessionId}`);
      if (f.level !== undefined) conds.push(sql`level = ${f.level}`);
      if (f.type !== undefined) conds.push(sql`type = ${f.type}`);
      if (f.since !== undefined) conds.push(sql`ts >= ${f.since}`);
      return read(async (q) => (await sql<Row>`
        SELECT * FROM errors WHERE ${and(conds)} ORDER BY id DESC LIMIT ${f.limit}`.execute(q)).rows);
    },
    searchEmbeddings(qvec, scope, opts) {
      return searchEmbeddings(qvec, [...scope], opts);
    },
    async query(caller, q) {
      if (!o.isolation) throw new Error(o.unavailable ?? 'query is unavailable on this Postgres store');
      return o.isolation.query(caller, q);
    },
    async forgetCaller(callerId) {
      await o.isolation?.forgetCaller(callerId);
    },
    async close() {
      await o.isolation?.end();
    },
  };
}
