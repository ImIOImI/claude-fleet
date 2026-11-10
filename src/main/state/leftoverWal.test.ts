import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { readTransaction } from '../store/kysely.js';
import {
  _setWalCheckpointerOptionsForTests, acquireWalCheckpointer, closeDb, onStateOpenStats, openDb, recordError, stateKysely,
  stateLeftoverDrain, withRawSqlite, type StateOpenStats,
} from '../db.js';
import { isPg } from '../store/testStore.js';
import { installWalCheckpointer } from './walCheckpointer.js';

installWalCheckpointer();

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

/** A worker that answers each checkpoint request with `reply` (JS statement). */
const fakeWorker = (reply: string) => `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', (m) => { if (m === 'close') { parentPort.close(); return; } ${reply} });
parentPort.postMessage({ ready: true });
`;

/** Holds its own connection to state.db, answers every checkpoint as busy (so none is in flight
 *  to terminate), closes 300 ms after a close request and then leaves a marker; ready after `delayMs`. */
const holder = (delayMs = 0) => `
const { parentPort, workerData } = require('node:worker_threads');
const d = new (require(workerData.bs3Path))(workerData.dbPath);
d.prepare('select count(*) from sessions').get();
require('node:fs').writeFileSync(workerData.dbPath + '.holder-open', '');
parentPort.on('message', (m) => {
  if (m === 'close') {
    const until = Date.now() + 300;
    while (Date.now() < until) { /* a slow close */ }
    d.close();
    require('node:fs').writeFileSync(workerData.dbPath + '.holder-closed', '');
    parentPort.close();
  }
  else parentPort.postMessage({ ok: true, busy: 1, log: 10, checkpointed: 0 });
});
setTimeout(() => parentPort.postMessage({ ready: true }), ${delayMs});
`;

/** Waits until the holder worker has its connection open (worker startup can take a while). */
async function connected(dir: string): Promise<void> {
  for (let i = 0; i < 200 && !existsSync(join(dir, 'state.db.holder-open')); i++) await new Promise((r) => setTimeout(r, 25));
  expect(existsSync(join(dir, 'state.db.holder-open'))).toBe(true);
}

/** The open db's stats at its first write (the fallback is far off). */
const firstWrite = () => new Promise<StateOpenStats>((r) => onStateOpenStats(r, 600_000));

