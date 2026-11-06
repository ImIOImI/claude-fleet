import { describe, expect, it } from 'vitest';
import { StoreSupervisor } from './storeSupervisor.js';
import { ServiceSteps, type ServiceStep } from './serviceSteps.js';

function steps(fail: Record<string, number>, calls: string[]): ServiceStep<string>[] {
  const step = (name: string, group: 'inbox' | 'history', after?: string[]): ServiceStep<string> => ({
    name, group, after,
    run: async () => {
      calls.push(name);
      if ((fail[name] ?? 0) > 0) { fail[name]--; throw new Error(`${name} failed`); }
    },
  });
  return [
    step('claims', 'inbox'),
    step('openDb', 'history'),
    step('readSource', 'history'),
    step('watcher', 'history'),
    step('inboxIpc', 'inbox'),
    step('scheduler', 'inbox', ['claims', 'watcher']),
  ];
}

describe('ServiceSteps', () => {
  it('runs each step once, in order', async () => {
    const calls: string[] = [];
    const s = new ServiceSteps(steps({}, calls));
    await s.run('x');
    await s.run('x');
    expect(calls).toEqual(['claims', 'openDb', 'readSource', 'watcher', 'inboxIpc', 'scheduler']);
  });

  it('a failed history step skips the rest of history and its dependants, says why, and the inbox still starts', async () => {
    const calls: string[] = [];
    const s = new ServiceSteps(steps({ openDb: 1 }, calls));
    await expect(s.run('x')).rejects.toThrow('History unavailable: openDb failed');
    expect(calls).toEqual(['claims', 'openDb', 'inboxIpc']);
    await s.run('x');
    expect(calls.slice(3)).toEqual(['openDb', 'readSource', 'watcher', 'scheduler']);
  });

  it('names both groups when both fail', async () => {
    const s = new ServiceSteps(steps({ claims: 1, watcher: 1 }, []));
    await expect(s.run('x')).rejects.toThrow('Inbox unavailable: claims failed; History unavailable: watcher failed');
  });

  it('reset(group) runs that group again and leaves the other done', async () => {
    const calls: string[] = [];
    const s = new ServiceSteps(steps({}, calls));
    await s.run('x');
    calls.length = 0;
    s.reset('inbox');
    await s.run('x');
    expect(calls).toEqual(['claims', 'inboxIpc', 'scheduler']);
  });

  it('under the supervisor: openDbPostgres throws once, the status says so, a later tick brings history up', async () => {
    const parked: Array<() => void> = [];
    const calls: string[] = [];
    const s = new ServiceSteps(steps({ openDb: 1 }, calls));
    const sup = new StoreSupervisor<string>({
      choice: 'managed',
      open: async () => 'stores',
      prepare: async () => null,
      ready: (st) => s.run(st),
      ping: async () => undefined,
      recovered: () => undefined,
      close: async () => undefined,
      log: () => undefined,
      sleep: () => new Promise<void>((r) => parked.push(r)),
    });
    void sup.run();
    await sup.whenReady();
    expect(sup.status()).toMatchObject({ phase: 'ready', detail: 'History unavailable: openDb failed' });
    for (let i = 0; i < 50 && parked.length === 0; i++) await new Promise((r) => setImmediate(r));
    parked.shift()!();
    for (let i = 0; i < 50 && parked.length === 0; i++) await new Promise((r) => setImmediate(r));
    expect(sup.status()).toMatchObject({ phase: 'ready', detail: null });
    expect(calls.filter((c) => c === 'watcher')).toHaveLength(1);
    sup.stop();
  });
});
