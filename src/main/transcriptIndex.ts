// Incremental transcript indexer: turns JSONL turn text into embeddings.
// Pure text extraction + a write path that embeds pending turns. The embed
// function is injected so this module has no dependency on the model runtime
// (and tests can stub it).
import type Database from 'better-sqlite3';
import { insertEmbedding, unembeddedTurnEvents, unembeddedSummaries, getDb } from './db.js';
import { encodeVector, decodeVector, topK, EMBED_MODEL_ID, EMBED_DIM } from './vectors.js';

export type EmbedFn = (texts: string[]) => Promise<Float32Array[]>;

const MAX_CHARS = 2000;

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
export async function indexSessionTurns(sessionId: string, embed: EmbedFn, batch = 64): Promise<number> {
  let total = 0;
  // Loop so a session with a large backlog drains across batches.
  // unembeddedTurnEvents only returns rows still lacking an embedding, so the
  // cursor advances naturally as rows are inserted.
  for (;;) {
    const pending = unembeddedTurnEvents(sessionId, EMBED_MODEL_ID, batch);
    if (pending.length === 0) break;

    const prepared = pending
      .map((ev) => {
        let text = '';
        try { text = extractText((JSON.parse(ev.rawJsonl) as { message?: unknown }).message); } catch { /* skip */ }
        return { ev, text: text.slice(0, MAX_CHARS) };
      })
      .filter((p) => p.text.length > 0);

    if (prepared.length === 0) {
      // Nothing embeddable in this batch (all tool-only/empty). Insert a
      // zero-vector placeholder so these rows leave the pending set and the
      // loop terminates. They score ~0 and never surface in search.
      for (const { ev } of pending) {
        insertEmbedding({
          workspaceId: ev.workspaceId, sessionId, kind: 'turn', refEventId: ev.id, ts: ev.ts,
          text: '', modelId: EMBED_MODEL_ID, dim: EMBED_DIM,
          vec: encodeVector(new Float32Array(EMBED_DIM)), dedupKey: `t${ev.id}`,
        });
      }
      continue;
    }

    const vecs = await embed(prepared.map((p) => p.text));
    prepared.forEach((p, i) => {
      const ok = insertEmbedding({
        workspaceId: p.ev.workspaceId, sessionId, kind: 'turn', refEventId: p.ev.id, ts: p.ev.ts,
        text: p.text, modelId: EMBED_MODEL_ID, dim: EMBED_DIM,
        vec: encodeVector(vecs[i]), dedupKey: `t${p.ev.id}`,
      });
      if (ok) total++;
    });
    // Placeholder-insert the skipped (empty) rows in this batch too, so they
    // don't reappear as pending forever.
    for (const ev of pending) {
      if (!prepared.some((p) => p.ev.id === ev.id)) {
        insertEmbedding({
          workspaceId: ev.workspaceId, sessionId, kind: 'turn', refEventId: ev.id, ts: ev.ts,
          text: '', modelId: EMBED_MODEL_ID, dim: EMBED_DIM,
          vec: encodeVector(new Float32Array(EMBED_DIM)), dedupKey: `t${ev.id}`,
        });
      }
    }
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

export async function searchTranscripts(
  query: string,
  allowedWorkspaces: Set<string>,
  embed: EmbedFn,
  opts: { limit?: number; kind?: 'turn' | 'summary' } = {},
  db: Database.Database = getDb(),
): Promise<SearchHit[]> {
  const ids = [...allowedWorkspaces];
  if (ids.length === 0 || query.trim().length === 0) return [];
  const limit = Math.max(1, Math.min(50, opts.limit ?? 10));

  const [qvec] = await embed([query.trim()]);
  const where = [`workspace_id IN (${ids.map(() => '?').join(',')})`, `model_id = ?`, `text <> ''`];
  const params: unknown[] = [...ids, EMBED_MODEL_ID];
  if (opts.kind) { where.push('kind = ?'); params.push(opts.kind); }

  const rows = db
    .prepare(`SELECT session_id AS sessionId, workspace_id AS workspaceId, kind, ts, text, vec
              FROM embeddings WHERE ${where.join(' AND ')}`)
    .all(...params) as Array<{ sessionId: string; workspaceId: string; kind: 'turn' | 'summary'; ts: number | null; text: string; vec: Buffer }>;

  const cands = rows.map((r) => ({ vec: decodeVector(r.vec) }));
  return topK(qvec, cands, limit).map(({ index, score }) => {
    const r = rows[index];
    return { sessionId: r.sessionId, workspaceId: r.workspaceId, kind: r.kind, ts: r.ts, text: r.text, score };
  });
}

export async function indexSessionSummaries(embed: EmbedFn, batch = 64): Promise<number> {
  let total = 0;
  for (;;) {
    const pending = unembeddedSummaries(EMBED_MODEL_ID, batch);
    if (pending.length === 0) break;
    const vecs = await embed(pending.map((p) => p.summary.slice(0, MAX_CHARS)));
    pending.forEach((p, i) => {
      const ok = insertEmbedding({
        workspaceId: p.workspaceId, sessionId: p.sessionId, kind: 'summary', refEventId: null, ts: p.ts,
        text: p.summary.slice(0, MAX_CHARS), modelId: EMBED_MODEL_ID, dim: EMBED_DIM,
        vec: encodeVector(vecs[i]), dedupKey: String(p.sourceMaxEventId),
      });
      if (ok) total++;
    });
    if (pending.length < batch) break;
  }
  return total;
}
