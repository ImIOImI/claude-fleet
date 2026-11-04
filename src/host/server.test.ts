import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { FrameType } from '../main/broker.js';
import { IdentityError, type Identity, type IdentityProvider } from '../main/identity/types.js';
import { AttachHub } from './attachHub.js';
import { buildAuthContext, type AuthContext } from './auth.js';
import { parseHostConfig } from './config.js';
import { EventHub } from './events.js';
import type { LeaseState } from './lease.js';
import { createLogger } from './log.js';
import { brokerRpcChannels, type RpcChannel } from './rpc.js';
import { createHostServer, MAX_RPC_BODY, REVERIFY_MS, type HostServer, type HostServerDeps } from './server.js';
import { decodeAll, fakeBroker, inputFrame, jsonFrame, person, TOKEN } from './testFakes.js';

const WS = { id: '01JC0000000000000000000000', name: 'review-bot', description: 'reviews', color: { hue: 210 } };
// One token per tier; anything else is rejected by the fake provider.
const TOKENS: Record<string, Identity> = {
  [`${TOKEN}r`]: person('reader', 10, ['acme/eng']),
  [`${TOKEN}s`]: person('steerer', 11, ['acme/ops']),
  [`${TOKEN}x`]: person('owner', 12, ['acme/platform']),
  [`${TOKEN}n`]: person('nobody', 13, ['acme/none'])
};
const GRANTS = [
  { team: 'acme/eng', tier: 'read' },
  { team: 'acme/ops', tier: 'steer' },
  { team: 'acme/platform', tier: 'session' }
];

interface Rig {
  url: string;
  host: HostServer;
  logs: string[];
  broker: ReturnType<typeof fakeBroker>;
  events: EventHub;
  setLease(s: LeaseState): void;
  setAuth(c: AuthContext): void;
  verify: IdentityProvider['verify'];
}

let rig: Rig | null = null;
afterEach(async () => {
  await rig?.host.close();
  rig = null;
});

function provider(verify: IdentityProvider['verify']): AuthContext {
  return buildAuthContext(parseHostConfig({ workspace: { name: 'w' }, grants: GRANTS }), () => ({ id: 'github', verify }));
}

async function start(extraRpc: Array<[string, RpcChannel]> = [], opts: Partial<HostServerDeps> = {}): Promise<Rig> {
  const logs: string[] = [];
  const broker = fakeBroker(['s1']);
  const events = new EventHub();
  let lease: LeaseState = 'holder';
  const verify = vi.fn(async (t: string) => {
    const who = TOKENS[t];
    if (!who) throw new IdentityError('unauthorized', 'bad credentials', 401);
    return who;
  });
  let auth = provider(verify);
  const rpc = new Map([...brokerRpcChannels(broker.ops), ...extraRpc]);
  const host = createHostServer({
    workspace: () => WS,
    auth: () => auth,
    lease: () => lease,
    healthy: () => true,
    hub: new AttachHub(broker.ops),
    events,
    rpc,
    log: createLogger((l) => logs.push(l)),
    reverifyMs: 3_600_000,
    ...opts
  });
  await new Promise<void>((r) => host.server.listen(0, '127.0.0.1', () => r()));
  const { port } = host.server.address() as AddressInfo;
  rig = {
    url: `http://127.0.0.1:${port}`,
    host,
    logs,
    broker,
    events,
    setLease: (s) => (lease = s),
    setAuth: (c) => (auth = c),
    verify
  };
  return rig;
}

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

async function rpc(r: Rig, channel: string, args: unknown[], token?: string) {
  const res = await fetch(`${r.url}/rpc/${channel}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? bearer(token) : {}) },
    body: JSON.stringify({ args })
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function openWs(r: Rig, path: string, token?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(r.url.replace('http', 'ws') + path, { headers: token ? bearer(token) : {} });
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once('error', reject);
  });
}

const nextMessage = (ws: WebSocket) => new Promise<Buffer>((r) => ws.once('message', (d: Buffer) => r(d)));
const closed = (ws: WebSocket) => new Promise<[number, string]>((r) => ws.once('close', (c, why) => r([c, String(why)])));

describe('unauthenticated routes', () => {
  it('/healthz reports lease state without a token, holder or standby', async () => {
    const r = await start();
    expect(await (await fetch(`${r.url}/healthz`)).json()).toEqual({ status: 'ok', lease: 'holder' });
    r.setLease('standby');
    const res = await fetch(`${r.url}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', lease: 'standby' });
    expect(r.verify).not.toHaveBeenCalled();
  });

  it('/leader is 200 only on the holder', async () => {
    const r = await start();
    expect((await fetch(`${r.url}/leader`)).status).toBe(200);
    r.setLease('standby');
    expect((await fetch(`${r.url}/leader`)).status).toBe(503);
  });
});

