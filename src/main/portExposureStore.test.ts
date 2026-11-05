import { describe, expect, it } from 'vitest';
import { stateKysely } from './db.js';
import { openTestState } from './store/testStore.js';
import { PortExposureStore, PORT_EXPOSURE_RETENTION_MS, gatedSink, type ExposureRow, type ExposureSink } from './portExposureStore.js';

const row = (over: Partial<ExposureRow> = {}): ExposureRow => ({
  id: 'R1', workspaceId: 'W1', sessionId: null, port: 5173, cmdline: null, label: null, reason: null,
  source: 'scanned', firstScannedAt: 1000, declaredAt: null, popupShownAt: null, outcome: null,
  openedVia: null, openCount: 0, endedAt: null, ...over
});

const rows = () => stateKysely().selectFrom('port_exposures').selectAll().orderBy('id').execute();

describe('PortExposureStore', () => {
  it('inserts a row and patches it by id', async () => {
    await openTestState();
    const s = new PortExposureStore(stateKysely);
    await s.insert(row());
    await s.update('R1', { label: 'Vite', declaredAt: 2000, source: 'both', openCount: 2, openedVia: 'rail', outcome: 'opened' });
    expect(await rows()).toEqual([
      expect.objectContaining({
        id: 'R1', workspace_id: 'W1', port: 5173, label: 'Vite', declared_at: 2000, source: 'both',
        open_count: 2, opened_via: 'rail', outcome: 'opened', ended_at: null
      })
    ]);
  });

  it('an empty patch is a no-op', async () => {
    await openTestState();
    const s = new PortExposureStore(stateKysely);
    await s.insert(row());
    await expect(s.update('R1', {})).resolves.toBeUndefined();
  });

  it('closeDangling ends open rows; never-served → not_serving, served → ignored, set outcomes kept', async () => {
    await openTestState();
    const s = new PortExposureStore(stateKysely);
    await s.insert(row({ id: 'A', source: 'declared', firstScannedAt: null, declaredAt: 1 }));
    await s.insert(row({ id: 'B' }));
    await s.insert(row({ id: 'C', outcome: 'dismissed' }));
    await s.insert(row({ id: 'D', endedAt: 50, outcome: 'opened' }));
    expect(await s.closeDangling(9000)).toBe(3);
    expect((await rows()).map((r) => [r.id, r.outcome, r.ended_at])).toEqual([
      ['A', 'not_serving', 9000],
      ['B', 'ignored', 9000],
      ['C', 'dismissed', 9000],
      ['D', 'opened', 50]
    ]);
  });

  it('prune deletes rows that ended before the retention window', async () => {
    await openTestState();
    const s = new PortExposureStore(stateKysely);
    const now = PORT_EXPOSURE_RETENTION_MS + 10_000;
    await s.insert(row({ id: 'old', endedAt: 5_000 }));
    await s.insert(row({ id: 'recent', endedAt: now - 1 }));
    await s.insert(row({ id: 'open' }));
    expect(await s.prune(PORT_EXPOSURE_RETENTION_MS, now)).toBe(1);
    expect((await rows()).map((r) => r.id)).toEqual(['open', 'recent']);
  });
});

describe('gatedSink', () => {
  const recorder = () => {
    const calls: string[] = [];
    const sink: ExposureSink = {
      insert: async (r) => void calls.push(`insert ${r.id}`),
      update: async (id) => void calls.push(`update ${id}`)
    };
    return { calls, sink };
  };

  it('holds writes until ready settles, then delegates in order', async () => {
    const { calls, sink } = recorder();
    let release!: () => void;
    const g = gatedSink(sink, new Promise<void>((r) => (release = r)));
    const w1 = g.insert(row());
    const w2 = g.update('R1', { label: 'x' });
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([]);
    release();
    await Promise.all([w1, w2]);
    expect(calls).toEqual(['insert R1', 'update R1']);
  });

  it('a rejected ready still releases writes', async () => {
    const { calls, sink } = recorder();
    const ready = Promise.reject(new Error('sweep failed'));
    await gatedSink(sink, ready).insert(row());
    expect(calls).toEqual(['insert R1']);
  });

  it('the startup sweep does not close a row inserted while it runs', async () => {
    await openTestState();
    const store = new PortExposureStore(stateKysely);
    await store.insert(row({ id: 'OLD' }));
    const g = gatedSink(store, store.sweep());
    await g.insert(row({ id: 'NEW', port: 3000 }));
    const byId = Object.fromEntries((await rows()).map((r) => [r.id, r.ended_at]));
    expect(byId.OLD).not.toBeNull();
    expect(byId.NEW).toBeNull();
  });
});
