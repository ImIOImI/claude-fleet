import { describe, expect, it } from 'vitest';
import { FrameType, MAX_FRAME_PAYLOAD, encodeChannelData, encodeFrame } from '../main/broker.js';
import type { Tier } from '../main/identity/grants.js';
import { AttachHub, MAX_PENDING_BYTES, MAX_PENDING_FRAMES, ReplayBuffer, trimToSafeStart, type AttachHubOptions } from './attachHub.js';
import { sessionSettings } from './attribution.js';
import { ownerOfIdentity, type OwnerClaim } from './sessionOwners.js';
import { createLogger } from './log.js';
import { RUNNER_HOOK_SETTINGS } from '../main/claudeArgs.js';
import { fakeBroker, inputFrame, jsonFrame, person, resizeFrame, sinkRecorder } from './testFakes.js';

const alice = person('alice', 1);
const bob = person('bob', 2);
const UUID = '0b7e6c1e-1f6a-4c55-9c39-6f1f8d6c2a11';
const UUID2 = '1c8e7d2f-2a7b-4d66-8d4a-7a2a9e7d3b22';
/** A v1 UUID: a viewer may pin it only as a session this host already owns. */
const V1 = 'a8098c1a-f86e-11da-bd1a-00112444be1e';
const PINNED = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** The `--settings` value a CREATE by alice carries. */
const SETTINGS_ARG = sessionSettings(ownerOfIdentity(alice))!;

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
    [['--settings', RUNNER_HOOK_SETTINGS, '--session-id', UUID], ['--settings', SETTINGS_ARG, '--session-id', UUID]],
    [['--resume', UUID], ['--settings', SETTINGS_ARG, '--resume', UUID]],
    [['--resume', UUID.toUpperCase()], ['--settings', SETTINGS_ARG, '--resume', UUID]],
    [['--session-id', UUID2.toUpperCase()], ['--settings', SETTINGS_ARG, '--session-id', UUID2]]
  ])('accepts %j', async (args, want) => {
    const { broker, v } = setup('session', []);
    await v.receive(jsonFrame(FrameType.CREATE, { id: 'n', args }));
    expect(broker.created).toEqual([{ id: 'n', args: want }]);
  });

  it.each([[undefined], [[]], [['--settings', RUNNER_HOOK_SETTINGS]]])('pins a fresh claude session id for %j', async (args) => {
    const { broker, v } = setup('session', []);
    await v.receive(jsonFrame(FrameType.CREATE, { id: 'n', args }));
    const got = broker.created[0].args;
    expect(got).toHaveLength(4);
    expect(got.slice(0, 3)).toEqual(['--settings', SETTINGS_ARG, '--session-id']);
    expect(got[3]).toMatch(PINNED);
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

  it('each CREATE carries its own caller’s attribution; machines keep the hooks file', async () => {
    const broker = fakeBroker([]);
    const hub = new AttachHub(broker.ops);
    const robot = { ...person('acme-bot[bot]', 9), kind: 'machine' as const, appId: 5 };
    await hub.viewer({ identity: bob, tier: 'session' }, sinkRecorder().sink).receive(jsonFrame(FrameType.CREATE, { id: 'b', args: ['--session-id', UUID] }));
    await hub.viewer({ identity: robot, tier: 'session' }, sinkRecorder().sink).receive(jsonFrame(FrameType.CREATE, { id: 'm' }));
    expect(broker.created[0].args.slice(0, 2)).toEqual(['--settings', sessionSettings(ownerOfIdentity(bob))]);
    expect(JSON.parse(broker.created[0].args[1]).attribution.pr).toBe('🤖 Generated with [Claude Code](https://claude.com/claude-code) on behalf of @bob');
    expect(broker.created[1].args.slice(0, 2)).toEqual(['--settings', RUNNER_HOOK_SETTINGS]);
    for (const c of broker.created) expect(c.args.filter((a) => a === '--settings'), c.id).toHaveLength(1);
  });

  it('a body-supplied name or login never reaches the attribution', async () => {
    const { broker, v } = setup('session', []);
    await v.receive(jsonFrame(FrameType.CREATE, { id: 'n', name: 'Mallory', login: 'mallory', attribution: { commit: 'x', pr: 'y' } }));
    const s = JSON.parse(broker.created[0].args[1]);
    expect(s.attribution.pr).toMatch(/on behalf of @alice$/);
    expect(JSON.stringify(s)).not.toMatch(/mallory|Mallory/);
  });

  it('appends createArgs after the gate', async () => {
    const broker = fakeBroker([]);
    const v = new AttachHub(broker.ops, { createArgs: (a) => [...a, '--mcp-config', '{}'] }).viewer({ identity: alice, tier: 'session' }, sinkRecorder().sink);
    await v.receive(jsonFrame(FrameType.CREATE, { id: 'n' }));
    await v.receive(jsonFrame(FrameType.CREATE, { id: 'm', args: ['--resume', UUID] }));
    expect(broker.created.map((c) => c.args)).toEqual([
      ['--settings', SETTINGS_ARG, '--session-id', expect.stringMatching(PINNED), '--mcp-config', '{}'],
      ['--settings', SETTINGS_ARG, '--resume', UUID, '--mcp-config', '{}']
    ]);
  });
});

