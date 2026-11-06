// Store-backed reads the desktop federates. Every query is limited to the
// hosted workspace, whatever the caller sends.
import { sql, type Kysely } from 'kysely';
import { HEADLESS_BROKER_PREFIX, listSessionCostsQuery, summaryForSession, summaryForWorkspace, type WorkspaceSummary } from '../main/db.js';
import { costFor } from '../main/pricing.js';
import { readTransaction } from '../main/store/kysely.js';
import type { StateDb } from '../main/store/stateSchema.js';
import type { SessionCursor } from '../preload/federation.js';

export const SESSIONS_PAGE_MAX = 200;
const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

export interface RemoteSessionRow {
  id: string;
  workspaceId: string;
  aiTitle: string | null;
  firstUserMessage: string | null;
  userSetName: string | null;
  startedAt: number | null;
  lastActiveAt: number | null;
  eventCount: number;
  usd: number;
  tags: string[];
  headless: boolean;
}

export interface SessionsPageReq { after: SessionCursor | null; limit: number }
export interface SessionsPage { rows: RemoteSessionRow[]; next: SessionCursor | null }

export class HistoryArgError extends Error {}

const int = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function parseSessionsReq(v: unknown): SessionsPageReq {
  if (!isObject(v)) throw new HistoryArgError('expected {after, limit}');
  const limit = v.limit === undefined ? SESSIONS_PAGE_MAX : v.limit;
  if (!int(limit) || limit < 1 || limit > SESSIONS_PAGE_MAX) throw new HistoryArgError(`limit must be 1-${SESSIONS_PAGE_MAX}`);
  if (v.after === undefined || v.after === null) return { after: null, limit };
  const a = v.after;
  if (!isObject(a) || !int(a.lastActiveAt) || a.lastActiveAt < 0 || typeof a.id !== 'string' || !ID_RE.test(a.id)) {
    throw new HistoryArgError('after must be {lastActiveAt: integer >= 0, id}');
  }
  return { after: { lastActiveAt: a.lastActiveAt, id: a.id }, limit };
}

export function parseSessionId(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || !ID_RE.test(v)) throw new HistoryArgError('sessionId must be a session id');
  return v;
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** One newest-first keyset page of `workspaceId`'s sessions, ordered as db.ts
 *  listSessions: COALESCE(last_active_at, 0) DESC, id in byte order. */
export async function sessionsPage(k: Kysely<StateDb>, workspaceId: string, req: SessionsPageReq): Promise<SessionsPage> {
  return readTransaction(k, async (trx) => {
    const la = sql<number>`COALESCE(last_active_at, 0)`;
    const after = req.after
      ? sql`AND (${la} < ${req.after.lastActiveAt} OR (${la} = ${req.after.lastActiveAt} AND id COLLATE "C" > ${req.after.id}))`
      : sql``;
    const sess = (await sql<{
      id: string; workspace_id: string; ai_title: string | null; first_user_message: string | null; user_set_name: string | null;
      started_at: number | string | null; last_active_at: number | string | null; headless: boolean;
    }>`
      SELECT id, workspace_id, ai_title, first_user_message, user_set_name, started_at, last_active_at,
             EXISTS (SELECT 1 FROM broker_sessions b WHERE b.claude_session_id = sessions.id
                     AND b.broker_session_id LIKE ${`${HEADLESS_BROKER_PREFIX}%`}) AS headless
      FROM sessions WHERE workspace_id = ${workspaceId} ${after}
      ORDER BY ${la} DESC, id COLLATE "C" ASC
      LIMIT ${req.limit + 1}`.execute(trx)).rows;
    const page = sess.slice(0, req.limit);
    const ids = page.map((s) => s.id);
    const agg = new Map<string, { usd: number; eventCount: number }>();
    const tags = new Map<string, string[]>();
    if (ids.length) {
      // Summed in key order, as listSessions does, so the float total is stable.
      const costs = await listSessionCostsQuery(trx, workspaceId).where('session_id', 'in', ids)
        .orderBy('session_id').orderBy('model').orderBy('service_tier').execute();
      for (const c of costs) {
        const a = agg.get(c.session_id) ?? { usd: 0, eventCount: 0 };
        a.eventCount += Number(c.event_count);
        a.usd += costFor(c.model, c.service_tier, {
          inputTokens: Number(c.input_tokens), outputTokens: Number(c.output_tokens),
          cacheReadInputTokens: Number(c.cache_read_input_tokens), cacheCreationInputTokens: Number(c.cache_creation_input_tokens),
        });
        agg.set(c.session_id, a);
      }
      const tagRows = (await sql<{ session_id: string; tags: string }>`
        SELECT DISTINCT ON (session_id) session_id, tags FROM session_summaries
        WHERE workspace_id = ${workspaceId} AND session_id IN (${sql.join(ids)}) AND tags IS NOT NULL
        ORDER BY session_id, id DESC`.execute(trx)).rows;
      for (const r of tagRows) {
        try {
          const p: unknown = JSON.parse(r.tags);
          if (Array.isArray(p)) tags.set(r.session_id, p.filter((t): t is string => typeof t === 'string'));
        } catch { /* malformed tags: untagged */ }
      }
    }
    const rows = page.map((s): RemoteSessionRow => ({
      id: s.id, workspaceId: s.workspace_id, aiTitle: s.ai_title, firstUserMessage: s.first_user_message,
      userSetName: s.user_set_name, startedAt: num(s.started_at), lastActiveAt: num(s.last_active_at),
      eventCount: agg.get(s.id)?.eventCount ?? 0, usd: agg.get(s.id)?.usd ?? 0,
      tags: tags.get(s.id) ?? [], headless: Boolean(s.headless),
    }));
    const last = rows[rows.length - 1];
    return { rows, next: sess.length > req.limit && last ? { lastActiveAt: last.lastActiveAt ?? 0, id: last.id } : null };
  });
}

export interface HistoryReader {
  workspaceId: string;
  sessions(req: SessionsPageReq): Promise<SessionsPage>;
  /** null: the workspace's latest session. A session outside the workspace answers null. */
  summary(sessionId: string | null): Promise<WorkspaceSummary | null>;
}

export function historyReader(k: () => Kysely<StateDb>, workspaceId: string): HistoryReader {
  return {
    workspaceId,
    sessions: (req) => sessionsPage(k(), workspaceId, req),
    async summary(sessionId) {
      if (sessionId === null) return summaryForWorkspace(workspaceId);
      const row = await k().selectFrom('sessions').select('workspace_id').where('id', '=', sessionId).executeTakeFirst();
      return row?.workspace_id === workspaceId ? summaryForSession(sessionId) : null;
    },
  };
}
