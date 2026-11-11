import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { deleteEmbeddingsForOtherModels, ingestLine, insertEmbedding, insertEmbeddings, unembeddedTurnEvents, maxEventId, sessionsWithPendingTurns, sessionsWithPendingTurnsQuery, stateKysely, withRawSqlite } from './db.js';
import { encodeVector, EMBED_MODEL_ID, EMBED_DIM } from './vectors.js';
import { isPg, openTestState, type TestState } from './store/testStore.js';

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

  it('reads only the turns after the newest embedded one, oldest first, across user and assistant (#583)', async () => {
    const assistantLine = (id: string, text: string) => JSON.stringify({
      type: 'assistant', uuid: id, timestamp: '2026-07-01T00:00:00Z', message: { model: 'm', content: [{ type: 'text', text }] },
    });
    await ingestLine(WS, SES, userLine('u1', 'one'));
    await ingestLine(WS, SES, assistantLine('a2', 'two'));
    await ingestLine(WS, SES, userLine('u3', 'three'));
    const all = await unembeddedTurnEvents(SES, EMBED_MODEL_ID);
    expect(all.map((e) => e.rawJsonl.includes('two'))).toEqual([false, true, false]);
    const embed = (ev: (typeof all)[number]) => ({
      workspaceId: WS, sessionId: SES, kind: 'turn' as const, refEventId: ev.id,
      ts: ev.ts, text: 'x', modelId: EMBED_MODEL_ID, dim: EMBED_DIM, vec: encodeVector(unitVec()), dedupKey: `t${ev.id}`,
    });
    // The assistant turn is the newest embedded one: only the user turn after it is pending.
    await insertEmbeddings([embed(all[0]), embed(all[1])]);
    await ingestLine(WS, SES, assistantLine('a4', 'four'));
    const tail = await unembeddedTurnEvents(SES, EMBED_MODEL_ID);
    expect(tail.map((e) => e.id)).toEqual([all[2].id, tail[1].id]);
    expect(tail[1].rawJsonl).toContain('four');
    expect((await unembeddedTurnEvents(SES, EMBED_MODEL_ID, 1)).map((e) => e.id)).toEqual([all[2].id]);
    // Another model's embeddings don't move the boundary.
    expect(await unembeddedTurnEvents(SES, 'other-model')).toHaveLength(4);
  });

  it.skipIf(isPg)('the pending-turns boundary walks idx_events_session_type newest-first with no sort (#583)', async () => {
    const plan = await withRawSqlite((d) => (d.prepare(`EXPLAIN QUERY PLAN
      SELECT e.id FROM events e WHERE e.session_id = ? AND e.type = ?
        AND EXISTS (SELECT em.id FROM embeddings em WHERE em.ref_event_id = e.id AND em.kind = 'turn' AND em.model_id = ?)
      ORDER BY e.id DESC LIMIT 1`).all(SES, 'user', EMBED_MODEL_ID) as { detail: string }[]).map((r) => r.detail).join('\n'));
    expect(plan).toMatch(/idx_events_session_type/);
    expect(plan).toMatch(/idx_emb_ref_event/);
    expect(plan).not.toMatch(/TEMP B-TREE/);
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

  it('deletes in chunks and yields between them', async () => {
    await ingestLine(WS, SES, userLine('u1', 'hello there'));
    const [ev] = await unembeddedTurnEvents(SES, EMBED_MODEL_ID);
    const row = (i: number, modelId: string) => ({
      workspaceId: WS, sessionId: SES, kind: 'turn' as const, refEventId: ev.id, ts: ev.ts, text: 'x',
      modelId, dim: EMBED_DIM, vec: encodeVector(new Float32Array(EMBED_DIM)), dedupKey: `k${i}`,
    });
    await insertEmbeddings(Array.from({ length: 12 }, (_, i) => row(i, 'retired@fp32')));
    await insertEmbeddings([row(99, EMBED_MODEL_ID)]);
    let yields = 0;
    expect(await deleteEmbeddingsForOtherModels(EMBED_MODEL_ID, 5, async () => { yields++; })).toBe(12);
    expect(yields).toBe(2);
    expect(await deleteEmbeddingsForOtherModels(EMBED_MODEL_ID, 5, async () => { yields++; })).toBe(0);
    expect(yields).toBe(2);
  });
});

