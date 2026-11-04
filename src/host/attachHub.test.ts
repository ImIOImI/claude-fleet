import { describe, expect, it } from 'vitest';
import { FrameType, encodeFrame } from '../main/broker.js';
import type { Tier } from '../main/identity/grants.js';
import { AttachHub, MAX_PENDING_FRAMES, ReplayBuffer, trimToSafeStart } from './attachHub.js';
import { createLogger } from './log.js';
import { RUNNER_HOOK_SETTINGS } from '../main/claudeArgs.js';
import { fakeBroker, inputFrame, jsonFrame, person, resizeFrame, sinkRecorder } from './testFakes.js';

const alice = person('alice', 1);
const bob = person('bob', 2);
const UUID = '0b7e6c1e-1f6a-4c55-9c39-6f1f8d6c2a11';

function setup(tier: Tier, sessions = ['s1'], who = alice) {
  const broker = fakeBroker(sessions);
  const hub = new AttachHub(broker.ops);
  const rec = sinkRecorder();
  const v = hub.viewer({ identity: who, tier }, rec.sink);
  return { broker, hub, rec, v };
}

const last = (rec: ReturnType<typeof sinkRecorder>) => rec.frames[rec.frames.length - 1];

describe('per-frame tier gating', () => {
  // Each row: frame, the tier it needs, the response type a denial is answered with (null = silently dropped).
  const rows: Array<[string, () => Buffer, Tier, FrameType | null]> = [
    ['ATTACH', () => jsonFrame(FrameType.ATTACH, { id: 's1', channel: 7 }), 'read', FrameType.ATTACHED],
    ['LIST', () => encodeFrame(FrameType.LIST, Buffer.alloc(0)), 'read', FrameType.SESSIONS],
    ['LISTPORTS', () => encodeFrame(FrameType.LISTPORTS, Buffer.alloc(0)), 'read', FrameType.PORTS],
    ['KILLPORT', () => jsonFrame(FrameType.KILLPORT, { port: 3000 }), 'steer', FrameType.KILLED],
    ['DIAL', () => jsonFrame(FrameType.DIAL, { channel: 9, port: 3000 }), 'steer', FrameType.DIALED],
    ['CREATE', () => jsonFrame(FrameType.CREATE, { id: 'new1', cols: 80, rows: 24 }), 'session', FrameType.CREATED]
  ];
  const tiers: Tier[] = ['read', 'steer', 'session'];
  const rank = (t: Tier) => tiers.indexOf(t);

  for (const [name, frame, need, resp] of rows) {
    for (const have of tiers) {
      const allowed = rank(have) >= rank(need);
      it(`${name} as ${have}: ${allowed ? 'allowed' : 'denied'}`, async () => {
        const { broker, rec, v } = setup(have);
        await v.receive(frame());
        const r = last(rec);
        expect(r.type).toBe(resp);
        if (allowed) {
          expect(String(r.json?.error ?? '')).not.toMatch(/forbidden/);
        } else {
          expect(r.json).toMatchObject({ ok: false, error: `forbidden: needs ${need}` });
          expect(v.denied).toBe(1);
          expect(broker.created).toEqual([]);
          expect(broker.killed).toEqual([]);
        }
      });
    }
  }

  it('DIAL is refused even for the session tier', async () => {
    const { rec, v } = setup('session');
    await v.receive(jsonFrame(FrameType.DIAL, { channel: 9, port: 3000 }));
    expect(last(rec)).toMatchObject({
      type: FrameType.DIALED,
      json: { channel: 9, ok: false, error: 'port forwarding is not available on remote hosts' }
    });
  });

  it('INPUT and RESIZE from a read viewer never reach the broker', async () => {
    const { broker, v } = setup('read');
    await v.receive(jsonFrame(FrameType.ATTACH, { id: 's1', channel: 7 }));
    await v.receive(inputFrame(7, 'rm -rf /\r'));
    await v.receive(resizeFrame(7, 10, 10));
    expect(broker.sessions.get('s1')!.inputs).toEqual([]);
    expect(broker.sessions.get('s1')!.resizes).toEqual([]);
    expect(v.denied).toBe(2);
  });

  it('INPUT and RESIZE from a steer viewer do reach the broker', async () => {
    const { broker, v } = setup('steer');
    await v.receive(jsonFrame(FrameType.ATTACH, { id: 's1', channel: 7 }));
    await v.receive(inputFrame(7, 'hi'));
    await v.receive(resizeFrame(7, 100, 30));
    expect(broker.sessions.get('s1')!.inputs.map(String)).toEqual(['hi']);
    expect(broker.sessions.get('s1')!.resizes).toEqual([[100, 30]]);
  });

  it('a tier drop applies to the next frame on an open connection', async () => {
    const { broker, v } = setup('steer');
    await v.receive(jsonFrame(FrameType.ATTACH, { id: 's1', channel: 7 }));
    v.principal = { ...v.principal, tier: 'read' };
    await v.receive(inputFrame(7, 'late'));
    expect(broker.sessions.get('s1')!.inputs).toEqual([]);
  });

  it.each([FrameType.OUTPUT, FrameType.HISTORY, FrameType.CREATED, FrameType.ATTACHED, FrameType.ENDED, FrameType.SESSIONS])(
    'server-only frame %d closes the connection with 1008',
    async (t) => {
      const { rec, v } = setup('session');
      await v.receive(encodeFrame(t, Buffer.from('{}')));
      expect(rec.closes).toEqual([[1008, `frame type ${t} not accepted`]]);
    }
  );

  it('a malformed frame closes with 1002', async () => {
    const { rec, v } = setup('session');
    const bad = Buffer.alloc(5);
    bad.writeUInt32BE(0, 0);
    await v.receive(bad);
    expect(rec.closes[0][0]).toBe(1002);
  });
});

