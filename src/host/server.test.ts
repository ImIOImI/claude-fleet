import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { connect, type AddressInfo, type Socket } from 'node:net';
import WebSocket from 'ws';
import { FrameType, MAX_FRAME_PAYLOAD } from '../main/broker.js';
import { IdentityError, type Identity, type IdentityProvider } from '../main/identity/types.js';
import { VERIFY_TTL_MS } from '../main/identity/verifyCache.js';
import { AttachHub } from './attachHub.js';
import { buildAuthContext, type AuthContext } from './auth.js';
import { parseHostConfig } from './config.js';
import { EventHub } from './events.js';
import type { LeaseState } from './lease.js';
import { createLogger } from './log.js';
import { brokerRpcChannels, type RpcChannel } from './rpc.js';
import {
  createHostServer,
  HUB_SHUTDOWN_MS,
  installCrashGuards,
  KNOWN_GOOD_TTL_MS,
  MAX_RPC_BODY,
  MAX_RPC_PER_IDENTITY,
  MAX_SOCKETS_PER_IDENTITY,
  PING_MS,
  REVERIFY_MS,
  type HostServer,
  type HostServerDeps
} from './server.js';
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
  hub: AttachHub;
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
  const hub = new AttachHub(broker.ops);
  const rpc = new Map([...brokerRpcChannels(broker.ops, hub.owners), ...extraRpc]);
  const host = createHostServer({
    workspace: () => WS,
    auth: () => auth,
    lease: () => lease,
    healthy: () => true,
    hub,
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
    hub,
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
  it('/healthz carries mesh only when the host requires it, and only ready is healthy', async () => {
    let mesh: 'checking' | 'ready' | 'missing' = 'checking';
    const r = await start([], { mesh: () => mesh, healthy: () => mesh === 'ready' });
    let res = await fetch(`${r.url}/healthz`);
    expect([res.status, await res.json()]).toEqual([503, { status: 'unhealthy', lease: 'holder', db: 'none', mesh: 'checking' }]);
    mesh = 'missing';
    res = await fetch(`${r.url}/healthz`);
    expect([res.status, await res.json()]).toEqual([503, { status: 'unhealthy', lease: 'holder', db: 'none', mesh: 'missing' }]);
    mesh = 'ready';
    expect(await (await fetch(`${r.url}/healthz`)).json()).toEqual({ status: 'ok', lease: 'holder', db: 'none', mesh: 'ready' });
  });

  it('/healthz reports lease state without a token, holder or standby', async () => {
    const r = await start();
    expect(await (await fetch(`${r.url}/healthz`)).json()).toEqual({ status: 'ok', lease: 'holder', db: 'none' });
    r.setLease('standby');
    const res = await fetch(`${r.url}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', lease: 'standby', db: 'none' });
    expect(r.verify).not.toHaveBeenCalled();
  });

  it('/healthz reports the host db, and a down db makes the pod unready', async () => {
    let db: 'ok' | 'down' = 'ok';
    const r = await start([], { db: () => db, healthy: () => db === 'ok' });
    expect(await (await fetch(`${r.url}/healthz`)).json()).toEqual({ status: 'ok', lease: 'holder', db: 'ok' });
    db = 'down';
    const res = await fetch(`${r.url}/healthz`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'unhealthy', lease: 'holder', db: 'down' });
  });

  it('while starting, /healthz is 503 and every authenticated route and upgrade is 503 host starting with Retry-After', async () => {
    let starting = true;
    const r = await start([], { starting: () => starting, db: () => (starting ? 'connecting' : 'ok') });
    r.setLease('standby');
    const h = await fetch(`${r.url}/healthz`);
    expect(h.status).toBe(503);
    expect(await h.json()).toEqual({ status: 'starting', lease: 'standby', db: 'connecting' });
    for (const res of [
      await fetch(`${r.url}/whoami`, { headers: bearer(`${TOKEN}x`) }),
      await fetch(`${r.url}/rpc/sessions:list`, { method: 'POST', headers: bearer(`${TOKEN}x`), body: '[]' })
    ]) {
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('5');
      expect(await res.json()).toEqual({ error: 'host starting' });
    }
    await expect(openWs(r, '/events', `${TOKEN}x`)).rejects.toThrow(/HTTP 503/);
    expect(r.verify).not.toHaveBeenCalled();
    starting = false;
    r.setLease('holder');
    expect((await fetch(`${r.url}/whoami`, { headers: bearer(`${TOKEN}x`) })).status).toBe(200);
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
    expect(await rpc(r, 'ports:list', [], `${TOKEN}r`)).toEqual({ status: 200, body: { ok: true, result: [{ port: 3000, session: 's1' }] } });
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

describe('verify limits (cache first, then global caps on misses)', () => {
  const get = (r: Rig, token?: string, xff?: string) =>
    fetch(`${r.url}/whoami`, { headers: { ...(token ? bearer(token) : {}), ...(xff ? { 'X-Forwarded-For': xff } : {}) } });
  const whoami = async (r: Rig, token?: string, xff?: string) => (await get(r, token, xff)).status;

  it('serves a cached-valid token and 401s a cached-rejected one while the rejection budget is spent', async () => {
    const r = await start([], { verifyLimits: { unauthPerMinute: 2 } });
    expect(await whoami(r, `${TOKEN}r`)).toBe(200);
    expect(await whoami(r, 'ghp_bad1')).toBe(401);
    expect(await whoami(r, 'ghp_bad2')).toBe(401);
    const limited = await get(r, 'ghp_bad3');
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    const calls = vi.mocked(r.verify).mock.calls.length;
    expect(await whoami(r, `${TOKEN}r`)).toBe(200);
    expect(await whoami(r, 'ghp_bad1')).toBe(401);
    expect(await whoami(r, `${TOKEN}s`)).toBe(429);
    await expect(openWs(r, '/attach', `${TOKEN}x`)).rejects.toThrow('HTTP 429');
    expect(vi.mocked(r.verify).mock.calls.length).toBe(calls);
  });

  it('missing or malformed tokens get 401 with WWW-Authenticate and spend no budget', async () => {
    const r = await start([], { verifyLimits: { unauthPerMinute: 1 } });
    for (let i = 0; i < 5; i++) {
      const res = await get(r);
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer');
      expect((await fetch(`${r.url}/whoami`, { headers: { Authorization: 'Bearer a b' } })).status).toBe(401);
    }
    expect(await whoami(r, 'ghp_bad1')).toBe(401);
    expect(await whoami(r, 'ghp_bad2')).toBe(429);
    expect(r.verify).toHaveBeenCalledTimes(1);
  });

  it('503s with Retry-After 1 past the in-flight verify cap, still serving cached tokens', async () => {
    const r = await start([], { verifyLimits: { maxInFlight: 1 } });
    expect(await whoami(r, `${TOKEN}r`)).toBe(200);
    let release!: () => void;
    const held = new Promise<void>((res) => (release = res));
    vi.mocked(r.verify).mockImplementationOnce(async () => {
      await held;
      return TOKENS[`${TOKEN}s`];
    });
    const slow = whoami(r, `${TOKEN}s`);
    await vi.waitFor(() => expect(r.verify).toHaveBeenCalledTimes(2));
    const busy = await get(r, `${TOKEN}x`);
    expect(busy.status).toBe(503);
    expect(busy.headers.get('retry-after')).toBe('1');
    expect(await whoami(r, `${TOKEN}r`)).toBe(200);
    release();
    expect(await slow).toBe(200);
    expect(await whoami(r, `${TOKEN}x`)).toBe(200);
  });

  it('keys an extra per-address limit on X-Forwarded-For only with trusted hops', async () => {
    const r = await start([], { verifyLimits: { perAddress: { max: 1, windowMs: 60_000, maxIps: 10 } }, trustedProxyHops: () => 1 });
    expect(await whoami(r, 'ghp_bad1', 'a, 203.0.113.1')).toBe(401);
    expect(await whoami(r, 'ghp_bad2', 'b, 203.0.113.1')).toBe(429);
    expect(await whoami(r, `${TOKEN}x`, 'a, 203.0.113.2')).toBe(200);
    await r.host.close();
    const plain = await start([], { verifyLimits: { perAddress: { max: 1, windowMs: 60_000, maxIps: 10 } } });
    expect(await whoami(plain, 'ghp_bad1')).toBe(401);
    expect(await whoami(plain, 'ghp_bad2')).toBe(401);
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

const UPGRADE_HEADERS = () =>
  `Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n`;

/** First response line for a raw request target that fetch/ws would normalise away. */
function rawHttp(r: Rig, target: string, upgrade = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect(Number(new URL(r.url).port), '127.0.0.1');
    let got = '';
    sock.on('data', (d) => (got += d.toString('latin1')));
    sock.on('error', reject);
    sock.on('close', () => resolve(got.split('\r\n')[0]));
    sock.write(`GET ${target} HTTP/1.1\r\nHost: x\r\n${upgrade ? UPGRADE_HEADERS() : 'Connection: close\r\n'}\r\n`);
  });
}

/** A WebSocket client that never answers a close frame; `halfOpen` also keeps its side open after the server ends. */
function rawUpgrade(r: Rig, path: string, token: string, halfOpen = false): Promise<{ sock: Socket; data: Buffer[]; ended: Promise<void> }> {
  return new Promise((resolve, reject) => {
    const sock = connect({ port: Number(new URL(r.url).port), host: '127.0.0.1', allowHalfOpen: halfOpen });
    const data: Buffer[] = [];
    const ended = new Promise<void>((res) => sock.once('close', () => res()));
    let head = '';
    sock.on('error', () => undefined);
    sock.on('data', (d: Buffer) => {
      if (head.includes('\r\n\r\n')) return void data.push(d);
      head += d.toString('latin1');
      if (!head.includes('\r\n\r\n')) return;
      if (head.startsWith('HTTP/1.1 101')) resolve({ sock, data, ended });
      else reject(new Error(head.split('\r\n')[0]));
    });
    sock.write(`GET ${path} HTTP/1.1\r\nHost: x\r\n${UPGRADE_HEADERS()}Authorization: Bearer ${token}\r\n\r\n`);
  });
}

function wsFrame(payload: Buffer): Buffer {
  const mask = randomBytes(4);
  const head = payload.length < 126 ? Buffer.from([0x82, 0x80 | payload.length]) : Buffer.from([0x82, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([head, mask, Buffer.from(payload.map((b, i) => b ^ mask[i % 4]))]);
}

const revokeAll = (r: Rig) => r.setAuth(provider(async () => { throw new IdentityError('unauthorized', 'revoked', 401); }));

describe('unparseable request targets', () => {
  it.each(['//', '//a:99999', '//%'])('%s answers 400 on HTTP and upgrade, and the server stays up', async (target) => {
    const r = await start();
    expect(await rawHttp(r, target)).toMatch(/^HTTP\/1.1 400/);
    expect(await rawHttp(r, target, true)).toMatch(/^HTTP\/1.1 400/);
    expect((await fetch(`${r.url}/healthz`)).status).toBe(200);
  });
});

describe('revocation drops frames at once', () => {
  it('a revoked /attach viewer that ignores the close frame sends nothing more and is terminated', async () => {
    const r = await start([], { closeGraceMs: 100 });
    const c = await rawUpgrade(r, '/attach', `${TOKEN}s`);
    c.sock.write(wsFrame(jsonFrame(FrameType.ATTACH, { id: 's1', channel: 1 })));
    await vi.waitFor(() => expect(c.data.length).toBeGreaterThan(0));
    c.sock.write(wsFrame(inputFrame(1, 'before')));
    await vi.waitFor(() => expect(r.broker.sessions.get('s1')!.inputs).toHaveLength(1));
    revokeAll(r);
    await r.host.reverifyAll();
    c.sock.write(wsFrame(inputFrame(1, 'after')));
    await c.ended;
    expect(r.broker.sessions.get('s1')!.inputs.map(String)).toEqual(['before']);
  });

  it('a revoked /events subscriber is unsubscribed before the close completes', async () => {
    const r = await start([], { closeGraceMs: 100 });
    const c = await rawUpgrade(r, '/events', `${TOKEN}r`);
    expect(r.events.size).toBe(1);
    revokeAll(r);
    await r.host.reverifyAll();
    expect(r.events.size).toBe(0);
    await c.ended;
  });
});

describe('re-verify during a GitHub outage', () => {
  it('keeps the socket within the cache window, then closes it as unverifiable', async () => {
    let t = 0;
    const r = await start([], { now: () => t });
    const ws = await openWs(r, '/events', `${TOKEN}r`);
    r.setAuth(provider(async () => { throw new IdentityError('network', 'ECONNRESET'); }));
    await r.host.reverifyAll();
    await new Promise((res) => setTimeout(res, 50));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(r.events.size).toBe(1);
    expect(r.logs.some((l) => l.includes('identity unverifiable'))).toBe(true);
    const done = closed(ws);
    t = VERIFY_TTL_MS + 1;
    await r.host.reverifyAll();
    expect(await done).toEqual([4401, 'identity unverifiable']);
  });
});

describe('shutdown', () => {
  it('close() detaches upstreams and terminates sockets that ignore the close frame', async () => {
    const r = await start([], { closeGraceMs: 100 });
    const c = await rawUpgrade(r, '/attach', `${TOKEN}r`);
    c.sock.write(wsFrame(jsonFrame(FrameType.ATTACH, { id: 's1', channel: 1 })));
    await vi.waitFor(() => expect(c.data.length).toBeGreaterThan(0));
    const shutdown = vi.spyOn(r.hub, 'shutdown');
    const t0 = Date.now();
    await r.host.close();
    expect(shutdown).toHaveBeenCalledTimes(1);
    rig = null;
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.broker.sessions.get('s1')!.detached).toBe(1);
    await c.ended;
  });
});

describe('connection limits', () => {
  it('caps concurrent sockets per identity with 429 + Retry-After', async () => {
    const r = await start([], { maxSocketsPerIdentity: 2 });
    const a = await openWs(r, '/events', `${TOKEN}r`);
    const b = await openWs(r, '/attach', `${TOKEN}r`);
    await expect(rawUpgrade(r, '/events', `${TOKEN}r`)).rejects.toThrow('HTTP/1.1 429');
    const other = await openWs(r, '/events', `${TOKEN}s`);
    const gone = closed(a);
    a.close();
    await gone;
    await vi.waitFor(async () => (await openWs(r, '/events', `${TOKEN}r`)).close());
    b.close();
    other.close();
  });

  it('sets explicit request and header timeouts, and keep-alive above the ALB and Envoy idle timeouts', async () => {
    const r = await start();
    expect([r.host.server.requestTimeout, r.host.server.headersTimeout]).toEqual([30_000, 10_000]);
    expect(r.host.server.keepAliveTimeout).toBe(65_000);
  });
});

describe('installCrashGuards', () => {
  it('logs every arrival redacted with its stack, and calls onFatal once', () => {
    const lines: string[] = [];
    const proc = new EventEmitter();
    const onFatal = vi.fn();
    const off = installCrashGuards(createLogger((l) => lines.push(l)), onFatal, proc);
    proc.emit('uncaughtException', new Error(`boom Bearer ${TOKEN}`));
    proc.emit('unhandledRejection', new Error('later'));
    expect(lines).toHaveLength(2);
    expect(lines.join('\n')).toContain('boom');
    expect(lines.join('\n')).not.toContain(TOKEN);
    const first = JSON.parse(lines[0]);
    expect(first).toMatchObject({ msg: 'uncaught exception', count: 1 });
    expect(first.error.stack).toContain('server.test.ts');
    expect(JSON.parse(lines[1])).toMatchObject({ msg: 'unhandled rejection', count: 2 });
    expect(onFatal).toHaveBeenCalledTimes(1);
    off();
    expect(proc.listenerCount('uncaughtException') + proc.listenerCount('unhandledRejection')).toBe(0);
  });
});

/** Close code of the first WebSocket close frame (opcode 8) in raw server bytes, or null. */
function closeCode(data: Buffer[]): number | null {
  const b = Buffer.concat(data);
  let i = 0;
  while (i + 2 <= b.length) {
    const op = b[i] & 0x0f;
    let len = b[i + 1] & 0x7f;
    let at = i + 2;
    if (len === 126) {
      len = b.readUInt16BE(at);
      at += 2;
    }
    if (op === 8) return len >= 2 ? b.readUInt16BE(at) : null;
    i = at + len;
  }
  return null;
}

describe('slow viewers (1013)', () => {
  it('an /attach viewer over the buffer limit is closed 1013, disposed and terminated', async () => {
    const r = await start([], { maxViewerBuffer: -1, closeGraceMs: 100 });
    const c = await rawUpgrade(r, '/attach', `${TOKEN}s`);
    c.sock.write(wsFrame(jsonFrame(FrameType.ATTACH, { id: 's1', channel: 1 })));
    await vi.waitFor(() => expect(closeCode(c.data)).toBe(1013));
    c.sock.write(wsFrame(inputFrame(1, 'after')));
    await c.ended;
    expect(r.broker.sessions.get('s1')!.inputs).toEqual([]);
    expect(r.hub.liveTaps).toBe(0);
  });

  it('an /events subscriber over the buffer limit is unsubscribed, closed 1013 and terminated', async () => {
    const r = await start([], { maxViewerBuffer: -1, closeGraceMs: 100 });
    const c = await rawUpgrade(r, '/events', `${TOKEN}r`);
    expect(r.events.size).toBe(1);
    r.events.publish('sessions:changed', { sessions: [] });
    expect(r.events.size).toBe(0);
    await c.ended;
    expect(closeCode(c.data)).toBe(1013);
  });
});

describe('halt', () => {
  it('revokes every socket at once without closing the listener', async () => {
    const r = await start([], { closeGraceMs: 100 });
    const c = await rawUpgrade(r, '/events', `${TOKEN}r`);
    r.host.halt(1001, 'host shutting down');
    expect(r.events.size).toBe(0);
    await c.ended;
    expect(closeCode(c.data)).toBe(1001);
    expect(r.host.server.listening).toBe(true);
  });

  it('answers 503 to authenticated routes and upgrades afterwards; probes still answer', async () => {
    const r = await start();
    r.host.halt(1001, 'host shutting down');
    const res = await fetch(`${r.url}/whoami`, { headers: bearer(`${TOKEN}r`) });
    expect([res.status, await res.json()]).toEqual([503, { error: 'shutting down' }]);
    await expect(rawUpgrade(r, '/events', `${TOKEN}r`)).rejects.toThrow('HTTP/1.1 503');
    expect(r.verify).not.toHaveBeenCalled();
    expect((await fetch(`${r.url}/healthz`)).status).toBe(200);
  });
});

describe('close bounds', () => {
  it('finishes even when hub.shutdown hangs', async () => {
    const r = await start([], { hubShutdownMs: 100 });
    vi.spyOn(r.hub, 'shutdown').mockReturnValue(new Promise(() => undefined));
    const t0 = Date.now();
    await r.host.close();
    rig = null;
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r.host.server.listening).toBe(false);
  });

  it('bounds hub.shutdown at 5 s by default', () => {
    expect(HUB_SHUTDOWN_MS).toBe(5_000);
  });
});

const realSleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('WebSocket keepalive', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('pings at most every 25 s by default', () => {
    expect(PING_MS).toBeLessThanOrEqual(25_000);
  });

  it('pings every open socket each interval and keeps one that answers', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const r = await start([], { pingMs: 25_000 });
    const ws = await openWs(r, '/events', `${TOKEN}r`);
    let pings = 0;
    ws.on('ping', () => pings++);
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(25_000);
      await realSleep(30);
    }
    expect(pings).toBe(4);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(r.events.size).toBe(1);
    ws.close();
  });

  it('terminates a socket that misses 2 pongs, and unsubscribes it', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const r = await start([], { pingMs: 25_000 });
    const c = await rawUpgrade(r, '/events', `${TOKEN}r`);
    let gone = false;
    void c.ended.then(() => (gone = true));
    await vi.advanceTimersByTimeAsync(25_000);
    await realSleep(30);
    expect(Buffer.concat(c.data)[0]).toBe(0x89);
    await vi.advanceTimersByTimeAsync(25_000);
    await realSleep(30);
    expect(gone).toBe(false);
    expect(r.events.size).toBe(1);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(r.events.size).toBe(0);
    await c.ended;
  });

  it('terminates a silent /attach viewer and detaches its upstream', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const r = await start([], { pingMs: 1_000 });
    const c = await rawUpgrade(r, '/attach', `${TOKEN}r`);
    c.sock.write(wsFrame(jsonFrame(FrameType.ATTACH, { id: 's1', channel: 1 })));
    await vi.waitFor(() => expect(r.hub.liveTaps).toBe(1));
    for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(1_000);
    await c.ended;
    await vi.waitFor(() => expect(r.broker.sessions.get('s1')!.detached).toBe(1));
  });
});

describe('WebSocket protocol errors', () => {
  const rsv1 = (payload: Buffer) => {
    const f = wsFrame(payload);
    f[0] |= 0x40;
    return f;
  };

  it.each(['/attach', '/events'])('%s: an oversize message or an RSV1 frame kills only that socket', async (path) => {
    const fatal = vi.fn();
    const off = installCrashGuards(createLogger(() => undefined), fatal);
    try {
      const r = await start();
      const ws = await openWs(r, path, `${TOKEN}s`);
      ws.on('error', () => undefined);
      const done = closed(ws);
      ws.send(Buffer.alloc(MAX_FRAME_PAYLOAD + 64));
      await done;
      // Half-open: only a server-side terminate (not ws's own close handshake) releases the socket at once.
      const c = await rawUpgrade(r, path, `${TOKEN}s`, true);
      if (path === '/attach') {
        c.sock.write(wsFrame(jsonFrame(FrameType.ATTACH, { id: 's1', channel: 1 })));
        await vi.waitFor(() => expect(r.hub.liveTaps).toBe(1));
      } else expect(r.events.size).toBe(1);
      const end = new Promise((res) => c.sock.once('end', res));
      c.sock.write(rsv1(inputFrame(1, 'x')));
      await end;
      await new Promise((res) => setTimeout(res, 50));
      expect(fatal).not.toHaveBeenCalled();
      expect((await fetch(`${r.url}/healthz`)).status).toBe(200);
      expect(r.logs.filter((l) => l.includes('"msg":"websocket error"'))).toHaveLength(2);
      expect(r.events.size).toBe(0);
      expect(r.hub.liveTaps).toBe(0);
      c.sock.destroy();
    } finally {
      off();
    }
  });
});

describe('socket slots across aborted upgrades', () => {
  it('a client reset during a slow verify releases its slot', async () => {
    const r = await start();
    for (let i = 0; i < MAX_SOCKETS_PER_IDENTITY; i++) {
      let release!: () => void;
      const held = new Promise<void>((res) => (release = res));
      const verify = vi.fn(async () => {
        await held;
        return TOKENS[`${TOKEN}r`];
      });
      r.setAuth(provider(verify));
      const sock = connect(Number(new URL(r.url).port), '127.0.0.1');
      sock.on('error', () => undefined);
      await new Promise((res) => sock.once('connect', res));
      sock.write(`GET /events HTTP/1.1\r\nHost: x\r\n${UPGRADE_HEADERS()}Authorization: Bearer ${TOKEN}r\r\n\r\n`);
      await vi.waitFor(() => expect(verify).toHaveBeenCalled());
      sock.resetAndDestroy();
      await new Promise((res) => setTimeout(res, 30));
      release();
      await new Promise((res) => setTimeout(res, 30));
    }
    const ws = await openWs(r, '/events', `${TOKEN}r`);
    ws.close();
  });
});

describe('known-good tokens and the rejection budget', () => {
  const whoami = async (r: Rig, token: string) => (await fetch(`${r.url}/whoami`, { headers: bearer(token) })).status;

  it('serves a token verified OK earlier, past its cache entry, while the budget is spent', async () => {
    const r = await start([], { verifyLimits: { unauthPerMinute: 1 } });
    expect(await whoami(r, `${TOKEN}r`)).toBe(200);
    r.setAuth(provider(r.verify));
    expect(await whoami(r, 'ghp_bad1')).toBe(401);
    expect(await whoami(r, 'ghp_bad2')).toBe(429);
    expect(await whoami(r, `${TOKEN}s`)).toBe(429);
    expect(await whoami(r, `${TOKEN}r`)).toBe(200);
    expect(vi.mocked(r.verify).mock.calls.filter(([t]) => t === `${TOKEN}r`)).toHaveLength(2);
  });

  it('drops the exemption once GitHub rejects the token, and after 24 h', async () => {
    let t = 0;
    const r = await start([], { verifyLimits: { unauthPerMinute: 1 }, now: () => t });
    expect(await whoami(r, `${TOKEN}r`)).toBe(200);
    expect(await whoami(r, `${TOKEN}s`)).toBe(200);
    r.setAuth(provider(async () => { throw new IdentityError('unauthorized', 'revoked', 401); }));
    expect(await whoami(r, `${TOKEN}r`)).toBe(401);
    r.setAuth(provider(r.verify));
    expect(await whoami(r, `${TOKEN}r`)).toBe(429);
    t = KNOWN_GOOD_TTL_MS + 1;
    r.setAuth(provider(r.verify));
    expect(await whoami(r, 'ghp_bad1')).toBe(401);
    expect(await whoami(r, `${TOKEN}s`)).toBe(429);
  });

  it('still applies the in-flight cap to a known-good token', async () => {
    const r = await start([], { verifyLimits: { maxInFlight: 1 } });
    expect(await whoami(r, `${TOKEN}r`)).toBe(200);
    r.setAuth(provider(r.verify));
    let release!: () => void;
    const held = new Promise<void>((res) => (release = res));
    vi.mocked(r.verify).mockImplementationOnce(async () => {
      await held;
      return TOKENS[`${TOKEN}s`];
    });
    const slow = whoami(r, `${TOKEN}s`);
    await vi.waitFor(() => expect(r.verify).toHaveBeenCalledTimes(2));
    expect(await whoami(r, `${TOKEN}r`)).toBe(503);
    release();
    expect(await slow).toBe(200);
  });

  it.each(['forbidden', 'machine-unknown'] as const)('a %s refusal spends the budget', async (kind) => {
    const r = await start([], { verifyLimits: { unauthPerMinute: 2 } });
    r.setAuth(provider(async () => { throw new IdentityError(kind, 'refused'); }));
    expect(await whoami(r, 'ghp_m1')).toBe(403);
    expect(await whoami(r, 'ghp_m2')).toBe(403);
    expect(await whoami(r, 'ghp_m3')).toBe(429);
  });

  it('a grant-less identity and an upstream failure spend the budget; a network error does not', async () => {
    const r = await start([], { verifyLimits: { unauthPerMinute: 2 } });
    r.setAuth(provider(async () => { throw new IdentityError('network', 'ECONNRESET'); }));
    for (let i = 0; i < 3; i++) expect(await whoami(r, `ghp_n${i}`)).toBe(503);
    r.setAuth(provider(r.verify));
    expect(await whoami(r, `${TOKEN}n`)).toBe(403);
    r.setAuth(provider(async () => { throw new IdentityError('upstream', 'GitHub 500'); }));
    expect(await whoami(r, 'ghp_u1')).toBe(502);
    expect(await whoami(r, 'ghp_u2')).toBe(429);
  });
});

describe('rpc limits', () => {
  it('caps the body at 64 KiB', () => {
    expect(MAX_RPC_BODY).toBe(64 * 1024);
  });

  it('caps concurrent /rpc per identity at 8 with 429, other identities unaffected', async () => {
    let release!: () => void;
    const held = new Promise<void>((res) => (release = res));
    const r = await start([['slow:op', { tier: 'read', handle: async () => { await held; return 1; } }]]);
    const pending = Array.from({ length: MAX_RPC_PER_IDENTITY }, () => rpc(r, 'slow:op', [], `${TOKEN}r`));
    await vi.waitFor(async () => expect((await rpc(r, 'slow:op', [], `${TOKEN}r`)).status).toBe(429));
    const res = await fetch(`${r.url}/rpc/ports:list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...bearer(`${TOKEN}r`) },
      body: '{"args":[]}'
    });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('1');
    expect((await rpc(r, 'ports:list', [], `${TOKEN}s`)).status).toBe(200);
    release();
    expect((await Promise.all(pending)).map((p) => p.status)).toEqual(Array(MAX_RPC_PER_IDENTITY).fill(200));
    expect((await rpc(r, 'ports:list', [], `${TOKEN}r`)).status).toBe(200);
  });
});
