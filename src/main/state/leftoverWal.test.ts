import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, openDb, recordError, stateOpenStats, takeLeftoverWal, withRawSqlite } from '../db.js';
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

const pragma = (name: string) => withRawSqlite((d) => d.pragma(name, { simple: true }) as number);
const frames = () => withRawSqlite((d) => (d.pragma('wal_checkpoint(NOOP)') as Array<{ log: number; checkpointed: number }>)[0]);
const dirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cf-leftover-wal-'));
  dirs.push(dir);
  return dir;
}

/** A state.db whose previous run left a WAL of about `rows` / 3.5 frames. */
async function leaveWal(rows: number): Promise<string> {
  const dir = freshDir();
  openDb(dir);
  await closeDb();
  spawnSync(process.execPath, ['-e', KILLED_WRITER, bs3, join(dir, 'state.db'), String(rows)]);
  return dir;
}

afterEach(async () => {
  vi.useRealTimers();
  await closeDb();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe.skipIf(isPg)('leftover WAL at open', () => {
  it('defers a leftover WAL from the first commit to the drain worker', async () => {
    const dir = await leaveWal(20_000);
    expect(statSync(join(dir, 'state.db-wal')).size).toBeGreaterThan(10 * 1024 * 1024);
    openDb(dir);
    expect(await pragma('wal_autocheckpoint')).toBe(0);

    await recordError({ ts: Date.now(), source: 'main', level: 'info', type: 'app-start', message: 'x' });
    const stats = await stateOpenStats()!;
    expect(stats.handedOff).toBe(true);
    expect(stats.walBytes).toBeGreaterThan(10 * 1024 * 1024);
    expect(stats.walFrames).toBeGreaterThan(1000);
    expect(stats.firstCommitMs).not.toBeNull();
    // The first commit did not checkpoint: nothing is backfilled yet.
    expect((await frames())!.checkpointed).toBe(0);

    const r = await drainLeftoverWal(join(dir, 'state.db'));
    expect(r).toMatchObject({ ok: true, busy: 0 });
    expect(r!.checkpointed).toBe(r!.log);
    expect(r!.log).toBeGreaterThanOrEqual(stats.walFrames);
    expect(await pragma('wal_autocheckpoint')).toBe(1000);
    expect(await drainLeftoverWal(join(dir, 'state.db'))).toBeNull();
  }, 60_000);

  it('leaves a small WAL to the normal auto-checkpoint', async () => {
    const dir = await leaveWal(1_000);
    openDb(dir);
    expect(await pragma('wal_autocheckpoint')).toBe(1000);
    await recordError({ ts: Date.now(), source: 'main', level: 'info', type: 't', message: 'x' });
    expect((await stateOpenStats()!).handedOff).toBe(false);
    expect(await drainLeftoverWal(join(dir, 'state.db'))).toBeNull();
  }, 60_000);

  it('restores auto-checkpoint when the drain fails', async () => {
    const dir = await leaveWal(20_000);
    openDb(dir);
    const failing = `
      const { parentPort } = require('node:worker_threads');
      parentPort.on('message', (m) => { if (m === 'close') { parentPort.close(); return; } parentPort.postMessage({ ok: false, error: 'disk' }); });
      parentPort.postMessage({ ready: true });`;
    const r = await drainLeftoverWal(join(dir, 'state.db'), { workerSource: failing });
    expect(r).toMatchObject({ ok: false, error: 'disk' });
    expect(await pragma('wal_autocheckpoint')).toBe(1000);
  }, 60_000);

  it('restores auto-checkpoint when the drain times out', async () => {
    const dir = await leaveWal(20_000);
    openDb(dir);
    const silent = `
      const { parentPort } = require('node:worker_threads');
      parentPort.on('message', (m) => { if (m === 'close') parentPort.close(); });
      parentPort.postMessage({ ready: true });`;
    const r = await drainLeftoverWal(join(dir, 'state.db'), { workerSource: silent, timeoutMs: 100 });
    expect(r?.ok).toBe(false);
    expect(await pragma('wal_autocheckpoint')).toBe(1000);
  }, 60_000);

  it('restores auto-checkpoint itself when nobody claims the leftover WAL', async () => {
    const dir = await leaveWal(20_000);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    openDb(dir);
    expect(await pragma('wal_autocheckpoint')).toBe(0);
    vi.advanceTimersByTime(5_000);
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 20));
    expect(await pragma('wal_autocheckpoint')).toBe(1000);
    expect(takeLeftoverWal()).toBeNull();
  }, 60_000);

  it('a retention checkpointer started during a drain restores the real setting', async () => {
    const dir = await leaveWal(20_000);
    openDb(dir);
    const drain = drainLeftoverWal(join(dir, 'state.db'));
    const ck = await startWalCheckpointer(join(dir, 'state.db'), { requestEveryMs: 0 });
    await drain;
    expect(await pragma('wal_autocheckpoint')).toBe(0);
    await ck!.close();
    expect(await pragma('wal_autocheckpoint')).toBe(1000);
  }, 60_000);
});