describe('CLOSE ownership', () => {
  it('the creator may close; another session-tier user may not', async () => {
    const broker = fakeBroker([]);
    const hub = new AttachHub(broker.ops);
    const a = sinkRecorder();
    const b = sinkRecorder();
    const va = hub.viewer({ identity: alice, tier: 'session' }, a.sink);
    const vb = hub.viewer({ identity: bob, tier: 'session' }, b.sink);
    await va.receive(jsonFrame(FrameType.CREATE, { id: 'mine', cols: 80, rows: 24 }));
    await va.receive(jsonFrame(FrameType.ATTACH, { id: 'mine', channel: 1 }));
    await vb.receive(jsonFrame(FrameType.ATTACH, { id: 'mine', channel: 5 }));
    await vb.receive(jsonFrame(FrameType.CLOSE, { channel: 5 }));
    expect(last(b).json).toMatchObject({ ok: false, error: 'forbidden: only the session owner can close it' });
    expect(broker.sessions.get('mine')!.closed).toBe(false);
    await va.receive(jsonFrame(FrameType.CLOSE, { channel: 1 }));
    expect(last(a).json).toMatchObject({ ok: true });
    expect(broker.sessions.get('mine')!.closed).toBe(true);
    expect(b.frames.some((f) => f.type === FrameType.ENDED && f.json?.reason === 'closed')).toBe(true);
  });

  it('an owner whose tier dropped to steer can no longer close', async () => {
    const { broker, rec, v } = setup('session', []);
    await v.receive(jsonFrame(FrameType.CREATE, { id: 'mine' }));
    await v.receive(jsonFrame(FrameType.ATTACH, { id: 'mine', channel: 1 }));
    v.principal = { ...v.principal, tier: 'steer' };
    await v.receive(jsonFrame(FrameType.CLOSE, { channel: 1 }));
    expect(last(rec).json).toMatchObject({ ok: false, error: 'forbidden: needs session' });
    expect(broker.sessions.get('mine')!.closed).toBe(false);
  });

  it('a session nobody created through this host cannot be closed by a viewer', async () => {
    const { broker, rec, v } = setup('session', ['auto-1']);
    await v.receive(jsonFrame(FrameType.ATTACH, { id: 'auto-1', channel: 1 }));
    await v.receive(jsonFrame(FrameType.CLOSE, { channel: 1 }));
    expect(last(rec).json).toMatchObject({ ok: false });
    expect(broker.sessions.get('auto-1')!.closed).toBe(false);
  });

  it('re-CREATE of an existing id does not transfer ownership', async () => {
    const broker = fakeBroker([]);
    const hub = new AttachHub(broker.ops);
    await hub.viewer({ identity: alice, tier: 'session' }, sinkRecorder().sink).receive(jsonFrame(FrameType.CREATE, { id: 'x' }));
    await hub.viewer({ identity: bob, tier: 'session' }, sinkRecorder().sink).receive(jsonFrame(FrameType.CREATE, { id: 'x' }));
    expect(hub.owners.get('x')).toBe('github:1');
  });
});

