import { afterEach, beforeEach, expect, it } from 'vitest';
import * as db from './db.js';
import { EMBED_DIM, EMBED_MODEL_ID, encodeVector } from './vectors.js';
import { openTestState, type TestState } from './store/testStore.js';

let st: TestState;
beforeEach(async () => { st = await openTestState('cf-search-emb-'); });
afterEach(() => st.close());

async function withSessions(rows: readonly db.EmbeddingInsert[]): Promise<void> {
  await db.stateKysely().insertInto('sessions').values([...new Set(rows.map((r) => r.sessionId))].map((id) => ({
    id, workspace_id: 'W-A', cwd: null, started_at: 1, last_active_at: 1, ai_title: null, first_user_message: null, user_set_name: null,
  }))).execute();
  await db.insertEmbeddings(rows);
}

function unit(seed: number): Float32Array {
  const v = new Float32Array(EMBED_DIM);
  let x = seed * 9301 + 49297;
  for (let i = 0; i < EMBED_DIM; i++) { x = (x * 9301 + 49297) % 233280; v[i] = x / 233280 - 0.5; }
  const n = Math.hypot(...v);
  return v.map((c) => c / n);
}

it('ranks the allowed workspaces by similarity, recorded across dialects', async () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({
    workspaceId: i % 3 === 0 ? 'W-OTHER' : 'W-A', sessionId: `s${i % 7}`, kind: (i % 5 === 0 ? 'summary' : 'turn') as 'turn' | 'summary',
    refEventId: i, ts: 1000 + i, text: i % 11 === 0 ? '' : `text ${i}`, modelId: EMBED_MODEL_ID, dim: EMBED_DIM,
    vec: encodeVector(unit(i)), dedupKey: `t${i}`,
  }));
  await withSessions(rows);
  const hits = await db.searchEmbeddings(unit(4), ['W-A'], { limit: 5 });
  // 1e-2: SQLite stores int8 (score error ~3e-4), Postgres float32; one snapshot serves both.
  expect(hits.map((h) => ({ ...h, score: Math.round(h.score * 1e2) / 1e2 }))).toMatchSnapshot();
  const kinds = await db.searchEmbeddings(unit(10), ['W-A', 'W-OTHER'], { limit: 3, kind: 'summary' });
  expect(kinds.map((h) => h.text)).toMatchSnapshot();
});

it('ties break by id, identically on both dialects', async () => {
  const vec = encodeVector(unit(1));
  const rows = [
    { workspaceId: 'W-A', sessionId: 's1', kind: 'turn' as const, refEventId: 1, ts: 1, text: 'first', modelId: EMBED_MODEL_ID, dim: EMBED_DIM, vec, dedupKey: 'tie1' },
    { workspaceId: 'W-B', sessionId: 's2', kind: 'turn' as const, refEventId: 2, ts: 2, text: 'second', modelId: EMBED_MODEL_ID, dim: EMBED_DIM, vec, dedupKey: 'tie2' },
    { workspaceId: 'W-A', sessionId: 's3', kind: 'turn' as const, refEventId: 3, ts: 3, text: 'third', modelId: EMBED_MODEL_ID, dim: EMBED_DIM, vec, dedupKey: 'tie3' },
    { workspaceId: 'W-B', sessionId: 's4', kind: 'turn' as const, refEventId: 4, ts: 4, text: 'fourth', modelId: EMBED_MODEL_ID, dim: EMBED_DIM, vec, dedupKey: 'tie4' },
  ];
  await withSessions(rows);
  const hits = await db.searchEmbeddings(unit(1), ['W-A', 'W-B'], { limit: 10 });
  expect(hits.map((h) => h.text)).toEqual(['first', 'second', 'third', 'fourth']);
});

it('never returns rows of a session that no longer exists, on both dialects', async () => {
  const vec = encodeVector(unit(1));
  const row = (sessionId: string, text: string) =>
    ({ workspaceId: 'W-A', sessionId, kind: 'turn' as const, refEventId: null, ts: 1, text, modelId: EMBED_MODEL_ID, dim: EMBED_DIM, vec, dedupKey: text });
  await withSessions([row('live', 'kept')]);
  await db.insertEmbeddings([row('gone', 'orphan')]);
  expect((await db.searchEmbeddings(unit(1), ['W-A'], { limit: 10 })).map((h) => h.text)).toEqual(['kept']);
});

it('returns [] for a non-positive limit, on both dialects', async () => {
  await db.insertEmbeddings([{ workspaceId: 'W-A', sessionId: 's1', kind: 'turn', refEventId: 1, ts: 1, text: 'x', modelId: EMBED_MODEL_ID, dim: EMBED_DIM, vec: encodeVector(unit(1)), dedupKey: 'lim1' }]);
  expect(await db.searchEmbeddings(unit(1), ['W-A'], { limit: 0 })).toEqual([]);
  expect(await db.searchEmbeddings(unit(1), ['W-A'], { limit: -1 })).toEqual([]);
});

it('returns [] for a zero-norm query vector, on both dialects', async () => {
  await db.insertEmbeddings([{ workspaceId: 'W-A', sessionId: 's1', kind: 'turn', refEventId: 1, ts: 1, text: 'x', modelId: EMBED_MODEL_ID, dim: EMBED_DIM, vec: encodeVector(unit(1)), dedupKey: 'zero1' }]);
  expect(await db.searchEmbeddings(new Float32Array(EMBED_DIM), ['W-A'], { limit: 5 })).toEqual([]);
});
