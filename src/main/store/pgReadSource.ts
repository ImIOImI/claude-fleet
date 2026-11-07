// The MCP read path on Postgres: the typed tools' SQL on the store's own pool,
// filtered by the caller's scope as on SQLite; `query` goes through the
// role + RLS isolation (pgQueryIsolation.ts).
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { stateKysely } from '../db.js';
import { readTransaction } from './kysely.js';
import { pgSearchEmbeddings } from './pgVectorSearch.js';
import type { StateDb } from './stateSchema.js';
import { PgQueryIsolation, type PreprovisionedLogin } from './pgQueryIsolation.js';
import type { PgPoolConfig } from './postgres.js';
import {
  NOT_AUTHORIZED, checkEventColumns, type OwnedReadSource, type QueryRunner, type Row, type Scope, type SummaryParts, type TokenGroup,
} from './readSource.js';

// Text sorts use COLLATE "C" to match SQLite's byte order on any database collation.
const inScope = (scope: Scope): RawBuilder<unknown> =>
  scope.size ? sql`workspace_id IN (${sql.join([...scope])})` : sql`false`;
const and = (conds: RawBuilder<unknown>[]): RawBuilder<unknown> => sql.join(conds, sql` AND `);

export interface PgReadSourceOptions {
  /** null: `query` reports `unavailable` (why is in the message). */
  isolation: QueryRunner | null;
  unavailable?: string;
  k?: () => Kysely<StateDb>;
}

