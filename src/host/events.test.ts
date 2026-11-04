import { describe, expect, it } from 'vitest';
import { brokerWatch, EventHub } from './events.js';
import { fakeBroker } from './testFakes.js';

describe('EventHub', () => {
  it('fans a JSON message to every subscriber until it unsubscribes', () => {
    const hub = new EventHub();
    const a: string[] = [];
    const b: string[] = [];
    hub.add({ send: (t) => a.push(t) });
    const offB = hub.add({ send: (t) => b.push(t) });
    hub.publish('inbox:changed', { n: 1 });
    offB();
    hub.publish('inbox:changed', { n: 2 });
    expect(a.map((t) => JSON.parse(t))).toEqual([{ channel: 'inbox:changed', payload: { n: 1 } }, { channel: 'inbox:changed', payload: { n: 2 } }]);
    expect(b).toHaveLength(1);
  });

  it('refuses an unknown channel', () => {
    expect(() => new EventHub().publish('vault:get', {})).toThrow(/unknown event channel/);
  });
});

describe('brokerWatch', () => {
  it('publishes sessions:changed and ports:changed only when they change', async () => {
    const b = fakeBroker(['s1']);
    const hub = new EventHub();
    const got: string[] = [];
    hub.add({ send: (t) => got.push((JSON.parse(t) as { channel: string }).channel) });
    const w = brokerWatch(b.ops, hub);
    await w.poll();
    await w.poll();
    expect(got).toEqual(['sessions:changed', 'ports:changed']);
    await b.ops.create('s2', 80, 24, []);
    await w.poll();
    expect(got).toEqual(['sessions:changed', 'ports:changed', 'sessions:changed']);
  });
});
