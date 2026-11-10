// Off-main-thread WAL checkpoints for state.db while retention runs (SPEC §7
// *Retention*). SQLite's auto-checkpoint runs inside whichever commit crosses
// the threshold, so on the main connection it lands, with its page copy and
// fsync, inside a retention slice.
import { Worker } from 'node:worker_threads';
import { withRawSqlite } from '../db.js';
import { logError } from '../errorLog.js';
import { betterSqlitePath } from '../queryWorker.js';

const WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
const Database = require(workerData.bs3Path);
const d = new Database(workerData.dbPath, { fileMustExist: true });
parentPort.on('message', () => {
  try {
    const [r] = d.pragma('wal_checkpoint(PASSIVE)');
    parentPort.postMessage({ ok: true, log: r.log, checkpointed: r.checkpointed });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: String(e) });
  }
});
parentPort.postMessage({ ready: true });
`;

/** SQLite's default `wal_autocheckpoint`, restored on close. */
const AUTOCHECKPOINT_PAGES = 1000;
const READY_TIMEOUT_MS = 5000;

export interface CheckpointResult { log: number; checkpointed: number }

export interface WalCheckpointer {
  /** Start a PASSIVE checkpoint in the worker unless one is already running. */
  request(): void;
  /** Resolves when no checkpoint is running. */
  idle(): Promise<void>;
  last(): CheckpointResult | null;
  /** Restore auto-checkpoint on the main connection and end the worker. */
  close(): Promise<void>;
}

/** Turn the main connection's auto-checkpoint off and checkpoint from a worker
 *  instead. Null (auto-checkpoint left on) when the worker can't start. */
export async function startWalCheckpointer(dbPath: string, opts: { workerSource?: string } = {}): Promise<WalCheckpointer | null> {
  let worker: Worker;
  try {
    worker = new Worker(opts.workerSource ?? WORKER_SRC, { eval: true, workerData: { bs3Path: betterSqlitePath(), dbPath } });
  } catch (e) {
    logError({ source: 'main', level: 'warn', type: 'wal-checkpointer', message: `worker failed to start: ${String(e)}` });
    return null;
  }
  worker.unref();
  const ready = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), READY_TIMEOUT_MS);
    worker.once('message', (m: { ready?: boolean }) => { clearTimeout(timer); resolve(m.ready === true); });
    worker.once('error', () => { clearTimeout(timer); resolve(false); });
  });
  if (!ready) {
    logError({ source: 'main', level: 'warn', type: 'wal-checkpointer', message: 'worker did not open state.db; auto-checkpoint stays on' });
    await worker.terminate();
    return null;
  }

  let pending: Promise<void> | null = null;
  let last: CheckpointResult | null = null;
  let closed = false;
  const restore = () => withRawSqlite((d) => d.pragma(`wal_autocheckpoint = ${AUTOCHECKPOINT_PAGES}`)).catch(() => undefined);
  // A worker that dies hands checkpoints back to the main connection.
  worker.on('error', (e) => {
    logError({ source: 'main', level: 'warn', type: 'wal-checkpointer', message: `worker failed: ${String(e)}` });
    if (!closed) { closed = true; void restore(); }
  });
  await withRawSqlite((d) => d.pragma('wal_autocheckpoint = 0'));

  return {
    request() {
      if (pending || closed) return;
      pending = new Promise<void>((resolve) => {
        const done = (m: { ok: boolean; log?: number; checkpointed?: number; error?: string }) => {
          worker.off('exit', gone);
          if (m.ok) last = { log: m.log ?? 0, checkpointed: m.checkpointed ?? 0 };
          else logError({ source: 'main', level: 'warn', type: 'wal-checkpointer', message: m.error ?? 'checkpoint failed' });
          pending = null;
          resolve();
        };
        const gone = () => { worker.off('message', done); pending = null; resolve(); };
        worker.once('message', done);
        worker.once('exit', gone);
        worker.postMessage(0);
      });
    },
    idle: () => pending ?? Promise.resolve(),
    last: () => last,
    async close() {
      await (pending ?? Promise.resolve());
      if (!closed) {
        closed = true;
        await restore();
      }
      await worker.terminate();
    },
  };
}
