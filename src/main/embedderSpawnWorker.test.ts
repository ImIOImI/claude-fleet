import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmbedderClient, FrameDecoder, encodeFrame, type SidecarErrorKind, type SidecarProcess } from './embedderClient.js';
import { SPAWN_WORKER_SRC, makeWorkerSpawner, spawnViaWorker } from './embedderSpawnWorker.js';
import { procState, waitForState } from './__fixtures__/procState.js';

const FAKE = fileURLToPath(new URL('./__fixtures__/fake-embedder.mjs', import.meta.url));
const THROW_ON_FIRST_MESSAGE = `require('node:worker_threads').parentPort.once('message', () => { throw new Error('boom'); });\n`;
const EXIT_ON_FIRST_MESSAGE = `require('node:worker_threads').parentPort.once('message', () => process.exit(7));\n`;
const procs: SidecarProcess[] = [];
const clients: EmbedderClient[] = [];

interface Spawned {
  p: SidecarProcess;
  pid: Promise<number>;
  errors: Array<[SidecarErrorKind, string]>;
  exits: Array<[number | null, string | null]>;
  exited: Promise<[number | null, string | null]>;
}

function start(mode: string, bin = process.execPath, workerSource?: string, args = bin === process.execPath ? [FAKE] : []): Spawned {
  process.env.FAKE_MODE = mode;
  process.env.FAKE_STATE = join(mkdtempSync(join(tmpdir(), 'fake-emb-')), 'crashed');
  let pid!: Promise<number>;
  const p = spawnViaWorker(bin, args, { workerSource, onCreating: (c) => { pid = c; } });
  procs.push(p);
  const errors: Spawned['errors'] = [];
  const exits: Spawned['exits'] = [];
  p.onError((k, m) => errors.push([k, m]));
  const exited = new Promise<[number | null, string | null]>((res) => p.onExit((c, s) => { exits.push([c, s]); res([c, s]); }));
  return { p, pid, errors, exits, exited };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 300));

afterEach(() => {
  for (const c of clients.splice(0)) c.dispose();
  for (const p of procs.splice(0)) p.kill(true);
});

