import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmbedderClient, FrameDecoder, encodeFrame, type SidecarProcess } from './embedderClient.js';
import { SPAWN_WORKER_SRC, makeWorkerSpawner, spawnViaWorker, type WorkerSidecarProcess } from './embedderSpawnWorker.js';

const FAKE = fileURLToPath(new URL('./__fixtures__/fake-embedder.mjs', import.meta.url));
const procs: SidecarProcess[] = [];
const clients: EmbedderClient[] = [];

function fake(mode: string, graceMs?: number): WorkerSidecarProcess {
  process.env.FAKE_MODE = mode;
  process.env.FAKE_STATE = join(mkdtempSync(join(tmpdir(), 'fake-emb-')), 'crashed');
  const p = spawnViaWorker(process.execPath, [FAKE], { graceMs });
  procs.push(p);
  return p;
}

function exitOf(p: SidecarProcess): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((res) => p.onExit((code, signal) => res({ code, signal })));
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

afterEach(() => {
  for (const c of clients.splice(0)) c.dispose();
  for (const p of procs.splice(0)) p.kill();
});

describe('spawnViaWorker', () => {
  it('relays frames both ways and reports the child pid', async () => {
    const p = fake('ok');
    const d = new FrameDecoder();
    const msgs: Record<string, unknown>[] = [];
    const got = new Promise<void>((res) => p.onStdout((b) => {
      expect(Buffer.isBuffer(b)).toBe(true);
      msgs.push(...(d.push(b) as Record<string, unknown>[]));
      if (msgs.length === 2) res();
    }));
    expect(await p.created).toBeGreaterThan(0);
    p.write(encodeFrame({ id: 7, texts: ['abc'] }));
    await got;
    expect(msgs[0]).toMatchObject({ type: 'ready', protocol: 1 });
    expect(msgs[1]).toMatchObject({ id: 7, n: 1, dim: 384 });
  });

  it('passes the creation promise to onCreating', async () => {
    process.env.FAKE_MODE = 'ok';
    let created: Promise<void> | undefined;
    const p = makeWorkerSpawner({ onCreating: (c) => { created = c; } })(process.execPath, [FAKE]);
    procs.push(p);
    expect(created).toBeDefined();
    await expect(created).resolves.toBeUndefined();
  });

  it('reports the child exit after its last output', async () => {
    const p = fake('fatal');
    const d = new FrameDecoder();
    const seen: unknown[] = [];
    p.onStdout((b) => seen.push(...d.push(b)));
    const e = await exitOf(p);
    expect(e.code).toBe(1);
    expect(seen).toEqual([{ type: 'fatal', error: 'model missing' }]);
  });

  it('surfaces a missing binary as an error and exit', async () => {
    const p = spawnViaWorker('/nonexistent/fleet-embedder', []);
    procs.push(p);
    const err = new Promise<Error>((res) => p.onError(res));
    await expect(p.created).rejects.toThrow(/ENOENT/);
    expect((await err).message).toMatch(/ENOENT/);
  });

  it('end() closes stdin and the child exits', async () => {
    const p = fake('ok');
    const pid = await p.created;
    const exit = exitOf(p);
    p.end();
    expect((await exit).code).toBe(0);
    expect(alive(pid)).toBe(false);
  });

  it('end() kills a child that ignores EOF within the grace period', async () => {
    const p = fake('ignore-eof', 150);
    const pid = await p.created;
    const exit = exitOf(p);
    const t0 = Date.now();
    p.end();
    const e = await exit;
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(e.signal ?? e.code).not.toBe(0);
    expect(alive(pid)).toBe(false);
  });

  it('a crashed worker surfaces as an error and an exit', async () => {
    process.env.FAKE_MODE = 'ok';
    const src = `require('node:worker_threads').parentPort.once('message', () => { throw new Error('boom'); });\n${SPAWN_WORKER_SRC}`;
    const p = spawnViaWorker(process.execPath, [FAKE], { workerSource: src });
    procs.push(p);
    const err = new Promise<Error>((res) => p.onError(res));
    const exit = exitOf(p);
    await p.created;
    p.write(encodeFrame({ id: 1, texts: ['a'] }));
    expect((await err).message).toContain('boom');
    expect(await exit).toEqual({ code: null, signal: null });
  });
});

describe('EmbedderClient over the worker spawner', () => {
  it('restarts after a worker crash and resends the in-flight request', async () => {
    process.env.FAKE_MODE = 'ok';
    const crashing = `require('node:worker_threads').parentPort.once('message', () => { throw new Error('boom'); });\n${SPAWN_WORKER_SRC}`;
    let n = 0;
    const logs: string[] = [];
    const onFatal = vi.fn();
    const c = new EmbedderClient({
      bin: process.execPath, args: [FAKE], onFatal, log: (m) => logs.push(m),
      spawner: (bin, args) => spawnViaWorker(bin, args, n++ === 0 ? { workerSource: crashing } : {}),
    });
    clients.push(c);
    const out = await c.embed(['abcd']);
    expect(out[0][4]).toBe(1);
    expect(n).toBe(2);
    expect(onFatal).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('spawn worker crashed: boom');
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
});
