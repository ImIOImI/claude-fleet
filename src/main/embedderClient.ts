// Host side of the fleet-embedder sidecar (embedder/README.md): lazy spawn,
// one request in flight, restart with backoff, crash-loop detection.
import { spawn } from 'node:child_process';
import { EMBED_DIM } from './vectors.js';

/** Thrown once the sidecar is given up on; callers switch to the fallback. */
export class EmbedderUnavailable extends Error {
  constructor(reason: string) {
    super(`embedder sidecar unavailable: ${reason}`);
    this.name = 'EmbedderUnavailable';
  }
}

export const MAX_FRAME = 64 * 1024 * 1024;
/** Must equal the sidecar's `ready.protocol` (embedder/src/main.rs). */
export const EMBEDDER_PROTOCOL = 1;

export function encodeFrame(obj: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const out: unknown[] = [];
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32LE(0);
      if (len > MAX_FRAME) throw new Error(`frame of ${len} bytes exceeds ${MAX_FRAME}`);
      if (this.buf.length < 4 + len) break;
      out.push(JSON.parse(this.buf.subarray(4, 4 + len).toString('utf8')));
      this.buf = this.buf.subarray(4 + len);
    }
    return out;
  }
}

export function decodeVectors(b64: string, n: number, dim: number): Float32Array[] {
  const bytes = Buffer.from(b64, 'base64');
  if (dim !== EMBED_DIM || bytes.length !== n * dim * 4) {
    throw new Error(`embedder returned ${bytes.length} bytes for n=${n} dim=${dim}`);
  }
  const out: Float32Array[] = [];
  for (let i = 0; i < n; i++) {
    const v = new Float32Array(dim);
    for (let k = 0; k < dim; k++) v[k] = bytes.readFloatLE((i * dim + k) * 4);
    out.push(v);
  }
  return out;
}

export const CRASH_LOOP_FAILURES = 3;
export const CRASH_LOOP_WINDOW_MS = 5 * 60_000;
export const MAX_BACKOFF_MS = 30_000;
export const REQUEST_TIMEOUT_MS = 120_000;
const STDERR_LINES_PER_MIN = 20;
/** dispose(): SIGTERM this long after closing stdin, SIGKILL after twice this. */
export const DISPOSE_GRACE_MS = 2_000;

/** spawn: the child never existed. child: a runtime error (the child is killed). relay: the owning worker died. */
export type SidecarErrorKind = 'spawn' | 'child' | 'relay';

const ERROR_LABEL: Record<SidecarErrorKind, string> = {
  spawn: 'spawn failed',
  child: 'child error',
  relay: 'relay worker crashed',
};

/** The sidecar's stdio and lifecycle, however it was spawned. An error is always followed by one exit. */
export interface SidecarProcess {
  /** Undefined until the child exists. */
  readonly pid: number | undefined;
  onStdout(cb: (chunk: Buffer) => void): void;
  onStderr(cb: (chunk: Buffer) => void): void;
  onError(cb: (kind: SidecarErrorKind, message: string) => void): void;
  onExit(cb: (code: number | null, signal: string | null) => void): void;
  write(chunk: Buffer): void;
  /** Closes stdin; the sidecar exits on EOF. */
  end(): void;
  kill(force?: boolean): void;
}

/** env, when set, replaces the inherited environment. */
export type SidecarSpawner = (bin: string, args: string[], env?: NodeJS.ProcessEnv) => SidecarProcess;

/** Spawns on the calling thread (CreateProcess blocks it until the child exists). */
export const directSpawner: SidecarSpawner = (bin, args, env) => {
  const c = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env });
  // stdin EPIPE after a crash surfaces here; 'exit' does the bookkeeping.
  c.stdin!.on('error', () => {});
  return {
    get pid() { return c.pid; },
    onStdout: (cb) => { c.stdout!.on('data', cb); },
    onStderr: (cb) => { c.stderr!.on('data', cb); },
    onError: (cb) => {
      c.on('error', (e) => {
        const spawned = c.pid !== undefined;
        if (spawned) c.kill('SIGKILL');
        cb(spawned ? 'child' : 'spawn', e.message);
      });
    },
    onExit: (cb) => { c.on('exit', cb); },
    write: (chunk) => { c.stdin!.write(chunk); },
    end: () => { c.stdin!.end(); },
    kill: (force) => { c.kill(force ? 'SIGKILL' : 'SIGTERM'); },
  };
};

