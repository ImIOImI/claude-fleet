import { describe, expect, it } from 'vitest';
import { brokerWatch, EventHub, pruneDeadOwners } from './events.js';
import { AttachHub } from './attachHub.js';
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

  it('redacts secrets from every frame, keeping it valid JSON', () => {
    const hub = new EventHub();
    const got: string[] = [];
    hub.add({ send: (t) => got.push(t) });
    const token = 'ghs_' + 'A1b2C3d4E5'.repeat(3) + 'abcdef';
    hub.publish('sessions:changed', { sessions: [{ id: 's1', title: `ran gh auth token: ${token}` }] });
    expect(got[0]).not.toContain(token);
    expect(JSON.parse(got[0]).payload.sessions[0].title).toBe('ran gh auth token: [redacted]');
  });

  it.each(['\n', '\t', '\u001b[0m', '\u001b]8;;x\u0007'])('redacts a token or Bearer value after %j in a payload string', (prefix) => {
    const hub = new EventHub();
    const got: string[] = [];
    hub.add({ send: (t) => got.push(t) });
    const token = 'ghs_' + 'A1b2C3d4E5'.repeat(3) + 'abcdef';
    hub.publish('sessions:changed', { sessions: [{ title: `done${prefix}${token}`, cmd: `hdr${prefix}Bearer abcDEF123.xyz` }] });
    expect(got[0]).not.toContain(token);
    expect(got[0]).not.toContain('abcDEF123.xyz');
    const s = JSON.parse(got[0]).payload.sessions[0];
    expect(s).toEqual({ title: `done${prefix}[redacted]`, cmd: `hdr${prefix}[redacted]` });
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

  it('prunes hub owners against the listing', async () => {
    const b = fakeBroker(['s1']);
    const marks: number[] = [];
    const pruned: string[][] = [];
    const owners = { ownerMark: () => (marks.push(7), 7), pruneOwners: (live: ReadonlySet<string>, mark: number) => pruned.push([...live, String(mark)]) };
    b.sessions.get('s1')!.closed = true;
    await b.ops.create('s2', 80, 24, []);
    await brokerWatch(b.ops, new EventHub(), owners).poll();
    expect(pruned).toEqual([['s2', '7']]);
  });
});

describe('pruneDeadOwners', () => {
  it('drops owners of sessions missing from or dead in the listing, sparing owners set after the mark', async () => {
    const b = fakeBroker(['live', 'dead']);
    b.sessions.get('dead')!.closed = true;
    const hub = new AttachHub(b.ops);
    hub.setOwner('live', 'github:1');
    hub.setOwner('dead', 'github:1');
    hub.setOwner('gone', 'github:1');
    const list = b.ops.list;
    b.ops.list = async () => {
      const r = await list();
      hub.setOwner('late', 'github:2');
      return r;
    };
    await pruneDeadOwners(b.ops, hub);
    expect([...hub.owners.keys()].sort()).toEqual(['late', 'live']);
  });
});
