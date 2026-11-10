import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { stateKysely, withRawSqlite } from '../db.js';
import { isPg, openTestState } from '../store/testStore.js';
import { startWalCheckpointer } from './walCheckpointer.js';

const autocheckpoint = () => withRawSqlite((d) => d.pragma('wal_autocheckpoint', { simple: true }) as number);
const walFrames = () => withRawSqlite((d) => (d.pragma('wal_checkpoint(NOOP)') as { log: number }[])[0].log);

async function writeRows(n: number): Promise<void> {
  const big = 'x'.repeat(8000);
  await stateKysely().insertInto('maintenance').values(Array.from({ length: n }, (_, i) => ({ key: `w${Math.random()}${i}`, value: big }))).execute();
}

describe.skipIf(isPg)('startWalCheckpointer', () => {
  it('turns auto-checkpoint off, checkpoints the WAL from a worker, and restores it on close', async () => {
    const s = await openTestState('cf-walckpt-');
    expect(await autocheckpoint()).toBe(1000);
    const c = await startWalCheckpointer(join(s.dir, 'state.db'));
    expect(c).not.toBeNull();
    expect(await autocheckpoint()).toBe(0);

    await writeRows(1500); // ~12 MB: past the 1,000-page default, so only the worker checkpoints it
    expect(await walFrames()).toBeGreaterThan(1000);
    c!.request();
    c!.request(); // one at a time: the second is a no-op while the first runs
    await c!.idle();
    const r = c!.last();
    expect(r).not.toBeNull();
    expect(r!.log).toBeGreaterThan(1000);
    expect(r!.checkpointed).toBe(r!.log);

    await c!.close();
    expect(await autocheckpoint()).toBe(1000);
  });

  it('returns null and leaves auto-checkpoint on when the worker cannot open the database', async () => {
    const s = await openTestState('cf-walckpt-');
    const c = await startWalCheckpointer(join(s.dir, 'missing.db'));
    expect(c).toBeNull();
    expect(await autocheckpoint()).toBe(1000);
  });

  it('hands checkpoints back to the main connection when the worker dies', async () => {
    const s = await openTestState('cf-walckpt-');
    const src = `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', () => { throw new Error('boom'); });
parentPort.postMessage({ ready: true });
`;
    const c = await startWalCheckpointer(join(s.dir, 'state.db'), { workerSource: src });
    expect(await autocheckpoint()).toBe(0);
    c!.request();
    await c!.idle();
    await new Promise((r) => setTimeout(r, 50));
    expect(await autocheckpoint()).toBe(1000);
    await c!.close();
  });
});
