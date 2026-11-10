import { describe, it, expect, beforeEach } from 'vitest';
import { ingestLine, insertEmbedding, nextPurgeChunk, purgeWorkspace, recordUsageEvent, setRetentionWatermarks, stateKysely, workspaceIdsInState } from './db.js';
import { encodeVector, EMBED_DIM, EMBED_MODEL_ID } from './vectors.js';
import { openTestState, queryRows } from './store/testStore.js';
import { sweepOrphans, type Throttle } from './state/retention.js';

const A = '01KW2JNC0K9JDYS8WAZBNT33X1';
const B = '01KW2MR8MZ7RXZ7171RYT6JKFA';
const unthrottled: Throttle = { slice: (_step, fn) => fn({ targetMs: 35, now: () => 0, begin: () => undefined, elapsed: () => 0, expired: () => false, note: () => undefined }), stopped: () => false };

const TABLES = ['events', 'sessions', 'embeddings', 'usage_events', 'session_costs', 'session_stats',
  'session_tool_counts', 'event_retention', 'session_summaries', 'session_tags'];

async function seedWorkspace(ws: string, ses: string): Promise<void> {
  await ingestLine(ws, ses, JSON.stringify({
    type: 'assistant', uuid: `${ses}-a`, timestamp: '2026-09-01T00:00:00Z',
    message: { model: 'claude-opus-4-1', usage: { input_tokens: 3, output_tokens: 1 },
      content: [{ type: 'tool_use', id: `${ses}-t`, name: 'Bash', input: { command: 'ls' } }] },
  }));
  await ingestLine(ws, ses, JSON.stringify({
    type: 'session-summary', summary: 'did things', tags: ['x'], sessionId: ses, model: 'haiku',
    fromEventTs: '2026-09-01T00:00:00Z', toEventTs: '2026-09-01T00:01:00Z',
  }));
  const v = new Float32Array(EMBED_DIM); v[0] = 1;
  await insertEmbedding({ workspaceId: ws, sessionId: ses, kind: 'turn', refEventId: 1, ts: 1, text: 't',
    modelId: EMBED_MODEL_ID, dim: EMBED_DIM, vec: encodeVector(v), dedupKey: `t-${ses}` });
  await recordUsageEvent({ workspaceId: ws, sessionId: ses, kind: 'resumed' });
  await stateKysely().insertInto('event_retention').values({ session_id: ses, workspace_id: ws }).execute();
}

async function countFor(ws: string, ses: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of TABLES) {
    const col = t === 'session_stats' || t === 'session_tool_counts' ? 'session_id' : 'workspace_id';
    const [r] = await queryRows<{ n: unknown }>(`SELECT count(*) AS n FROM ${t} WHERE ${col} = ?`, [col === 'session_id' ? ses : ws]);
    out[t] = Number(r.n);
  }
  return out;
}

beforeEach(async () => {
  await openTestState('cf-purge-');
});

describe('purgeWorkspace', () => {
  it('removes every row of one workspace and leaves the other untouched', async () => {
    await seedWorkspace(A, 'sa');
    await seedWorkspace(B, 'sb');
    const before = await countFor(B, 'sb');
    expect(before.events).toBeGreaterThan(0);
    expect(before.session_summaries).toBeGreaterThan(0);
    expect(await purgeWorkspace(A)).toBeGreaterThan(0);
    expect(Object.values(await countFor(A, 'sa')).every((n) => n === 0)).toBe(true);
    expect(await countFor(B, 'sb')).toEqual(before);
  });

  it('sizes chunks to the clock: shrinks to the 50-row floor on slow deletes, regrows when fast', () => {
    expect(nextPurgeChunk(250, 350)).toBe(50); // 250 × 35/350 × 0.8 = 20 → floor
    expect(nextPurgeChunk(250, 70)).toBe(100);
    expect(nextPurgeChunk(100, 25)).toBe(100);
    expect(nextPurgeChunk(100, 10)).toBe(125);
    expect(nextPurgeChunk(240, 1)).toBe(250);
  });

  it('with slow deletes, purges in floor-sized chunks and still removes everything', async () => {
    for (let i = 0; i < 300; i++) {
      await ingestLine(A, 'sa', JSON.stringify({ type: 'system', uuid: `e${i}`, timestamp: '2026-09-01T00:00:00Z', subtype: 'x' }));
    }
    let clock = 0;
    const sizes: number[] = [];
    // Every delete appears to take 350 ms.
    const slice = async <T>(fn: () => Promise<T>): Promise<T> => {
      const r = await fn();
      const n = Number((r as { numDeletedRows?: bigint }).numDeletedRows ?? -1);
      if (n > 0) sizes.push(n);
      return r;
    };
    await purgeWorkspace(A, slice, () => (clock += 175));
    expect(sizes[0]).toBe(250);
    expect(sizes.slice(1).every((n) => n <= 50)).toBe(true);
    expect((await countFor(A, 'sa')).events).toBe(0);
  });
});

describe('sweepOrphans', () => {
  const deps = (listed: string[], dirs: string[] = []) => ({
    listManifestIds: async () => listed,
    stateDirExists: (id: string) => dirs.includes(id),
  });

  it('purges an unlisted ULID workspace with no state dir', async () => {
    await seedWorkspace(A, 'sa');
    await seedWorkspace(B, 'sb');
    expect(await sweepOrphans(deps([B]), unthrottled)).toEqual([A]);
    expect(await workspaceIdsInState()).toEqual([B]);
  });

  it('keeps everything when the manifest listing is empty', async () => {
    await seedWorkspace(A, 'sa');
    expect(await sweepOrphans(deps([]), unthrottled)).toEqual([]);
    expect(await workspaceIdsInState()).toEqual([A]);
  });

  it('keeps a workspace whose state dir still exists, and non-ULID ids', async () => {
    await seedWorkspace(A, 'sa');
    await seedWorkspace('01WS', 'sx');
    expect(await sweepOrphans(deps([B], [A]), unthrottled)).toEqual([]);
    expect(await workspaceIdsInState()).toEqual([A, '01WS']);
  });
});

describe('purge vs a retention pass', () => {
  it('a watermark written after the purge leaves no row behind', async () => {
    await seedWorkspace(A, 'sa');
    await purgeWorkspace(A);
    await setRetentionWatermarks('sa', A, 10, 10);
    expect(await queryRows('SELECT session_id FROM event_retention')).toEqual([]);
  });

  it('workspaceIdsInState finds a workspace that only has events or embeddings left', async () => {
    await seedWorkspace(A, 'sa');
    await stateKysely().deleteFrom('sessions').execute();
    expect(await workspaceIdsInState()).toEqual([A]);
    await stateKysely().deleteFrom('events').execute();
    expect(await workspaceIdsInState()).toEqual([A]);
  });
});
