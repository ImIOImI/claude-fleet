// Owns the fleet-embedder child so a slow CreateProcess blocks this worker, not main.
// eval worker: no bundle entry or asar handling needed in packaged builds.
import { Worker } from 'node:worker_threads';
import type { SidecarErrorKind, SidecarProcess, SidecarSpawner } from './embedderClient.js';

// The worker stays alive until the child is reaped: on POSIX only the thread
// that spawned a child can reap it, so a worker dying first leaves a zombie.
export const SPAWN_WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
const { spawn } = require('node:child_process');
const own = (b) => { const u = new Uint8Array(b.byteLength); u.set(b); return u; };
const relay = (t, b) => { const u = own(b); parentPort.postMessage({ t, b: u }, [u.buffer]); };
let errored = false;
const fail = (kind, message) => {
  if (errored) return;
  errored = true;
  parentPort.postMessage({ t: 'error', kind, message });
};
let finished = false;
const finish = (code, signal) => {
  if (finished) return;
  finished = true;
  parentPort.postMessage({ t: 'exit', code, signal });
  parentPort.close();
};
const t0 = Date.now();
let child = null;
try {
  child = spawn(workerData.bin, workerData.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
} catch (e) {
  fail('spawn', String((e && e.message) || e));
  finish(null, null);
}
if (child) {
  process.on('uncaughtException', (e) => {
    fail('relay', String((e && e.message) || e));
    if (finished) parentPort.close();
    else child.kill('SIGKILL');
  });
  child.stdin.on('error', () => {});
  child.stdout.on('data', (b) => relay('out', b));
  child.stderr.on('data', (b) => relay('err', b));
  child.on('error', (e) => {
    if (child.pid === undefined) {
      fail('spawn', e.message);
      finish(null, null);
      return;
    }
    fail('child', e.message);
    child.kill('SIGKILL');
  });
  // 'close' follows the reap and the last stdout chunk.
  child.on('close', (code, signal) => finish(code, signal));
  parentPort.on('message', (m) => {
    if (m.t === 'in') child.stdin.write(Buffer.from(m.b.buffer, m.b.byteOffset, m.b.byteLength));
    else if (m.t === 'end') child.stdin.end();
    else if (m.t === 'kill') child.kill(m.force ? 'SIGKILL' : 'SIGTERM');
  });
  if (child.pid !== undefined) parentPort.postMessage({ t: 'spawned', pid: child.pid, ms: Date.now() - t0 });
}
`;

export interface WorkerSpawnerOptions {
  /** Receives each spawn's promise of the child's pid (perf span hook). */
  onCreating?: (created: Promise<number>) => void;
  /** Test seam. */
  workerSource?: string;
}

type WorkerMsg =
  | { t: 'spawned'; pid: number; ms: number }
  | { t: 'out' | 'err'; b: Uint8Array }
  | { t: 'error'; kind: SidecarErrorKind; message: string }
  | { t: 'exit'; code: number | null; signal: string | null };

export function makeWorkerSpawner(opts: WorkerSpawnerOptions = {}): SidecarSpawner {
  return (bin, args) => spawnViaWorker(bin, args, opts);
}

export function spawnViaWorker(bin: string, args: string[], opts: WorkerSpawnerOptions = {}): SidecarProcess {
  const worker = new Worker(opts.workerSource ?? SPAWN_WORKER_SRC, {
    eval: true,
    workerData: { bin, args },
    resourceLimits: { maxOldGenerationSizeMb: 16 },
  });
  // Never holds the event loop (or quit) open.
  worker.unref();

  const out: Array<(b: Buffer) => void> = [];
  const err: Array<(b: Buffer) => void> = [];
  const errors: Array<(kind: SidecarErrorKind, message: string) => void> = [];
  const exits: Array<(code: number | null, signal: string | null) => void> = [];
  let createdResolve!: (pid: number) => void;
  let createdReject!: (e: Error) => void;
  const created = new Promise<number>((res, rej) => { createdResolve = res; createdReject = rej; });
  created.catch(() => {});
  opts.onCreating?.(created);

  let pid: number | undefined;
  let errored = false;
  let exited = false;
  const emitError = (kind: SidecarErrorKind, message: string): void => {
    createdReject(new Error(message));
    if (errored) return;
    errored = true;
    for (const cb of errors) cb(kind, message);
  };
  const emitExit = (code: number | null, signal: string | null): void => {
    if (exited) return;
    exited = true;
    createdReject(new Error('exited'));
    for (const cb of exits) cb(code, signal);
  };
  const buf = (b: Uint8Array): Buffer => Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  const relayDied = (message: string): void => {
    if (exited) return;
    if (pid !== undefined) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* ESRCH: already gone */ }
    }
    emitError('relay', message);
    emitExit(null, null);
  };

  worker.on('message', (m: WorkerMsg) => {
    switch (m.t) {
      case 'spawned': pid = m.pid; createdResolve(m.pid); break;
      case 'out': for (const cb of out) cb(buf(m.b)); break;
      case 'err': for (const cb of err) cb(buf(m.b)); break;
      case 'error': emitError(m.kind, m.message); break;
      case 'exit':
        emitExit(m.code, m.signal);
        void worker.terminate();
        break;
    }
  });
  worker.on('error', (e) => relayDied(e.message));
  worker.on('exit', (code) => relayDied(`worker exited (code ${code})`));

  const post = (m: { t: 'end' } | { t: 'kill'; force: boolean }): void => {
    if (!exited) worker.postMessage(m);
  };
  return {
    onStdout: (cb) => { out.push(cb); },
    onStderr: (cb) => { err.push(cb); },
    onError: (cb) => { errors.push(cb); },
    onExit: (cb) => { exits.push(cb); },
    write: (b) => {
      if (exited) return;
      const u = new Uint8Array(b.byteLength);
      u.set(b);
      worker.postMessage({ t: 'in', b: u }, [u.buffer]);
    },
    end: () => post({ t: 'end' }),
    kill: (force) => post({ t: 'kill', force: !!force }),
  };
}