export function pgReadSource(o: PgReadSourceOptions): OwnedReadSource {
  const k = o.k ?? stateKysely;
  const read = <T>(fn: (q: Kysely<StateDb>) => Promise<T>): Promise<T> => readTransaction(k(), fn);
  const sessionWorkspace = async (q: Kysely<StateDb>, scope: Scope, id: string): Promise<string | null> =>
    (await sql<{ workspace_id: string }>`
      SELECT workspace_id FROM sessions WHERE id = ${id} AND ${inScope(scope)}`.execute(q)).rows[0]?.workspace_id ?? null;
  const assertInScope = async (q: Kysely<StateDb>, scope: Scope, id: string): Promise<void> => {
    if ((await sessionWorkspace(q, scope, id)) === null) throw new Error(NOT_AUTHORIZED);
  };
  const tokenGroups = async (q: Kysely<StateDb>, scope: Scope, sessionId: string): Promise<TokenGroup[]> =>
    (await sql<TokenGroup>`
      SELECT model, service_tier,
             SUM(COALESCE(input_tokens, 0)) AS input,
             SUM(COALESCE(output_tokens, 0)) AS output,
             SUM(COALESCE(cache_read_input_tokens, 0)) AS "cacheRead",
             SUM(COALESCE(cache_creation_input_tokens, 0)) AS "cacheCreate"
      FROM events WHERE session_id = ${sessionId} AND type = 'assistant' AND ${inScope(scope)}
      GROUP BY model, service_tier
      ORDER BY model COLLATE "C" NULLS FIRST, service_tier COLLATE "C" NULLS FIRST`.execute(q)).rows;
  const distinctInputs = async (q: Kysely<StateDb>, scope: Scope, sessionId: string, names: string[]): Promise<string[]> =>
    (await sql<{ tool_input: string }>`
      SELECT tool_input FROM events
      WHERE session_id = ${sessionId} AND tool_name IN (${sql.join(names)}) AND tool_input IS NOT NULL AND ${inScope(scope)}
      GROUP BY tool_input ORDER BY tool_input COLLATE "C"`.execute(q)).rows.map((r) => r.tool_input);

  return {
    queryFlavor: o.isolation ? 'postgres' : null,
    async listSessions(scope, f) {
      const conds = [inScope(scope)];
      if (f.workspaceId !== undefined) conds.push(sql`workspace_id = ${f.workspaceId}`);
      if (f.since !== undefined) conds.push(sql`last_active_at >= ${f.since}`);
      if (f.until !== undefined) conds.push(sql`last_active_at <= ${f.until}`);
      // SQLite sorts NULL last under DESC; the id tiebreak makes the order total.
      return read(async (q) => (await sql<Row>`
        SELECT * FROM sessions WHERE ${and(conds)}
        ORDER BY last_active_at DESC NULLS LAST, id COLLATE "C" LIMIT ${f.limit}`.execute(q)).rows);
    },
    async getSession(scope, id) {
      return read(async (q) => (await sql<Row>`
        SELECT * FROM sessions WHERE id = ${id} AND ${inScope(scope)}`.execute(q)).rows[0] ?? null);
    },
    async sessionWorkspace(scope, id) {
      return read((q) => sessionWorkspace(q, scope, id));
    },
    async tokenGroups(scope, sessionId) {
      return read(async (q) => {
        await assertInScope(q, scope, sessionId);
        return tokenGroups(q, scope, sessionId);
      });
    },
    async listEvents(scope, sessionId, f) {
      checkEventColumns(f.columns);
      const conds = [sql`session_id = ${sessionId}`, inScope(scope)];
      if (f.type !== undefined) conds.push(sql`type = ${f.type}`);
      if (f.toolName !== undefined) conds.push(sql`tool_name = ${f.toolName}`);
      if (f.since !== undefined) conds.push(sql`ts >= ${f.since}`);
      const cols = sql.join(f.columns.map((c) => sql.ref(c)));
      return read(async (q) => {
        await assertInScope(q, scope, sessionId);
        return (await sql<Row>`
          SELECT ${cols} FROM events WHERE ${and(conds)} ORDER BY id ASC LIMIT ${f.limit}`.execute(q)).rows;
      });
    },
    async summaryParts(scope, sessionId): Promise<SummaryParts> {
      return read(async (q) => {
        await assertInScope(q, scope, sessionId);
        const files = await distinctInputs(q, scope, sessionId, ['Write', 'Edit', 'NotebookEdit']);
        const commands = await distinctInputs(q, scope, sessionId, ['Bash']);
        const span = (await sql<SummaryParts['span']>`
          SELECT MIN(ts) AS started_at, MAX(ts) AS last_active_at FROM events
          WHERE session_id = ${sessionId} AND ${inScope(scope)}`.execute(q)).rows[0];
        return { files, commands, tokens: await tokenGroups(q, scope, sessionId), span };
      });
    },
    async listErrors(scope, f) {
      const conds = [sql`(${inScope(scope)} OR workspace_id IS NULL)`];
      if (f.workspaceId !== undefined) conds.push(sql`(workspace_id = ${f.workspaceId} OR workspace_id IS NULL)`);
      if (f.sessionId !== undefined) conds.push(sql`session_id = ${f.sessionId}`);
      if (f.level !== undefined) conds.push(sql`level = ${f.level}`);
      if (f.type !== undefined) conds.push(sql`type = ${f.type}`);
      if (f.since !== undefined) conds.push(sql`ts >= ${f.since}`);
      return read(async (q) => (await sql<Row>`
        SELECT * FROM errors WHERE ${and(conds)} ORDER BY id DESC LIMIT ${f.limit}`.execute(q)).rows);
    },
    async searchEmbeddings(qvec, scope, opts) {
      return read((q) => pgSearchEmbeddings(q, qvec, [...scope], opts));
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

/** The read source for an open Postgres store. `query` degrades to an error
 *  naming the reason when isolation can't be provisioned; the rest still work. */
export async function openPgMcpReadSource(
  schema: string, base: PgPoolConfig, log: (message: string) => void, o: { preprovisioned?: PreprovisionedLogin } = {},
): Promise<OwnedReadSource> {
  try {
    return pgReadSource({
      isolation: await PgQueryIsolation.open(stateKysely(), schema, base, {
        onPoolError: (e) => log(String(e)), preprovisioned: o.preprovisioned, onUnavailable: log,
      }),
    });
  } catch (e) {
    log(String(e));
    const why = e instanceof Error ? e.message : String(e);
    return pgReadSource({ isolation: null, unavailable: why.startsWith('query is unavailable') ? why : `query is unavailable on this Postgres store: ${why}` });
  }
}
