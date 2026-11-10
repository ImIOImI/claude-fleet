import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, openDb, recordError, stateKysely, stateOpenStats, takeLeftoverWal, withRawSqlite } from '../db.js';
import { isPg } from '../store/testStore.js';
import { drainLeftoverWal, startWalCheckpointer } from './walCheckpointer.js';

const bs3 = createRequire(import.meta.url).resolve('better-sqlite3');

/** Writes `rows` ~1 KB rows with auto-checkpoint off, then dies by SIGKILL:
 *  the WAL stays behind with every frame, as after a crash or a killed quit. */
const KILLED_WRITER = `
const Database = require(process.argv[1]);
const d = new Database(process.argv[2]);
d.pragma('journal_mode = WAL');
d.pragma('wal_autocheckpoint = 0');
const ins = d.prepare("INSERT INTO perf_events (ts, kind, name, dur_ms, meta) VALUES (?, 'span', 'x', 1, ?)");
const tx = d.transaction((n) => { for (let i = 0; i < n; i++) ins.run(Date.now(), 'y'.repeat(900)); });
for (let i = 0; i < Number(process.argv[3]); i += 500) tx(500);
process.kill(process.pid, 'SIGKILL');
`;

/** A worker that answers each checkpoint request with `reply` (JS expression). */
const fakeWorker = (reply: string) => `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', (m) => { if (m === 'close') { parentPort.close(); return; } ${reply} });
parentPort.postMessage({ ready: true });
`;

const pragma = (name: string) => withRawSqlite((d) => d.pragma(name, { simple: true }) as number);
const frames = () => withRawSqlite((d) => (d.pragma('wal_checkpoint(NOOP)') as Array<{ log: number; checkpointed: number }>)[0]);
const walSize = (dir: string) => (existsSync(join(dir, 'state.db-wal')) ? statSync(join(dir, 'state.db-wal')).size : 0);
const dirs: string[] = [];

/** A state.db whose previous run left a WAL of about `rows` / 3.5 frames. */
async function leaveWal(rows: number): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'cf-leftover-wal-'));
  dirs.push(dir);
  openDb(dir);
  await closeDb();
  const r = spawnSync(process.execPath, ['-e', KILLED_WRITER, bs3, join(dir, 'state.db'), String(rows)]);
  expect(r.signal).toBe('SIGKILL');
  expect(walSize(dir)).toBeGreaterThan(rows * 900);
  return dir;
}

async function writeRows(n: number): Promise<void> {
  await stateKysely().insertInto('maintenance')
    .values(Array.from({ length: n }, (_, i) => ({ key: `w${Math.random()}${i}`, value: 'x'.repeat(4000) }))).execute();
}

