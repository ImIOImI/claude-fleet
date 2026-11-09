import { describe, it, expect, beforeEach } from 'vitest';
import { deleteSession, ingestLine, stateKysely } from './db.js';
import { isPg, openTestState, queryRows } from './store/testStore.js';

const WS = '01WS';
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
});
