import { describe, it, expect } from 'vitest';
import { keyedSerialQueue } from './serialQueue.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('keyedSerialQueue', () => {
  it('runs one key strictly in enqueue order, never overlapping', async () => {
    const q = keyedSerialQueue(() => {});
    const log: string[] = [];
    let running = 0;
    const task = (id: number, ms: number) => async () => {
      running++;
      expect(running).toBe(1);
      log.push(`start ${id}`);
      await sleep(ms);
      log.push(`end ${id}`);
      running--;
    };
    await Promise.all([q.enqueue('f', task(1, 15)), q.enqueue('f', task(2, 1)), q.enqueue('f', task(3, 5))]);
    expect(log).toEqual(['start 1', 'end 1', 'start 2', 'end 2', 'start 3', 'end 3']);
  });

  it('runs different keys concurrently', async () => {
    const q = keyedSerialQueue(() => {});
    const log: string[] = [];
    const a = q.enqueue('a', async () => { await sleep(20); log.push('a'); });
    const b = q.enqueue('b', async () => { log.push('b'); });
    await Promise.all([a, b]);
    expect(log).toEqual(['b', 'a']);
  });

  it('reports a rejection and keeps the chain going', async () => {
    const errors: Array<[string, unknown]> = [];
    const q = keyedSerialQueue((key, err) => errors.push([key, err]));
    const log: string[] = [];
    const boom = new Error('boom');
    await Promise.all([
      q.enqueue('f', async () => { throw boom; }),
      q.enqueue('f', async () => { log.push('after'); }),
    ]);
    expect(errors).toEqual([['f', boom]]);
    expect(log).toEqual(['after']);
  });

  it('drain() waits for queued and running tasks under every key', async () => {
    const q = keyedSerialQueue(() => {});
    const done: string[] = [];
    void q.enqueue('a', async () => { await sleep(10); done.push('a1'); });
    void q.enqueue('a', async () => { await sleep(10); done.push('a2'); });
    void q.enqueue('b', async () => { await sleep(5); done.push('b'); });
    await q.drain();
    expect(done.sort()).toEqual(['a1', 'a2', 'b']);
    expect(q.activeKeys()).toBe(0);
  });

  it('drain() also waits for tasks enqueued while draining', async () => {
    const q = keyedSerialQueue(() => {});
    const done: string[] = [];
    void q.enqueue('a', async () => {
      await sleep(5);
      void q.enqueue('b', async () => { await sleep(5); done.push('late'); });
    });
    await q.drain();
    expect(done).toEqual(['late']);
  });
});
