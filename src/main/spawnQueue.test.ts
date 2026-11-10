import { describe, expect, it } from 'vitest';
import { createSpawnQueue } from './spawnQueue.js';

/** Manual macrotask driver: each `tick()` runs one deferred callback. */
function manualYield() {
  const pending: Array<() => void> = [];
  return {
    yieldFn: (cb: () => void) => void pending.push(cb),
    tick: () => pending.shift()?.(),
    get waiting() {
      return pending.length;
    }
  };
}

const flush = () => new Promise<void>((r) => setImmediate(r));

describe('createSpawnQueue', () => {
  it('runs nothing synchronously: the first task waits for a yield', () => {
    const y = manualYield();
    const q = createSpawnQueue({ yieldFn: y.yieldFn });
    const ran: string[] = [];
    void q.run(() => ran.push('a'));
    expect(ran).toEqual([]);
    y.tick();
    expect(ran).toEqual(['a']);
  });

  it('runs exactly one task per macrotask', () => {
    const y = manualYield();
    const q = createSpawnQueue({ yieldFn: y.yieldFn });
    const ran: string[] = [];
    for (const n of ['a', 'b', 'c']) void q.run(() => ran.push(n));
    y.tick();
    expect(ran).toEqual(['a']);
    y.tick();
    expect(ran).toEqual(['a', 'b']);
    y.tick();
    expect(ran).toEqual(['a', 'b', 'c']);
    y.tick(); // drains the empty-queue pump
    expect(y.waiting).toBe(0);
  });

  it('runs a foreground task ahead of queued background tasks, FIFO within each class', () => {
    const y = manualYield();
    const q = createSpawnQueue({ yieldFn: y.yieldFn });
    const ran: string[] = [];
    void q.run(() => ran.push('bg1'));
    void q.run(() => ran.push('bg2'));
    void q.run(() => ran.push('fg1'), { foreground: true });
    void q.run(() => ran.push('fg2'), { foreground: true });
    void q.run(() => ran.push('bg3'));
    for (let i = 0; i < 6; i++) y.tick();
    expect(ran).toEqual(['fg1', 'fg2', 'bg1', 'bg2', 'bg3']);
  });

  it('lets a late foreground task overtake background tasks still waiting', () => {
    const y = manualYield();
    const q = createSpawnQueue({ yieldFn: y.yieldFn });
    const ran: string[] = [];
    void q.run(() => ran.push('bg1'));
    void q.run(() => ran.push('bg2'));
    y.tick();
    void q.run(() => ran.push('fg'), { foreground: true });
    y.tick();
    y.tick();
    expect(ran).toEqual(['bg1', 'fg', 'bg2']);
  });

  it('resolves with the task result and rejects with its error without stalling the queue', async () => {
    const q = createSpawnQueue();
    const bad = q.run(() => {
      throw new Error('spawn failed');
    });
    const good = q.run(() => 42);
    await expect(bad).rejects.toThrow('spawn failed');
    await expect(good).resolves.toBe(42);
  });

  it('restarts after draining', async () => {
    const q = createSpawnQueue();
    await expect(q.run(() => 1)).resolves.toBe(1);
    await flush();
    expect(q.pending).toBe(0);
    await expect(q.run(() => 2)).resolves.toBe(2);
  });

  it('yields to other macrotasks between spawns', async () => {
    const q = createSpawnQueue();
    const order: string[] = [];
    const a = q.run(() => order.push('spawn1'));
    const b = q.run(() => order.push('spawn2'));
    setImmediate(() => order.push('ipc'));
    await Promise.all([a, b]);
    expect(order).toEqual(['spawn1', 'ipc', 'spawn2']);
  });
});
