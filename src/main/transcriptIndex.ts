// Incremental transcript indexer: turns JSONL turn text into embeddings.
// Pure text extraction + a write path that embeds pending turns. The embed
// function is injected so this module has no dependency on the model runtime
// (and tests can stub it).
import type Database from 'better-sqlite3';
import { insertEmbeddings, unembeddedSummaries } from './db.js';
import { encodeVector, EMBED_MODEL_ID, EMBED_DIM, type EmbedFn } from './vectors.js';
import { perfSpanAsync } from './perf.js';
import { scanTopK, type ScanJob, type ScanHit } from './searchWorker.js';
import { EMBED_BATCH, MAX_CHARS, extractText, indexSessionTurnsWith } from './transcriptIndexCore.js';

export type { EmbedFn };
export { extractText };

/** Embed every pending turn for a session. Returns rows inserted. */
export async function indexSessionTurns(sessionId: string, embed: EmbedFn, batch?: number): Promise<number> {
  return indexSessionTurnsWith(perfSpanAsync, sessionId, embed, batch);
}

export type SearchHit = ScanHit;

/** Brute-force cosine scan of `ids`' current-model embeddings on a SQLite
 *  connection, inline on the calling thread. The MCP read source runs the same
 *  scan in a worker (searchWorker.ts) and uses this only as the fallback. */
export function searchVectorsSqlite(
  db: Database.Database,
  qvec: Float32Array,
  ids: readonly string[],
  opts: { limit: number; kind?: 'turn' | 'summary' },
): SearchHit[] {
  return scanTopK(db, qvec, scanJob(ids, opts)).hits;
}

export function scanJob(ids: readonly string[], opts: { limit: number; kind?: 'turn' | 'summary' }): ScanJob {
  return { allowed: [...ids], modelId: EMBED_MODEL_ID, kind: opts.kind, limit: opts.limit, dim: EMBED_DIM };
}

/** Embed `query`, then searchVectorsSqlite. Kept for the state bench and
 *  transcriptSearch.test.ts; the MCP tool embeds and calls its ReadSource. */
export async function searchTranscripts(
  query: string,
  allowedWorkspaces: Set<string>,
  embed: EmbedFn,
  opts: { limit?: number; kind?: 'turn' | 'summary' },
  /** The MCP server's read-only connection; search stays raw better-sqlite3
   *  (SPEC §11). */
  db: Database.Database,
): Promise<SearchHit[]> {
  const ids = [...allowedWorkspaces];
  if (ids.length === 0 || query.trim().length === 0) return [];
  const limit = Math.max(1, Math.min(50, opts.limit ?? 10));
  const [qvec] = await embed([query.trim()]);
  return searchVectorsSqlite(db, qvec, ids, { limit, kind: opts.kind });
}

export async function indexSessionSummaries(embed: EmbedFn, batch = EMBED_BATCH): Promise<number> {
  let total = 0;
  for (;;) {
    const pending = await perfSpanAsync('claude_fleet.index.pending_summaries', () => unembeddedSummaries(EMBED_MODEL_ID, batch));
    if (pending.length === 0) break;
    const vecs = await embed(pending.map((p) => p.summary.slice(0, MAX_CHARS)));
    total += await insertEmbeddings(
      pending.map((p, i) => ({
        workspaceId: p.workspaceId, sessionId: p.sessionId, kind: 'summary' as const, refEventId: null, ts: p.ts,
        text: p.summary.slice(0, MAX_CHARS), modelId: EMBED_MODEL_ID, dim: EMBED_DIM,
        vec: encodeVector(vecs[i]), dedupKey: String(p.sourceMaxEventId),
      }))
    );
    if (pending.length < batch) break;
  }
  return total;
}
