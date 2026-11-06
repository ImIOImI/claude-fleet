import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';
import { closeDb, maintenanceGet, maintenanceSet, openDb } from '../db.js';
import { isPg } from '../store/testStore.js';
import { prepareVacuum, spawnVacuumHelper, vacuumLockPath, waitForVacuumHelper } from './vacuumHelper.js';

const dirs: string[] = [];
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'cf-vac-')); dirs.push(d); return d; };
afterEach(async () => {
  await closeDb();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const bs3 = createRequire(import.meta.url).resolve('better-sqlite3');

describe.skipIf(isPg)('spawnVacuumHelper', () => {
  it('converts state.db to incremental auto_vacuum, shrinks it and removes the lock', async () => {
    const dir = tmp();
    const file = join(dir, 'state.db');
    const d = new Database(file);
    d.pragma('journal_mode = WAL');
    d.exec('CREATE TABLE t (x TEXT)');
    const ins = d.prepare('INSERT INTO t VALUES (?)');
    for (let i = 0; i < 1500; i++) ins.run('x'.repeat(4000));
    d.exec('DELETE FROM t');
    d.pragma('wal_checkpoint(TRUNCATE)');
    d.close();
    const before = statSync(file).size;

    const pid = spawnVacuumHelper(dir, { execPath: process.execPath, bs3Path: bs3 });
    expect(pid).not.toBeNull();
    expect(await waitForVacuumHelper(dir, { capMs: 60_000, pollMs: 50 })).toMatch(/^(done|stale)$/);
    expect(existsSync(vacuumLockPath(dir))).toBe(false);

    const after = new Database(file, { readonly: true });
    expect(after.pragma('auto_vacuum', { simple: true })).toBe(2);
    after.close();
    expect(statSync(file).size).toBeLessThan(before / 4);
    expect(readFileSync(join(dir, 'error.log'), 'utf8')).toContain('vacuum-done');
  }, 90_000);
});

describe('waitForVacuumHelper', () => {
  it('returns none without a lock and stale for a dead pid', async () => {
    const dir = tmp();
    expect(await waitForVacuumHelper(dir)).toBe('none');
    writeFileSync(vacuumLockPath(dir), JSON.stringify({ pid: 999_999_999, startedAt: Date.now() }));
    expect(await waitForVacuumHelper(dir)).toBe('stale');
    expect(existsSync(vacuumLockPath(dir))).toBe(false);
  });

  it('kills a helper that outlives the cap', async () => {
    const dir = tmp();
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    const exited = new Promise((r) => child.on('exit', r));
    writeFileSync(vacuumLockPath(dir), JSON.stringify({ pid: child.pid, startedAt: Date.now() }));
    expect(await waitForVacuumHelper(dir, { capMs: 200, pollMs: 50 })).toBe('killed');
    await exited;
  });

  it('never kills the pid of an old lock', async () => {
    const dir = tmp();
    const killed: number[] = [];
    writeFileSync(vacuumLockPath(dir), JSON.stringify({ pid: 4242, startedAt: Date.now() - 60 * 60_000 }));
    const r = await waitForVacuumHelper(dir, { capMs: 100, pollMs: 20, isAlive: () => true, kill: (p) => killed.push(p) });
    expect(r).toBe('stale');
    expect(killed).toEqual([]);
  });
});

describe.skipIf(isPg)('prepareVacuum', () => {
  const roomy = () => ({ bavail: 1e12, bsize: 1 });

  it('waits for the first retention pass, then fires at most once a day', async () => {
    const dir = tmp();
    openDb(dir);
    expect(await prepareVacuum(dir, { now: 1_000, statfs: roomy })).toBe(false);
    await maintenanceSet('retention.first_pass_at', '1');
    expect(await prepareVacuum(dir, { now: 2_000, statfs: roomy })).toBe(true);
    expect(await maintenanceGet('vacuum.last_attempt_at')).toBe('2000');
    expect(await prepareVacuum(dir, { now: 3_000, statfs: roomy })).toBe(false);
  });

  it('skips when free disk is short', async () => {
    const dir = tmp();
    openDb(dir);
    await maintenanceSet('retention.first_pass_at', '1');
    expect(await prepareVacuum(dir, { now: 2_000, statfs: () => ({ bavail: 0, bsize: 4096 }) })).toBe(false);
  });
});
