import { describe, it, expect, beforeEach } from 'vitest';
import { deleteSession, eventsForSession, ingestBatch, ingestLine, purgeWorkspace, stateKysely } from './db.js';
import { isPg, openTestState, queryRows } from './store/testStore.js';

const WS = '01WS';
const big = (u: string, n = 0) => JSON.stringify({ type: 'attachment', uuid: u, timestamp: '2026-11-01T00:00:00Z',
  attachment: { type: 'deferred_tools_delta', tools: 'T$&'.repeat(700), n } });
const refs = async () => (await queryRows<{ refs: number }>('SELECT refs FROM event_blobs ORDER BY refs')).map((b) => Number(b.refs));
const line = (u: string) => JSON.stringify({ type: 'system', uuid: u, timestamp: '2026-11-01T00:00:00Z' });

beforeEach(async () => {
  await openTestState('cf-att-blobs-');
});

describe('state v17 attachment blobs', () => {
  it('has att_ref and event_blobs on both dialects', async () => {
    expect(await queryRows('SELECT att_ref FROM events')).toEqual([]);
    expect(await queryRows('SELECT hash, body_z, bytes, refs FROM event_blobs')).toEqual([]);
  });

  it.skipIf(isPg)('the delete trigger releases refs and drops a blob at zero', async () => {
    await ingestLine(WS, 's1', line('a'));
    await ingestLine(WS, 's2', line('b'));
    await stateKysely().updateTable('events').set({ att_ref: 'h' }).execute();
    await stateKysely().insertInto('event_blobs').values({ hash: 'h', body_z: Buffer.from('z'), bytes: 1, refs: 2 }).execute();
    await deleteSession('s1');
    expect(await queryRows('SELECT refs FROM event_blobs')).toEqual([{ refs: 1 }]);
    await deleteSession('s2');
    expect(await queryRows('SELECT refs FROM event_blobs')).toEqual([]);
  });

  it('dedupes identical payloads at ingest and reads the originals back', async () => {
    const lines = [big('a'), big('b'), big('c', 1)];
    await ingestBatch(WS, 's1', lines);
    expect((await eventsForSession('s1')).map((e) => e.rawJsonl)).toEqual(lines);
    if (isPg) {
      expect(await refs()).toEqual([]);
      return;
    }
    expect(await refs()).toEqual([1, 2]);
    const [a] = await queryRows<{ raw_jsonl: string; att_ref: string }>(`SELECT raw_jsonl, att_ref FROM events WHERE uuid = 'a'`);
    expect(a.raw_jsonl.length).toBeLessThan(200);
    expect(JSON.parse(a.raw_jsonl).attachment).toEqual({ fleetRef: a.att_ref });
  });

  it('a replayed line does not add a reference', async () => {
    await ingestLine(WS, 's1', big('a'));
    await ingestLine(WS, 's1', big('a'));
    expect(await refs()).toEqual(isPg ? [] : [1]);
  });

  it.skipIf(isPg)('deleting sessions and purging a workspace release the blobs', async () => {
    await ingestBatch(WS, 's1', [big('a'), big('b')]);
    await ingestBatch(WS, 's2', [big('c')]);
    await ingestBatch('01OTHER', 's3', [big('d')]);
    expect(await refs()).toEqual([4]);
    await deleteSession('s1');
    expect(await refs()).toEqual([2]);
    await purgeWorkspace('01OTHER');
    expect(await refs()).toEqual([1]);
    await deleteSession('s2');
    expect(await refs()).toEqual([]);
  });
});
