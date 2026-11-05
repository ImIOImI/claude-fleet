import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stateKysely } from './db.js';
import { PerfStore } from './perfStore.js';
import { openTestState, queryRows, isPg, type TestState } from './store/testStore.js';

let st: TestState;
describe('PerfStore', () => {
  let store: PerfStore;

  beforeEach(async () => {
    st = await openTestState('perfstore-');
    store = new PerfStore(stateKysely());
  });
  afterEach(async () => {
    await st.close();
  });

  it.skipIf(isPg)('migration creates perf_events with the expected columns', async () => {
    const cols = (await queryRows(`PRAGMA table_info(perf_events)`)) as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toEqual([
      'id', 'ts', 'kind', 'workspace_id', 'session_id', 'name', 'dur_ms', 'trace_id', 'span_id', 'meta'
    ]);
  });

  it('enqueue is buffered; flush writes one transaction and empties the buffer', async () => {
    store.enqueue({ ts: 1000, kind: 'slow_op', name: 'claude_fleet.ingest', durMs: 40 });
    store.enqueue({ ts: 1001, kind: 'stall', durMs: 80, meta: { p50: 1, p99: 60, max: 80 } });
    expect((await queryRows(`SELECT COUNT(*) AS n FROM perf_events`))[0]).toEqual({ n: 0 });
    expect(await store.flush()).toBe(2);
    expect(store.pending()).toBe(0);
    const rows = (await queryRows(`SELECT kind, name, dur_ms, meta FROM perf_events ORDER BY id`));
    expect(rows).toEqual([
      { kind: 'slow_op', name: 'claude_fleet.ingest', dur_ms: 40, meta: null },
      { kind: 'stall', name: null, dur_ms: 80, meta: JSON.stringify({ p50: 1, p99: 60, max: 80 }) }
    ]);
    expect(await store.flush()).toBe(0); // idempotent when empty
  });

  it('prune deletes rows older than the retention window', async () => {
    const now = 10 * 24 * 60 * 60 * 1000;
    store.enqueue({ ts: now - 8 * 24 * 60 * 60 * 1000, kind: 'stall', durMs: 60 });
    store.enqueue({ ts: now - 1000, kind: 'stall', durMs: 60 });
    await store.flush();
    expect(await store.prune(7 * 24 * 60 * 60 * 1000, now)).toBe(1);
    expect((await queryRows(`SELECT COUNT(*) AS n FROM perf_events`))[0]).toEqual({ n: 1 });
  });

  it('counts24h groups by kind within the window', async () => {
    const now = 2 * 24 * 60 * 60 * 1000;
    store.enqueue({ ts: now - 1000, kind: 'stall', durMs: 60 });
    store.enqueue({ ts: now - 2000, kind: 'slow_op', name: 'x', durMs: 30 });
    store.enqueue({ ts: now - 3000, kind: 'slow_op', name: 'y', durMs: 30 });
    store.enqueue({ ts: now - 30 * 60 * 60 * 1000, kind: 'slow_op', name: 'old', durMs: 30 });
    await store.flush();
    expect(await store.counts24h(now)).toEqual({ stall: 1, slow_op: 2 });
  });

  it('buffer is capped so a runaway producer cannot exhaust memory', async () => {
    for (let i = 0; i < 11_000; i++) store.enqueue({ ts: i, kind: 'stall', durMs: 60 });
    expect(store.pending()).toBe(10_000);
  });

  it('flush restores the buffer when the transaction throws', async () => {
    store.enqueue({ ts: 1, kind: 'stall', durMs: 60 });
    await queryRows(`DROP TABLE perf_events`); // force the transaction to throw
    await expect(store.flush()).rejects.toThrow();
    expect(store.pending()).toBe(1);
  });

  it('concurrent flushes run one at a time and write every row exactly once', async () => {
    for (let i = 0; i < 250; i++) store.enqueue({ ts: i, kind: 'stall', durMs: 60 });
    const first = store.flush();
    for (let i = 250; i < 300; i++) store.enqueue({ ts: i, kind: 'stall', durMs: 60 });
    const second = store.flush();
    expect(await Promise.all([first, second])).toEqual([250, 50]);
    expect((await queryRows('SELECT COUNT(*) AS n, COUNT(DISTINCT ts) AS d FROM perf_events'))[0]).toEqual({ n: 300, d: 300 });
  });
});
