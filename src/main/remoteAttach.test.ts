import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { encodeFrame, encodeJSONFrame, FrameType } from './broker.js';
import { person, TOKEN } from '../host/testFakes.js';
import { startTestHost } from '../host/testHost.js';
import { attachRemotePty, DRAIN_NOTICE_TEXT, fetchDrained } from './remoteAttach.js';
import { RemoteClient, RemoteError } from './remoteClient.js';

const READER = `${TOKEN}r`;
const OWNER = `${TOKEN}x`;
const OTHER = `${TOKEN}y`;
let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

async function rig(sessions: string[]) {
  const h = await startTestHost({
    tokens: { [READER]: person('reader', 1, ['acme/eng']), [OWNER]: person('owner', 2, ['acme/platform']), [OTHER]: person('other', 3, ['acme/platform']) },
    grants: [{ team: 'acme/eng', tier: 'read' }, { team: 'acme/platform', tier: 'session' }],
    sessions
  });
  close = h.close;
  return { ...h, client: (t: string) => new RemoteClient({ url: h.url, token: async () => t }) };
}

function collect(h: { stream: NodeJS.ReadableStream }) {
  const got: string[] = [];
  let ended = false;
  h.stream.on('data', (b: Buffer) => got.push(String(b)));
  h.stream.on('end', () => (ended = true));
  return { text: () => got.join(''), ended: () => ended };
}

