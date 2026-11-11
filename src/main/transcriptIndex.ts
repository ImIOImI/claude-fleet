// Incremental transcript indexer: turns JSONL turn text into embeddings.
// Pure text extraction + a write path that embeds pending turns. The embed
// function is injected so this module has no dependency on the model runtime
// (and tests can stub it).
import type Database from 'better-sqlite3';
import { insertEmbeddings, unembeddedSummaries } from './db.js';
import { encodeVector, decodeVector, topK, EMBED_MODEL_ID, EMBED_DIM, type EmbedFn } from './vectors.js';
import { perfSpan, perfSpanAsync } from './perf.js';
import { EMBED_BATCH, MAX_CHARS, extractText, indexSessionTurnsWith } from './transcriptIndexCore.js';

export type { EmbedFn };
export { extractText };

/** Embed every pending turn for a session. Returns rows inserted. */
export async function indexSessionTurns(sessionId: string, embed: EmbedFn, batch?: number): Promise<number> {
  return indexSessionTurnsWith(perfSpanAsync, sessionId, embed, batch);
}

export interface SearchHit {
  sessionId: string;
  workspaceId: string;
  kind: 'turn' | 'summary';
  ts: number | null;
  text: string;
  score: number;
}

/** Brute-force cosine scan of `ids`' current-model embeddings on a SQLite
 *  connection (the MCP server's read-only one). */
export function searchVectorsSqlite(
  db: Database.Database,
  qvec: Float32Array,
  ids: readonly string[],
  opts: { limit: number; kind?: 'turn' | 'summary' },
): SearchHit[] {
  if (ids.length === 0) return [];
  const where = [`workspace_id IN (${ids.map(() => '?').join(',')})`, `model_id = ?`, `text <> ''`,
    'EXISTS (SELECT 1 FROM sessions s WHERE s.id = embeddings.session_id)'];
  const params: unknown[] = [...ids, EMBED_MODEL_ID];
  if (opts.kind) { where.push('kind = ?'); params.push(opts.kind); }

  // Brute-force scan: every allowed vector is read and scored synchronously.
  // Spanned because its cost (and transient memory) grows with the corpus.
  const { rows, ranked } = perfSpan('claude_fleet.search.scan', () => {
    const rows = db
      .prepare(`SELECT session_id AS sessionId, workspace_id AS workspaceId, kind, ts, text, vec
                FROM embeddings WHERE ${where.join(' AND ')}`)
      .all(...params) as Array<{ sessionId: string; workspaceId: string; kind: 'turn' | 'summary'; ts: number | null; text: string; vec: Buffer }>;
    const cands = rows.map((r) => ({ vec: decodeVector(r.vec) }));
    return { rows, ranked: topK(qvec, cands, opts.limit) };
  });
  return ranked.map(({ index, score }) => {
    const r = rows[index];
    return { sessionId: r.sessionId, workspaceId: r.workspaceId, kind: r.kind, ts: r.ts, text: r.text, score };
  });
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