describe('identity on every request', () => {
  it.each(['/whoami'])('%s: 401 without a token, 401 with a bad one, 403 with no grant', async (path) => {
    const r = await start();
    expect((await fetch(`${r.url}${path}`)).status).toBe(401);
    expect((await fetch(`${r.url}${path}`, { headers: bearer('ghp_wrong') })).status).toBe(401);
    expect((await fetch(`${r.url}${path}`, { headers: bearer(`${TOKEN}n`) })).status).toBe(403);
  });

  it('/rpc: 401 without a token even for a read channel', async () => {
    const r = await start();
    expect((await rpc(r, 'ports:list', [])).status).toBe(401);
  });

  it.each(['/attach', '/events'])('%s upgrade: 401 without a token, 403 with no grant', async (path) => {
    const r = await start();
    await expect(openWs(r, path)).rejects.toThrow('HTTP 401');
    await expect(openWs(r, path, `${TOKEN}n`)).rejects.toThrow('HTTP 403');
  });

  it('verifies each request rather than trusting a prior one on the same connection', async () => {
    const r = await start();
    await fetch(`${r.url}/whoami`, { headers: bearer(`${TOKEN}r`), keepalive: true });
    expect((await fetch(`${r.url}/whoami`, { keepalive: true })).status).toBe(401);
  });

  it('a standby serves none of the authenticated routes', async () => {
    const r = await start();
    r.setLease('standby');
    expect((await fetch(`${r.url}/whoami`, { headers: bearer(`${TOKEN}x`) })).status).toBe(503);
    expect((await rpc(r, 'ports:list', [], `${TOKEN}x`)).status).toBe(503);
    await expect(openWs(r, '/attach', `${TOKEN}x`)).rejects.toThrow('HTTP 503');
  });
});

describe('per-route tiers', () => {
  it('/whoami returns workspace, user and tier', async () => {
    const r = await start();
    const res = await fetch(`${r.url}/whoami`, { headers: bearer(`${TOKEN}s`) });
    expect(await res.json()).toEqual({
      workspace: WS,
      user: { provider: 'github', kind: 'user', login: 'steerer', id: 11, name: null, avatarUrl: null },
      tier: 'steer'
    });
  });

  it.each([
    ['r', 403],
    ['s', 200],
    ['x', 200]
  ])('ports:kill (steer) with tier token %s → %d', async (suffix, status) => {
    const r = await start();
    const res = await rpc(r, 'ports:kill', [3000], `${TOKEN}${suffix}`);
    expect(res.status).toBe(status);
    expect(r.broker.killed).toEqual(status === 200 ? [3000] : []);
  });

  it('ports:list (read) is open to read', async () => {
    const r = await start();
    expect(await rpc(r, 'ports:list', [], `${TOKEN}r`)).toEqual({ status: 200, body: { ok: true, result: [{ port: 3000 }] } });
  });

  it('a session-tier channel refuses steer', async () => {
    const handle = vi.fn(async () => 'ran');
    const r = await start([['sessions:start', { tier: 'session', handle }]]);
    expect((await rpc(r, 'sessions:start', [], `${TOKEN}s`)).status).toBe(403);
    expect(handle).not.toHaveBeenCalled();
    expect((await rpc(r, 'sessions:start', [], `${TOKEN}x`)).status).toBe(200);
  });

  it('unregistered channels do not exist', async () => {
    const r = await start();
    for (const ch of ['config:get', 'workspace:remove', 'fs:openPath', 'endpoints:setApiKey']) {
      expect((await rpc(r, ch, [], `${TOKEN}x`)).status).toBe(404);
    }
  });

  it('/attach frames are gated by the upgrade tier', async () => {
    const r = await start();
    const ws = await openWs(r, '/attach', `${TOKEN}r`);
    ws.send(jsonFrame(FrameType.ATTACH, { id: 's1', channel: 1 }));
    expect(decodeAll(await nextMessage(ws))[0]).toMatchObject({ type: FrameType.ATTACHED, json: { ok: true } });
    ws.send(inputFrame(1, 'x'));
    ws.send(jsonFrame(FrameType.CREATE, { id: 'n' }));
    expect(decodeAll(await nextMessage(ws))[0].json).toMatchObject({ ok: false, error: 'forbidden: needs session' });
    expect(r.broker.sessions.get('s1')!.inputs).toEqual([]);
    ws.close();
  });

  it('/events pushes to authenticated subscribers', async () => {
    const r = await start();
    const ws = await openWs(r, '/events', `${TOKEN}r`);
    const msg = nextMessage(ws);
    r.events.publish('sessions:changed', { sessions: [] });
    expect(JSON.parse(String(await msg))).toEqual({ channel: 'sessions:changed', payload: { sessions: [] } });
    ws.close();
  });
});