describe('CREATE args', () => {
  it.each([
    [undefined, ['--settings', RUNNER_HOOK_SETTINGS]],
    [['--settings', RUNNER_HOOK_SETTINGS, '--session-id', UUID], ['--settings', RUNNER_HOOK_SETTINGS, '--session-id', UUID]],
    [['--resume', UUID], ['--settings', RUNNER_HOOK_SETTINGS, '--resume', UUID]]
  ])('accepts %j', async (args, want) => {
    const { broker, v } = setup('session', []);
    await v.receive(jsonFrame(FrameType.CREATE, { id: 'n', args }));
    expect(broker.created).toEqual([{ id: 'n', args: want }]);
  });

  it.each([
    [['--dangerously-skip-permissions']],
    [['--resume', 'not-a-uuid']],
    [['--settings', '/tmp/evil.json', '--resume', UUID]],
    [['--resume', UUID, '--mcp-config', '/x']]
  ])('refuses %j', async (args) => {
    const { broker, rec, v } = setup('session', []);
    await v.receive(jsonFrame(FrameType.CREATE, { id: 'n', args }));
    expect(broker.created).toEqual([]);
    expect(last(rec).json).toMatchObject({ ok: false, error: 'forbidden: unsupported create args' });
  });
});

describe('fan-out', () => {
  it('one upstream per session; output reaches every viewer; newcomers get HISTORY', async () => {
    const broker = fakeBroker(['s1']);
    const hub = new AttachHub(broker.ops);
    const a = sinkRecorder();
    const b = sinkRecorder();
    const va = hub.viewer({ identity: alice, tier: 'steer' }, a.sink);
    await va.receive(jsonFrame(FrameType.ATTACH, { id: 's1', channel: 1 }));
    broker.sessions.get('s1')!.handlers!.onHistory(Buffer.from('old\n'));
    broker.sessions.get('s1')!.handlers!.onOutput(Buffer.from('live1'));
    const vb = hub.viewer({ identity: bob, tier: 'read' }, b.sink);
    await vb.receive(jsonFrame(FrameType.ATTACH, { id: 's1', channel: 4 }));
    broker.sessions.get('s1')!.handlers!.onOutput(Buffer.from('live2'));
    expect(broker.attachCalls()).toBe(1);
    expect(a.frames.filter((f) => f.type === FrameType.OUTPUT).map((f) => String(f.body))).toEqual(['live1', 'live2']);
    expect(b.frames.map((f) => f.type)).toEqual([FrameType.ATTACHED, FrameType.HISTORY, FrameType.OUTPUT]);
    expect(String(b.frames[1].body)).toBe('old\nlive1');
    expect(b.frames[1].channel).toBe(4);
  });

  it('the upstream detaches when the last viewer leaves, leaving the session alive', async () => {
    const { broker, hub, v } = setup('read');
    await v.receive(jsonFrame(FrameType.ATTACH, { id: 's1', channel: 1 }));
    await v.dispose();
    expect(broker.sessions.get('s1')!.detached).toBe(1);
    expect(broker.sessions.get('s1')!.closed).toBe(false);
    expect(hub.liveTaps).toBe(0);
  });

  it('ATTACH to a missing session reports "no such session" (the desktop then CREATEs)', async () => {
    const { rec, v } = setup('session', []);
    await v.receive(jsonFrame(FrameType.ATTACH, { id: 'nope', channel: 1 }));
    expect(last(rec).json).toMatchObject({ ok: false, error: 'no such session' });
  });

  it('ENDED fans out to every viewer', async () => {
    const { broker, rec, v } = setup('read');
    await v.receive(jsonFrame(FrameType.ATTACH, { id: 's1', channel: 3 }));
    broker.sessions.get('s1')!.handlers!.onEnded();
    expect(last(rec)).toMatchObject({ type: FrameType.ENDED, json: { channel: 3, reason: 'exit' } });
  });
});