describe('a viewer-supplied claude id', () => {
  function rig(pinState?: AttachHubOptions['pinState']) {
    const broker = fakeBroker([]);
    const claims: OwnerClaim[] = [];
    const asked: string[] = [];
    const hub = new AttachHub(broker.ops, {
      recordOwner: async (c) => { claims.push(c); return true; },
      ...(pinState ? { pinState: async (id: string) => { asked.push(id); return pinState(id); } } : {})
    });
    const rec = sinkRecorder();
    return { broker, claims, asked, rec, v: hub.viewer({ identity: alice, tier: 'session' }, rec.sink) };
  }

  it.each([['--session-id'], ['--resume']])('%s: a non-v4 UUID is refused unless this host already owns it', async (flag) => {
    const fresh = rig();
    await fresh.v.receive(jsonFrame(FrameType.CREATE, { id: 'n', args: [flag, V1] }));
    expect([fresh.broker.created, fresh.claims]).toEqual([[], []]);
    expect(last(fresh.rec).json).toMatchObject({ id: 'n', ok: false, error: 'forbidden: unsupported session id' });

    const unknown = rig(async () => ({ owned: false, published: false }));
    await unknown.v.receive(jsonFrame(FrameType.CREATE, { id: 'n', args: [flag, V1.toUpperCase()] }));
    expect(unknown.asked).toEqual([V1]);
    expect(unknown.broker.created).toEqual([]);

    const owned = rig(async () => ({ owned: true, published: false }));
    await owned.v.receive(jsonFrame(FrameType.CREATE, { id: 'n', args: [flag, V1.toUpperCase()] }));
    expect(owned.broker.created).toEqual([{ id: 'n', args: ['--settings', SETTINGS_ARG, flag, V1] }]);
    expect(owned.claims[0].sessionId).toBe(V1);
  });

  it.each([['--session-id'], ['--resume']])('%s: a published session id is refused, even a v4 one this host owns', async (flag) => {
    const { broker, claims, rec, v } = rig(async () => ({ owned: true, published: true }));
    await v.receive(jsonFrame(FrameType.CREATE, { id: 'n', args: [flag, UUID] }));
    expect([broker.created, claims]).toEqual([[], []]);
    expect(last(rec).json).toMatchObject({ id: 'n', ok: false, error: 'forbidden: unsupported session id' });
  });

  it('a failed id lookup refuses the CREATE', async () => {
    const { broker, claims, rec, v } = rig(async () => { throw new Error('db down'); });
    await v.receive(jsonFrame(FrameType.CREATE, { id: 'n', args: ['--resume', UUID] }));
    expect([broker.created, claims]).toEqual([[], []]);
    expect(last(rec).json).toMatchObject({ id: 'n', ok: false, error: 'could not record the session owner' });
  });

  it('an id the host mints is never looked up', async () => {
    const { asked, broker, v } = rig(async () => ({ owned: false, published: false }));
    await v.receive(jsonFrame(FrameType.CREATE, { id: 'n' }));
    expect(asked).toEqual([]);
    expect(broker.created).toHaveLength(1);
  });
});

