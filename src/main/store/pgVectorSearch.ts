// pgvector reads on a caller-supplied Kysely: db.ts's Postgres search and the
// MCP read source share this one SQL.
import { sql, type Kysely } from 'kysely';
import type { EmbeddingHit } from '../db.js';
import { EMBED_MODEL_ID, dot } from '../vectors.js';
import type { StateDb } from './stateSchema.js';

/** pgvector's text form. Float32 → number → string round-trips exactly. */
export function pgVectorLiteral(v: Float32Array): string {
  return `[${Array.from(v).join(',')}]`;
}

/** Exact `ORDER BY vec <=> q, id` scan; an ANN index can't serve the `id` tiebreak. */
export async function pgSearchEmbeddings(
  k: Kysely<StateDb>, qvec: Float32Array, scope: readonly string[], opts: { limit: number; kind?: 'turn' | 'summary' },
): Promise<EmbeddingHit[]> {
  if (scope.length === 0 || opts.limit <= 0 || dot(qvec, qvec) === 0) return [];
  const q = pgVectorLiteral(qvec);
  return k.selectFrom('embeddings')
    .select(['session_id as sessionId', 'workspace_id as workspaceId', 'kind', 'ts', 'text',
      sql<number>`1 - (vec <=> ${q}::vector)`.as('score')])
    .where('workspace_id', 'in', [...scope]).where('model_id', '=', EMBED_MODEL_ID).where('text', '<>', '')
    .$if(opts.kind !== undefined, (qb) => qb.where('kind', '=', opts.kind as 'turn' | 'summary'))
    .orderBy(sql`vec <=> ${q}::vector`).orderBy('id')
    .limit(opts.limit)
    .execute();
}
