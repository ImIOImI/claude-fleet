import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { acquireWalCheckpointer, closeDb, stateKysely, withRawSqlite } from '../db.js';
import { isPg, openTestState } from '../store/testStore.js';
import { installWalCheckpointer, raceTimeout, WalCheckpointer, WAL_MAX_FRAMES, WAL_MAX_INCOMPLETE, WAL_REWIND_FRAMES } from './walCheckpointer.js';
import type Database from 'better-sqlite3';

installWalCheckpointer();

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
    const c = await acquireWalCheckpointer({ requestEveryMs: 0 });
    expect(c).not.toBeNull();
    expect(await pragma('wal_autocheckpoint')).toBe(0);
    expect(await pragma('journal_size_limit')).toBe(16 * 1024 * 1024);

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
    const small = await acquireWalCheckpointer({ requestEveryMs: 0, workerSource: counting(10) });
    small!.request();
    await small!.idle();
    await small!.drain();
    expect(small!.last()!.log).toBe(11); // under the threshold: no extra checkpoint
    await small!.close();

    const big = await acquireWalCheckpointer({ requestEveryMs: 0, workerSource: counting(WAL_REWIND_FRAMES) });
    big!.request();
    await big!.idle();
    await big!.drain();
    expect(big!.last()!.log).toBe(WAL_REWIND_FRAMES + 2);
    await big!.close();
  });

  it('drain() rewinds a real WAL: the next write starts it from the beginning', async () => {
    const s = await openTestState('cf-walckpt-');
    const c = await acquireWalCheckpointer({ requestEveryMs: 0 });
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

  it('a checkpoint that answers once past the rewind threshold, then hangs: drain() returns within the bound and hands back', async () => {
    const s = await openTestState('cf-walckpt-');
    await withRawSqlite((d) => { d.pragma('wal_autocheckpoint = 700'); d.pragma('journal_size_limit = 1234'); });
    const c = await acquireWalCheckpointer({
      requestEveryMs: 0, checkpointTimeoutMs: 200,
      workerSource: fakeWorker(`if (!globalThis.once) { globalThis.once = 1; parentPort.postMessage({ ok: true, busy: 0, log: ${WAL_REWIND_FRAMES + 1000}, checkpointed: ${WAL_REWIND_FRAMES + 1000} }); }`),
    });
    c!.request();
    await c!.idle();
    expect(c!.last()!.log).toBeGreaterThan(WAL_REWIND_FRAMES);
    const t0 = Date.now();
    await c!.drain(); // its checkpoint never answers
    expect(Date.now() - t0).toBeLessThan(1000);
    await settle();
    expect(c!.active()).toBe(false);
    expect(await pragma('wal_autocheckpoint')).toBe(700);
    expect(await pragma('journal_size_limit')).toBe(1234);
    await c!.idle(); // settled by the hand-back, not by the worker's exit
    await c!.drain(); // a no-op once handed back
  });

  it(`hands back after ${WAL_MAX_INCOMPLETE} failed checkpoints in a row`, async () => {
    const s = await openTestState('cf-walckpt-');
    const c = await acquireWalCheckpointer({
      requestEveryMs: 0, workerSource: fakeWorker(`parentPort.postMessage({ ok: false, error: 'SQLITE_IOERR' });`),
    });
    for (let i = 0; i < WAL_MAX_INCOMPLETE - 1; i++) { c!.request(); await c!.idle(); }
    expect(c!.active()).toBe(true);
    c!.request();
    await c!.idle();
    await settle();
    expect(c!.active()).toBe(false);
    expect(await pragma('wal_autocheckpoint')).toBe(1000);
  });

  it('checkpoints on its own timer between requests', async () => {
    const s = await openTestState('cf-walckpt-');
    const c = await acquireWalCheckpointer({ requestEveryMs: 20 });
    await writeRows(200);
    await settle(200);
    expect(c!.last()).not.toBeNull();
    await c!.close();
  });

  it('returns null and leaves the main connection alone when the worker cannot open the database', async () => {
    const s = await openTestState('cf-walckpt-');
    expect(await acquireWalCheckpointer({ dbPath: join(s.dir, 'missing.db') })).toBeNull();
    expect(await pragma('wal_autocheckpoint')).toBe(1000);
  });

  it('returns null when the store is closed before it can set the pragmas', async () => {
    const s = await openTestState('cf-walckpt-');
    await closeDb();
    expect(await acquireWalCheckpointer()).toBeNull();
    await s.open();
  });

  it(`hands checkpoints back once the WAL passes ${WAL_MAX_FRAMES} frames`, async () => {
    const s = await openTestState('cf-walckpt-');
    const c = await acquireWalCheckpointer({
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
    const c = await acquireWalCheckpointer({
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
    const c = await acquireWalCheckpointer({ requestEveryMs: 0, workerSource: fakeWorker('') });
    c!.request();
    const t0 = Date.now();
    await c!.close();
    expect(Date.now() - t0).toBeLessThan(500);
    expect(await pragma('wal_autocheckpoint')).toBe(1000);
    await c!.idle(); // the worker's exit settles the pending request
  });

  it('hands checkpoints back when the worker exits without an error event', async () => {
    const s = await openTestState('cf-walckpt-');
    const c = await acquireWalCheckpointer({ requestEveryMs: 0, workerSource: fakeWorker('process.exit(0);') });
    expect(await pragma('wal_autocheckpoint')).toBe(0);
    c!.request();
    await c!.idle();
    await settle();
    expect(c!.active()).toBe(false);
    expect(await pragma('wal_autocheckpoint')).toBe(1000);
  });

  it('hands checkpoints back when the worker throws', async () => {
    const s = await openTestState('cf-walckpt-');
    const c = await acquireWalCheckpointer({ requestEveryMs: 0, workerSource: fakeWorker(`throw new Error('boom');`) });
    c!.request();
    await c!.idle();
    await settle();
    expect(await pragma('wal_autocheckpoint')).toBe(1000);
    await c!.close();
  });
});

describe.skipIf(isPg)('the store checkpointer', () => {
  it('counts a busy or negative checkpoint result as incomplete', async () => {
    await openTestState('cf-walckpt-');
    for (const reply of ['busy: 1, log: 10, checkpointed: 10', 'busy: 0, log: -1, checkpointed: -1']) {
      const c = await acquireWalCheckpointer({ requestEveryMs: 0, workerSource: fakeWorker(`parentPort.postMessage({ ok: true, ${reply} });`) });
      for (let i = 0; i < WAL_MAX_INCOMPLETE; i++) { c!.request(); await c!.idle(); }
      await settle();
      expect(c!.active()).toBe(false);
      expect(await pragma('wal_autocheckpoint')).toBe(1000);
      await c!.close();
    }
  });

  it('is one worker for every lease; the last close restores the main connection', async () => {
    await openTestState('cf-walckpt-');
    await withRawSqlite((d) => d.pragma('wal_autocheckpoint = 700'));
    const a = await acquireWalCheckpointer({ requestEveryMs: 0 });
    const b = await acquireWalCheckpointer({ requestEveryMs: 0 });
    a!.request();
    await a!.idle();
    expect(b!.last()).toBe(a!.last());
    await a!.close();
    expect(b!.active()).toBe(true);
    expect(await pragma('wal_autocheckpoint')).toBe(0);
    await b!.close();
    expect(await pragma('wal_autocheckpoint')).toBe(700);
  });
});

describe('WalCheckpointer holds', () => {
  /** A main connection whose `journal_size_limit = …` write throws while `failSizeLimit` is set. */
  function fakeMain() {
    const state = { wal_autocheckpoint: 1000, journal_size_limit: -1, failSizeLimit: true };
    const d = {
      open: true,
      pragma(p: string, o?: { simple: boolean }) {
        const m = /^(\w+)\s*=\s*(-?\d+)$/.exec(p);
        if (!m) return o?.simple ? state[p as 'wal_autocheckpoint'] : [];
        if (m[1] === 'journal_size_limit' && Number(m[2]) > 0 && state.failSizeLimit) throw new Error('disk I/O error');
        state[m[1] as 'wal_autocheckpoint'] = Number(m[2]);
        return [];
      },
    } as unknown as Database.Database;
    return { d, state };
  }

  it('a hold that throws partway leaves the connection as it was and never saves 0', async () => {
    const { d, state } = fakeMain();
    const c = new WalCheckpointer({ dbPath: ':memory:', withMain: async (fn) => fn(d), warn: () => undefined });
    const ok = fakeWorker(`parentPort.postMessage({ ok: true, busy: 0, log: 1, checkpointed: 1 });`);
    expect(await c.acquire({ requestEveryMs: 0, workerSource: ok })).toBeNull();
    expect(state.wal_autocheckpoint).toBe(1000);
    state.failSizeLimit = false;
    const lease = await c.acquire({ requestEveryMs: 0, workerSource: ok });
    expect(state.wal_autocheckpoint).toBe(0);
    await lease!.close();
    expect(state.wal_autocheckpoint).toBe(1000);
    await c.stop();
  });

  it('holdAtOpen holds before spawning: a failed hold starts no worker', () => {
    const { d, state } = fakeMain();
    const c = new WalCheckpointer({ dbPath: ':memory:', withMain: async (fn) => fn(d), warn: () => undefined });
    expect(() => c.holdAtOpen(d, { requestEveryMs: 0, workerSource: fakeWorker('') })).toThrow('disk I/O error');
    expect(c.hasWorkers()).toBe(false);
    expect(state.wal_autocheckpoint).toBe(1000);
  });
});

describe('raceTimeout', () => {
  it('clears its timer when the promise settles first', async () => {
    vi.useFakeTimers();
    try {
      await raceTimeout(Promise.resolve(), 5000);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles after the bound when the promise never does', async () => {
    vi.useFakeTimers();
    try {
      let done = false;
      const r = raceTimeout(new Promise(() => {}), 5000).then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(4999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await r;
      expect(done).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
