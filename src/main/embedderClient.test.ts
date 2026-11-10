import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmbedderClient, EmbedderUnavailable, FrameDecoder, directSpawner, encodeFrame, type SidecarSpawner } from './embedderClient.js';
import { makeWorkerSpawner } from './embedderSpawnWorker.js';
import { waitForState } from './__fixtures__/procState.js';

const FAKE = fileURLToPath(new URL('./__fixtures__/fake-embedder.mjs', import.meta.url));
const clients: EmbedderClient[] = [];
let spawner: SidecarSpawner = directSpawner;

function client(mode: string, extra: Partial<ConstructorParameters<typeof EmbedderClient>[0]> = {}) {
  process.env.FAKE_MODE = mode;
  process.env.FAKE_STATE = join(mkdtempSync(join(tmpdir(), 'fake-emb-')), 'crashed');
  const onFatal = vi.fn();
  const logs: string[] = [];
  const c = new EmbedderClient({ bin: process.execPath, args: [FAKE], onFatal, log: (m) => logs.push(m), spawner, ...extra });
  clients.push(c);
  return { c, onFatal, logs };
}

afterEach(() => { for (const c of clients.splice(0)) c.dispose(); });

describe('frames', () => {
  it('decodes frames split across chunks', () => {
    const d = new FrameDecoder();
    const bytes = Buffer.concat([encodeFrame({ a: 1 }), encodeFrame({ b: 2 })]);
    expect(d.push(bytes.subarray(0, 3))).toEqual([]);
    expect(d.push(bytes.subarray(3, 12))).toEqual([{ a: 1 }]);
    expect(d.push(bytes.subarray(12))).toEqual([{ b: 2 }]);
  });
});

describe.each([
  ['direct', directSpawner],
  ['worker', makeWorkerSpawner()],
] as const)('EmbedderClient (%s spawn)', (_name, s) => {
  beforeEach(() => { spawner = s; });

  it('returns one 384-d Float32Array per text', async () => {
    const { c } = client('ok');
    const out = await c.embed(['a', 'abc']);
    expect(out).toHaveLength(2);
    expect(out[0]).toBeInstanceOf(Float32Array);
    expect(out[0].length).toBe(384);
    expect(out[0][1]).toBe(1);
    expect(out[1][3]).toBe(1);
  });

  it('matches concurrent calls to their own responses', async () => {
    const { c } = client('ok');
    const [x, y] = await Promise.all([c.embed(['aa']), c.embed(['aaaaa'])]);
    expect(x[0][2]).toBe(1);
    expect(y[0][5]).toBe(1);
  });

  it('returns [] for no texts without spawning', async () => {
    const { c } = client('fatal');
    expect(await c.embed([])).toEqual([]);
  });

  it('resends the in-flight request once after a crash', async () => {
    const { c, onFatal } = client('crash-on-first');
    const out = await c.embed(['abcd']);
    expect(out[0][4]).toBe(1);
    expect(onFatal).not.toHaveBeenCalled();
  }, 15_000);

  it('rejects a per-request error without counting a failure', async () => {
    const { c, onFatal } = client('error-reply');
    await expect(c.embed(['x'])).rejects.toThrow('embedder: boom');
    await expect(c.embed(['x'])).rejects.toThrow('embedder: boom');
    expect(onFatal).not.toHaveBeenCalled();
  });

  it('gives up after 3 failures and reports once', async () => {
    const { c, onFatal } = client('fatal');
    await expect(c.embed(['x'])).rejects.toBeInstanceOf(Error);
    await expect(c.embed(['y'])).rejects.toBeInstanceOf(EmbedderUnavailable);
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(onFatal.mock.calls[0][0]).toContain('model missing');
    await expect(c.embed(['z'])).rejects.toBeInstanceOf(EmbedderUnavailable);
  }, 20_000);

  it('kills a child that never becomes ready', async () => {
    const { c, logs } = client('never-ready', { readyTimeoutMs: 200 });
    await expect(c.embed(['x'])).rejects.toBeInstanceOf(Error);
    expect(logs.join('\n')).toContain('no ready within timeout');
  }, 20_000);

  it('kills a hung request after the timeout', async () => {
    const { c, logs } = client('hang', { timeoutMs: 300 });
    await expect(c.embed(['x'])).rejects.toBeInstanceOf(Error);
    expect(logs.join('\n')).toContain('request timeout');
  }, 20_000);

  it('a failure outside the 5-minute window does not count', async () => {
    let t = 0;
    const { c, onFatal } = client('crash-on-first', { now: () => t });
    await c.embed(['a']);
    t += 6 * 60_000;
    // FAKE_STATE persists, so this child is healthy; only the window logic is exercised.
    await c.embed(['b']);
    expect(onFatal).not.toHaveBeenCalled();
  }, 15_000);

  it('rejects a missing binary as a failure, then gives up', async () => {
    const onFatal = vi.fn();
    const c = new EmbedderClient({ bin: '/nonexistent/fleet-embedder', args: [], onFatal, log: () => {}, spawner });
    clients.push(c);
    await expect(c.embed(['x'])).rejects.toBeInstanceOf(Error);
    await expect(c.embed(['x'])).rejects.toBeInstanceOf(EmbedderUnavailable);
    expect(onFatal).toHaveBeenCalledTimes(1);
  }, 20_000);

  it('rejects a reply with fewer vectors than texts', async () => {
    const { c } = client('short-reply');
    await expect(c.embed(['a', 'b'])).rejects.toThrow('returned 1 vectors for 2 texts');
  });

  it('logs stderr by whole line', async () => {
    const { c, logs } = client('stderr-split');
    await c.embed(['a']);
    await new Promise((r) => setTimeout(r, 300));
    expect(logs).toEqual(['fleet-embedder stderr: first half', 'fleet-embedder stderr: second']);
  });

  it.each([
    ['closing stdin', 'ok'],
    ['SIGTERM after the grace period', 'ignore-eof'],
    ['SIGKILL after twice the grace period', 'ignore-term'],
  ])('dispose stops the child by %s', async (_how, mode) => {
    const pidFile = join(mkdtempSync(join(tmpdir(), 'fake-emb-')), 'pid');
    process.env.FAKE_PID_FILE = pidFile;
    try {
      const { c } = client(mode, { disposeGraceMs: 150 });
      await c.embed(['a']);
      const pid = Number(readFileSync(pidFile, 'utf8'));
      c.dispose();
      expect(await waitForState(pid, 'gone', 2_000)).toBe('gone');
    } finally {
      delete process.env.FAKE_PID_FILE;
    }
  });

  it('gives up at once on a protocol mismatch', async () => {
    const { c, onFatal, logs } = client('old-protocol');
    await expect(c.embed(['a'])).rejects.toBeInstanceOf(EmbedderUnavailable);
    expect(onFatal).toHaveBeenCalledOnce();
    expect(onFatal.mock.calls[0][0]).toBe('fleet-embedder speaks protocol 0, host expects 1');
    expect(logs).toContain('fleet-embedder speaks protocol 0, host expects 1');
  });
});