describe('CREATE records the owner from the principal', () => {
  function rig(who = alice, tier: Tier = 'session', o: Partial<AttachHubOptions> = {}) {
    const broker = fakeBroker([]);
    const claims: OwnerClaim[] = [];
    const released: OwnerClaim[] = [];
    const order: string[] = [];
    const create = broker.ops.create.bind(broker.ops);
    broker.ops.create = async (...a) => { order.push('create'); return create(...a); };
    const hub = new AttachHub(broker.ops, {
      recordOwner: async (c) => {
        order.push('record');
        const fresh = !claims.some((x) => x.brokerSessionId === c.brokerSessionId && x.sessionId === c.sessionId);
        claims.push(c);
        return fresh;
      },
      releaseOwner: async (c) => { released.push(c); },
      now: () => 42,
      ...o
    });
    const rec = sinkRecorder();
    return { broker, hub, claims, released, order, rec, v: hub.viewer({ identity: who, tier }, rec.sink) };
  }

  it('records the verified caller before the broker starts claude; body fields never name the owner', async () => {
    const { broker, claims, order, v } = rig();
    await v.receive(jsonFrame(FrameType.CREATE, {
      id: 'n', args: ['--session-id', UUID], owner: { login: 'mallory', id: 666 }, login: 'mallory', identity: { provider: 'github', id: 666 }
    }));
    expect(order).toEqual(['record', 'create']);
    expect(claims).toEqual([{
      brokerSessionId: 'n', sessionId: UUID, startedAt: 42,
      owner: { kind: 'user', provider: 'github', id: '1', login: 'alice', name: null, avatarUrl: null }
    }]);
    expect(broker.created).toHaveLength(1);
  });

  it('records the claude id it pinned when the viewer sent none', async () => {
    const { broker, claims, v } = rig();
    await v.receive(jsonFrame(FrameType.CREATE, { id: 'n' }));
    const args = broker.created[0].args;
    expect(claims[0].sessionId).toBe(args[args.indexOf('--session-id') + 1]);
  });

  it('refuses the CREATE when the owner row cannot be written', async () => {
    const { broker, rec, v } = rig(alice, 'session', { recordOwner: async () => { throw new Error('fenced off'); } });
    await v.receive(jsonFrame(FrameType.CREATE, { id: 'n' }));
    expect(broker.created).toEqual([]);
    expect(last(rec).json).toMatchObject({ id: 'n', ok: false, error: 'could not record the session owner' });
  });

  it('refuses an identity that cannot be recorded as an owner', async () => {
    const { broker, claims, rec, v } = rig(person('-odd', 3));
    await v.receive(jsonFrame(FrameType.CREATE, { id: 'n' }));
    expect([claims, broker.created]).toEqual([[], []]);
    expect(last(rec).json).toMatchObject({ ok: false, error: 'could not record the session owner' });
  });

  it('a broker refusal releases only a row this CREATE wrote; ownership never moves', async () => {
    const { hub, released } = rig();
    const vb = hub.viewer({ identity: bob, tier: 'session' }, sinkRecorder().sink);
    await hub.viewer({ identity: alice, tier: 'session' }, sinkRecorder().sink).receive(jsonFrame(FrameType.CREATE, { id: 'x', args: ['--session-id', UUID] }));
    await vb.receive(jsonFrame(FrameType.CREATE, { id: 'x', args: ['--session-id', UUID] }));
    expect(released).toEqual([]);
    await vb.receive(jsonFrame(FrameType.CREATE, { id: 'x', args: ['--session-id', UUID2] }));
    expect(released.map((c) => [c.brokerSessionId, c.sessionId, c.owner.login])).toEqual([['x', UUID2, 'bob']]);
    expect(hub.owners.get('x')).toBe('github:1');
  });

  it('a failed release still answers the CREATE with the broker error', async () => {
    const { rec, v, hub } = rig(alice, 'session', { releaseOwner: async () => { throw new Error('fenced off'); } });
    await hub.viewer({ identity: bob, tier: 'session' }, sinkRecorder().sink).receive(jsonFrame(FrameType.CREATE, { id: 'x' }));
    await v.receive(jsonFrame(FrameType.CREATE, { id: 'x' }));
    expect(last(rec).json).toMatchObject({ id: 'x', ok: false, error: 'session id in use' });
  });

  it('a steer or read viewer never reaches the owner hook', async () => {
    for (const tier of ['read', 'steer'] as const) {
      const { claims, v } = rig(alice, tier);
      await v.receive(jsonFrame(FrameType.CREATE, { id: 'n' }));
      expect(claims).toEqual([]);
    }
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

describe('whole frames per message (D4)', () => {
  it('closes 1002 on a message that ends mid-frame', async () => {
    const { broker, rec, v } = setup('steer');
    await v.receive(jsonFrame(FrameType.ATTACH, { id: 's1', channel: 1 }));
    const f = inputFrame(1, 'hello');
    await v.receive(Buffer.concat([inputFrame(1, 'a'), f.subarray(0, 7)]));
    await v.receive(f.subarray(7));
    expect(rec.closes).toEqual([[1002, 'partial frame']]);
    expect(broker.sessions.get('s1')!.inputs).toEqual([]);
  });

  it('closes 1002 on a message shorter than a frame header', async () => {
    const { rec, v } = setup('steer');
    await v.receive(Buffer.from([0, 0]));
    expect(rec.closes).toEqual([[1002, 'partial frame']]);
  });

  it('accepts a 1 MiB frame in one message', async () => {
    const { broker, rec, v } = setup('steer');
    await v.receive(jsonFrame(FrameType.ATTACH, { id: 's1', channel: 1 }));
    const body = Buffer.alloc(MAX_FRAME_PAYLOAD - 4, 0x61);
    await v.receive(encodeFrame(FrameType.INPUT, encodeChannelData(1, body)));
    expect(rec.closes).toEqual([]);
    expect(broker.sessions.get('s1')!.inputs[0].length).toBe(body.length);
  });

  it('handles 10k tiny messages, and 10k slivers of one frame, in linear time', async () => {
    const { rec, v } = setup('steer');
    await v.receive(jsonFrame(FrameType.ATTACH, { id: 's1', channel: 1 }));
    const tiny = inputFrame(1, 'k');
    // 10k x 105 bytes: one 1 MiB frame, the reviewer's quadratic-concat case.
    const sliver = Buffer.alloc(105);
    sliver.writeUInt32BE(MAX_FRAME_PAYLOAD, 0);
    const t0 = performance.now();
    for (let i = 0; i < 10_000; i++) await v.receive(tiny);
    const fresh = setup('steer');
    for (let i = 0; i < 10_000; i++) await fresh.v.receive(i === 0 ? sliver : Buffer.alloc(105));
    expect(performance.now() - t0).toBeLessThan(200);
    expect(rec.closes).toEqual([]);
    expect(fresh.rec.closes).toEqual([[1002, 'partial frame']]);
  });
});

describe('pending bytes cap', () => {
  it('closes 1008 once more than MAX_PENDING_BYTES are queued', async () => {
    const broker = fakeBroker(['s1']);
    broker.ops.list = () => new Promise(() => undefined);
    const rec = sinkRecorder();
    const v = new AttachHub(broker.ops).viewer({ identity: alice, tier: 'steer' }, rec.sink);
    void v.receive(encodeFrame(FrameType.LIST, Buffer.alloc(0)));
    const big = encodeFrame(FrameType.INPUT, encodeChannelData(1, Buffer.alloc(MAX_FRAME_PAYLOAD - 4)));
    const fit = Math.floor(MAX_PENDING_BYTES / MAX_FRAME_PAYLOAD);
    for (let i = 0; i < fit; i++) void v.receive(big);
    expect(rec.closes).toEqual([]);
    void v.receive(big);
    expect(rec.closes).toEqual([[1008, 'too many pending bytes']]);
  });
});
