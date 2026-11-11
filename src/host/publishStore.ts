// Published transcripts on the holder's fenced state store (remote-workspaces §7). Rows go into the
// ordinary state tables under a partition derived from the verified caller (D97, D98).
import { sql, type Kysely, type Transaction } from 'kysely';
import { ingestBatch } from '../main/db.js';
import { partitionIdFor, publishedSessionId, type PublishOwner } from '../main/publish/protocol.js';
import type { ScrubbedLine } from '../main/publish/scrub.js';
import type { StateDb } from '../main/store/stateSchema.js';

export const PUBLISH_STATEMENT_TIMEOUT = '5s';

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
}

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
    }
  };
}
