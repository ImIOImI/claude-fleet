// Ingest ordering (async store part 2a): ingest is async, so the watcher's
// per-file queue is the only thing keeping a file's lines in file order. The
// stub ingestBatch takes a random delay so overlapping batches WOULD reorder
// or double-ingest if the queue ever let two of a file's batches run at once.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
  seen: new Set<string>(),
  order: [] as string[],
  inFlight: new Map<string, number>(),
  maxInFlightPerSession: 0,
  finished: 0,
  maxDelayMs: 15,
}));
vi.mock('./db.js', () => ({
  ingestBatch: async (_ws: string, sessionId: string, raws: string[]) => {
    const n = (h.inFlight.get(sessionId) ?? 0) + 1;
    h.inFlight.set(sessionId, n);
    h.maxInFlightPerSession = Math.max(h.maxInFlightPerSession, n);
    await new Promise((r) => setTimeout(r, Math.random() * h.maxDelayMs));
    const out = raws.map((raw) => {
      const uuid = (JSON.parse(raw) as { uuid: string }).uuid;
      const inserted = !h.seen.has(uuid);
      h.seen.add(uuid);
      if (inserted) h.order.push(uuid);
      return { inserted, sessionId, type: 'user' };
    });
    h.inFlight.set(sessionId, n - 1);
    h.finished++;
    return out;
  },
}));

const { JsonlWatcher } = await import('./jsonlWatcher.js');

const SESSION = '11111111-2222-3333-4444-555555555555';
const line = (uuid: string): string => JSON.stringify({ type: 'user', uuid }) + '\n';
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitUntil(fn: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return;
    await sleep(25);
  }
  throw new Error(`timed out (ingested ${h.order.length} lines in ${h.finished} batches)`);
}

let watcher: InstanceType<typeof JsonlWatcher>;
/** The watcher's add/change handler entry point (private). */
const nudge = (path: string): void => (watcher as unknown as { enqueue(p: string): void }).enqueue(path);
let dir: string;
beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'cf-watch-order-'));
  h.seen.clear();
  h.order.length = 0;
  h.inFlight.clear();
  h.maxInFlightPerSession = 0;
  h.finished = 0;
  h.maxDelayMs = 15;
  dir = join(userDataDir, 'projects', '-home-x');
  mkdirSync(dir, { recursive: true });
  watcher = new JsonlWatcher();
  await watcher.start([]);
  watcher.registerLocalDirForTest('ws-order', dir);
});
afterEach(async () => {
  await watcher.stop();
  await rm(userDataDir, { recursive: true, force: true });
});

describe('JsonlWatcher per-file ingest ordering', () => {
  it('ingests a file appended in many bursts exactly once, in file order', async () => {
    const file = join(dir, `${SESSION}.jsonl`);
    writeFileSync(file, '');
    const expected: string[] = [];
    for (let burst = 0; burst < 25; burst++) {
      let chunk = '';
      for (let i = 0; i < 4; i++) {
        const uuid = `e${burst * 4 + i}`;
        expected.push(uuid);
        chunk += line(uuid);
      }
      appendFileSync(file, chunk);
      // Fire the change ourselves too (chokidar coalesces and throttles its
      // own events, so it can't be relied on to deliver one per burst); this
      // queues work far faster than the slow stub drains it.
      nudge(file);
      await sleep(2);
    }
    nudge(file);
    await waitUntil(() => h.order.length === expected.length);
    expect(h.order).toEqual(expected);
    expect(h.maxInFlightPerSession).toBe(1);
  });

  it('stop() resolves only after every queued batch has finished', async () => {
    h.maxDelayMs = 300; // keep the batch in flight while stop() is called
    writeFileSync(join(dir, `${SESSION}.jsonl`), line('s1') + line('s2'));
    await waitUntil(() => h.inFlight.get(SESSION) === 1);
    await watcher.stop();
    expect(h.inFlight.get(SESSION)).toBe(0);
    expect(h.order).toEqual(['s1', 's2']);
    await watcher.start([]); // afterEach stops it again
  });
});
