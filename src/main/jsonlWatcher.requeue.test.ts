// A store outage: ingest throws, the offset stays put, and requeueAll() after
// recovery ingests what the failed batches carried.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
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

const h = vi.hoisted(() => ({ down: false, attempts: 0, ingested: [] as string[] }));
vi.mock('./db.js', () => ({
  loadTranscriptOffsets: async () => new Map(),
  saveTranscriptOffsets: async () => undefined,
  deleteTranscriptOffsets: async () => undefined,
  ingestBatch: async (_ws: string, _session: string, raws: string[]) => {
    h.attempts++;
    if (h.down) throw new Error('connect ECONNREFUSED');
    return raws.map((raw) => { h.ingested.push((JSON.parse(raw) as { uuid: string }).uuid); return { inserted: true }; });
  },
}));

const { JsonlWatcher } = await import('./jsonlWatcher.js');
const SESSION = '11111111-2222-3333-4444-555555555555';
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitUntil(fn: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await sleep(25);
  }
}

let watcher: InstanceType<typeof JsonlWatcher>;
let dir: string;
beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'cf-watch-requeue-'));
  h.down = false;
  h.attempts = 0;
  h.ingested.length = 0;
  dir = join(userDataDir, 'projects', '-home-x');
  mkdirSync(dir, { recursive: true });
  watcher = new JsonlWatcher();
  await watcher.start([]);
  watcher.registerLocalDirForTest('ws-requeue', dir);
});
afterEach(async () => {
  await watcher.stop();
  await rm(userDataDir, { recursive: true, force: true });
});

it('re-reads a file whose batch failed while the store was down', async () => {
  h.down = true;
  const file = join(dir, `${SESSION}.jsonl`);
  writeFileSync(file, JSON.stringify({ type: 'user', uuid: 'u1' }) + '\n');
  (watcher as unknown as { enqueue(p: string): void }).enqueue(file);
  await waitUntil(() => h.attempts > 0);
  await sleep(50);
  expect(h.ingested).toEqual([]);
  h.down = false;
  watcher.requeueAll();
  await waitUntil(() => h.ingested.length === 1);
  expect(h.ingested).toEqual(['u1']);
});
