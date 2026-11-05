import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb, deleteEmbeddingsForOtherModels, ingestLine, insertEmbedding, insertEmbeddings, unembeddedTurnEvents, maxEventId } from './db.js';
import { encodeVector, EMBED_MODEL_ID, EMBED_DIM } from './vectors.js';
import { openTestState, type TestState } from './store/testStore.js';

let dir: string;
const WS = '01WS';
const SES = 'ses-1';
/** Postgres stores vector(EMBED_DIM), so test vectors are full-width. */
const unitVec = (): Float32Array => { const v = new Float32Array(EMBED_DIM); v[0] = 1; return v; };

function userLine(id: string, text: string): string {
  return JSON.stringify({ type: 'user', uuid: id, timestamp: '2026-07-01T00:00:00Z', message: { content: text } });
}

let st: TestState;
beforeEach(async () => {
  st = await openTestState('cf-emb-');
  dir = st.dir;
});
afterEach(async () => {
  await st.close();
});

describe('embeddings schema + helpers', () => {
  it('lists user/assistant events that have no turn embedding yet', async () => {
    await ingestLine(WS, SES, userLine('u1', 'hello there'));
    await ingestLine(WS, SES, userLine('u2', 'second message'));
    const pending = await unembeddedTurnEvents(SES, EMBED_MODEL_ID);
    expect(pending.length).toBe(2);
    expect(pending[0].rawJsonl).toContain('hello there');
  });

  it('insertEmbedding removes a turn from the pending set and dedupes', async () => {
    await ingestLine(WS, SES, userLine('u1', 'hello there'));
    const [ev] = await unembeddedTurnEvents(SES, EMBED_MODEL_ID);
    const row = {
      workspaceId: WS, sessionId: SES, kind: 'turn' as const, refEventId: ev.id,
      ts: ev.ts, text: 'hello there', modelId: EMBED_MODEL_ID, dim: EMBED_DIM,
      vec: encodeVector(unitVec()), dedupKey: `t${ev.id}`,
    };
    expect(await insertEmbedding(row)).toBe(true);
    expect(await insertEmbedding(row)).toBe(false); // dedup
    expect((await unembeddedTurnEvents(SES, EMBED_MODEL_ID)).length).toBe(0);
  });

  it('maxEventId returns the largest event id for a session', async () => {
    await ingestLine(WS, SES, userLine('u1', 'a'));
    await ingestLine(WS, SES, userLine('u2', 'b'));
    expect(await maxEventId(SES)).toBeGreaterThan(0);
  });
});

describe('insertEmbeddings (batch)', () => {
  it('inserts every row in one call and counts only the ones that actually landed', async () => {
    await ingestLine(WS, SES, userLine('u1', 'first'));
    await ingestLine(WS, SES, userLine('u2', 'second'));
    const pending = await unembeddedTurnEvents(SES, EMBED_MODEL_ID);
    expect(pending.length).toBe(2);
    const row = (ev: (typeof pending)[number], text: string) => ({
      workspaceId: WS, sessionId: SES, kind: 'turn' as const, refEventId: ev.id,
      ts: ev.ts, text, modelId: EMBED_MODEL_ID, dim: EMBED_DIM,
      vec: encodeVector(unitVec()), dedupKey: `t${ev.id}`,
    });
    const rows = [row(pending[0], 'first'), row(pending[1], 'second')];

    expect(await insertEmbeddings(rows)).toBe(2);
    expect((await unembeddedTurnEvents(SES, EMBED_MODEL_ID)).length).toBe(0);

    // Re-inserting the same dedup keys lands zero new rows (ON CONFLICT DO NOTHING).
    expect(await insertEmbeddings(rows)).toBe(0);
  });

  it('a partial duplicate counts only the rows that landed, same as single-row insertEmbedding', async () => {
    await ingestLine(WS, SES, userLine('u1', 'first'));
    const [ev] = await unembeddedTurnEvents(SES, EMBED_MODEL_ID);
    const row = {
      workspaceId: WS, sessionId: SES, kind: 'turn' as const, refEventId: ev.id,
      ts: ev.ts, text: 'first', modelId: EMBED_MODEL_ID, dim: EMBED_DIM,
      vec: encodeVector(unitVec()), dedupKey: `t${ev.id}`,
    };
    expect(await insertEmbedding(row)).toBe(true); // already there before the batch call
    const other = { ...row, sessionId: 'ses-2', dedupKey: `t${ev.id}-other` };
    expect(await insertEmbeddings([row, other])).toBe(1); // row dupes, other lands
  });

  it('an empty batch is a no-op', async () => {
    expect(await insertEmbeddings([])).toBe(0);
  });
});

describe('deleteEmbeddingsForOtherModels', () => {
  it('drops rows keyed to a different model, keeps the current ones', async () => {
    await ingestLine(WS, SES, userLine('u1', 'hello there'));
    const [ev] = await unembeddedTurnEvents(SES, EMBED_MODEL_ID);
    await insertEmbedding({
      workspaceId: WS, sessionId: SES, kind: 'turn', refEventId: ev.id,
      ts: ev.ts, text: 'old fp32 row', modelId: 'Xenova/bge-small-en-v1.5', dim: EMBED_DIM,
      vec: encodeVector(new Float32Array(EMBED_DIM)), dedupKey: `t${ev.id}-old`,
    });
    await insertEmbedding({
      workspaceId: WS, sessionId: SES, kind: 'turn', refEventId: ev.id,
      ts: ev.ts, text: 'current row', modelId: EMBED_MODEL_ID, dim: EMBED_DIM,
      vec: encodeVector(new Float32Array(EMBED_DIM)), dedupKey: `t${ev.id}`,
    });
    expect(await deleteEmbeddingsForOtherModels(EMBED_MODEL_ID)).toBe(1);
    // The current-model row still satisfies the pending query (row is embedded).
    expect((await unembeddedTurnEvents(SES, EMBED_MODEL_ID)).length).toBe(0);
    expect(await deleteEmbeddingsForOtherModels(EMBED_MODEL_ID)).toBe(0);
  });
});
