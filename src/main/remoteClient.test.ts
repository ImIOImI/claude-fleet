import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { person, TOKEN } from '../host/testFakes.js';
import { startTestHost, TEST_WORKSPACE_ID } from '../host/testHost.js';
import { makeScrubber } from './publish/scrub.js';
import type { PublishRoute } from '../host/publishRoute.js';
import { MAX_RPC_BODY, MAX_SMALL_BODY, oneLine, reconnectDelay, RemoteClient, RemoteError, type RemoteDisconnect, type RemoteEvent } from './remoteClient.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function rig(pingMs?: number) {
  const h = await startTestHost({ tokens: { [TOKEN]: person('alice', 1, ['acme/eng']) }, grants: [{ team: 'acme/eng', tier: 'read' }], pingMs });
  cleanups.push(h.close);
  return { ...h, client: (t: string | null) => new RemoteClient({ url: h.url, token: async () => t }) };
}

/** A bare HTTP server; `upgrade` handles WebSocket handshakes when given. */
async function rawServer(
  onRequest: (req: IncomingMessage, res: ServerResponse) => void,
  onUpgrade?: (req: IncomingMessage, socket: Duplex, head: Buffer) => void
): Promise<{ url: string; srv: Server }> {
  const srv = createServer(onRequest);
  if (onUpgrade) srv.on('upgrade', onUpgrade);
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', () => ok()));
  cleanups.push(() => new Promise<void>((ok) => (srv.closeAllConnections(), srv.close(() => ok()))));
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, srv };
}

/** Records reconnect delays instead of waiting them out; `fire()` runs the pending one. */
function manualSchedule() {
  const delays: number[] = [];
  let pending: (() => void) | null = null;
  return {
    delays,
    schedule: (fn: () => void, ms: number) => {
      delays.push(ms);
      pending = fn;
      return () => (pending = null);
    },
    fire: () => {
      const f = pending;
      pending = null;
      f?.();
    }
  };
}

