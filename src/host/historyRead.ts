// Store-backed reads the desktop federates. Every query is limited to the
// hosted workspace, whatever the caller sends.
import { sql, type Kysely } from 'kysely';
import { HEADLESS_BROKER_PREFIX, listSessionCostsQuery, summaryForSession, summaryForWorkspace, type EmbeddingHit, type WorkspaceSummary } from '../main/db.js';
import { costFor } from '../main/pricing.js';
import { readTransaction } from '../main/store/kysely.js';
import { pgSearchEmbeddings } from '../main/store/pgVectorSearch.js';
import { EMBED_DIM, EMBED_MODEL_ID } from '../main/vectors.js';
import type { StateDb } from '../main/store/stateSchema.js';
import type { SessionCursor } from '../preload/federation.js';
import type { OwnerCostRow, SessionOwner } from '../preload/sessionOwner.js';
import { SESSION_ID_RE as ID_RE, type SessionOwnerStore } from './sessionOwners.js';

export const SESSIONS_PAGE_MAX = 200;
// D59: the caps of the desktop validator (src/main/federation/remoteRows.ts),
// so a page of long titles or many tags stays far under the 2 MB reply cap.
const MAX_TEXT = 500;
const MAX_TAGS = 20;
const MAX_TAG_LEN = 64;

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

export type OwnedSessionRow = RemoteSessionRow & { owner: SessionOwner | null };

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

export const SEARCH_LIMIT_MAX = 50;
export const SEARCH_TEXT_MAX = 1000;
const SEARCH_LIMIT_DEFAULT = 10;
const UNIT_TOLERANCE = 1e-3;
export interface SearchReq { vector: Float32Array; limit: number; kind?: 'turn' | 'summary' }

/** D66: a query vector for the host's own model, never text, so a viewer can't spend the host's model CPU. */
export function parseSearchReq(v: unknown): SearchReq {
  if (!isObject(v)) throw new HistoryArgError('expected {vector, modelId, limit}');
  if (v.modelId !== EMBED_MODEL_ID) throw new HistoryArgError(`model mismatch: host uses ${EMBED_MODEL_ID}`);
  if (!Array.isArray(v.vector) || v.vector.length !== EMBED_DIM) throw new HistoryArgError(`vector must have ${EMBED_DIM} numbers`);
  const vec = new Float32Array(EMBED_DIM);
  let norm = 0;
  for (let i = 0; i < EMBED_DIM; i++) {
    const x: unknown = v.vector[i];
    if (typeof x !== 'number' || !Number.isFinite(x)) throw new HistoryArgError('vector must be finite numbers');
    vec[i] = x;
    norm += x * x;
  }
  if (Math.abs(Math.sqrt(norm) - 1) > UNIT_TOLERANCE) throw new HistoryArgError('vector must be unit length');
  const limit = v.limit === undefined ? SEARCH_LIMIT_DEFAULT : v.limit;
  if (!int(limit) || limit < 1 || limit > SEARCH_LIMIT_MAX) throw new HistoryArgError(`limit must be 1-${SEARCH_LIMIT_MAX}`);
  if (v.kind !== undefined && v.kind !== 'turn' && v.kind !== 'summary') throw new HistoryArgError('kind must be turn or summary');
  return { vector: vec, limit, kind: v.kind };
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
      SELECT id, workspace_id, LEFT(ai_title, ${MAX_TEXT}) AS ai_title, LEFT(first_user_message, ${MAX_TEXT}) AS first_user_message,
             LEFT(user_set_name, ${MAX_TEXT}) AS user_set_name, started_at, last_active_at,
             EXISTS (SELECT 1 FROM broker_sessions b WHERE b.claude_session_id = sessions.id
                     AND b.broker_session_id LIKE ${`${HEADLESS_BROKER_PREFIX}%`}) AS headless
      FROM sessions WHERE workspace_id = ${workspaceId} AND id ~ ${ID_RE.source} ${after}
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
      tags: (tags.get(s.id) ?? []).slice(0, MAX_TAGS).map((t) => t.slice(0, MAX_TAG_LEN)), headless: Boolean(s.headless),
    }));
    const last = rows[rows.length - 1];
    return { rows, next: sess.length > req.limit && last ? { lastActiveAt: last.lastActiveAt ?? 0, id: last.id } : null };
  });
}

export interface HistoryReader {
  workspaceId: string;
  sessions(req: SessionsPageReq): Promise<{ rows: OwnedSessionRow[]; next: SessionCursor | null }>;
  /** null: the workspace's latest session. A session outside the workspace answers null. */
  summary(sessionId: string | null): Promise<WorkspaceSummary | null>;
  /** The exact pgvector scan over the hosted workspace (D66). */
  search(req: SearchReq): Promise<{ modelId: string; hits: EmbeddingHit[] }>;
  /** Cost per owner over the hosted workspace (D121). */
  ownerCosts(): Promise<{ rows: OwnerCostRow[] }>;
}

/** `summary` goes through db.ts's global store (summaryForWorkspace/summaryForSession), the same
 *  handle the holder passes as `k` here, not a store `k` could swap per call. */
export function historyReader(
  k: () => Kysely<StateDb>, workspaceId: string, owners?: Pick<SessionOwnerStore, 'ownersOf' | 'ownerCosts'>
): HistoryReader {
  return {
    workspaceId,
    async sessions(req) {
      const page = await sessionsPage(k(), workspaceId, req);
      const m = owners && page.rows.length > 0 ? await owners.ownersOf(page.rows.map((r) => r.id), [workspaceId]) : new Map<string, SessionOwner>();
      return { rows: page.rows.map((r) => ({ ...r, owner: m.get(r.id) ?? null })), next: page.next };
    },
    async summary(sessionId) {
      if (sessionId === null) return summaryForWorkspace(workspaceId);
      const row = await k().selectFrom('sessions').select('workspace_id').where('id', '=', sessionId).executeTakeFirst();
      return row?.workspace_id === workspaceId ? summaryForSession(sessionId) : null;
    },
    async search(req) {
      const hits = await readTransaction(k(), (q) => pgSearchEmbeddings(q, req.vector, [workspaceId], { limit: req.limit, kind: req.kind }));
      return {
        modelId: EMBED_MODEL_ID,
        hits: hits.map((h) => ({ ...h, text: h.text.slice(0, SEARCH_TEXT_MAX), score: Number(h.score), ts: num(h.ts) }))
      };
    },
    // Hosted only, never partitions (D107, D119).
    ownerCosts: async () => ({ rows: owners ? await owners.ownerCosts([workspaceId]) : [] }),
  };
}
