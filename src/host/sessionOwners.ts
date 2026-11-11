// Session owners on the holder's fenced state store. Rows come only from a verified identity on
// CREATE (D116) or the host's own automation runs (D118).
import { sql, type Kysely } from 'kysely';
import type { Identity } from '../main/identity/types.js';
import { costFor } from '../main/pricing.js';
import type { StateDb } from '../main/store/stateSchema.js';
import {
  AUTOMATION_LOGIN, AUTOMATION_PROVIDER, MAX_OWNER_COST_ROWS, parseSessionOwner, type OwnerCostRow, type SessionOwner
} from '../preload/sessionOwner.js';

export const OWNER_LOOKUP_CHUNK = 500;

export interface OwnerClaim {
  brokerSessionId: string;
  /** The claude session id the host pinned. */
  sessionId: string;
  owner: SessionOwner;
  startedAt: number;
}

export function ownerOfIdentity(i: Identity): SessionOwner {
  const o = parseSessionOwner({ kind: i.kind, provider: i.provider, id: String(i.id), login: i.login, name: i.name, avatarUrl: i.avatarUrl });
  if (!o) throw new Error(`identity ${i.provider}:${i.id} can't be recorded as a session owner`);
  return o;
}

export function automationOwner(workspaceId: string): SessionOwner {
  return { kind: 'automation', provider: AUTOMATION_PROVIDER, id: workspaceId, login: AUTOMATION_LOGIN, name: null, avatarUrl: null };
}

export interface SessionOwnerStore {
  /** False: that (broker session, claude session) already had an owner, which is unchanged. */
  record(c: OwnerClaim): Promise<boolean>;
  release(brokerSessionId: string, sessionId: string): Promise<void>;
  /** Within `workspaceIds` only: a session's earliest row, or its publish partition's owner (D119). */
  ownersOf(sessionIds: readonly string[], workspaceIds: readonly string[]): Promise<Map<string, SessionOwner>>;
  /** Most expensive first, at most MAX_OWNER_COST_ROWS; `since` filters on last_active_at. */
  ownerCosts(workspaceIds: readonly string[], o?: { since?: number }): Promise<OwnerCostRow[]>;
}

interface OwnerRow {
  session_id: string; kind: string; provider: string; account_id: string; login: string; name: string | null; avatar_url: string | null;
}
interface CostRow {
  session_id: string; model: string | null; service_tier: string | null;
  input_tokens: number | string; output_tokens: number | string;
  cache_read_input_tokens: number | string; cache_creation_input_tokens: number | string;
}

const groupKey = (o: SessionOwner | null): string => (o ? `${o.kind}\u0000${o.provider}\u0000${o.id}` : '');

