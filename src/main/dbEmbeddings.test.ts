import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb, deleteEmbeddingsForOtherModels, ingestLine, insertEmbedding, unembeddedTurnEvents, maxEventId } from './db.js';
import { encodeVector, EMBED_MODEL_ID, EMBED_DIM } from './vectors.js';

let dir: string;
const WS = '01WS';
const SES = 'ses-1';

function userLine(id: string, text: string): string {
  return JSON.stringify({ type: 'user', uuid: id, timestamp: '2026-07-01T00:00:00Z', message: { content: text } });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cf-emb-'));
  openDb(dir);
});
afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe('embeddings schema + helpers', () => {
  it('lists user/assistant events that have no turn embedding yet', () => {
    ingestLine(WS, SES, userLine('u1', 'hello there'));
    ingestLine(WS, SES, userLine('u2', 'second message'));
    const pending = unembeddedTurnEvents(SES, EMBED_MODEL_ID);
    expect(pending.length).toBe(2);
    expect(pending[0].rawJsonl).toContain('hello there');
  });

  it('insertEmbedding removes a turn from the pending set and dedupes', () => {
    ingestLine(WS, SES, userLine('u1', 'hello there'));
    const [ev] = unembeddedTurnEvents(SES, EMBED_MODEL_ID);
    const row = {
      workspaceId: WS, sessionId: SES, kind: 'turn' as const, refEventId: ev.id,
      ts: ev.ts, text: 'hello there', modelId: EMBED_MODEL_ID, dim: 3,
      vec: encodeVector(Float32Array.from([1, 0, 0])), dedupKey: `t${ev.id}`,
    };
    expect(insertEmbedding(row)).toBe(true);
    expect(insertEmbedding(row)).toBe(false); // dedup
    expect(unembeddedTurnEvents(SES, EMBED_MODEL_ID).length).toBe(0);
  });

  it('maxEventId returns the largest event id for a session', () => {
    ingestLine(WS, SES, userLine('u1', 'a'));
    ingestLine(WS, SES, userLine('u2', 'b'));
    expect(maxEventId(SES)).toBeGreaterThan(0);
  });
});

describe('deleteEmbeddingsForOtherModels', () => {
  it('drops rows keyed to a different model, keeps the current ones', () => {
    ingestLine(WS, SES, userLine('u1', 'hello there'));
    const [ev] = unembeddedTurnEvents(SES, EMBED_MODEL_ID);
    insertEmbedding({
      workspaceId: WS, sessionId: SES, kind: 'turn', refEventId: ev.id,
      ts: ev.ts, text: 'old fp32 row', modelId: 'Xenova/bge-small-en-v1.5', dim: EMBED_DIM,
      vec: encodeVector(new Float32Array(EMBED_DIM)), dedupKey: `t${ev.id}-old`,
    });
    insertEmbedding({
      workspaceId: WS, sessionId: SES, kind: 'turn', refEventId: ev.id,
      ts: ev.ts, text: 'current row', modelId: EMBED_MODEL_ID, dim: EMBED_DIM,
      vec: encodeVector(new Float32Array(EMBED_DIM)), dedupKey: `t${ev.id}`,
    });
    expect(deleteEmbeddingsForOtherModels(EMBED_MODEL_ID)).toBe(1);
    // The current-model row still satisfies the pending query (row is embedded).
    expect(unembeddedTurnEvents(SES, EMBED_MODEL_ID).length).toBe(0);
    expect(deleteEmbeddingsForOtherModels(EMBED_MODEL_ID)).toBe(0);
  });
});
