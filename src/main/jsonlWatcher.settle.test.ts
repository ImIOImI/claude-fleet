// chokidar drops a file's events that land within 5 ms of the previous one
// — a write in that window gets no event. A fake chokidar that delivers only
// the first event shows the trailing re-check still reads the write.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let userDataDir = '';
vi.mock('electron', () => ({
  app: {
    getPath: (which: string) => {
      if (which === 'userData' || which === 'home') return userDataDir;
      throw new Error(`unexpected getPath: ${which}`);
    },
  },
}));

const h = vi.hoisted(() => ({
  ingested: [] as string[],
  gate: null as Promise<void> | null,
  entered: false,
  fake: null as (import('node:events').EventEmitter & Record<string, unknown>) | null,
}));
vi.mock('./db.js', () => ({
  ingestBatch: async (_ws: string, _session: string, raws: string[]) => {
    h.entered = true;
    await h.gate;
    return raws.map((raw) => {
      h.ingested.push((JSON.parse(raw) as { uuid: string }).uuid);
      return { inserted: true };
    });
  },
}));
vi.mock('chokidar', () => ({
  default: {},
  watch: () => {
    const w = new EventEmitter() as EventEmitter & Record<string, unknown>;
    w.add = () => w;
    w.unwatch = () => w;
    w.close = async () => {};
    h.fake = w;
    return w;
  },
}));

const { JsonlWatcher } = await import('./jsonlWatcher.js');
const SESSION = '11111111-2222-3333-4444-555555555555';
const line = (uuid: string): string => JSON.stringify({ type: 'user', uuid }) + '\n';
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitUntil(fn: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await sleep(10);
  }
}

let watcher: InstanceType<typeof JsonlWatcher>;
let dir: string;
beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'cf-watch-settle-'));
  h.ingested.length = 0;
  h.entered = false;
  dir = join(userDataDir, 'projects', '-home-x');
  mkdirSync(dir, { recursive: true });
  watcher = new JsonlWatcher({ nativeRecursive: false });
  await watcher.start([]);
  watcher.registerLocalDirForTest('ws-settle', dir);
});
afterEach(async () => {
  await watcher.stop();
  await rm(userDataDir, { recursive: true, force: true });
});

it('reads a write whose own change event was dropped', async () => {
  const file = join(dir, `${SESSION}.jsonl`);
  let release!: () => void;
  h.gate = new Promise<void>((r) => (release = r));
  writeFileSync(file, line('a'));
  h.fake!.emit('change', file);
  // Batch for 'a' is in flight; 'b' lands with no event of its own.
  await waitUntil(() => h.entered);
  appendFileSync(file, line('b'));
  release();
  await waitUntil(() => h.ingested.includes('b'));
  expect(h.ingested).toEqual(['a', 'b']);
});

it('does not re-check a file after it is unlinked', async () => {
  h.gate = null;
  const file = join(dir, `${SESSION}.jsonl`);
  writeFileSync(file, line('a'));
  h.fake!.emit('change', file);
  await waitUntil(() => h.ingested.length === 1);
  h.fake!.emit('unlink', file);
  writeFileSync(file, line('a') + line('b'));
  await sleep(400);
  expect(h.ingested).toEqual(['a']);
});
