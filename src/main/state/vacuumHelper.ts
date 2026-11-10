// One-time VACUUM that switches state.db to auto_vacuum = INCREMENTAL (SPEC §7
// *Retention*). A full VACUUM rewrites the whole file and holds the write lock
// for its duration, so it runs in a detached helper process after quit
// (Electron as node, like the MCP bridge), never in the app. A VACUUM that is
// killed rolls back, leaving the DB unchanged.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statfsSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileSize } from '../store/sqliteFiles.js';
import { join } from 'node:path';
import { maintenanceGet, maintenanceSet, stateDialect, withRawSqlite } from '../db.js';
import { logError } from '../errorLog.js';
import { betterSqlitePath } from '../queryWorker.js';
import { DAY_MS } from './retention.js';

const ATTEMPT_EVERY_MS = DAY_MS;
/** VACUUM peaks at about db + 2 × (temp copy + WAL); temp files are pointed
 *  at userData so one statfs covers them. */
const FREE_SPACE_FACTOR = 2.2;
/** A lock younger than this names a helper that may still be vacuuming. */
const LOCK_FRESH_MS = 15 * 60_000;

export const vacuumLockPath = (userData: string): string => join(userData, 'state.db.vacuum.lock');

/** Self-contained: runs as `-e` with argv [bs3Path, dbPath, lockPath, logPath]. */
export const VACUUM_SCRIPT = `
const fs = require('node:fs');
const [bs3, dbPath, lockPath, logPath] = process.argv.slice(process.argv[1] === '-e' ? 2 : 1);
const log = (o) => { try { fs.appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), source: 'main', ...o }) + '\\n'); } catch {} };
const size = () => { let n = 0; for (const f of [dbPath, dbPath + '-wal']) { try { n += fs.statSync(f).size; } catch {} } return n; };
const t0 = Date.now();
const before = size();
try {
  const Database = require(bs3);
  const d = new Database(dbPath);
  d.pragma('busy_timeout = 30000');
  d.pragma('auto_vacuum = INCREMENTAL');
  d.exec('VACUUM');
  d.pragma('wal_checkpoint(TRUNCATE)');
  d.close();
  log({ level: 'info', type: 'vacuum-done', message: 'state.db vacuumed', extra: { ms: Date.now() - t0, bytesBefore: before, bytesAfter: size() } });
} catch (e) {
  log({ level: 'warn', type: 'vacuum-failed', message: String((e && e.message) || e) });
} finally {
  try { fs.unlinkSync(lockPath); } catch {}
}
`;

/** Decide, while state.db is still open, whether this quit should run the
 *  conversion; records the attempt so it is tried at most once a day. */
export async function prepareVacuum(
  userData: string, opts: { now?: number; statfs?: (p: string) => { bavail: number; bsize: number } } = {},
): Promise<boolean> {
  if (stateDialect() !== 'sqlite') return false;
  const now = opts.now ?? Date.now();
  if ((await withRawSqlite((d) => d.pragma('auto_vacuum', { simple: true }) as number)) === 2) return false;
  if (!(await maintenanceGet('retention.first_pass_at'))) return false;
  const last = await maintenanceGet('vacuum.last_attempt_at');
  if (last !== null && now - Number(last) < ATTEMPT_EVERY_MS) return false;
  const dbPath = join(userData, 'state.db');
  const need = FREE_SPACE_FACTOR * (fileSize(dbPath) + fileSize(`${dbPath}-wal`));
  const fs = (opts.statfs ?? statfsSync)(userData);
  if (fs.bavail * fs.bsize < need) {
    logError({ source: 'main', level: 'warn', type: 'vacuum-skipped', message: 'not enough free disk for the one-time VACUUM',
      extra: { freeBytes: fs.bavail * fs.bsize, needBytes: need } });
    return false;
  }
  await maintenanceSet('vacuum.last_attempt_at', String(now));
  return true;
}

