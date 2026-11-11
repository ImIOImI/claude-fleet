// Turn-indexing loop with the span injected, so fleet-host can run it without perf.ts.
import { insertSessionEmbeddings, unembeddedTurnEvents } from './db.js';
import { encodeVector, EMBED_MODEL_ID, EMBED_DIM, EMPTY_VECTOR, type EmbedFn } from './vectors.js';

export type SpanAsync = <T>(name: string, fn: () => Promise<T>, attrs?: Record<string, string | number>) => Promise<T>;

// Truncation + batch size are MEMORY controls, not just throughput knobs:
// activation memory scales with batch × sequence length, and onnxruntime's
// arena holds its peak allocation for the life of the process. Measured on
// bge-small q8: 1000 chars × batch 8 holds ~300 MB steady; 2000 chars ×
// batch 64 on fp32 grew past 3 GB. Retrieval quality is insensitive to the
// tail truncation (the head of a turn carries its topic).
export const MAX_CHARS = 1000;
export const EMBED_BATCH = 8;

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
export async function indexSessionTurnsWith(span: SpanAsync, sessionId: string, embed: EmbedFn, batch = EMBED_BATCH): Promise<number> {
  let total = 0;
  // Loop so a session with a large backlog drains across batches. Every
  // returned row gets a vector or a placeholder before the next read, so the
  // next read starts after the last id (no boundary re-walk per batch).
  let after: number | undefined;
  for (;;) {
    // Once per session in the startup backfill — spanned so stalls it causes
    // self-attribute.
    const pending = await span('claude_fleet.index.pending_turns',
      () => unembeddedTurnEvents(sessionId, EMBED_MODEL_ID, batch, after), { session_id: sessionId });
    if (pending.length === 0) break;
    after = pending[pending.length - 1].id;

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
      if ((await insertSessionEmbeddings(sessionId, pending.map(placeholder))) === null) break;
      continue;
    }

    const vecs = await embed(prepared.map((p) => p.text));
    // null: the session was deleted while embedding; its rows must not come back.
    const n = await insertSessionEmbeddings(sessionId,
      prepared.map((p, i) => ({
        workspaceId: p.ev.workspaceId, sessionId, kind: 'turn' as const, refEventId: p.ev.id, ts: p.ev.ts,
        text: p.text, modelId: EMBED_MODEL_ID, dim: EMBED_DIM,
        vec: encodeVector(vecs[i]), dedupKey: `t${p.ev.id}`,
      }))
    );
    if (n === null) break;
    total += n;
    // Placeholder-insert the skipped (empty) rows in this batch too, so they
    // don't reappear as pending forever.
    if ((await insertSessionEmbeddings(sessionId, pending.filter((ev) => !prepared.some((p) => p.ev.id === ev.id)).map(placeholder))) === null) break;
  }
  return total;
}