describe('attachRemotePty', () => {
  it('a read viewer sees output and its keystrokes never reach the broker', async () => {
    const { broker, client } = await rig(['s1']);
    const h = await attachRemotePty({ client: client(READER), sessionId: 's1', cols: 80, rows: 24, canCreate: false });
    const out = collect(h);
    await expect.poll(() => broker.sessions.get('s1')!.handlers !== null).toBe(true);
    broker.sessions.get('s1')!.handlers!.onOutput(Buffer.from('hello'));
    await expect.poll(() => out.text()).toContain('hello');
    h.stream.write('typed');
    await new Promise((r) => setTimeout(r, 50));
    expect(broker.sessions.get('s1')!.inputs).toEqual([]);
    h.detach();
    await expect.poll(() => broker.sessions.get('s1')!.detached).toBe(1);
    expect(broker.sessions.get('s1')!.closed).toBe(false);
  });

  it('a session-tier owner creates a missing session, types into it, and closes it', async () => {
    const { broker, client } = await rig([]);
    const h = await attachRemotePty({ client: client(OWNER), sessionId: 'tab1', cols: 100, rows: 30, canCreate: true });
    expect(broker.created[0].id).toBe('tab1');
    expect(broker.created[0].args.slice(2, 3)).toEqual(['--session-id']);
    h.stream.write('ls\r');
    await expect.poll(() => broker.sessions.get('tab1')!.inputs.map(String).join('')).toBe('ls\r');
    await h.close();
    expect(broker.sessions.get('tab1')!.closed).toBe(true);
  });

  it('a non-owner close only detaches', async () => {
    const { broker, client } = await rig([]);
    const a = await attachRemotePty({ client: client(OWNER), sessionId: 'tab1', cols: 80, rows: 24, canCreate: true });
    const b = await attachRemotePty({ client: client(OTHER), sessionId: 'tab1', cols: 80, rows: 24, canCreate: true });
    await b.close();
    expect(broker.sessions.get('tab1')!.closed).toBe(false);
    a.detach();
  });

  it('a read viewer cannot start a missing session', async () => {
    const { client } = await rig([]);
    await expect(attachRemotePty({ client: client(READER), sessionId: 'nope', cols: 80, rows: 24, canCreate: false })).rejects.toThrow(/cannot start one/);
  });

  it('sends a paste larger than one frame as whole frames the host accepts', async () => {
    const { broker, client } = await rig([]);
    const h = await attachRemotePty({ client: client(OWNER), sessionId: 'tab1', cols: 80, rows: 24, canCreate: true });
    const out = collect(h);
    const big = 'a'.repeat(3 * (1 << 20) + 7);
    h.stream.write(big);
    await expect.poll(() => broker.sessions.get('tab1')!.inputs.reduce((n, b) => n + b.length, 0), { timeout: 5000 }).toBe(big.length);
    expect(out.ended()).toBe(false);
    h.detach();
  });

  it.each([
    [4401, /sign in/i],
    [4403, /access .* removed/i],
    [1001, /restarting/i]
  ] as const)('host close %i ends the tab with a distinct notice', async (code, notice) => {
    const { host, client } = await rig(['s1']);
    const h = await attachRemotePty({ client: client(READER), sessionId: 's1', cols: 80, rows: 24, canCreate: false });
    const out = collect(h);
    host.halt(code, 'x');
    await expect.poll(() => out.ended()).toBe(true);
    expect(out.text()).toMatch(notice);
  });

  it('a detach adds no notice', async () => {
    const { client } = await rig(['s1']);
    const h = await attachRemotePty({ client: client(READER), sessionId: 's1', cols: 80, rows: 24, canCreate: false });
    const out = collect(h);
    h.detach();
    await expect.poll(() => out.ended()).toBe(true);
    expect(out.text()).toBe('');
  });

  describe('against a hostile or failing host', () => {
    async function wsHost(onMessage: (ws: WebSocket, token: string) => void) {
      const wss = new WebSocketServer({ noServer: true });
      const srv = createServer((_q, res) => res.end());
      srv.on('upgrade', (req, socket, head) =>
        wss.handleUpgrade(req, socket, head, (ws) => ws.on('message', () => onMessage(ws, String(req.headers.authorization).slice(7))))
      );
      await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', () => ok()));
      close = async () => {
        wss.close();
        srv.closeAllConnections();
        await new Promise<void>((ok) => srv.close(() => ok()));
      };
      return new RemoteClient({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, token: async () => OWNER });
    }

    it('redacts the token from a host error it echoes', async () => {
      const c = await wsHost((ws, token) => ws.send(encodeJSONFrame(FrameType.ATTACHED, { channel: 1, ok: false, error: `nope ${token}` })));
      const err = (await attachRemotePty({ client: c, sessionId: 's', cols: 80, rows: 24, canCreate: true }).catch((e: unknown) => e)) as Error;
      expect(err.message).toMatch(/host refused to attach/);
      expect(err.message).not.toContain(OWNER);
    });

    it('redacts host text inside a malformed attach reply', async () => {
      const c = await wsHost((ws, token) => ws.send(encodeFrame(FrameType.ATTACHED, Buffer.from(`[\x1b[31m${token}`))));
      const err = (await attachRemotePty({ client: c, sessionId: 's', cols: 80, rows: 24, canCreate: true }).catch((e: unknown) => e)) as Error;
      expect(err.message).toBe('host attach failed: malformed host reply');
      expect(err.message).not.toContain(OWNER.slice(0, 6));
      expect(err.message).not.toMatch(/[\x00-\x1f]/);
    });

    it('End session gives up waiting for CLOSED and drops the socket', async () => {
      let n = 0;
      let dropped = false;
      const c = await wsHost((ws) => {
        ws.once('close', () => (dropped = true));
        if (n++ === 0) ws.send(encodeJSONFrame(FrameType.ATTACHED, { channel: 1, ok: true }));
      });
      const h = await attachRemotePty({ client: c, sessionId: 's', cols: 80, rows: 24, canCreate: true, closeWaitMs: 100 });
      const started = Date.now();
      await h.close();
      expect(Date.now() - started).toBeLessThan(1000);
      await expect.poll(() => dropped).toBe(true);
    });

    it('a close during attach fails at once with the close-code reason', async () => {
      const c = await wsHost((ws) => ws.close(4403, 'grant removed'));
      const started = Date.now();
      await expect(attachRemotePty({ client: c, sessionId: 's', cols: 80, rows: 24, canCreate: true })).rejects.toMatchObject({
        kind: 'forbidden',
        message: expect.stringMatching(/access .* removed/)
      });
      expect(Date.now() - started).toBeLessThan(2000);
    });
  });
});

