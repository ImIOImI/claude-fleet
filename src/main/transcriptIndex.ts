// Incremental transcript indexer: turns JSONL turn text into embeddings.
// Pure text extraction + a write path that embeds pending turns. The embed
// function is injected so this module has no dependency on the model runtime
// (and tests can stub it).
import type Database from 'better-sqlite3';
import { insertEmbeddings, unembeddedTurnEvents, unembeddedSummaries } from './db.js';
import { encodeVector, decodeVector, topK, EMBED_MODEL_ID, EMBED_DIM, EMPTY_VECTOR, type EmbedFn } from './vectors.js';
import { perfSpan, perfSpanAsync } from './perf.js';

export type { EmbedFn };

// Truncation + batch size are MEMORY controls, not just throughput knobs:
// activation memory scales with batch × sequence length, and onnxruntime's
// arena holds its peak allocation for the life of the process. Measured on
// bge-small q8: 1000 chars × batch 8 holds ~300 MB steady; 2000 chars ×
// batch 64 on fp32 grew past 3 GB. Retrieval quality is insensitive to the
// tail truncation (the head of a turn carries its topic).
const MAX_CHARS = 1000;
const EMBED_BATCH = 8;

/** Human-readable text of a JSONL event's `message`, or '' if it carries none. */
export function extractText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n').trim();
}

/** Embed every pending turn for a session. Returns rows inserted. */
export async function indexSessionTurns(sessionId: string, embed: EmbedFn, batch = EMBED_BATCH): Promise<number> {
  let total = 0;
  // Loop so a session with a large backlog drains across batches.
  // unembeddedTurnEvents only returns rows still lacking an embedding, so the
  // cursor advances naturally as rows are inserted.
  for (;;) {
    // Once per session in the startup backfill — spanned so stalls it causes
    // self-attribute.
    const pending = await perfSpanAsync('claude_fleet.index.pending_turns',
      () => unembeddedTurnEvents(sessionId, EMBED_MODEL_ID, batch), { session_id: sessionId });
    if (pending.length === 0) break;

    const prepared = pending
      .map((ev) => {
        let text = '';
        try { text = extractText((JSON.parse(ev.rawJsonl) as { message?: unknown }).message); } catch { /* skip */ }
        return { ev, text: text.slice(0, MAX_CHARS) };
      })
      .filter((p) => p.text.length > 0);

    const placeholder = (ev: (typeof pending)[number]) => ({
      workspaceId: ev.workspaceId, sessionId, kind: 'turn' as const, refEventId: ev.id, ts: ev.ts,
      text: '', modelId: EMBED_MODEL_ID, dim: EMBED_DIM,
      vec: EMPTY_VECTOR, dedupKey: `t${ev.id}`,
    });

    if (prepared.length === 0) {
      // Nothing embeddable in this batch (all tool-only/empty). Insert a
      // vectorless placeholder so these rows leave the pending set and the
      // loop terminates; search skips text ''.
      await insertEmbeddings(pending.map(placeholder));
      continue;
    }

    const vecs = await embed(prepared.map((p) => p.text));
    total += await insertEmbeddings(
      prepared.map((p, i) => ({
        workspaceId: p.ev.workspaceId, sessionId, kind: 'turn' as const, refEventId: p.ev.id, ts: p.ev.ts,
        text: p.text, modelId: EMBED_MODEL_ID, dim: EMBED_DIM,
        vec: encodeVector(vecs[i]), dedupKey: `t${p.ev.id}`,
      }))
    );
    // Placeholder-insert the skipped (empty) rows in this batch too, so they
    // don't reappear as pending forever.
    await insertEmbeddings(pending.filter((ev) => !prepared.some((p) => p.ev.id === ev.id)).map(placeholder));
  }
  return total;
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
  const where = [`workspace_id IN (${ids.map(() => '?').join(',')})`, `model_id = ?`, `text <> ''`];
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
