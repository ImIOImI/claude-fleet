import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { closeDb, stateKysely, withRawSqlite } from '../db.js';
import { isPg, openTestState } from '../store/testStore.js';
import { startWalCheckpointer, WAL_MAX_FRAMES, WAL_MAX_INCOMPLETE, WAL_REWIND_FRAMES } from './walCheckpointer.js';

const pragma = (name: string) => withRawSqlite((d) => d.pragma(name, { simple: true }) as number);
const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));

async function writeRows(n: number): Promise<void> {
  const big = 'x'.repeat(8000);
  await stateKysely().insertInto('maintenance').values(Array.from({ length: n }, (_, i) => ({ key: `w${Math.random()}${i}`, value: big }))).execute();
}

/** A worker that answers checkpoint requests with `reply` (JS source of an object literal). */
const fakeWorker = (onMessage: string) => `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', (m) => { if (m === 'close') { parentPort.close(); return; } ${onMessage} });
parentPort.postMessage({ ready: true });
`;

describe.skipIf(isPg)('startWalCheckpointer', () => {
  it('turns auto-checkpoint off, checkpoints from a worker, and restores the prior settings on close', async () => {
    const s = await openTestState('cf-walckpt-');
    await withRawSqlite((d) => { d.pragma('wal_autocheckpoint = 700'); d.pragma('journal_size_limit = 1234'); });
    const c = await startWalCheckpointer(join(s.dir, 'state.db'), { requestEveryMs: 0 });
    expect(c).not.toBeNull();
    expect(await pragma('wal_autocheckpoint')).toBe(0);
    expect(await pragma('journal_size_limit')).toBe(64 * 1024 * 1024);

    await writeRows(1500); // ~12 MB: past the default threshold, so only the worker checkpoints it
    c!.request();
    c!.request(); // one at a time: a no-op while the first runs
    await c!.idle();
    const r = c!.last()!;
    expect(r.log).toBeGreaterThan(1000);
    expect(r.checkpointed).toBe(r.log);
    expect(r.busy).toBe(0);

    await c!.close();
    expect(c!.active()).toBe(false);
    expect(await pragma('wal_autocheckpoint')).toBe(700);
    expect(await pragma('journal_size_limit')).toBe(1234);
  });

  it(`drain() runs and waits for a checkpoint only once the WAL is past ${WAL_REWIND_FRAMES} frames`, async () => {
    const s = await openTestState('cf-walckpt-');
    // Each checkpoint reports one more frame than the last, starting from `start`.
    const counting = (start: number) => fakeWorker(`globalThis.n = (globalThis.n ?? ${start}) + 1; parentPort.postMessage({ ok: true, busy: 0, log: globalThis.n, checkpointed: globalThis.n });`);
    const small = await startWalCheckpointer(join(s.dir, 'state.db'), { requestEveryMs: 0, workerSource: counting(10) });
    small!.request();
    await small!.idle();
    await small!.drain();
    expect(small!.last()!.log).toBe(11); // under the threshold: no extra checkpoint
    await small!.close();

    const big = await startWalCheckpointer(join(s.dir, 'state.db'), { requestEveryMs: 0, workerSource: counting(WAL_REWIND_FRAMES) });
    big!.request();
    await big!.idle();
    await big!.drain();
    expect(big!.last()!.log).toBe(WAL_REWIND_FRAMES + 2);
    await big!.close();
  });

  it('drain() rewinds a real WAL: the next write starts it from the beginning', async () => {
    const s = await openTestState('cf-walckpt-');
    const c = await startWalCheckpointer(join(s.dir, 'state.db'), { requestEveryMs: 0 });
    await writeRows(Math.ceil(WAL_REWIND_FRAMES / 2) + 100); // two 4 KB pages per 8 KB row
    c!.request();
    await c!.idle();
    expect(c!.last()!.log).toBeGreaterThan(WAL_REWIND_FRAMES);
    await c!.drain();
    await writeRows(1);
    c!.request();
    await c!.idle();
    expect(c!.last()!.log).toBeLessThan(100);
    await c!.close();
  });

  it('checkpoints on its own timer between requests', async () => {
    const s = await openTestState('cf-walckpt-');
    const c = await startWalCheckpointer(join(s.dir, 'state.db'), { requestEveryMs: 20 });
    await writeRows(200);
    await settle(200);
    expect(c!.last()).not.toBeNull();
    await c!.close();
  });

  it('returns null and leaves the main connection alone when the worker cannot open the database', async () => {
    const s = await openTestState('cf-walckpt-');
    expect(await startWalCheckpointer(join(s.dir, 'missing.db'))).toBeNull();
    expect(await pragma('wal_autocheckpoint')).toBe(1000);
  });

  it('returns null when the store is closed before it can set the pragmas', async () => {
    const s = await openTestState('cf-walckpt-');
    await closeDb();
    expect(await startWalCheckpointer(join(s.dir, 'state.db'))).toBeNull();
    await s.open();
  });

  it(`hands checkpoints back once the WAL passes ${WAL_MAX_FRAMES} frames`, async () => {
    const s = await openTestState('cf-walckpt-');
    const c = await startWalCheckpointer(join(s.dir, 'state.db'), {
      requestEveryMs: 0, workerSource: fakeWorker(`parentPort.postMessage({ ok: true, busy: 1, log: ${WAL_MAX_FRAMES + 1}, checkpointed: 0 });`),
    });
    c!.request();
    await c!.idle();
    await settle();
    expect(c!.active()).toBe(false);
    expect(await pragma('wal_autocheckpoint')).toBe(1000);
  });

  it(`hands checkpoints back after ${WAL_MAX_INCOMPLETE} incomplete checkpoints in a row`, async () => {
    const s = await openTestState('cf-walckpt-');
    const c = await startWalCheckpointer(join(s.dir, 'state.db'), {
      requestEveryMs: 0, workerSource: fakeWorker(`parentPort.postMessage({ ok: true, busy: 0, log: 100, checkpointed: 40 });`),
    });
    for (let i = 0; i < WAL_MAX_INCOMPLETE - 1; i++) { c!.request(); await c!.idle(); }
    expect(c!.active()).toBe(true);
    c!.request();
    await c!.idle();
    await settle();
    expect(c!.active()).toBe(false);
    expect(await pragma('wal_autocheckpoint')).toBe(1000);
  });

  it('close() returns at once with a checkpoint hung in flight', async () => {
    const s = await openTestState('cf-walckpt-');
    // Never answers: a checkpoint stuck in slow I/O.
    const c = await startWalCheckpointer(join(s.dir, 'state.db'), { requestEveryMs: 0, workerSource: fakeWorker('') });
    c!.request();
    const t0 = Date.now();
    await c!.close();
    expect(Date.now() - t0).toBeLessThan(500);
    expect(await pragma('wal_autocheckpoint')).toBe(1000);
    await c!.idle(); // the worker's exit settles the pending request
  });

  it('hands checkpoints back when the worker exits without an error event', async () => {
    const s = await openTestState('cf-walckpt-');
    const c = await startWalCheckpointer(join(s.dir, 'state.db'), { requestEveryMs: 0, workerSource: fakeWorker('process.exit(0);') });
    expect(await pragma('wal_autocheckpoint')).toBe(0);
    c!.request();
    await c!.idle();
    await settle();
    expect(c!.active()).toBe(false);
    expect(await pragma('wal_autocheckpoint')).toBe(1000);
  });

  it('hands checkpoints back when the worker throws', async () => {
    const s = await openTestState('cf-walckpt-');
    const c = await startWalCheckpointer(join(s.dir, 'state.db'), { requestEveryMs: 0, workerSource: fakeWorker(`throw new Error('boom');`) });
    c!.request();
    await c!.idle();
    await settle();
    expect(await pragma('wal_autocheckpoint')).toBe(1000);
    await c!.close();
  });
});