describe('re-verification of open sockets', () => {
  it('closes a socket whose grant was removed by a config reload', async () => {
    const r = await start();
    const ws = await openWs(r, '/events', `${TOKEN}s`);
    const done = closed(ws);
    r.setAuth(buildAuthContext(parseHostConfig({ workspace: { name: 'w' }, grants: [] }), () => ({ id: 'github', verify: r.verify })));
    await r.host.reverifyAll();
    expect(await done).toEqual([4403, 'no grant for @steerer']);
  });

  it('downgrades an /attach viewer in place when its tier drops', async () => {
    const r = await start();
    const ws = await openWs(r, '/attach', `${TOKEN}s`);
    ws.send(jsonFrame(FrameType.ATTACH, { id: 's1', channel: 1 }));
    await nextMessage(ws);
    r.setAuth(
      buildAuthContext(parseHostConfig({ workspace: { name: 'w' }, grants: [{ team: 'acme/ops', tier: 'read' }] }), () => ({
        id: 'github',
        verify: r.verify
      }))
    );
    await r.host.reverifyAll();
    ws.send(inputFrame(1, 'after'));
    ws.send(jsonFrame(FrameType.KILLPORT, { port: 1 }));
    expect(decodeAll(await nextMessage(ws))[0].json).toMatchObject({ error: 'forbidden: needs steer' });
    expect(r.broker.sessions.get('s1')!.inputs).toEqual([]);
    ws.close();
  });

  it('closes with 4401 once the token itself is rejected', async () => {
    const r = await start();
    const ws = await openWs(r, '/events', `${TOKEN}r`);
    const done = closed(ws);
    r.setAuth(provider(async () => { throw new IdentityError('unauthorized', 'revoked', 401); }));
    await r.host.reverifyAll();
    expect((await done)[0]).toBe(4401);
  });
});

describe('no token in logs or error bodies', () => {
  it('across auth failures, rpc errors and upgrades', async () => {
    const leaky = `${TOKEN}leak`;
    const handle = async () => {
      throw new Error(`upstream said: Authorization: Bearer ${leaky}`);
    };
    const r = await start([['boom', { tier: 'read', handle }]]);
    r.setAuth(
      buildAuthContext(parseHostConfig({ workspace: { name: 'w' }, grants: GRANTS }), () => ({
        id: 'github',
        verify: async (t) => {
          if (t === leaky) return person('reader', 10, ['acme/eng']);
          throw new Error(`GitHub said no to ${t}`);
        }
      }))
    );
    const bodies: string[] = [];
    bodies.push(await (await fetch(`${r.url}/whoami`, { headers: bearer(`${TOKEN}other`) })).text());
    bodies.push(JSON.stringify((await rpc(r, 'boom', [], leaky)).body));
    bodies.push(JSON.stringify((await rpc(r, 'nope', [], leaky)).body));
    await openWs(r, '/attach', `${TOKEN}other`).catch((e: Error) => bodies.push(e.message));
    const ws = await openWs(r, '/attach', leaky);
    ws.close();
    for (const b of [...bodies, ...r.logs]) {
      expect(b).not.toContain(TOKEN);
    }
    expect(r.logs.some((l) => l.includes('"path":"/rpc/boom"'))).toBe(true);
  });
});