afterEach(async () => {
  vi.useRealTimers();
  await closeDb();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe.skipIf(isPg)('leftover WAL at open', () => {
  it('keeps the leftover WAL out of the first write and drains it from a worker', async () => {
    const dir = await leaveWal(20_000);
    openDb(dir);
    expect(await pragma('wal_autocheckpoint')).toBe(0);

    await recordError({ ts: Date.now(), source: 'main', level: 'info', type: 'app-start', message: 'x' });
    const stats = await stateOpenStats()!;
    expect(stats).toMatchObject({ handedOff: true });
    expect(stats.walBytes).toBeGreaterThan(10 * 1024 * 1024);
    expect(stats.walFrames).toBeGreaterThan(1000);
    expect(stats.firstWriteMs).not.toBeNull();
    // The first commit did not checkpoint: nothing is backfilled yet.
    expect((await frames())!.checkpointed).toBe(0);

    const r = await drainLeftoverWal(join(dir, 'state.db'));
    expect(r).toMatchObject({ ok: true, busy: 0 });
    expect(r!.rounds).toBeGreaterThanOrEqual(2);
    expect(await pragma('wal_autocheckpoint')).toBe(1000);
    expect(await drainLeftoverWal(join(dir, 'state.db'))).toBeNull();
  }, 60_000);

  it('records an autocommit write as the first write', async () => {
    const dir = await leaveWal(1_000);
    openDb(dir);
    await stateKysely().insertInto('maintenance').values({ key: 'k', value: 'v' }).execute();
    const stats = await stateOpenStats()!;
    expect(stats.firstWriteMs).not.toBeNull();
    expect(stats.handedOff).toBe(false);
  }, 60_000);

  it('also checkpoints what main writes during the drain before releasing', async () => {
    const dir = await leaveWal(20_000);
    openDb(dir);
    const drain = drainLeftoverWal(join(dir, 'state.db'));
    for (let i = 0; i < 5; i++) await writeRows(200);
    const r = await drain;
    expect(r?.ok).toBe(true);
    const left = (await frames())!;
    expect(left.log - left.checkpointed).toBeLessThanOrEqual(256);
  }, 60_000);

  it('leaves a small WAL to the normal auto-checkpoint', async () => {
    const dir = await leaveWal(1_000);
    openDb(dir);
    expect(await pragma('wal_autocheckpoint')).toBe(1000);
    await recordError({ ts: Date.now(), source: 'main', level: 'info', type: 't', message: 'x' });
    expect((await stateOpenStats()!).handedOff).toBe(false);
    expect(await drainLeftoverWal(join(dir, 'state.db'))).toBeNull();
  }, 60_000);

  it('releases the hold when the drain fails', async () => {
    const dir = await leaveWal(20_000);
    openDb(dir);
    const r = await drainLeftoverWal(join(dir, 'state.db'), { workerSource: fakeWorker(`parentPort.postMessage({ ok: false, error: 'disk' });`) });
    expect(r?.ok).toBe(false);
    expect(await pragma('wal_autocheckpoint')).toBe(1000);
  }, 60_000);

  it('releases the hold when a drain checkpoint hangs', async () => {
    const dir = await leaveWal(20_000);
    openDb(dir);
    const r = await drainLeftoverWal(join(dir, 'state.db'), { workerSource: fakeWorker(''), timeoutMs: 100 });
    expect(r?.ok).toBe(false);
    expect(await pragma('wal_autocheckpoint')).toBe(1000);
  }, 60_000);

  it('releases the hold itself when nobody claims the leftover WAL', async () => {
    const dir = await leaveWal(20_000);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    openDb(dir);
    expect(await pragma('wal_autocheckpoint')).toBe(0);
    vi.advanceTimersByTime(5_000);
    vi.useRealTimers();
    expect(await pragma('wal_autocheckpoint')).toBe(1000);
    expect(takeLeftoverWal()).toBeNull();
  }, 60_000);

  it('a retention checkpointer started after the handoff but before the drain never restores 0', async () => {
    const dir = await leaveWal(20_000);
    openDb(dir);
    const ck = await startWalCheckpointer(join(dir, 'state.db'), { requestEveryMs: 0 });
    await ck!.close();
    expect(await pragma('wal_autocheckpoint')).toBe(0); // the leftover hold is still out
    await drainLeftoverWal(join(dir, 'state.db'));
    expect(await pragma('wal_autocheckpoint')).toBe(1000);
  }, 60_000);

  it('a retention checkpointer outliving the drain keeps checkpoints until it closes', async () => {
    const dir = await leaveWal(20_000);
    openDb(dir);
    const drain = drainLeftoverWal(join(dir, 'state.db'));
    const ck = await startWalCheckpointer(join(dir, 'state.db'), { requestEveryMs: 0 });
    await drain;
    expect(await pragma('wal_autocheckpoint')).toBe(0);
    await ck!.close();
    expect(await pragma('wal_autocheckpoint')).toBe(1000);
  }, 60_000);

  it('closeDb mid-drain stops the worker first, so main closes last and removes the WAL', async () => {
    const dir = await leaveWal(20_000);
    openDb(dir);
    // Holds its own connection and never answers: the drain is still in flight at closeDb.
    const holder = `
      const { parentPort, workerData } = require('node:worker_threads');
      const d = new (require(workerData.bs3Path))(workerData.dbPath);
      d.prepare('select count(*) from sessions').get();
      parentPort.on('message', (m) => { if (m === 'close') { d.close(); parentPort.close(); } });
      parentPort.postMessage({ ready: true });`;
    const drain = drainLeftoverWal(join(dir, 'state.db'), { workerSource: holder, timeoutMs: 30_000 });
    await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    await closeDb();
    expect(Date.now() - t0).toBeLessThan(3_000);
    // The worker was stopped by closeDb, not by its 30 s watchdog.
    const r = await Promise.race([drain, new Promise<null>((res) => setTimeout(() => res(null), 3_000))]);
    expect(r?.ok).toBe(false);
    expect(walSize(dir)).toBe(0);
  }, 60_000);

  it('a retention checkpointer closes at once while a drain is in flight', async () => {
    const dir = await leaveWal(20_000);
    openDb(dir);
    const drain = drainLeftoverWal(join(dir, 'state.db'), { workerSource: fakeWorker(''), timeoutMs: 30_000 });
    const ck = await startWalCheckpointer(join(dir, 'state.db'), { requestEveryMs: 0 });
    const t0 = Date.now();
    await ck!.close();
    expect(Date.now() - t0).toBeLessThan(500);
    await closeDb();
    await drain;
  }, 60_000);
});