const pragma = (name: string) => withRawSqlite((d) => d.pragma(name, { simple: true }) as number);
const frames = () => withRawSqlite((d) => (d.pragma('wal_checkpoint(NOOP)') as Array<{ log: number; checkpointed: number }>)[0]);
const walSize = (dir: string) => (existsSync(join(dir, 'state.db-wal')) ? statSync(join(dir, 'state.db-wal')).size : 0);
const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms))]);
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
  _setWalCheckpointerOptionsForTests({});
  await closeDb();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe.skipIf(isPg)('leftover WAL at open', () => {
  it('keeps the leftover WAL out of the first write and drains it from the worker', async () => {
    const dir = await leaveWal(20_000);
    openDb(dir);
    expect(await pragma('wal_autocheckpoint')).toBe(0);

    await recordError({ ts: Date.now(), source: 'main', level: 'info', type: 'app-start', message: 'x' });
    const stats = await firstWrite();
    expect(stats).toMatchObject({ handedOff: true });
    expect(stats.walFrames).toBeGreaterThan(1000);
    expect(stats.firstWriteMs).not.toBeNull();

    const r = await stateLeftoverDrain()!;
    expect(r).toMatchObject({ ok: true, busy: 0 });
    expect(r.rounds).toBeGreaterThanOrEqual(2);
    expect(await pragma('wal_autocheckpoint')).toBe(1000);
    expect(await pragma('journal_size_limit')).toBe(-1);
  }, 60_000);

  it('also checkpoints what main writes during the drain before releasing', async () => {
    const dir = await leaveWal(20_000);
    openDb(dir);
    for (let i = 0; i < 5; i++) await writeRows(200);
    expect((await stateLeftoverDrain()!).ok).toBe(true);
    const left = (await frames())!;
    expect(left.log - left.checkpointed).toBeLessThanOrEqual(256);
  }, 60_000);

  it('leaves a small WAL to the normal auto-checkpoint', async () => {
    const dir = await leaveWal(1_000);
    openDb(dir);
    expect(await pragma('wal_autocheckpoint')).toBe(1000);
    expect(stateLeftoverDrain()).toBeNull();
  }, 60_000);

  it('restores the main connection when drain checkpoints fail', async () => {
    const dir = await leaveWal(20_000);
    _setWalCheckpointerOptionsForTests({ workerSource: fakeWorker(`parentPort.postMessage({ ok: false, error: 'disk' });`) });
    openDb(dir);
    expect((await stateLeftoverDrain()!).ok).toBe(false);
    expect(await pragma('wal_autocheckpoint')).toBe(1000);
  }, 60_000);

  it('restores the main connection when a drain checkpoint hangs', async () => {
    const dir = await leaveWal(20_000);
    _setWalCheckpointerOptionsForTests({ workerSource: fakeWorker(''), checkpointTimeoutMs: 100 });
    openDb(dir);
    expect((await stateLeftoverDrain()!).ok).toBe(false);
    expect(await pragma('wal_autocheckpoint')).toBe(1000);
  }, 60_000);

  it('never counts a busy checkpoint as caught up', async () => {
    const dir = await leaveWal(20_000);
    _setWalCheckpointerOptionsForTests({ workerSource: fakeWorker(`parentPort.postMessage({ ok: true, busy: 1, log: 10, checkpointed: 10 });`), requestEveryMs: 0 });
    openDb(dir);
    const r = await stateLeftoverDrain()!;
    expect(r.ok).toBe(false);
    expect(r.error).toBe('checkpointer handed back');
    expect(await pragma('wal_autocheckpoint')).toBe(1000);
  }, 60_000);

  it('retention shares the drain worker: checkpoints stay held until the last lease closes', async () => {
    const dir = await leaveWal(20_000);
    openDb(dir);
    const early = await acquireWalCheckpointer({ requestEveryMs: 0 });
    expect(early?.active()).toBe(true);
    await early!.close();
    expect(await pragma('wal_autocheckpoint')).toBe(0); // the drain still holds them
    const late = await acquireWalCheckpointer({ requestEveryMs: 0 });
    await stateLeftoverDrain();
    expect(await pragma('wal_autocheckpoint')).toBe(0); // retention still holds them
    expect(late?.active()).toBe(true);
    await late!.close();
    expect(await pragma('wal_autocheckpoint')).toBe(1000);
  }, 60_000);

  it('closeDb mid-drain stops the worker first, so main closes last and removes the WAL', async () => {
    const dir = await leaveWal(20_000);
    _setWalCheckpointerOptionsForTests({ workerSource: holder(), checkpointTimeoutMs: 30_000 });
    openDb(dir);
    lastDrain = stateLeftoverDrain()!;
    await connected(dir);
    const t0 = Date.now();
    await closeDb();
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(existsSync(join(dir, 'state.db.holder-closed'))).toBe(true);
    expect(walSize(dir)).toBe(0);
    expect(await within(stateDrainOf(), 3_000)).not.toBe('timeout');
  }, 60_000);

  it('closeDb waits for a worker that has not answered ready yet', async () => {
    const dir = await leaveWal(20_000);
    _setWalCheckpointerOptionsForTests({ workerSource: holder(1_000) });
    openDb(dir);
    await connected(dir);
    await closeDb();
    expect(existsSync(join(dir, 'state.db.holder-closed'))).toBe(true);
    expect(walSize(dir)).toBe(0);
  }, 60_000);
});

let lastDrain: Promise<unknown> = Promise.resolve();
/** The drain of the store that was just closed (captured before closeDb). */
const stateDrainOf = () => lastDrain;

describe.skipIf(isPg)('closeDb overlapping a reopen', () => {
  it('a stale close never destroys a reopened handle', async () => {
    const dir = await leaveWal(20_000);
    _setWalCheckpointerOptionsForTests({ workerSource: holder(), checkpointTimeoutMs: 30_000 });
    openDb(dir);
    lastDrain = stateLeftoverDrain()!;
    const first = closeDb();
    const second = closeDb();
    await first;
    _setWalCheckpointerOptionsForTests({});
    openDb(dir);
    await second;
    expect(await sql<{ n: number }>`select 1 as n`.execute(stateKysely())).toMatchObject({ rows: [{ n: 1 }] });
  }, 60_000);
});

describe.skipIf(isPg)('first write after open', () => {
  const fresh = async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cf-first-write-'));
    dirs.push(dir);
    openDb(dir);
    return dir;
  };

  it('counts an autocommit INSERT … RETURNING read through all()', async () => {
    await fresh();
    await stateKysely().selectFrom('maintenance').select('key').execute();
    await stateKysely().insertInto('maintenance').values({ key: 'k', value: 'v' }).returning('key').execute();
    expect((await firstWrite()).firstWriteMs).not.toBeNull();
  });

  it('skips a failed write and a pragma, then counts the next commit', async () => {
    await fresh();
    let counted: StateOpenStats | null = null;
    onStateOpenStats((s) => { counted = s; }, 600_000);
    // The raw handle isn't observed; the Kysely insert then fails in run() on the unique key.
    await withRawSqlite((d) => d.prepare(`insert into maintenance (key, value) values ('dup', 'v')`).run());
    await expect(stateKysely().insertInto('maintenance').values({ key: 'dup', value: 'v' }).execute()).rejects.toThrow();
    await sql`pragma user_version`.execute(stateKysely());
    await new Promise((r) => setTimeout(r, 10));
    expect(counted).toBeNull();
    await stateKysely().transaction().execute((t) => t.insertInto('maintenance').values({ key: 'k', value: 'v' }).execute());
    expect((await firstWrite()).firstWriteMs).not.toBeNull();
  });

  it('onStateOpenStats reports once: at the first write, never again at the fallback', async () => {
    await fresh();
    const seen: StateOpenStats[] = [];
    onStateOpenStats((s) => seen.push(s), 50);
    await stateKysely().insertInto('maintenance').values({ key: 'k', value: 'v' }).execute();
    await new Promise((r) => setTimeout(r, 100));
    expect(seen).toHaveLength(1);
    expect(seen[0].firstWriteMs).not.toBeNull();
  });

  it('onStateOpenStats reports once: at the fallback, never again at a later write', async () => {
    await fresh();
    const seen: StateOpenStats[] = [];
    onStateOpenStats((s) => seen.push(s), 20);
    await new Promise((r) => setTimeout(r, 50));
    await stateKysely().insertInto('maintenance').values({ key: 'k', value: 'v' }).execute();
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toHaveLength(1);
    expect(seen[0].firstWriteMs).toBeNull();
  });
});

