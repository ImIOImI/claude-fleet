import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as db from '../db.js';
import { EMBED_DIM, EMBED_MODEL_ID, dot, encodeVector, topK } from '../vectors.js';
import { pgSearchEmbeddings } from './pgVectorSearch.js';
import { isPg, openTestState, type TestState } from './testStore.js';

// D64: pgvector's `1 - (vec <=> q)` is the same cosine the desktop's dot over
// unit float32 vectors computes, so merged scores sort together.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}
function unitVec(next: () => number): Float32Array {
  const v = new Float32Array(EMBED_DIM);
  for (let i = 0; i < EMBED_DIM; i++) v[i] = next() * 2 - 1;
  const n = Math.hypot(...v);
  return v.map((c) => c / n);
}

describe.skipIf(!isPg)('pgvector score parity (D64)', () => {
  let st: TestState;
  beforeEach(async () => { st = await openTestState('cf-pgvec-'); });
  afterEach(() => st.close());

  it('scores equal the float32 dot product within 1e-5, ordered as topK', async () => {
    const next = rng(20261110);
    const vecs = Array.from({ length: 20 }, () => unitVec(next));
    await db.insertEmbeddings(vecs.map((v, i) => ({
      workspaceId: 'W', sessionId: `s${i}`, kind: 'turn' as const, refEventId: i, ts: i, text: `t${i}`,
      modelId: EMBED_MODEL_ID, dim: EMBED_DIM, vec: encodeVector(v), dedupKey: `p${i}`,
    })));
    for (let round = 0; round < 5; round++) {
      const q = unitVec(next);
      const hits = await pgSearchEmbeddings(db.stateKysely(), q, ['W'], { limit: 20 });
      expect(hits).toHaveLength(20);
      for (const h of hits) {
        const i = Number(h.sessionId.slice(1));
        expect(Math.abs(Number(h.score) - dot(q, vecs[i]))).toBeLessThan(1e-5);
      }
      const want = topK(q, vecs.map((vec) => ({ vec })), 20);
      hits.forEach((h, j) => {
        if (h.sessionId === `s${want[j].index}`) return;
        expect(Math.abs(dot(q, vecs[Number(h.sessionId.slice(1))]) - want[j].score)).toBeLessThan(1e-6);
      });
    }
  });
});
