import { describe, it, expect, beforeEach } from 'vitest';
import {
  deleteSession, eventsForSession, ingestLine, insertEmbedding, maintenanceGet, maintenanceSet, stateKysely,
  unembeddedTurnEvents,
} from './db.js';
import { deflateLine } from './state/rawCodec.js';
import { encodeVector, EMBED_DIM, EMBED_MODEL_ID } from './vectors.js';
import { openTestState, queryRows } from './store/testStore.js';

const WS = '01WS';
const SES = 'ses-r';
const line = JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-07-01T00:00:00Z', message: { content: 'hello there '.repeat(80) } });

beforeEach(async () => {
  await openTestState('cf-ret-schema-');
});

async function compressAll(): Promise<void> {
  await stateKysely().updateTable('events').set({ raw_jsonl: '', raw_z: deflateLine(line) }).execute();
}

describe('state v16 retention schema', () => {
  it('reads a compressed row back as its original line', async () => {
    await ingestLine(WS, SES, line);
    await compressAll();
    const [ev] = await eventsForSession(SES);
    expect(ev.rawJsonl).toBe(line);
    const [pending] = await unembeddedTurnEvents(SES, EMBED_MODEL_ID);
    expect(pending.rawJsonl).toBe(line);
  });

  it('deleteSession removes embeddings and retention watermarks', async () => {
    await ingestLine(WS, SES, line);
    const [ev] = await unembeddedTurnEvents(SES, EMBED_MODEL_ID);
    const v = new Float32Array(EMBED_DIM); v[0] = 1;
    await insertEmbedding({
      workspaceId: WS, sessionId: SES, kind: 'turn', refEventId: ev.id, ts: ev.ts, text: 'hello',
      modelId: EMBED_MODEL_ID, dim: EMBED_DIM, vec: encodeVector(v), dedupKey: `t${ev.id}`,
    });
    await stateKysely().insertInto('event_retention').values({ session_id: SES, workspace_id: WS }).execute();
    await deleteSession(SES);
    expect(await queryRows('SELECT id FROM embeddings WHERE session_id = ?', [SES])).toEqual([]);
    expect(await queryRows('SELECT session_id FROM event_retention WHERE session_id = ?', [SES])).toEqual([]);
  });

  it('maintenance values round-trip and overwrite', async () => {
    expect(await maintenanceGet('k')).toBeNull();
    await maintenanceSet('k', 'a');
    await maintenanceSet('k', 'b');
    expect(await maintenanceGet('k')).toBe('b');
  });
});