describe('ReplayBuffer', () => {
  it('keeps the newest bytes and trims a wrapped head to a safe start', () => {
    const r = new ReplayBuffer(8);
    r.append(Buffer.from('abc\n'));
    expect(String(r.snapshot())).toBe('abc\n');
    r.append(Buffer.from('de\x1b[1mfg'));
    expect(String(r.snapshot())).toBe('\x1b[1mfg');
  });

  it('trimToSafeStart drops a dangling UTF-8 continuation', () => {
    expect(trimToSafeStart(Buffer.from([0x80, 0x80, 0x41]))).toEqual(Buffer.from('A'));
  });
});

describe('AttachHub.shutdown', () => {
  it('detaches every upstream and leaves sessions alive', async () => {
    const { broker, hub, v } = setup('read', ['s1']);
    await v.receive(jsonFrame(FrameType.ATTACH, { id: 's1', channel: 1 }));
    await hub.shutdown();
    expect(broker.sessions.get('s1')!.detached).toBe(1);
    expect(broker.sessions.get('s1')!.closed).toBe(false);
    expect(hub.liveTaps).toBe(0);
  });
});

describe('KILLPORT scope', () => {
  it('refuses the host port, refuses an unattributed port, allows a session-owned one', async () => {
    const broker = fakeBroker(['s1']);
    broker.ports.push({ port: 8080 }, { port: 9229, pid: 7 });
    const hub = new AttachHub(broker.ops, { hostPort: 8080 });
    const rec = sinkRecorder();
    const v = hub.viewer({ identity: alice, tier: 'steer' }, rec.sink);
    await v.receive(jsonFrame(FrameType.KILLPORT, { port: 8080 }));
    expect(last(rec).json).toMatchObject({ ok: false, error: 'forbidden: that port belongs to the host' });
    await v.receive(jsonFrame(FrameType.KILLPORT, { port: 9229 }));
    expect(last(rec).json).toMatchObject({ ok: false, error: 'forbidden: that port is not owned by a session' });
    await v.receive(jsonFrame(FrameType.KILLPORT, { port: 3000 }));
    expect(last(rec).json).toMatchObject({ ok: true });
    expect(broker.killed).toEqual([3000]);
  });

  it('refuses the host port even when a session appears to own it', async () => {
    const broker = fakeBroker(['s1']);
    broker.ports.push({ port: 8080, session: 's1' });
    const v = new AttachHub(broker.ops, { hostPort: 8080 }).viewer({ identity: alice, tier: 'steer' }, sinkRecorder().sink);
    await v.receive(jsonFrame(FrameType.KILLPORT, { port: 8080 }));
    expect(broker.killed).toEqual([]);
  });
});