describe('spawnViaWorker', () => {
  it('relays frames both ways', async () => {
    const { p, pid } = start('ok');
    const d = new FrameDecoder();
    const msgs: Record<string, unknown>[] = [];
    const got = new Promise<void>((res) => p.onStdout((b) => {
      expect(Buffer.isBuffer(b)).toBe(true);
      msgs.push(...(d.push(b) as Record<string, unknown>[]));
      if (msgs.length === 2) res();
    }));
    expect(await pid).toBeGreaterThan(0);
    p.write(encodeFrame({ id: 7, texts: ['abc'] }));
    await got;
    expect(msgs[0]).toMatchObject({ type: 'ready', protocol: 1 });
    expect(msgs[1]).toMatchObject({ id: 7, n: 1, dim: 384 });
  });

  it('reports the child exit after its last output, once', async () => {
    const s = start('fatal');
    const d = new FrameDecoder();
    const seen: unknown[] = [];
    s.p.onStdout((b) => seen.push(...d.push(b)));
    expect((await s.exited)[0]).toBe(1);
    await settle();
    expect(seen).toEqual([{ type: 'fatal', error: 'model missing' }]);
    expect(s.exits).toHaveLength(1);
    expect(s.errors).toEqual([]);
  });

  it('a missing binary is exactly one spawn error and one exit', async () => {
    const s = start('ok', '/nonexistent/fleet-embedder');
    await expect(s.pid).rejects.toThrow();
    await s.exited;
    await settle();
    expect(s.errors).toHaveLength(1);
    expect(s.errors[0][0]).toBe('spawn');
    expect(s.errors[0][1]).toMatch(/ENOENT/);
    expect(s.exits).toHaveLength(1);
  });

  it('end() closes stdin and the child exits', async () => {
    const s = start('ok');
    const pid = await s.pid;
    s.p.end();
    expect((await s.exited)[0]).toBe(0);
    expect(await waitForState(pid, 'gone')).toBe('gone');
  });

  it('a runtime child error kills and reaps the child', async () => {
    const src = `${SPAWN_WORKER_SRC}\nsetTimeout(() => child.emit('error', new Error('kill failed')), 200);\n`;
    const s = start('ignore-term', process.execPath, src);
    const pid = await s.pid;
    await s.exited;
    await settle();
    expect(s.errors).toEqual([['child', 'kill failed']]);
    expect(s.exits).toHaveLength(1);
    expect(await waitForState(pid, 'gone')).toBe('gone');
  });

  it('a worker that throws kills and reaps the child before reporting', async () => {
    const s = start('ok', process.execPath, THROW_ON_FIRST_MESSAGE + SPAWN_WORKER_SRC);
    const pid = await s.pid;
    s.p.write(encodeFrame({ id: 1, texts: ['a'] }));
    await s.exited;
    expect(s.errors).toEqual([['relay', 'boom']]);
    expect(await waitForState(pid, 'gone')).toBe('gone');
    await settle();
    expect(s.exits).toHaveLength(1);
  });

  // sleep, not node: it neither exits on a closed pipe nor inherits the test runner's env hooks.
  it.skipIf(process.platform === 'win32')('a worker that dies outright still gets its child killed', async () => {
    const s = start('ok', '/bin/sleep', EXIT_ON_FIRST_MESSAGE + SPAWN_WORKER_SRC, ['30']);
    const pid = await s.pid;
    s.p.end();
    expect(await s.exited).toEqual([null, null]);
    expect(s.errors).toEqual([['relay', 'worker exited (code 7)']]);
    // Unreaped (zombie) on POSIX until the app exits: only the dead thread could reap it.
    const end = Date.now() + 2_000;
    while (procState(pid) === 'alive' && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
    expect(procState(pid)).not.toBe('alive');
  });

  it('does not kill a reaped pid when the worker dies before close', async () => {
    const src = `${SPAWN_WORKER_SRC}\nchild.on('exit', () => process.exit(5));\n`;
    const s = start('ok', process.execPath, src);
    const pid = await s.pid;
    const kill = vi.spyOn(process, 'kill');
    try {
      s.p.end();
      await s.exited;
      expect(kill.mock.calls.filter(([p]) => p === pid)).toEqual([]);
    } finally {
      kill.mockRestore();
    }
  });

  it('relays frames larger than the worker heap limit', async () => {
    process.env.FAKE_MODE = 'ok';
    const c = new EmbedderClient({ bin: process.execPath, args: [FAKE], onFatal: () => {}, log: () => {}, spawner: makeWorkerSpawner() });
    clients.push(c);
    const big = 'x'.repeat(40 * 1024 * 1024);
    const many = Array.from({ length: 3_000 }, (_, i) => 'y'.repeat(i % 50));
    expect((await c.embed([big]))[0]).toHaveLength(384);
    expect(await c.embed(many)).toHaveLength(3_000);
  }, 60_000);
});

describe('EmbedderClient over the worker spawner', () => {
  it('restarts after a worker crash and resends the in-flight request', async () => {
    process.env.FAKE_MODE = 'ok';
    let n = 0;
    const logs: string[] = [];
    const onFatal = vi.fn();
    const c = new EmbedderClient({
      bin: process.execPath, args: [FAKE], onFatal, log: (m) => logs.push(m),
      spawner: (bin, args) => spawnViaWorker(bin, args, n++ === 0 ? { workerSource: THROW_ON_FIRST_MESSAGE + SPAWN_WORKER_SRC } : {}),
    });
    clients.push(c);
    const out = await c.embed(['abcd']);
    expect(out[0][4]).toBe(1);
    expect(n).toBe(2);
    expect(onFatal).not.toHaveBeenCalled();
    expect(logs).toContain('fleet-embedder: relay worker crashed: boom');
  }, 15_000);

  it('restarts after the child exits mid-request', async () => {
    process.env.FAKE_MODE = 'crash-on-first';
    process.env.FAKE_STATE = join(mkdtempSync(join(tmpdir(), 'fake-emb-')), 'crashed');
    const logs: string[] = [];
    const c = new EmbedderClient({ bin: process.execPath, args: [FAKE], onFatal: () => {}, log: (m) => logs.push(m), spawner: makeWorkerSpawner() });
    clients.push(c);
    expect((await c.embed(['ab']))[0][2]).toBe(1);
    expect(logs.join('\n')).toContain('exited code=3');
  }, 15_000);

  it('labels a missing binary as a spawn failure', async () => {
    const logs: string[] = [];
    const c = new EmbedderClient({ bin: '/nonexistent/fleet-embedder', args: [], onFatal: () => {}, log: (m) => logs.push(m), spawner: makeWorkerSpawner() });
    clients.push(c);
    await expect(c.embed(['x'])).rejects.toThrow();
    expect(logs[0]).toMatch(/^fleet-embedder: spawn failed: .*ENOENT/);
  }, 20_000);
});