export interface EmbedderClientOptions {
  bin: string;
  args: string[];
  timeoutMs?: number;
  /** Bounds spawn → ready (model load). */
  readyTimeoutMs?: number;
  now?: () => number;
  /** Called once, when the crash loop trips. */
  onFatal: (reason: string) => void;
  log: (msg: string) => void;
  /** Receives each spawn's ready promise (perf span hook). */
  onSpawn?: (ready: Promise<void>) => void;
  /** Defaults to directSpawner. */
  spawner?: SidecarSpawner;
  disposeGraceMs?: number;
  /** Replaces the inherited environment when set. */
  env?: NodeJS.ProcessEnv;
}

interface Pending {
  texts: string[];
  resolve: (v: Float32Array[]) => void;
  reject: (e: Error) => void;
  attempts: number;
}

type State = 'idle' | 'starting' | 'ready' | 'backoff' | 'dead';

export class EmbedderClient {
  private state: State = 'idle';
  private child: SidecarProcess | null = null;
  private queue: Pending[] = [];
  private inflight: { p: Pending; id: number } | null = null;
  private nextId = 1;
  private failures: number[] = [];
  private timer: NodeJS.Timeout | null = null;
  private lastFatal = '';
  private stderrWindow = { start: 0, lines: 0 };
  private stderrPartial = '';
  /** Killed but not yet exited: its late output must not settle requests. */
  private readonly killed = new WeakSet<SidecarProcess>();
  private readonly timeoutMs: number;
  private readonly readyTimeoutMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: EmbedderClientOptions) {
    this.timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.now = opts.now ?? Date.now;
  }

  embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return Promise.resolve([]);
    if (this.state === 'dead') return Promise.reject(new EmbedderUnavailable(this.lastFatal || 'stopped'));
    return new Promise((resolve, reject) => {
      this.queue.push({ texts, resolve, reject, attempts: 0 });
      if (this.state === 'idle') this.start();
      else this.pump();
    });
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** Closes stdin (the sidecar exits on EOF), then escalates to SIGTERM and SIGKILL. */
  dispose(): void {
    const child = this.child;
    this.stop('disposed');
    if (!child) return;
    const grace = this.opts.disposeGraceMs ?? DISPOSE_GRACE_MS;
    const term = setTimeout(() => child.kill(), grace);
    const kill = setTimeout(() => child.kill(true), 2 * grace);
    term.unref?.();
    kill.unref?.();
    child.onExit(() => { clearTimeout(term); clearTimeout(kill); });
    child.end();
  }

  private start(): void {
    this.state = 'starting';
    this.lastFatal = '';
    let child: SidecarProcess;
    try {
      child = (this.opts.spawner ?? directSpawner)(this.opts.bin, this.opts.args, this.opts.env);
    } catch (e) {
      this.onChildGone(null, `spawn failed: ${String(e)}`);
      return;
    }
    this.child = child;
    this.stderrPartial = '';
    const decoder = new FrameDecoder();
    let readyResolve!: () => void;
    let readyReject!: (e: Error) => void;
    const ready = new Promise<void>((res, rej) => { readyResolve = res; readyReject = rej; });
    ready.catch(() => {});
    this.opts.onSpawn?.(ready);
    this.arm(() => {
      readyReject(new Error('ready timeout'));
      this.kill(child, 'no ready within timeout');
    }, this.readyTimeoutMs);

    child.onStdout((chunk) => {
      let msgs: unknown[];
      try { msgs = decoder.push(chunk); } catch (e) { this.kill(child, `protocol error: ${String(e)}`); return; }
      for (const m of msgs) this.onMessage(child, m as Record<string, unknown>, readyResolve);
    });
    child.onStderr((chunk) => this.logStderr(chunk.toString('utf8')));
    let gone = false;
    const onGone = (why: string): void => {
      if (gone) return;
      gone = true;
      readyReject(new Error(why));
      this.onChildGone(child, why);
    };
    child.onError((kind, message) => onGone(`${ERROR_LABEL[kind]}: ${message}`));
    child.onExit((code, signal) => onGone(this.lastFatal || `exited code=${code} signal=${signal}`));
  }

  private onMessage(child: SidecarProcess, m: Record<string, unknown>, readyResolve: () => void): void {
    if (child !== this.child || this.killed.has(child)) return;
    if (m.type === 'ready') {
      if (m.protocol !== EMBEDDER_PROTOCOL) {
        // A stale or newer binary won't improve on restart: give up at once.
        const why = `fleet-embedder speaks protocol ${String(m.protocol ?? 'none')}, host expects ${EMBEDDER_PROTOCOL}`;
        this.opts.log(why);
        this.killed.add(child);
        child.kill();
        this.lastFatal = why;
        this.stop(why);
        this.opts.onFatal(why);
        return;
      }
      this.clearTimer();
      this.state = 'ready';
      readyResolve();
      this.pump();
      return;
    }
    if (m.type === 'fatal') {
      this.lastFatal = String(m.error);
      return;
    }
    const inf = this.inflight;
    if (!inf || m.id !== inf.id) {
      this.kill(child, `response id ${String(m.id)} does not match request ${inf?.id ?? 'none'}`);
      return;
    }
    this.clearTimer();
    this.inflight = null;
    if (typeof m.error === 'string') inf.p.reject(new Error(`embedder: ${m.error}`));
    else {
      try {
        if (Number(m.n) !== inf.p.texts.length) throw new Error(`embedder returned ${String(m.n)} vectors for ${inf.p.texts.length} texts`);
        inf.p.resolve(decodeVectors(String(m.vectors), Number(m.n), Number(m.dim)));
      } catch (e) { inf.p.reject(e as Error); }
    }
    this.pump();
  }

  private pump(): void {
    if (this.state !== 'ready' || this.inflight || this.queue.length === 0 || !this.child || this.killed.has(this.child)) return;
    const p = this.queue.shift()!;
    const id = this.nextId++;
    this.inflight = { p, id };
    const child = this.child;
    this.arm(() => this.kill(child, 'request timeout'), this.timeoutMs);
    child.write(encodeFrame({ id, texts: p.texts }));
  }

  private onChildGone(child: SidecarProcess | null, why: string): void {
    if (child !== this.child || this.state === 'dead') return;
    this.child = null;
    this.clearTimer();
    const inf = this.inflight;
    this.inflight = null;
    if (inf) {
      inf.p.attempts++;
      if (inf.p.attempts >= 2) inf.p.reject(new Error(`embedder failed twice: ${why}`));
      else this.queue.unshift(inf.p);
    }
    const t = this.now();
    this.failures = this.failures.filter((f) => t - f < CRASH_LOOP_WINDOW_MS);
    this.failures.push(t);
    this.opts.log(`fleet-embedder: ${why}`);
    if (this.failures.length >= CRASH_LOOP_FAILURES) {
      this.lastFatal = why;
      this.stop(why);
      this.opts.onFatal(why);
      return;
    }
    if (this.queue.length === 0) { this.state = 'idle'; return; }
    this.state = 'backoff';
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (this.failures.length - 1));
    this.timer = setTimeout(() => { this.timer = null; this.start(); }, delay);
    this.timer.unref?.();
  }

  private stop(reason: string): void {
    this.state = 'dead';
    this.clearTimer();
    this.child = null;
    const err = new EmbedderUnavailable(reason);
    if (this.inflight) { this.inflight.p.reject(err); this.inflight = null; }
    for (const p of this.queue.splice(0)) p.reject(err);
  }

  private kill(child: SidecarProcess, why: string): void {
    this.lastFatal = why;
    this.killed.add(child);
    child.kill();
  }

  private arm(fn: () => void, ms: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => { this.timer = null; fn(); }, ms);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  private logStderr(text: string): void {
    const t = this.now();
    if (t - this.stderrWindow.start > 60_000) this.stderrWindow = { start: t, lines: 0 };
    const lines = (this.stderrPartial + text).split('\n');
    this.stderrPartial = (lines.pop() ?? '').slice(-4096);
    for (const line of lines) {
      if (!line.trim() || this.stderrWindow.lines >= STDERR_LINES_PER_MIN) continue;
      this.stderrWindow.lines++;
      this.opts.log(`fleet-embedder stderr: ${line}`);
    }
  }
}