describe('drained sessions (D151)', () => {
  const CID = '0b6f8f0e-4b1c-4c2a-9a0e-1f2e3d4c5b6a';

  it('resumes a drained session with its claude id under the same broker id', async () => {
    const { broker, client } = await rig([]);
    const h = await attachRemotePty({
      client: client(OWNER), sessionId: 'tab1', cols: 80, rows: 24, canCreate: true,
      drained: async () => [{ brokerSessionId: 'other', sessionId: '1b6f8f0e-4b1c-4c2a-9a0e-1f2e3d4c5b6a' }, { brokerSessionId: 'tab1', sessionId: CID }]
    });
    expect(broker.created[0]).toMatchObject({ id: 'tab1' });
    expect(broker.created[0].args).toContain('--resume');
    expect(broker.created[0].args).toContain(CID);
    expect(broker.created[0].args).not.toContain('--session-id');
    h.detach();
  });

  it('a tab missing from the list starts fresh, as before', async () => {
    const { broker, client } = await rig([]);
    const h = await attachRemotePty({ client: client(OWNER), sessionId: 'tab1', cols: 80, rows: 24, canCreate: true, drained: async () => [{ brokerSessionId: 'other', sessionId: CID }] });
    expect(broker.created[0].args).toContain('--session-id');
    expect(broker.created[0].args).not.toContain(CID);
    h.detach();
  });

  it('attaches instead when another viewer resumed first', async () => {
    const { broker, client } = await rig([]);
    const realCreate = broker.ops.create;
    broker.ops.create = async (id, c, r, args, opts) => { await realCreate(id, c, r, args, opts); return { ok: false, error: 'session: id already in use' }; };
    const h = await attachRemotePty({ client: client(OWNER), sessionId: 'tab1', cols: 80, rows: 24, canCreate: true, drained: async () => [] });
    await expect.poll(() => broker.sessions.get('tab1')?.handlers ?? null).not.toBeNull();
    h.detach();
  });

  it('another CREATE refusal still fails', async () => {
    const { broker, client } = await rig([]);
    broker.ops.create = async () => ({ ok: false, error: 'draining: the workspace is restarting' });
    await expect(attachRemotePty({ client: client(OWNER), sessionId: 'tab1', cols: 80, rows: 24, canCreate: true, drained: async () => [] }))
      .rejects.toThrow(/host refused to start the session: draining/);
  });

  it('a failed drained lookup never starts a fresh claude', async () => {
    const { broker, client } = await rig([]);
    await expect(attachRemotePty({ client: client(OWNER), sessionId: 'tab1', cols: 80, rows: 24, canCreate: true, drained: async () => { throw new Error('503'); } }))
      .rejects.toThrow('The host is starting; reopen this tab in a moment.');
    expect(broker.created).toEqual([]);
  });

  it('a matching row with an invalid claude id never starts a fresh claude', async () => {
    const { broker, client } = await rig([]);
    await expect(attachRemotePty({ client: client(OWNER), sessionId: 'tab1', cols: 80, rows: 24, canCreate: true, drained: async () => [{ brokerSessionId: 'tab1', sessionId: null }] }))
      .rejects.toThrow('The host is starting; reopen this tab in a moment.');
    expect(broker.created).toEqual([]);
  });

  it('a malformed drained reply never starts a fresh claude', async () => {
    const { broker, client } = await rig([]);
    const c = client(OWNER);
    const bad = { ...c, rpc: (async () => ({ rows: 'nope' })) as never };
    await expect(attachRemotePty({ client: c, sessionId: 'tab1', cols: 80, rows: 24, canCreate: true, drained: () => fetchDrained(bad) }))
      .rejects.toThrow('The host is starting; reopen this tab in a moment.');
    const badUuid = { ...c, rpc: (async () => ({ rows: [{ brokerSessionId: 'tab1', sessionId: 'not-a-uuid' }] })) as never };
    await expect(attachRemotePty({ client: c, sessionId: 'tab1', cols: 80, rows: 24, canCreate: true, drained: () => fetchDrained(badUuid) }))
      .rejects.toThrow('The host is starting; reopen this tab in a moment.');
    expect(broker.created).toEqual([]);
  });

  it('an explicit resumeOf wins and skips the lookup', async () => {
    const { broker, client } = await rig([]);
    let asked = 0;
    const own = '2b6f8f0e-4b1c-4c2a-9a0e-1f2e3d4c5b6a';
    const h = await attachRemotePty({ client: client(OWNER), sessionId: 'tab1', cols: 80, rows: 24, canCreate: true, resumeOf: own, drained: async () => { asked++; return [{ brokerSessionId: 'tab1', sessionId: CID }]; } });
    expect(asked).toBe(0);
    expect(broker.created[0].args).toContain(own);
    h.detach();
  });

  it('a running session never consults the list', async () => {
    const { broker, client } = await rig(['s1']);
    let asked = 0;
    const h = await attachRemotePty({ client: client(OWNER), sessionId: 's1', cols: 80, rows: 24, canCreate: true, drained: async () => { asked++; return []; } });
    expect(asked).toBe(0);
    expect(broker.created).toEqual([]);
    h.detach();
  });

  it('prints the fixed notice when the host drops input', async () => {
    const { broker, client } = await rig(['s1']);
    const h = await attachRemotePty({ client: client(OWNER), sessionId: 's1', cols: 80, rows: 24, canCreate: true });
    const out = collect(h);
    await expect.poll(() => broker.sessions.get('s1')!.handlers !== null).toBe(true);
    broker.sessions.get('s1')!.handlers!.onNotice!('draining');
    await expect.poll(() => out.text()).toContain("[host is restarting; your input wasn't sent]");
    expect(DRAIN_NOTICE_TEXT).toBe("[host is restarting; your input wasn't sent]");
    h.detach();
  });
});