describe('viewer limits', () => {
  it('closes with 1008 once more than MAX_PENDING_FRAMES frames are queued', async () => {
    const broker = fakeBroker(['s1']);
    broker.ops.list = () => new Promise(() => undefined);
    const rec = sinkRecorder();
    const v = new AttachHub(broker.ops).viewer({ identity: alice, tier: 'steer' }, rec.sink);
    void v.receive(encodeFrame(FrameType.LIST, Buffer.alloc(0)));
    void v.receive(Buffer.concat(Array.from({ length: MAX_PENDING_FRAMES }, () => inputFrame(1, 'x'))));
    expect(rec.closes).toEqual([[1008, 'too many pending frames']]);
  });

  it('rate-limits control frames per viewer but not INPUT', async () => {
    let t = 0;
    const broker = fakeBroker(['s1']);
    const hub = new AttachHub(broker.ops, { now: () => t, controlBurst: 2, controlPerSec: 1 });
    const rec = sinkRecorder();
    const v = hub.viewer({ identity: alice, tier: 'steer' }, rec.sink);
    await v.receive(jsonFrame(FrameType.ATTACH, { id: 's1', channel: 1 }));
    await v.receive(encodeFrame(FrameType.LISTPORTS, Buffer.alloc(0)));
    await v.receive(encodeFrame(FrameType.LISTPORTS, Buffer.alloc(0)));
    expect(last(rec)).toMatchObject({ type: FrameType.PORTS, json: { ok: false, error: 'rate limited' } });
    for (let i = 0; i < 5; i++) await v.receive(inputFrame(1, 'k'));
    expect(broker.sessions.get('s1')!.inputs).toHaveLength(5);
    t = 1000;
    await v.receive(encodeFrame(FrameType.LISTPORTS, Buffer.alloc(0)));
    expect(last(rec).json).toHaveProperty('ports');
  });

  it('refuses a second ATTACH to a session the viewer already holds', async () => {
    const { rec, hub, v } = setup('read');
    await v.receive(jsonFrame(FrameType.ATTACH, { id: 's1', channel: 1 }));
    await v.receive(jsonFrame(FrameType.ATTACH, { id: 's1', channel: 2 }));
    expect(last(rec).json).toMatchObject({ channel: 2, ok: false, error: 'session already attached on this connection' });
    expect(hub.liveTaps).toBe(1);
  });

  it('clamps RESIZE to 1-1000', async () => {
    const { broker, v } = setup('steer');
    await v.receive(jsonFrame(FrameType.ATTACH, { id: 's1', channel: 1 }));
    await v.receive(resizeFrame(1, 0, 5000));
    expect(broker.sessions.get('s1')!.resizes).toEqual([[1, 1000]]);
  });

  it('answers a failed broker request generically and logs the detail', async () => {
    const lines: string[] = [];
    const broker = fakeBroker(['s1']);
    broker.ops.list = async () => { throw new Error('dial /run/broker/broker.sock: secret detail'); };
    const rec = sinkRecorder();
    const v = new AttachHub(broker.ops, { log: createLogger((l) => lines.push(l)) }).viewer({ identity: alice, tier: 'read' }, rec.sink);
    await v.receive(encodeFrame(FrameType.LIST, Buffer.alloc(0)));
    expect(last(rec).json).toEqual({ ok: false, error: 'broker request failed' });
    expect(lines.join('\n')).toContain('secret detail');
  });
});

describe('owner pruning', () => {
  it('forgets the owner when the session exits', async () => {
    const broker = fakeBroker([]);
    const hub = new AttachHub(broker.ops);
    const v = hub.viewer({ identity: alice, tier: 'session' }, sinkRecorder().sink);
    await v.receive(jsonFrame(FrameType.CREATE, { id: 'x' }));
    await v.receive(jsonFrame(FrameType.ATTACH, { id: 'x', channel: 1 }));
    broker.sessions.get('x')!.handlers!.onEnded();
    expect(hub.owners.has('x')).toBe(false);
  });

  it('prunes owners missing from a broker listing taken after they were set, never newer ones', async () => {
    const broker = fakeBroker([]);
    const hub = new AttachHub(broker.ops);
    const v = hub.viewer({ identity: alice, tier: 'session' }, sinkRecorder().sink);
    await v.receive(jsonFrame(FrameType.CREATE, { id: 'gone' }));
    await v.receive(jsonFrame(FrameType.CREATE, { id: 'kept' }));
    const mark = hub.ownerMark();
    await v.receive(jsonFrame(FrameType.CREATE, { id: 'newer' }));
    hub.pruneOwners(new Set(['kept']), mark);
    expect([...hub.owners.keys()].sort()).toEqual(['kept', 'newer']);
  });
});