describe('sessionsWithPendingTurns', () => {
  const embed = async (sessionId: string, modelId = EMBED_MODEL_ID, upTo = Infinity) => {
    const pending = await unembeddedTurnEvents(sessionId, EMBED_MODEL_ID, 1000);
    await insertEmbeddings(pending.filter((_, i) => i < upTo).map((ev) => ({
      workspaceId: WS, sessionId, kind: 'turn' as const, refEventId: ev.id, ts: ev.ts, text: 'x', modelId, dim: EMBED_DIM,
      vec: encodeVector(unitVec()), dedupKey: modelId === EMBED_MODEL_ID ? `t${ev.id}` : `old${ev.id}`,
    })));
  };
  const perSession = async (ids: string[]) => {
    const out: string[] = [];
    for (const id of ids) if ((await unembeddedTurnEvents(id, EMBED_MODEL_ID)).length > 0) out.push(id);
    return out;
  };
  const ts = (n: number) => `2026-07-0${n}T00:00:00Z`;
  const line = (type: string, id: string, n: number) => JSON.stringify({ type, uuid: id, timestamp: ts(n), message: { content: `m ${id}` } });

  it('matches a per-session pending-turns read, in listSessions order', async () => {
    // fresh: nothing embedded; done: all; partial: the oldest turn only;
    // stale: only another model's; quiet: no user/assistant events.
    for (const [ses, n] of [['fresh', 1], ['done', 2], ['partial', 3], ['stale', 4], ['quiet', 5]] as const) {
      if (ses === 'quiet') {
        await ingestLine(WS, ses, JSON.stringify({ type: 'system', uuid: `${ses}-s`, timestamp: ts(n) }));
        continue;
      }
      await ingestLine(WS, ses, line('user', `${ses}-1`, n));
      await ingestLine(WS, ses, line('assistant', `${ses}-2`, n));
    }
    await embed('done');
    await embed('partial', EMBED_MODEL_ID, 1);
    await embed('stale', 'old-model');

    const newestFirst = ['quiet', 'stale', 'partial', 'done', 'fresh'];
    expect(await sessionsWithPendingTurns(EMBED_MODEL_ID)).toEqual(await perSession(newestFirst));
    expect(await sessionsWithPendingTurns(EMBED_MODEL_ID)).toEqual(['stale', 'partial', 'fresh']);

    await ingestLine(WS, 'done', line('user', 'done-3', 2));
    expect(await sessionsWithPendingTurns(EMBED_MODEL_ID)).toContain('done');
    for (const ses of ['done', 'partial', 'stale', 'fresh']) await embed(ses);
    expect(await sessionsWithPendingTurns(EMBED_MODEL_ID)).toEqual([]);
  });
});

describe.skipIf(isPg)('sessionsWithPendingTurns plan', () => {
  it("computes each session's newest turn once, through the session/type index", async () => {
    const c = sessionsWithPendingTurnsQuery(stateKysely(), EMBED_MODEL_ID).compile();
    const plan = (await withRawSqlite((d) => d.prepare(`EXPLAIN QUERY PLAN ${c.sql}`).all(...(c.parameters as unknown[])) as Array<{ detail: string }>))!
      .map((r) => r.detail);
    expect(plan).toContain('MATERIALIZE x');
    expect(plan.filter((d) => d.includes('idx_events_session_type'))).toHaveLength(1);
    expect(plan.some((d) => d.includes('idx_emb_ref_event'))).toBe(true);
  });
});