describe('fetchDrained', () => {
  const ok = '0b6f8f0e-4b1c-4c2a-9a0e-1f2e3d4c5b6a';
  const client = (rpc: () => Promise<unknown>) => ({ rpc: rpc as never });

  it('keeps well-formed rows, at most 200; a bad claude id stays as null, other bad rows drop', async () => {
    const rows = [
      { brokerSessionId: 'a', sessionId: ok }, { brokerSessionId: 'b', sessionId: 'not-a-uuid' }, { brokerSessionId: 7, sessionId: ok },
      null, 'x', { brokerSessionId: 'c', sessionId: ok.toUpperCase() }, { brokerSessionId: 'd', sessionId: `${ok}\n` }
    ];
    expect(await fetchDrained(client(async () => ({ rows })))).toEqual([
      { brokerSessionId: 'a', sessionId: ok }, { brokerSessionId: 'b', sessionId: null },
      { brokerSessionId: 'c', sessionId: null }, { brokerSessionId: 'd', sessionId: null }
    ]);
    const many = Array.from({ length: 250 }, (_, i) => ({ brokerSessionId: `s${i}`, sessionId: ok }));
    expect(await fetchDrained(client(async () => ({ rows: many })))).toHaveLength(200);
  });

  it('a 200 reply without a rows array is a protocol error', async () => {
    await expect(fetchDrained(client(async () => ({ rows: 'nope' })))).rejects.toMatchObject({ kind: 'protocol', message: 'bad sessions:drained reply' });
    await expect(fetchDrained(client(async () => null))).rejects.toMatchObject({ kind: 'protocol', message: 'bad sessions:drained reply' });
    await expect(fetchDrained(client(async () => ({})))).rejects.toMatchObject({ kind: 'protocol' });
  });

  it('an older host without the channel (404) has none; other errors propagate', async () => {
    expect(await fetchDrained(client(async () => { throw new RemoteError('protocol', 'not found', 404); }))).toEqual([]);
    await expect(fetchDrained(client(async () => { throw new RemoteError('unreachable', 'host starting', 503); }))).rejects.toThrow('host starting');
  });
});
