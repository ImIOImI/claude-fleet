import { describe, expect, it } from 'vitest';
import { createSpawnQueue, SpawnCancelledError } from './spawnQueue.js';

/** Manual macrotask driver: each `tick()` runs one deferred callback, then
 *  lets the task's microtasks settle. */
function manualYield() {
  const pending: Array<() => void> = [];
  return {
    yieldFn: (cb: () => void) => void pending.push(cb),
    tick: async () => {
      pending.shift()?.();
      for (let i = 0; i < 5; i++) await Promise.resolve();
    },
    get waiting() {
      return pending.length;
    }
  };
}

const flush = () => new Promise<void>((r) => setImmediate(r));

describe('createSpawnQueue', () => {
  it('runs nothing synchronously: the first task waits for a yield', async () => {
    const y = manualYield();
    const q = createSpawnQueue({ yieldFn: y.yieldFn });
    const ran: string[] = [];
    void q.run('a', () => ran.push('a'));
    expect(ran).toEqual([]);
    await y.tick();
    expect(ran).toEqual(['a']);
  });

  it('runs exactly one task per macrotask', async () => {
    const y = manualYield();
    const q = createSpawnQueue({ yieldFn: y.yieldFn });
    const ran: string[] = [];
    for (const n of ['a', 'b', 'c']) void q.run(n, () => ran.push(n));
    await y.tick();
    expect(ran).toEqual(['a']);
    await y.tick();
    expect(ran).toEqual(['a', 'b']);
    await y.tick();
    expect(ran).toEqual(['a', 'b', 'c']);
    await y.tick(); // drains the empty-queue pump
    expect(y.waiting).toBe(0);
  });

  it('waits for an async task before starting the next', async () => {
    const y = manualYield();
    const q = createSpawnQueue({ yieldFn: y.yieldFn });
    const ran: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    void q.run('a', async () => {
      ran.push('a:start');
      await gate;
      ran.push('a:end');
    });
    void q.run('b', () => ran.push('b'));
    await y.tick();
    expect(ran).toEqual(['a:start']);
    expect(y.waiting).toBe(0);
    release();
    await y.tick(); // no-op tick lets a finish
    await y.tick();
    expect(ran).toEqual(['a:start', 'a:end', 'b']);
  });

  it('runs a foreground task ahead of queued background tasks, FIFO within each lane', async () => {
    const y = manualYield();
    const q = createSpawnQueue({ yieldFn: y.yieldFn });
    const ran: string[] = [];
    void q.run('bg1', () => ran.push('bg1'));
    void q.run('bg2', () => ran.push('bg2'));
    void q.run('fg1', () => ran.push('fg1'), { foreground: true });
    void q.run('fg2', () => ran.push('fg2'), { foreground: true });
    void q.run('bg3', () => ran.push('bg3'));
    for (let i = 0; i < 6; i++) await y.tick();
    expect(ran).toEqual(['fg1', 'fg2', 'bg1', 'bg2', 'bg3']);
  });

  it('lets a late foreground task overtake background tasks still waiting', async () => {
    const y = manualYield();
    const q = createSpawnQueue({ yieldFn: y.yieldFn });
    const ran: string[] = [];
    void q.run('bg1', () => ran.push('bg1'));
    void q.run('bg2', () => ran.push('bg2'));
    await y.tick();
    void q.run('fg', () => ran.push('fg'), { foreground: true });
    await y.tick();
    await y.tick();
    expect(ran).toEqual(['bg1', 'fg', 'bg2']);
  });

  it('a newer run for the same key replaces the pending task in place and rejects the old caller', async () => {
    const y = manualYield();
    const q = createSpawnQueue({ yieldFn: y.yieldFn });
    const ran: string[] = [];
    const first = q.run('tab', () => ran.push('tab:old'));
    void q.run('other', () => ran.push('other'));
    const second = q.run('tab', () => {
      ran.push('tab:new');
      return 'new';
    });
    await expect(first).rejects.toBeInstanceOf(SpawnCancelledError);
    for (let i = 0; i < 3; i++) await y.tick();
    expect(ran).toEqual(['tab:new', 'other']);
    await expect(second).resolves.toBe('new');
    expect(q.pending).toBe(0);
  });

  it('a foreground replacement promotes a background task', async () => {
    const y = manualYield();
    const q = createSpawnQueue({ yieldFn: y.yieldFn });
    const ran: string[] = [];
    void q.run('a', () => ran.push('a')).catch(() => {});
    void q.run('b', () => ran.push('b'));
    void q.run('c', () => ran.push('c')).catch(() => {});
    void q.run('c', () => ran.push('c:fg'), { foreground: true });
    for (let i = 0; i < 4; i++) await y.tick();
    expect(ran).toEqual(['c:fg', 'a', 'b']);
  });

  it('a background replacement keeps a foreground task in its lane', async () => {
    const y = manualYield();
    const q = createSpawnQueue({ yieldFn: y.yieldFn });
    const ran: string[] = [];
    void q.run('bg', () => ran.push('bg'));
    void q.run('t', () => ran.push('t:old'), { foreground: true }).catch(() => {});
    void q.run('t', () => ran.push('t:new'));
    for (let i = 0; i < 3; i++) await y.tick();
    expect(ran).toEqual(['t:new', 'bg']);
  });

  it('cancel drops a pending task and rejects its caller', async () => {
    const y = manualYield();
    const q = createSpawnQueue({ yieldFn: y.yieldFn });
    const ran: string[] = [];
    const doomed = q.run('tab', () => ran.push('tab'));
    void q.run('keep', () => ran.push('keep'));
    expect(q.has('tab')).toBe(true);
    expect(q.cancel('tab', 'tab closed')).toBe(true);
    expect(q.has('tab')).toBe(false);
    await expect(doomed).rejects.toThrow('tab closed');
    expect(q.cancel('tab')).toBe(false);
    for (let i = 0; i < 2; i++) await y.tick();
    expect(ran).toEqual(['keep']);
  });

  it('cancelMatching drops every matching pending task', async () => {
    const q = createSpawnQueue();
    const ran: string[] = [];
    const a1 = q.run('ws1:a', () => ran.push('ws1:a'));
    const a2 = q.run('ws1:b', () => ran.push('ws1:b'));
    const b = q.run('ws2:a', () => ran.push('ws2:a'));
    expect(q.cancelMatching((k) => k.startsWith('ws1:'), 'stopped')).toBe(2);
    await expect(a1).rejects.toBeInstanceOf(SpawnCancelledError);
    await expect(a2).rejects.toThrow('stopped');
    await b;
    expect(ran).toEqual(['ws2:a']);
  });

  it('resolves with the task result and rejects with its error without stalling the queue', async () => {
    const q = createSpawnQueue();
    const bad = q.run('bad', () => {
      throw new Error('spawn failed');
    });
    const good = q.run('good', () => 42);
    await expect(bad).rejects.toThrow('spawn failed');
    await expect(good).resolves.toBe(42);
  });

  it('restarts after draining', async () => {
    const q = createSpawnQueue();
    await expect(q.run('a', () => 1)).resolves.toBe(1);
    await flush();
    expect(q.pending).toBe(0);
    await expect(q.run('b', () => 2)).resolves.toBe(2);
  });

  it('yields to other macrotasks between spawns', async () => {
    const q = createSpawnQueue();
    const order: string[] = [];
    const a = q.run('a', () => order.push('spawn1'));
    const b = q.run('b', () => order.push('spawn2'));
    setImmediate(() => order.push('ipc'));
    await Promise.all([a, b]);
    expect(order).toEqual(['spawn1', 'ipc', 'spawn2']);
  });
});
