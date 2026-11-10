import { describe, expect, it, vi } from 'vitest';
import { startHostIndexer } from './hostIndexer.js';
import { createLogger } from './log.js';

describe('host indexer', () => {
  it('runs one session at a time and coalesces repeat bumps', async () => {
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const ix = startHostIndexer({ embed: async () => [], log: createLogger(() => undefined),
      index: async (id) => { calls.push(id); if (id === 'a') await gate; return 0; } });
    ix.bump('a'); ix.bump('b'); ix.bump('b'); ix.bump('a');
    await new Promise((r) => setImmediate(r));
    expect(calls).toEqual(['a']);
    release();
    await vi.waitFor(() => expect(calls).toEqual(['a', 'b', 'a']));
    await ix.stop(1000);
  });

  it('drains the whole queue when not stopped', async () => {
    const calls: string[] = [];
    const ix = startHostIndexer({ embed: async () => [], log: createLogger(() => undefined),
      index: async (id) => { calls.push(id); await new Promise((r) => setTimeout(r, 2)); return 0; } });
    for (const id of ['a', 'b', 'c', 'd']) ix.bump(id);
    await vi.waitFor(() => expect(calls).toEqual(['a', 'b', 'c', 'd']));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual(['a', 'b', 'c', 'd']);
    await ix.stop(1000);
  });

  it('stop finishes only the in-flight pass and drops the queue', async () => {
    const calls: string[] = [];
    const done: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const ix = startHostIndexer({ embed: async () => [], log: createLogger(() => undefined),
      index: async (id) => { calls.push(id); await gate; done.push(id); return 0; } });
    ix.bump('a'); ix.bump('b'); ix.bump('c');
    await new Promise((r) => setImmediate(r));
    const stopping = ix.stop(1000);
    release();
    await stopping;
    expect(done).toEqual(['a']);
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toEqual(['a']);
    ix.bump('z');
    await new Promise((r) => setImmediate(r));
    expect(calls).toEqual(['a']);
  });

  it('never runs two passes at once', async () => {
    let live = 0;
    let peak = 0;
    const ix = startHostIndexer({ embed: async () => [], log: createLogger(() => undefined),
      index: async () => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 5)); live--; return 0; } });
    for (const id of ['a', 'b', 'c']) ix.bump(id);
    await new Promise((r) => setTimeout(r, 1));
    ix.bump('d');
    await vi.waitFor(() => expect(live).toBe(0), { timeout: 1000 });
    await new Promise((r) => setTimeout(r, 20));
    await ix.stop(1000);
    expect(peak).toBe(1);
  });

  it('logs a failure and keeps going', async () => {
    const logs: string[] = [];
    const calls: string[] = [];
    const ix = startHostIndexer({ embed: async () => [], log: createLogger((l) => logs.push(l)),
      index: async (id) => { calls.push(id); if (id === 'x') throw new Error('boom'); return 1; } });
    ix.bump('x'); ix.bump('y');
    await vi.waitFor(() => expect(calls).toEqual(['x', 'y']));
    await ix.stop(1000);
    expect(logs.some((l) => l.includes('transcript index failed'))).toBe(true);
    expect(calls).toEqual(['x', 'y']);
  });

  it('takes no work while paused (embedder failed), queued work included', async () => {
    const calls: string[] = [];
    let paused = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const ix = startHostIndexer({ embed: async () => [], log: createLogger(() => undefined), paused: () => paused,
      index: async (id) => { calls.push(id); await gate; return 0; } });
    ix.bump('a'); ix.bump('b');
    paused = true;
    release();
    await new Promise((r) => setTimeout(r, 10));
    ix.bump('c');
    paused = false;
    await ix.stop(1000);
    expect(calls).toEqual(['a']);
  });

  it('stop waits at most the grace period for the in-flight pass, then takes no more work', async () => {
    const calls: string[] = [];
    const ix = startHostIndexer({ embed: async () => [], log: createLogger(() => undefined),
      index: async (id) => { calls.push(id); await new Promise(() => undefined); return 0; } });
    ix.bump('a'); ix.bump('b');
    const t0 = Date.now();
    await ix.stop(50);
    expect(Date.now() - t0).toBeLessThan(1000);
    ix.bump('c');
    expect(calls).toEqual(['a']);
  });
});