describe('401 rate limit', () => {
  const limit = { max: 2, windowMs: 60_000, maxIps: 100 };
  const whoami = async (r: Rig, token?: string, xff?: string) =>
    (await fetch(`${r.url}/whoami`, { headers: { ...(token ? bearer(token) : {}), ...(xff ? { 'X-Forwarded-For': xff } : {}) } })).status;

  it('429s a limited address before the provider runs, on every authenticated route', async () => {
    const r = await start([], { unauthLimit: limit });
    expect(await whoami(r, 'ghp_bad1')).toBe(401);
    expect(await whoami(r)).toBe(401);
    const calls = vi.mocked(r.verify).mock.calls.length;
    expect(await whoami(r, `${TOKEN}x`)).toBe(429);
    expect((await rpc(r, 'ports:list', [], `${TOKEN}x`)).status).toBe(429);
    await expect(openWs(r, '/attach', `${TOKEN}x`)).rejects.toThrow('HTTP 429');
    expect(vi.mocked(r.verify).mock.calls.length).toBe(calls);
  });

  it('keys on the socket address, ignoring X-Forwarded-For by default', async () => {
    const r = await start([], { unauthLimit: limit });
    expect(await whoami(r, 'ghp_bad1', '198.51.100.1')).toBe(401);
    expect(await whoami(r, 'ghp_bad2', '198.51.100.2')).toBe(401);
    expect(await whoami(r, `${TOKEN}x`, '198.51.100.3')).toBe(429);
  });

  it('with trusted hops, keys on the address that many hops from the right', async () => {
    const r = await start([], { unauthLimit: limit, trustedProxyHops: () => 1 });
    expect(await whoami(r, 'ghp_bad1', 'a, 203.0.113.1')).toBe(401);
    expect(await whoami(r, 'ghp_bad2', 'b, 203.0.113.1')).toBe(401);
    expect(await whoami(r, `${TOKEN}x`, 'c, 203.0.113.1')).toBe(429);
    expect(await whoami(r, `${TOKEN}x`, 'a, 203.0.113.2')).toBe(200);
  });

  it('a repeated bad token reaches the provider once', async () => {
    const r = await start();
    for (let i = 0; i < 3; i++) expect(await whoami(r, 'ghp_wrong')).toBe(401);
    expect(vi.mocked(r.verify).mock.calls.filter(([t]) => t === 'ghp_wrong')).toHaveLength(1);
  });
});

describe('server-side detail, generic body', () => {
  it('logs a refused machine detail and answers with the generic 403', async () => {
    const r = await start();
    r.setAuth(provider(async () => { throw new IdentityError('machine-unknown', 'app 42 has no machines rule'); }));
    const res = await fetch(`${r.url}/whoami`, { headers: bearer(`${TOKEN}r`) });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'machine not permitted' });
    expect(r.logs.some((l) => l.includes('app 42 has no machines rule'))).toBe(true);
  });
});

describe('re-verify timer', () => {
  it('re-checks open sockets every REVERIFY_MS without a reload', async () => {
    expect(REVERIFY_MS).toBe(60_000);
    const r = await start([], { reverifyMs: 30 });
    const ws = await openWs(r, '/events', `${TOKEN}r`);
    const done = closed(ws);
    r.setAuth(provider(async () => { throw new IdentityError('unauthorized', 'revoked', 401); }));
    expect((await done)[0]).toBe(4401);
  });
});

describe('rpc body limits', () => {
  it('413s a body over MAX_RPC_BODY and 415s a non-JSON content type', async () => {
    const r = await start();
    const big = await fetch(`${r.url}/rpc/ports:list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...bearer(`${TOKEN}r`) },
      body: JSON.stringify({ args: ['x'.repeat(MAX_RPC_BODY)] })
    });
    expect(big.status).toBe(413);
    const text = await fetch(`${r.url}/rpc/ports:list`, { method: 'POST', headers: bearer(`${TOKEN}r`), body: '{"args":[]}' });
    expect(text.status).toBe(415);
  });

  it('404s a channel name that is not valid percent-encoding', async () => {
    const r = await start();
    expect((await rpc(r, '%E0%A4%A', [], `${TOKEN}r`)).status).toBe(404);
  });
});
