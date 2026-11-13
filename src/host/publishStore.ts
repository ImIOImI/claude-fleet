// Published transcripts on the holder's fenced state store (remote-workspaces §7). Rows go into the
// ordinary state tables under a partition derived from the verified caller (D97, D98).
import { sql, type Kysely, type Transaction } from 'kysely';
import { deleteSessionRows, ingestBatch } from '../main/db.js';
import { partitionIdFor, publishedSessionId, type PublishOwner } from '../main/publish/protocol.js';
import type { ScrubbedLine } from '../main/publish/scrub.js';
import type { StateDb } from '../main/store/stateSchema.js';

export const PUBLISH_STATEMENT_TIMEOUT = '5s';
/** D138: a published session is removed once its last activity is older than this. */
export const PUBLISH_RETENTION_DAYS = 180;
export const PUBLISH_RETENTION_MS = PUBLISH_RETENTION_DAYS * 86_400_000;
export const PUBLISH_PRUNE_BATCH = 100;

export class PublishConflictError extends Error {}

export interface PublishIngestResult {
  sessionId: string;
  partitionId: string;
  inserted: number;
}

export interface PublishStore {
  ingest(owner: PublishOwner, sourceWorkspaceId: string, sourceSessionId: string, lines: readonly ScrubbedLine[]): Promise<PublishIngestResult>;
  /** The host MCP's read scope beyond the hosted workspace. */
  partitionIds(): Promise<string[]>;
  /** The caller's own copies of `sourceSessionId`, in every partition they own; returns how many were removed. */
  unpublish(owner: PublishOwner, sourceSessionId: string): Promise<number>;
  /** Removes up to `limit` published sessions last active before the retention cutoff, oldest first; returns how many. */
  prune(now?: number, limit?: number): Promise<number>;
}

/** Everything a published session left on the host; the caller's transaction must not have touched the session yet. */
async function removePublishedSession(trx: Transaction<StateDb>, id: string): Promise<void> {
  await deleteSessionRows(trx, id);
  await trx.deleteFrom('session_summaries').where('session_id', '=', id).execute();
  await trx.deleteFrom('session_tags').where('session_id', '=', id).execute();
  await trx.deleteFrom('usage_anchors').where('session_id', '=', id).execute();
  await trx.deleteFrom('usage_events').where('session_id', '=', id).execute();
  await sql`DELETE FROM publish_sessions WHERE session_id = ${id}`.execute(trx);
}

/** A session with no `sessions` row (or no activity yet) ages by its last publish. */
const LAST_ACTIVE = sql`COALESCE(s.last_active_at, ps.last_published_at)`;

interface Claim {
  owner: PublishOwner;
  partitionId: string;
  sourceWorkspaceId: string;
  sessionId: string;
  sourceSessionId: string;
  at: number;
}

async function claim(trx: Transaction<StateDb>, c: Claim): Promise<void> {
  const held = await sql<{ w: string }>`SELECT workspace_id AS w FROM sessions WHERE id = ${c.sessionId}`.execute(trx);
  if (held.rows[0] && held.rows[0].w !== c.partitionId) throw new PublishConflictError('session id belongs to another workspace');
  await sql`INSERT INTO publish_partitions (partition_id, owner_provider, owner_id, owner_login, source_workspace_id, created_at)
    VALUES (${c.partitionId}, ${c.owner.provider}, ${String(c.owner.id)}, ${c.owner.login}, ${c.sourceWorkspaceId}, ${c.at})
    ON CONFLICT (partition_id) DO UPDATE SET owner_login = EXCLUDED.owner_login
    WHERE publish_partitions.owner_login IS DISTINCT FROM EXCLUDED.owner_login`.execute(trx);
  const p = await sql<{ owner_provider: string; owner_id: string; source_workspace_id: string }>`
    SELECT owner_provider, owner_id, source_workspace_id FROM publish_partitions WHERE partition_id = ${c.partitionId}`.execute(trx);
  const row = p.rows[0];
  if (!row || row.owner_provider !== c.owner.provider || row.owner_id !== String(c.owner.id) || row.source_workspace_id !== c.sourceWorkspaceId) {
    throw new PublishConflictError('partition belongs to another owner');
  }
  await sql`INSERT INTO publish_sessions (session_id, partition_id, source_session_id, first_published_at, last_published_at)
    VALUES (${c.sessionId}, ${c.partitionId}, ${c.sourceSessionId}, ${c.at}, ${c.at})
    ON CONFLICT (session_id) DO UPDATE SET last_published_at = EXCLUDED.last_published_at`.execute(trx);
}

export function publishStore(
  k: () => Kysely<StateDb>,
  o: { ingest?: typeof ingestBatch; onIngested?: (sessionId: string) => void; now?: () => number } = {}
): PublishStore {
  const ingest = o.ingest ?? ingestBatch;
  const now = o.now ?? Date.now;
  return {
    async ingest(owner, sourceWorkspaceId, sourceSessionId, lines) {
      const partitionId = partitionIdFor(owner, sourceWorkspaceId);
      const sessionId = publishedSessionId(partitionId, sourceSessionId);
      const at = now();
      const results = await ingest(partitionId, sessionId, lines, {
        atStart: async (trx) => {
          await sql`SET LOCAL statement_timeout = ${sql.lit(PUBLISH_STATEMENT_TIMEOUT)}`.execute(trx);
          await claim(trx, { owner, partitionId, sourceWorkspaceId, sessionId, sourceSessionId, at });
        }
      });
      const inserted = results.filter((r) => r.inserted).length;
      if (inserted > 0) o.onIngested?.(sessionId);
      return { sessionId, partitionId, inserted };
    },
    async partitionIds() {
      const r = await sql<{ partition_id: string }>`SELECT partition_id FROM publish_partitions ORDER BY partition_id`.execute(k());
      return r.rows.map((x) => x.partition_id);
    },
    async unpublish(owner, sourceSessionId) {
      const r = await sql<{ session_id: string }>`
        SELECT s.session_id FROM publish_sessions s JOIN publish_partitions p ON p.partition_id = s.partition_id
        WHERE p.owner_provider = ${owner.provider} AND p.owner_id = ${String(owner.id)} AND s.source_session_id = ${sourceSessionId}
        ORDER BY s.session_id`.execute(k());
      for (const { session_id: id } of r.rows) {
        await k().transaction().execute((trx) => removePublishedSession(trx, id));
      }
      return r.rows.length;
    },
    async prune(at = now(), limit = PUBLISH_PRUNE_BATCH) {
      const cutoff = at - PUBLISH_RETENTION_MS;
      const r = await sql<{ session_id: string }>`
        SELECT ps.session_id FROM publish_sessions ps LEFT JOIN sessions s ON s.id = ps.session_id
        WHERE ${LAST_ACTIVE} < ${cutoff} ORDER BY ${LAST_ACTIVE}, ps.session_id LIMIT ${limit}`.execute(k());
      let removed = 0;
      for (const { session_id: id } of r.rows) {
        const gone = await k().transaction().execute(async (trx) => {
          // Lock, then re-check: a re-send that committed after the scan may have made the session recent again.
          await sql`SELECT 1 FROM sessions WHERE id = ${id} FOR UPDATE`.execute(trx);
          const still = await sql`SELECT 1 FROM publish_sessions ps LEFT JOIN sessions s ON s.id = ps.session_id
            WHERE ps.session_id = ${id} AND ${LAST_ACTIVE} < ${cutoff}`.execute(trx);
          if (!still.rows.length) return false;
          await removePublishedSession(trx, id);
          return true;
        });
        if (gone) removed++;
      }
      return removed;
    }
  };
}