describe('RemoteClient', () => {
  it('healthz needs no token; whoami returns workspace and tier', async () => {
    const r = await rig();
    expect(await r.client(null).healthz()).toEqual({ status: 'ok', lease: 'holder' });
    expect(await r.client(TOKEN).whoami()).toMatchObject({ workspace: { id: TEST_WORKSPACE_ID, name: 'review-bot' }, user: { login: 'alice' }, tier: 'read' });
  });

  it('rpc returns the result, and refuses a channel above the tier', async () => {
    const r = await rig();
    expect(await r.client(TOKEN).rpc('sessions:live', [])).toEqual([]);
    await expect(r.client(TOKEN).rpc('ports:kill', [3000])).rejects.toMatchObject({ kind: 'forbidden' });
  });

  it('classifies failures, never echoing the token', async () => {
    const r = await rig();
    await expect(r.client(null).whoami()).rejects.toMatchObject({ kind: 'not-signed-in' });
    const bad = 'ghp_' + 'z'.repeat(36);
    const err = (await r.client(bad).whoami().catch((e: unknown) => e)) as RemoteError;
    expect(err.kind).toBe('unauthorized');
    expect(err.message).not.toContain('zzzz');
    r.setLease('standby');
    await expect(r.client(TOKEN).whoami()).rejects.toMatchObject({ kind: 'standby' });
    await expect(new RemoteClient({ url: 'http://127.0.0.1:1', token: async () => TOKEN }).healthz()).rejects.toMatchObject({ kind: 'unreachable' });
  });

  it('redacts the token from an error body a hostile host echoes back', async () => {
    const { url } = await rawServer((req, res) => {
      const t = String(req.headers.authorization).slice('Bearer '.length);
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `no grant for ${t}` }));
    });
    const err = (await new RemoteClient({ url, token: async () => TOKEN }).whoami().catch((e: unknown) => e)) as RemoteError;
    expect(err.kind).toBe('forbidden');
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).toContain('[redacted]');
  });

  it('refuses a malformed token without sending it', async () => {
    const seen: unknown[] = [];
    const { url } = await rawServer((req, res) => (seen.push(req.headers.authorization), res.end('{}')));
    await expect(new RemoteClient({ url, token: async () => 'bad token\r\nX: y' }).whoami()).rejects.toMatchObject({ kind: 'not-signed-in' });
    expect(seen).toEqual([]);
  });

  async function whoamiServing(body: unknown) {
    const { url } = await rawServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    return new RemoteClient({ url, token: async () => TOKEN }).whoami();
  }
  const WHO = (workspace: Record<string, unknown>, user: Record<string, unknown> = {}) => ({
    workspace: { id: TEST_WORKSPACE_ID, name: 'x', description: null, color: null, ...workspace },
    user: { provider: 'github', kind: 'user', login: 'a', id: 1, name: null, avatarUrl: null, ...user },
    tier: 'read'
  });

  it.each(['../../evil', 'CON', 'nul', 'a'.repeat(64), '01JC000000000000000000000', '01JC0000000000000000000000X', '01JC000000000000000000000I', '01jc0000000000000000000000'])(
    'refuses a /whoami workspace id that is not a ULID: %s',
    async (id) => {
      await expect(whoamiServing(WHO({ id }))).rejects.toMatchObject({ kind: 'protocol' });
    }
  );

  it('sanitises /whoami display fields', async () => {
    const who = await whoamiServing(WHO({ name: `ev\u0007il${'n'.repeat(100)}`, description: `d\r\n${'d'.repeat(600)}` }, { avatarUrl: 'http://x/a.png' }));
    expect(who.workspace.id).toBe(TEST_WORKSPACE_ID);
    expect(who.workspace.name).toHaveLength(64);
    expect(who.workspace.name).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(who.workspace.description!.length).toBeLessThanOrEqual(500);
    expect(who.workspace.description).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(who.user.avatarUrl).toBeNull();
    expect((await whoamiServing(WHO({}, { avatarUrl: 'https://x/a.png' }))).user.avatarUrl).toBe('https://x/a.png');
    expect((await whoamiServing(WHO({}, { avatarUrl: 'javascript:alert(1)' }))).user.avatarUrl).toBeNull();
  });

  it.each([' alice ', 'a-b', 'renovate[bot]', 'A'.repeat(39)])('accepts the GitHub login %j', async (login) => {
    expect((await whoamiServing(WHO({}, { login }))).user.login).toBe(login.trim());
  });

  it.each(['', 'al ice', 'al\u202eice', 'a/b', '<b>', 'a'.repeat(40), 'x[bot][bot]', 'a\u0007b'])('refuses the /whoami login %j', async (login) => {
    await expect(whoamiServing(WHO({}, { login }))).rejects.toMatchObject({ kind: 'protocol' });
  });

  it('oneLine strips bidi and other format characters', () => {
    expect(oneLine('ev\u202eil\u200b\u2066x\u00ad\ufeff', 64)).toBe('ev il x');
  });

  it('redacts a token that straddles the 200-character cut', async () => {
    const { url } = await rawServer((req, res) => {
      const t = String(req.headers.authorization).slice('Bearer '.length);
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `${'x'.repeat(190)}${t} tail` }));
    });
    const err = (await new RemoteClient({ url, token: async () => TOKEN }).whoami().catch((e: unknown) => e)) as RemoteError;
    expect(err.message).not.toContain(TOKEN.slice(0, 8));
    expect(err.message).toContain('[redacted]');
  });

  it('redacts other secret shapes the host echoes', async () => {
    const other = 'ghp_' + 'Q'.repeat(36);
    const { url } = await rawServer((_req, res) => {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `leaked ${other}` }));
    });
    const err = (await new RemoteClient({ url, token: async () => TOKEN }).whoami().catch((e: unknown) => e)) as RemoteError;
    expect(err.message).not.toContain('QQQQ');
  });

  it('carries Retry-After from 429 and 503', async () => {
    const { url } = await rawServer((req, res) => {
      res.writeHead(req.url === '/whoami' ? 429 : 503, { 'Content-Type': 'application/json', 'Retry-After': req.url === '/whoami' ? '7' : '2' });
      res.end(JSON.stringify({ error: 'busy' }));
    });
    const c = new RemoteClient({ url, token: async () => TOKEN });
    await expect(c.whoami()).rejects.toMatchObject({ kind: 'unreachable', status: 429, retryAfterMs: 7000 });
    await expect(c.rpc('sessions:live', [])).rejects.toMatchObject({ status: 503, retryAfterMs: 2000 });
  });

  it('maps 503 search unavailable to disabled; any other 503 stays unreachable', async () => {
    const { url } = await rawServer((req, res) => {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(req.url === '/rpc/history%3Asearch' ? { ok: false, error: 'search unavailable' } : { error: 'history unavailable' }));
    });
    const c = new RemoteClient({ url, token: async () => TOKEN });
    await expect(c.rpc('history:search', [])).rejects.toMatchObject({ kind: 'disabled', status: 503 });
    await expect(c.rpc('history:sessions', [])).rejects.toMatchObject({ kind: 'unreachable', status: 503 });
  });

  it('maps a 400 model mismatch to model; any other 400 stays protocol', async () => {
    const { url } = await rawServer((req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: req.url === '/rpc/history%3Asearch' ? 'model mismatch: host uses other@q8' : 'bad args' }));
    });
    const c = new RemoteClient({ url, token: async () => TOKEN });
    await expect(c.rpc('history:search', [])).rejects.toMatchObject({ kind: 'model', status: 400 });
    await expect(c.rpc('history:sessions', [])).rejects.toMatchObject({ kind: 'protocol', status: 400 });
  });

  it('a 400 search unavailable is not disabled', async () => {
    const { url } = await rawServer((_req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'search unavailable' }));
    });
    await expect(new RemoteClient({ url, token: async () => TOKEN }).rpc('history:search', [])).rejects.toMatchObject({ kind: 'protocol', status: 400 });
  });

  /** Streams 64 KB chunks until the client goes away; resolves `aborted` when it does. */
  async function endless(status: number, headers: Record<string, string> = {}) {
    let aborted!: () => void;
    const gone = new Promise<void>((ok) => (aborted = ok));
    const chunk = Buffer.alloc(64 * 1024, 0x20);
    const { url } = await rawServer((_req, res) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.write('{"error":"');
      const pump = (): void => {
        while (!res.destroyed && res.write(chunk));
        if (!res.destroyed) res.once('drain', pump);
      };
      res.on('close', aborted);
      pump();
    });
    return { client: new RemoteClient({ url, token: async () => TOKEN }), gone };
  }

  it.each([
    ['healthz', (c: RemoteClient) => c.healthz()],
    ['whoami', (c: RemoteClient) => c.whoami()],
    ['rpc', (c: RemoteClient) => c.rpc('sessions:live', [])]
  ] as const)('%s aborts a reply that never ends', async (_name, call) => {
    const { client, gone } = await endless(200);
    await expect(call(client)).rejects.toMatchObject({ kind: 'protocol', message: expect.stringMatching(/too large/) });
    await gone;
  });

  it('aborts an error body that never ends and still classifies the status', async () => {
    const { client, gone } = await endless(503, { 'Retry-After': '3' });
    await expect(client.whoami()).rejects.toMatchObject({ kind: 'unreachable', status: 503, retryAfterMs: 3000 });
    await gone;
  });

  it('refuses a declared content-length over the cap without reading it', async () => {
    let wrote = 0;
    const { url } = await rawServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(MAX_SMALL_BODY + 1) });
      res.write('{');
      wrote++;
    });
    await expect(new RemoteClient({ url, token: async () => TOKEN }).healthz()).rejects.toMatchObject({ message: expect.stringMatching(/too large/) });
    expect(wrote).toBe(1);
  });

  it('caps healthz at 64 KB and rpc at 2 MB', async () => {
    const pad = (n: number) => JSON.stringify({ status: 'ok', lease: 'holder', ok: true, result: [], pad: 'p'.repeat(n) });
    let size = 0;
    const { url } = await rawServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(pad(size));
    });
    const c = new RemoteClient({ url, token: async () => TOKEN });
    size = MAX_SMALL_BODY - 200;
    await expect(c.healthz()).resolves.toMatchObject({ status: 'ok' });
    size = MAX_SMALL_BODY + 1;
    await expect(c.healthz()).rejects.toMatchObject({ message: expect.stringMatching(/too large/) });
    await expect(c.rpc('x', [])).resolves.toEqual([]);
    size = MAX_RPC_BODY + 1;
    await expect(c.rpc('x', [])).rejects.toMatchObject({ message: expect.stringMatching(/too large/) });
  });

  it('rpc honours a per-call timeout', async () => {
    const { url } = await rawServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result: 1 }));
      }, 200);
    });
    const err = (await new RemoteClient({ url, token: async () => TOKEN }).rpc('x', [], { timeoutMs: 50 }).catch((e: unknown) => e)) as RemoteError;
    expect(err).toBeInstanceOf(RemoteError);
    expect(err.kind).toBe('unreachable');
    expect(err.message).toContain('timed out');
  });

  it('never follows a redirect with the token', async () => {
    const seen: Array<string | undefined> = [];
    const { url } = await rawServer((req, res) => {
      seen.push(req.headers.authorization);
      res.writeHead(302, { Location: '/elsewhere' });
      res.end();
    });
    await expect(new RemoteClient({ url, token: async () => TOKEN }).whoami()).rejects.toMatchObject({ kind: 'unreachable' });
    expect(seen).toHaveLength(1);
  });

  it('never follows a WebSocket upgrade redirect with the token', async () => {
    const seen: Array<string | undefined> = [];
    const { url } = await rawServer(
      (req, res) => (seen.push(req.headers.authorization), res.end()),
      (req, socket) => {
        seen.push(req.headers.authorization);
        socket.end('HTTP/1.1 302 Found\r\nLocation: /elsewhere\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      }
    );
    await expect(new RemoteClient({ url, token: async () => TOKEN }).openSocket('/events')).rejects.toBeInstanceOf(RemoteError);
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toHaveLength(1);
  });

  it('keeps the host it was built for when the options object is mutated', async () => {
    const r = await rig();
    const hits: string[] = [];
    const { url: evil } = await rawServer((req, res) => (hits.push(String(req.headers.authorization)), res.end('{}')));
    const opts = { url: r.url, token: async () => TOKEN };
    const c = new RemoteClient(opts);
    opts.url = evil;
    expect(await c.whoami()).toMatchObject({ user: { login: 'alice' } });
    expect(c.url).toBe(r.url);
    expect(hits).toEqual([]);
  });

  it('canonicalises the URL and refuses one with credentials', () => {
    expect(new RemoteClient({ url: 'HTTP://Host:8080/', token: async () => null }).url).toBe('http://host:8080');
    expect(() => new RemoteClient({ url: 'http://u:p@host', token: async () => null })).toThrow();
  });

  it('answers host pings so an idle socket stays open', async () => {
    const r = await rig(40);
    const ws = await r.client(TOKEN).openSocket('/events');
    let closed = false;
    ws.on('close', () => (closed = true));
    await new Promise((res) => setTimeout(res, 300));
    expect(closed).toBe(false);
    ws.close();
  });

  it('subscribe delivers pushed events and reconnects after a drop', async () => {
    const r = await rig();
    const got: RemoteEvent[] = [];
    const states: boolean[] = [];
    const s = manualSchedule();
    const c = new RemoteClient({ url: r.url, token: async () => TOKEN, schedule: s.schedule });
    const off = c.subscribe((e) => got.push(e), (up) => states.push(up));
    cleanups.push(off);
    await expect.poll(() => states[0]).toBe(true);
    r.events.publish('sessions:changed', { sessions: [] });
    await expect.poll(() => got).toEqual([{ channel: 'sessions:changed', payload: { sessions: [] } }]);
    r.host.halt(1011, 'restarting');
    await expect.poll(() => states).toEqual([true, false]);
    expect(s.delays).toHaveLength(1);
    expect(s.delays[0]).toBeGreaterThanOrEqual(1000);
  });

  it('subscribe honours Retry-After and never retries faster than the backoff floor', async () => {
    let upgrades = 0;
    const { url } = await rawServer(
      (_req, res) => res.end(),
      (_req, socket) => {
        upgrades++;
        socket.end('HTTP/1.1 429 Too Many Requests\r\nRetry-After: 9\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      }
    );
    const s = manualSchedule();
    const whys: Array<RemoteDisconnect | undefined> = [];
    const off = new RemoteClient({ url, token: async () => TOKEN, schedule: s.schedule }).subscribe(
      () => undefined,
      (_up, why) => whys.push(why)
    );
    cleanups.push(off);
    await expect.poll(() => s.delays.length).toBe(1);
    expect(s.delays[0]).toBe(9000);
    expect(whys[0]).toMatchObject({ kind: 'unreachable', status: 429, retryInMs: 9000 });
    s.fire();
    await expect.poll(() => s.delays.length).toBe(2);
    expect(upgrades).toBe(2);
    expect(Math.min(...s.delays)).toBeGreaterThanOrEqual(1000);
  });

  it.each([
    [4401, 'unauthorized'],
    [4403, 'forbidden'],
    [1013, 'dropped'],
    [1008, 'dropped'],
    [1001, 'unreachable']
  ] as const)('subscribe treats close code %i as %s', async (code, kind) => {
    const wss = new WebSocketServer({ noServer: true });
    const { url } = await rawServer(
      (_req, res) => res.end(),
      (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => setTimeout(() => ws.close(code, 'x'), 10))
    );
    cleanups.push(() => wss.close());
    const s = manualSchedule();
    const whys: Array<RemoteDisconnect | undefined> = [];
    const off = new RemoteClient({ url, token: async () => TOKEN, schedule: s.schedule }).subscribe(
      () => undefined,
      (up, why) => !up && whys.push(why)
    );
    cleanups.push(off);
    await expect.poll(() => whys.length).toBe(1);
    expect(whys[0]).toMatchObject({ kind, code });
    if (code === 4403) expect(s.delays).toEqual([]);
    else expect(s.delays).toEqual([whys[0]!.retryInMs]);
  });
});

describe('reconnectDelay', () => {
  it('backs off, honours Retry-After, stops on forbidden, and has a floor', () => {
    expect(reconnectDelay(0, { kind: 'dropped' })).toBe(1000);
    expect(reconnectDelay(10, { kind: 'dropped' })).toBe(30_000);
    expect(reconnectDelay(0, { kind: 'unreachable', retryAfterMs: 20_000 })).toBe(20_000);
    expect(reconnectDelay(0, { kind: 'unreachable', retryAfterMs: 0 })).toBe(1000);
    expect(reconnectDelay(0, { kind: 'unreachable', retryAfterMs: 99 * 60_000 })).toBe(10 * 60_000);
    expect(reconnectDelay(0, { kind: 'forbidden' })).toBeNull();
    expect(reconnectDelay(0, { kind: 'unauthorized' })).toBe(30_000);
    for (let a = 0; a < 20; a++) expect(reconnectDelay(a, { kind: 'dropped' })).toBeGreaterThanOrEqual(1000);
  });
});

describe('RemoteClient.publish', () => {
  const SRC = '01JC0000000000000000000005';
  const SID = '11111111-2222-4333-8444-555555555555';
  async function publishHost(route: Partial<PublishRoute>) {
    const seen: unknown[] = [];
    const h = await startTestHost({
      tokens: { [TOKEN]: person('alice', 1, ['acme/eng']) }, grants: [{ team: 'acme/eng', tier: 'read' }],
      publish: {
        admit: () => ({ ok: true, release: () => undefined }),
        post: async (c, b) => { seen.push([c.identity.login, b]); return { status: 200, body: { ok: true, accepted: 1, inserted: 1 } }; },
        ...route
      }
    });
    cleanups.push(h.close);
    const calls = { token: 0 };
    return { client: new RemoteClient({ url: h.url, token: async () => (calls.token++, TOKEN) }), seen, calls };
  }

  it('posts a scrubbed batch and returns the ack', async () => {
    const { client, seen } = await publishHost({});
    const line = makeScrubber([])('{"type":"user"}');
    expect(await client.publish({ sourceWorkspaceId: SRC, sessionId: SID, events: [line] })).toEqual({ ok: true, accepted: 1, inserted: 1 });
    expect(seen).toEqual([['alice', { sourceWorkspaceId: SRC, sessionId: SID, events: ['{"type":"user"}'] }]]);
  });

  it('refuses a batch over 1 MiB without sending it', async () => {
    const { client, seen, calls } = await publishHost({});
    const big = makeScrubber([])(JSON.stringify({ t: 'x'.repeat(1024 * 1024) }));
    await expect(client.publish({ sourceWorkspaceId: SRC, sessionId: SID, events: [big] })).rejects.toMatchObject({ kind: 'protocol', status: 413 });
    expect(seen).toEqual([]);
    expect(calls.token).toBe(0);
  });

  it('maps a 429 to unreachable with its Retry-After', async () => {
    const { client } = await publishHost({ admit: () => ({ ok: false, status: 429, error: 'publishing too fast', retryAfterSec: 3 }) });
    const line = makeScrubber([])('{"type":"user"}');
    await expect(client.publish({ sourceWorkspaceId: SRC, sessionId: SID, events: [line] })).rejects.toMatchObject({ kind: 'unreachable', status: 429, retryAfterMs: 3000 });
  });

  it('maps a 400 to a protocol error carrying the status, and a malformed ack to protocol', async () => {
    const bad = await publishHost({ post: async () => ({ status: 400, body: { error: 'events[0]: too deep' } }) });
    const line = makeScrubber([])('{"type":"user"}');
    await expect(bad.client.publish({ sourceWorkspaceId: SRC, sessionId: SID, events: [line] })).rejects.toMatchObject({ kind: 'protocol', status: 400 });
    const odd = await publishHost({ post: async () => ({ status: 200, body: { ok: true } }) });
    await expect(odd.client.publish({ sourceWorkspaceId: SRC, sessionId: SID, events: [line] })).rejects.toMatchObject({ kind: 'protocol' });
  });
});