describe.skipIf(isPg)('first write is a change', () => {
  const fresh = async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cf-first-write-'));
    dirs.push(dir);
    openDb(dir);
  };

  it('a read-only transaction and an INSERT OR IGNORE that changes nothing are not writes', async () => {
    await fresh();
    let counted: StateOpenStats | null = null;
    onStateOpenStats((s) => { counted = s; }, 600_000);
    await stateKysely().insertInto('maintenance').values({ key: 'k', value: 'v' }).execute();
    counted = null;
    await closeDb();
    openDb(dirs[dirs.length - 1]);
    onStateOpenStats((s) => { counted = s; }, 600_000);
    await readTransaction(stateKysely(), async (t) => { await t.selectFrom('maintenance').select('key').execute(); });
    await stateKysely().insertInto('maintenance').values({ key: 'k', value: 'v' }).onConflict((oc) => oc.doNothing()).execute();
    await new Promise((r) => setTimeout(r, 10));
    expect(counted).toBeNull();
    await stateKysely().insertInto('maintenance').values({ key: 'k2', value: 'v' }).execute();
    await new Promise((r) => setTimeout(r, 0));
    expect(counted!.firstWriteMs).not.toBeNull();
  });

  it('the fallback window starts at the open', async () => {
    await fresh();
    await new Promise((r) => setTimeout(r, 80));
    let counted: StateOpenStats | null = null;
    onStateOpenStats((s) => { counted = s; }, 50);
    await new Promise((r) => setTimeout(r, 20));
    expect(counted).not.toBeNull();
    expect(counted!.firstWriteMs).toBeNull();
  });
});

describe.skipIf(isPg)('leftover WAL hand-off outcomes', () => {
  it('records workerReady false when the worker never comes up', async () => {
    const dir = await leaveWal(20_000);
    _setWalCheckpointerOptionsForTests({ workerSource: `require('node:worker_threads').parentPort.on('message', () => {});` });
    openDb(dir);
    const r = await stateLeftoverDrain()!;
    expect(r.ok).toBe(false);
    const s = await new Promise<StateOpenStats>((res) => onStateOpenStats(res, 0));
    expect(s).toMatchObject({ handedOff: true, workerReady: false });
    expect(await pragma('wal_autocheckpoint')).toBe(1000);
  }, 60_000);

  it('a stale failed round never counts as caught up', async () => {
    const dir = await leaveWal(20_000);
    // One complete answer, then only failures: the old result must not end the drain as ok.
    _setWalCheckpointerOptionsForTests({ requestEveryMs: 0, workerSource: fakeWorker(
      `if (!globalThis.once) { globalThis.once = 1; parentPort.postMessage({ ok: true, busy: 0, log: 5000, checkpointed: 5000 }); } else parentPort.postMessage({ ok: false, error: 'disk' });`) });
    openDb(dir);
    const r = await stateLeftoverDrain()!;
    expect(r.ok).toBe(false);
    expect(await pragma('wal_autocheckpoint')).toBe(1000);
  }, 60_000);

  it('retention gets a fresh worker once the drain\'s worker handed back', async () => {
    const dir = await leaveWal(20_000);
    _setWalCheckpointerOptionsForTests({ requestEveryMs: 0, workerSource: fakeWorker(`parentPort.postMessage({ ok: true, busy: 1, log: 10, checkpointed: 0 });`) });
    openDb(dir);
    await stateLeftoverDrain();
    _setWalCheckpointerOptionsForTests({});
    const lease = await acquireWalCheckpointer({ requestEveryMs: 0 });
    expect(lease?.active()).toBe(true);
    expect(await pragma('wal_autocheckpoint')).toBe(0);
    await lease!.close();
    expect(await pragma('wal_autocheckpoint')).toBe(1000);
  }, 60_000);
});
