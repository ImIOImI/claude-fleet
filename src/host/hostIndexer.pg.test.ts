import { afterEach, describe, expect, it } from 'vitest';
import * as db from '../main/db.js';
import { isPg, openTestState, type TestState } from '../main/store/testStore.js';
import { EMBED_DIM, EMBED_MODEL_ID } from '../main/vectors.js';
import { startHostIndexer } from './hostIndexer.js';
import { createLogger } from './log.js';

const WS = '01JC0000000000000000000000';
const unit = (): Float32Array => new Float32Array(EMBED_DIM).fill(1 / Math.sqrt(EMBED_DIM));
const turn = (uuid: string, type: string, content: string) =>
  JSON.stringify({ type, uuid, timestamp: '2026-11-05T00:00:00Z', message: { role: type, content } });

describe.skipIf(!isPg)('host indexer on Postgres', () => {
  let st: TestState | null = null;
  afterEach(async () => { await st?.close(); st = null; });

  it('backfills every session once and drops vectors of other models', async () => {
    st = await openTestState('hix-');
    await db.ingestBatch(WS, 's1', [turn('u1', 'user', 'first'), turn('a1', 'assistant', 'second')]);
    await db.insertEmbeddings([{ workspaceId: WS, sessionId: 's1', kind: 'turn', refEventId: null, ts: 1, text: 'stale', modelId: 'old@fp32', dim: EMBED_DIM, vec: Buffer.from(unit().buffer), dedupKey: 'old' }]);
    const k = db.stateKysely();
    const count = async (model: string) =>
      Number((await k.selectFrom('embeddings').select((eb) => eb.fn.countAll().as('n')).where('model_id', '=', model).executeTakeFirstOrThrow()).n);
    const texts: string[] = [];
    const log = createLogger(() => undefined);
    const ix = startHostIndexer({ embed: async (t) => { texts.push(...t); return t.map(() => unit()); }, log });
    await ix.backfill();
    await ix.stop(5000);
    expect(await count(EMBED_MODEL_ID)).toBe(2);
    expect(await count('old@fp32')).toBe(0);
    expect(texts.sort()).toEqual(['first', 'second']);
    const again = startHostIndexer({ embed: async (t) => { texts.push(...t); return t.map(() => unit()); }, log });
    await again.backfill();
    await again.stop(5000);
    expect(await count(EMBED_MODEL_ID)).toBe(2);
    expect(texts).toHaveLength(2);
  });
});