export function sessionOwnerStore(k: () => Kysely<StateDb>, workspaceId: string): SessionOwnerStore {
  async function ownersOf(sessionIds: readonly string[], workspaceIds: readonly string[]): Promise<Map<string, SessionOwner>> {
    const out = new Map<string, SessionOwner>();
    if (sessionIds.length === 0 || workspaceIds.length === 0) return out;
    const ws = sql.join([...workspaceIds]);
    for (let i = 0; i < sessionIds.length; i += OWNER_LOOKUP_CHUNK) {
      const ids = sql.join(sessionIds.slice(i, i + OWNER_LOOKUP_CHUNK));
      const r = await sql<OwnerRow>`
        (SELECT DISTINCT ON (session_id) session_id, kind, provider, account_id, login, name, avatar_url
           FROM session_owners o WHERE workspace_id IN (${ws}) AND session_id IN (${ids})
             AND NOT EXISTS (SELECT 1 FROM publish_sessions p WHERE p.session_id = o.session_id)
           ORDER BY session_id, started_at, broker_session_id)
        UNION ALL
        (SELECT s.session_id, 'publisher', p.owner_provider, p.owner_id, p.owner_login, NULL::text, NULL::text
           FROM publish_sessions s JOIN publish_partitions p ON p.partition_id = s.partition_id
           WHERE p.partition_id IN (${ws}) AND s.session_id IN (${ids}))`.execute(k());
      for (const row of r.rows) {
        const o = parseSessionOwner({ kind: row.kind, provider: row.provider, id: row.account_id, login: row.login, name: row.name, avatarUrl: row.avatar_url });
        if (o && !out.has(row.session_id)) out.set(row.session_id, o);
      }
    }
    return out;
  }

  return {
    async record(c) {
      if (c.owner.kind === 'publisher') throw new Error('published sessions take their owner from the partition');
      const o = parseSessionOwner(c.owner);
      if (!o) throw new Error("session owner can't be recorded");
      return k().transaction().execute(async (trx) => {
        // Strictly after every existing row, so a skewed clock (failover) or a smaller broker id never takes ownership.
        const r = await sql<{ broker_session_id: string }>`
          INSERT INTO session_owners (broker_session_id, session_id, workspace_id, kind, provider, account_id, login, name, avatar_url, started_at)
          VALUES (${c.brokerSessionId}, ${c.sessionId}, ${workspaceId}, ${o.kind}, ${o.provider}, ${o.id}, ${o.login}, ${o.name}, ${o.avatarUrl},
            GREATEST(${c.startedAt}::bigint, (SELECT COALESCE(max(started_at) + 1, 0) FROM session_owners WHERE session_id = ${c.sessionId} AND workspace_id = ${workspaceId})))
          ON CONFLICT (broker_session_id, session_id) DO NOTHING
          RETURNING broker_session_id`.execute(trx);
        return r.rows.length > 0;
      });
    },
    async release(brokerSessionId, sessionId) {
      await k().transaction().execute(async (trx) => {
        await sql`DELETE FROM session_owners WHERE broker_session_id = ${brokerSessionId} AND session_id = ${sessionId}`.execute(trx);
      });
    },
    ownersOf,
    async ownerCosts(workspaceIds, o = {}) {
      if (workspaceIds.length === 0) return [];
      const since = o.since === undefined ? sql`` : sql`AND COALESCE(s.last_active_at, 0) >= ${o.since}`;
      const costs = (await sql<CostRow>`
        SELECT c.session_id, NULLIF(c.model, '') AS model, NULLIF(c.service_tier, '') AS service_tier,
               c.input_tokens, c.output_tokens, c.cache_read_input_tokens, c.cache_creation_input_tokens
        FROM session_costs c JOIN sessions s ON s.id = c.session_id AND s.workspace_id = c.workspace_id
        WHERE c.workspace_id IN (${sql.join([...workspaceIds])}) ${since}
        ORDER BY c.session_id, c.model, c.service_tier`.execute(k())).rows;
      const owners = await ownersOf([...new Set(costs.map((c) => c.session_id))], workspaceIds);
      const groups = new Map<string, { owner: SessionOwner | null; sessions: Set<string>; usd: number }>();
      for (const c of costs) {
        const owner = owners.get(c.session_id) ?? null;
        const key = groupKey(owner);
        const g = groups.get(key) ?? { owner, sessions: new Set<string>(), usd: 0 };
        g.sessions.add(c.session_id);
        g.usd += costFor(c.model, c.service_tier, {
          inputTokens: Number(c.input_tokens), outputTokens: Number(c.output_tokens),
          cacheReadInputTokens: Number(c.cache_read_input_tokens), cacheCreationInputTokens: Number(c.cache_creation_input_tokens)
        });
        groups.set(key, g);
      }
      return [...groups.entries()]
        .sort(([ka, a], [kb, b]) => b.usd - a.usd || (ka < kb ? -1 : ka > kb ? 1 : 0))
        .slice(0, MAX_OWNER_COST_ROWS)
        .map(([, g]) => ({ owner: g.owner, sessions: g.sessions.size, usd: g.usd }));
    }
  };
}
