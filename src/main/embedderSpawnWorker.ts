// Spawns the fleet-embedder sidecar from a worker thread, which owns the child
// and relays its stdio over the worker port. CreateProcess can take seconds on
// Windows (first-run AV scan of the exe); here it blocks only the worker.
// An `eval` worker (as in queryWorker.ts) needs no extra bundle entry or asar
// handling in packaged builds.
import { Worker } from 'node:worker_threads';
import type { SidecarProcess, SidecarSpawner } from './embedderClient.js';

export const SPAWN_WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
const { spawn } = require('node:child_process');
const t0 = Date.now();
let child = null;
try {
  child = spawn(workerData.bin, workerData.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
} catch (e) {
  parentPort.postMessage({ t: 'error', message: String((e && e.message) || e) });
  parentPort.close();
}
if (child) {
  child.stdin.on('error', () => {});
  child.stdout.on('data', (b) => parentPort.postMessage({ t: 'out', b }));
  child.stderr.on('data', (b) => parentPort.postMessage({ t: 'err', b }));
  child.on('error', (e) => {
    parentPort.postMessage({ t: 'error', message: e.message });
    if (child.pid === undefined) parentPort.close();
  });
  // 'close' (not 'exit') so every stdout chunk is posted before the exit.
  child.on('close', (code, signal) => {
    parentPort.postMessage({ t: 'exit', code, signal });
    parentPort.close();
  });
  parentPort.on('message', (m) => {
    if (m.t === 'in') child.stdin.write(m.b);
    else if (m.t === 'end') child.stdin.end();
    else if (m.t === 'kill') child.kill();
  });
  if (child.pid !== undefined) parentPort.postMessage({ t: 'spawned', pid: child.pid, ms: Date.now() - t0 });
}
`;

/** After end(): kill the child at graceMs, terminate the worker at 2 × graceMs. */
export const SHUTDOWN_GRACE_MS = 2_000;

export interface WorkerSpawnerOptions {
  /** Receives each spawn's "child process exists" promise (perf span hook). */
  onCreating?: (created: Promise<void>) => void;
  /** Test seam. */
  workerSource?: string;
  graceMs?: number;
}

type WorkerMsg =
  | { t: 'spawned'; pid: number; ms: number }
  | { t: 'out' | 'err'; b: Uint8Array }
  | { t: 'error'; message: string }
  | { t: 'exit'; code: number | null; signal: string | null };

export interface WorkerSidecarProcess extends SidecarProcess {
  /** Resolves with the child's pid once it exists. */
  readonly created: Promise<number>;
}

export function makeWorkerSpawner(opts: WorkerSpawnerOptions = {}): SidecarSpawner {
  return (bin, args) => spawnViaWorker(bin, args, opts);
}

export function spawnViaWorker(bin: string, args: string[], opts: WorkerSpawnerOptions = {}): WorkerSidecarProcess {
  const graceMs = opts.graceMs ?? SHUTDOWN_GRACE_MS;
  const worker = new Worker(opts.workerSource ?? SPAWN_WORKER_SRC, { eval: true, workerData: { bin, args } });
  // Never holds the event loop (or quit) open; the sidecar exits when its stdin pipe closes.
  worker.unref();

  const out: Array<(b: Buffer) => void> = [];
  const err: Array<(b: Buffer) => void> = [];
  const errors: Array<(e: Error) => void> = [];
  const exits: Array<(code: number | null, signal: string | null) => void> = [];
  let createdResolve!: (pid: number) => void;
  let createdReject!: (e: Error) => void;
  const created = new Promise<number>((res, rej) => { createdResolve = res; createdReject = rej; });
  created.catch(() => {});
  opts.onCreating?.(created.then(() => undefined));

  let exited = false;
  const emitExit = (code: number | null, signal: string | null): void => {
    if (exited) return;
    exited = true;
    for (const cb of exits) cb(code, signal);
  };
  const emitError = (e: Error): void => {
    createdReject(e);
    for (const cb of errors) cb(e);
  };
  const buf = (b: Uint8Array): Buffer => Buffer.from(b.buffer, b.byteOffset, b.byteLength);

  worker.on('message', (m: WorkerMsg) => {
    switch (m.t) {
      case 'spawned': createdResolve(m.pid); break;
      case 'out': for (const cb of out) cb(buf(m.b)); break;
      case 'err': for (const cb of err) cb(buf(m.b)); break;
      case 'error': emitError(new Error(m.message)); break;
      case 'exit': emitExit(m.code, m.signal); break;
    }
  });
  worker.on('error', (e) => emitError(new Error(`spawn worker crashed: ${e.message}`)));
  worker.on('exit', (code) => {
    if (exited) return;
    // A worker gone without reporting the child's exit: surface it as a child failure.
    emitError(new Error(`spawn worker exited (code ${code})`));
    emitExit(null, null);
  });

  const post = (m: { t: 'in'; b: Buffer } | { t: 'end' } | { t: 'kill' }): void => {
    if (!exited) worker.postMessage(m);
  };
  return {
    created,
    onStdout: (cb) => { out.push(cb); },
    onStderr: (cb) => { err.push(cb); },
    onError: (cb) => { errors.push(cb); },
    onExit: (cb) => { exits.push(cb); },
    write: (b) => post({ t: 'in', b }),
    end: () => {
      post({ t: 'end' });
      const kill = setTimeout(() => post({ t: 'kill' }), graceMs);
      const term = setTimeout(() => { if (!exited) void worker.terminate(); }, 2 * graceMs);
      kill.unref();
      term.unref();
    },
    kill: () => post({ t: 'kill' }),
  };
}