/** Start the detached helper (after closeDb). Returns its pid, or null. */
export function spawnVacuumHelper(
  userData: string, opts: { execPath?: string; bs3Path?: string } = {},
): number | null {
  const lock = vacuumLockPath(userData);
  const startedAt = Date.now();
  // The lock exists before the helper does, so a relaunch can never miss it;
  // no lock, no helper.
  try {
    writeFileSync(lock, JSON.stringify({ pid: null, startedAt }));
  } catch (e) {
    logError({ source: 'main', level: 'warn', type: 'vacuum-failed', message: `lock: ${String(e)}` });
    return null;
  }
  try {
    const child = spawn(opts.execPath ?? process.execPath,
      ['-e', VACUUM_SCRIPT, opts.bs3Path ?? betterSqlitePath(), join(userData, 'state.db'), lock, join(userData, 'error.log')],
      {
        detached: true, stdio: 'ignore', windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SQLITE_TMPDIR: userData, TMP: userData, TEMP: userData },
      });
    if (child.pid === undefined) {
      unlinkSync(lock);
      return null;
    }
    writeFileSync(lock, JSON.stringify({ pid: child.pid, startedAt }));
    child.unref();
    return child.pid;
  } catch (e) {
    logError({ source: 'main', level: 'warn', type: 'vacuum-failed', message: String(e) });
    return null;
  }
}

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

function readLock(lock: string): { pid: number | null; startedAt: number } | null {
  try {
    return JSON.parse(readFileSync(lock, 'utf8')) as { pid: number | null; startedAt: number };
  } catch {
    return null;
  }
}

/** Whether a helper from the last quit may still be vacuuming (sync, cheap):
 *  a fresh lock naming a live pid. */
export function vacuumHelperActive(userData: string, isAlive: (pid: number) => boolean = pidAlive, now = Date.now()): boolean {
  const info = readLock(vacuumLockPath(userData));
  return !!info && Number.isInteger(info.pid) && now - info.startedAt <= LOCK_FRESH_MS && isAlive(info.pid as number);
}

/** Before openDb: wait (asynchronously) for a helper from the last quit. After
 *  `capMs` a fresh lock's helper is killed (its VACUUM rolls back); an old
 *  lock is treated as stale, never killed (its pid may be reused). */
export async function waitForVacuumHelper(userData: string, opts: {
  capMs?: number; pollMs?: number; exitWaitMs?: number; isAlive?: (pid: number) => boolean; kill?: (pid: number) => void; now?: () => number;
} = {}): Promise<'none' | 'done' | 'killed' | 'stale'> {
  const lock = vacuumLockPath(userData);
  if (!existsSync(lock)) return 'none';
  const isAlive = opts.isAlive ?? pidAlive;
  const now = opts.now ?? Date.now;
  const drop = (): void => { try { unlinkSync(lock); } catch { /* already gone */ } };
  const parsed = readLock(lock);
  if (!parsed || !Number.isInteger(parsed.pid) || !isAlive(parsed.pid as number)) {
    drop();
    return 'stale';
  }
  const info = { pid: parsed.pid as number, startedAt: parsed.startedAt };
  const poll = (): Promise<void> => new Promise((r) => setTimeout(r, opts.pollMs ?? 250));
  const deadline = now() + (opts.capMs ?? 120_000);
  while (now() < deadline) {
    await poll();
    if (!existsSync(lock)) return 'done';
    if (!isAlive(info.pid)) {
      drop();
      return 'done';
    }
  }
  drop();
  if (now() - info.startedAt > LOCK_FRESH_MS) return 'stale';
  try {
    (opts.kill ?? ((pid) => process.kill(pid)))(info.pid);
  } catch { /* exited meanwhile */ }
  // Its file locks go only when it is gone (Windows releases them late).
  const exitDeadline = now() + (opts.exitWaitMs ?? 10_000);
  while (isAlive(info.pid) && now() < exitDeadline) await poll();
  return 'killed';
}
