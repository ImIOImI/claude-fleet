import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { IdentityError, type IdentityProvider } from '../main/identity/types.js';
import { memoryLeaseStore, type LeaseStore } from './lease.js';
import { isDbUnavailable, runHost, type RunHostOptions } from './main.js';
import { fakeBroker, person, TOKEN } from './testFakes.js';

const ID_A = '01JC0000000000000000000000';
const ID_B = '01JC0000000000000000000001';
const CONFIG = `workspace: { id: ${ID_A}, name: smoke }\ngrants:\n  - { team: acme/platform, tier: session }\n`;

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

const verify: IdentityProvider['verify'] = async (t) => {
  if (t !== TOKEN) throw new IdentityError('unauthorized', 'bad credentials', 401);
  return person('owner', 1, ['acme/platform']);
};

interface Rig {
  url: string;
  cfgPath: string;
  proc: EventEmitter;
  exit: ReturnType<typeof vi.fn>;
  logs: string[];
  store: LeaseStore;
  broker: ReturnType<typeof fakeBroker>;
  host: Awaited<ReturnType<typeof runHost>>;
}

let rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs) {
    await r.host.shutdown(0);
    await new Promise<void>((res) => (r.host.server.listening ? r.host.server.close(() => res()) : res()));
  }
  rigs = [];
});

async function start(config = CONFIG, opts: Partial<RunHostOptions> = {}): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'fh-main-'));
  const cfgPath = join(dir, 'config.yaml');
  writeFileSync(cfgPath, config);
  const port = await freePort();
  const proc = new EventEmitter();
  const exit = vi.fn();
  const logs: string[] = [];
  const store = opts.leaseStore ?? memoryLeaseStore();
  const broker = fakeBroker(['s1']);
  const host = await runHost({
    env: { FLEET_HOST_PORT: String(port), FLEET_HOST_CONFIG: cfgPath, FLEET_HOST_STATE: join(dir, 'state'), CLAUDE_FLEET_BROKER_SOCKET: join(dir, 'b.sock') },
    leaseStore: store,
    exit,
    proc,
    logSink: (l) => logs.push(l),
    authFactory: () => ({ id: 'github', verify }),
    brokerOps: broker.ops,
    ...opts
  });
  const r = { url: `http://127.0.0.1:${port}`, cfgPath, proc, exit, logs, store, broker, host };
  rigs.push(r);
  await vi.waitFor(async () => expect((await fetch(`${r.url}/leader`)).status).toBe(200));
  return r;
}

const whoami = async (r: Rig) => {
  const res = await fetch(`${r.url}/whoami`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  return { status: res.status, body: (await res.json()) as { workspace?: { id: string; name: string } } };
};

function openEvents(r: Rig): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${r.url.replace('http', 'ws')}/events`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

const msgs = (r: Rig) => r.logs.map((l) => JSON.parse(l) as { msg: string; [k: string]: unknown });

describe('runHost', () => {
  it('serves App tokens on the credential socket when github.appId, installationId and keyFile are set', async () => {
    const { startFakeGithubApp } = await import('./testGithubApp.js');
    const { requestToken } = await import('./credCli.js');
    const gh = await startFakeGithubApp({ appId: '9', installationId: '8', account: 'acme', repos: ['a', 'b'] });
    const dir = mkdtempSync(join(tmpdir(), 'fh-cred-'));
    writeFileSync(join(dir, 'key.pem'), gh.privatePem, { mode: 0o400 });
    const sock = join(dir, 'run', 'cred.sock');
    const port = await freePort();
    const cfgPath = join(dir, 'config.yaml');
    writeFileSync(cfgPath, CONFIG + `github: { appId: 9, installationId: 8, keyFile: ${join(dir, 'key.pem')}, repositories: [a] }\n`);
    const logs: string[] = [];
    const host = await runHost({
      env: {
        FLEET_HOST_PORT: String(port), FLEET_HOST_CONFIG: cfgPath, FLEET_HOST_STATE: join(dir, 'state'), CLAUDE_FLEET_BROKER_SOCKET: join(dir, 'b.sock'),
        FLEET_HOST_CRED_SOCKET: sock
      },
      exit: vi.fn(), proc: new EventEmitter(), logSink: (l) => logs.push(l), authFactory: () => ({ id: 'github', verify }),
      brokerOps: fakeBroker([]).ops, githubApiBase: gh.url
    });
    try {
      const token = await requestToken(sock, { repositories: ['a'] });
      expect(token).toMatch(/^ghs_fake/);
      await expect(requestToken(sock, { repositories: ['b'] })).rejects.toThrow(/403/);
      expect(logs.join('\n')).not.toContain(token);
    } finally {
      await host.shutdown(0);
      await gh.close();
    }
  });

  async function firstPruneFailure(env: Record<string, string>, dir: string): Promise<string | undefined> {
    const cfgPath = join(dir, 'config.yaml');
    writeFileSync(cfgPath, CONFIG);
    const logs: string[] = [];
    const host = await runHost({
      env: { FLEET_HOST_PORT: String(await freePort()), FLEET_HOST_CONFIG: cfgPath, FLEET_HOST_STATE: join(dir, 'state'), ...env },
      leaseStore: memoryLeaseStore(), exit: vi.fn(), proc: new EventEmitter(), logSink: (l) => logs.push(l),
      authFactory: () => ({ id: 'github', verify }), ownerPruneMs: 20
    });
    try {
      const failures = () => logs.map((l) => JSON.parse(l) as { msg: string; error?: string }).filter((m) => m.msg === 'owner prune failed');
      await vi.waitFor(() => expect(failures().length).toBeGreaterThan(0), { timeout: 5000 });
      return failures()[0].error;
    } finally {
      await host.shutdown(0);
      await new Promise<void>((r) => (host.server.listening ? host.server.close(() => r()) : r()));
    }
  }

  it('dials the broker at CLAUDE_FLEET_BROKER_ADDR instead of the socket', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fh-broker-addr-'));
    const brokerPort = await freePort();
    const err = await firstPruneFailure({ CLAUDE_FLEET_BROKER_SOCKET: join(dir, 'b.sock'), CLAUDE_FLEET_BROKER_ADDR: `127.0.0.1:${brokerPort}` }, dir);
    expect(err).toContain(`127.0.0.1:${brokerPort}`);
  });

  it('dials the broker socket when CLAUDE_FLEET_BROKER_ADDR is unset', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fh-broker-sock-'));
    expect(await firstPruneFailure({ CLAUDE_FLEET_BROKER_SOCKET: join(dir, 'b.sock') }, dir)).toContain(join(dir, 'b.sock'));
  });

  it('serves App tokens on FLEET_HOST_CRED_TCP_PORT instead of the socket', async () => {
    const { startFakeGithubApp } = await import('./testGithubApp.js');
    const { requestToken } = await import('./credCli.js');
    const gh = await startFakeGithubApp({ appId: '9', installationId: '8', account: 'acme', repos: ['a'] });
    const dir = mkdtempSync(join(tmpdir(), 'fh-cred-tcp-'));
    writeFileSync(join(dir, 'key.pem'), gh.privatePem, { mode: 0o400 });
    const cfgPath = join(dir, 'config.yaml');
    writeFileSync(cfgPath, CONFIG + `github: { appId: 9, installationId: 8, keyFile: ${join(dir, 'key.pem')} }\n`);
    const probe = createHttpServer((_q, r) => r.end('ok'));
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
    const probeUrl = `http://127.0.0.1:${(probe.address() as AddressInfo).port}/healthz/ready`;
    const [port, credPort] = [await freePort(), await freePort()];
    const host = await runHost({
      env: {
        FLEET_HOST_PORT: String(port), FLEET_HOST_CONFIG: cfgPath, FLEET_HOST_STATE: join(dir, 'state'), CLAUDE_FLEET_BROKER_SOCKET: join(dir, 'b.sock'),
        FLEET_HOST_CRED_SOCKET: join(dir, 'run', 'cred.sock'), FLEET_HOST_CRED_TCP_PORT: String(credPort),
        FLEET_HOST_REQUIRE_MESH: '1', FLEET_MESH_READY_URL: probeUrl
      },
      exit: vi.fn(), proc: new EventEmitter(), logSink: () => undefined, authFactory: () => ({ id: 'github', verify }),
      brokerOps: fakeBroker([]).ops, githubApiBase: gh.url
    });
    try {
      expect(await requestToken({ host: '127.0.0.1', port: credPort }, { repositories: ['a'] })).toMatch(/^ghs_fake/);
      expect(existsSync(join(dir, 'run', 'cred.sock'))).toBe(false);
    } finally {
      await host.shutdown(0);
      await gh.close();
      probe.close();
    }
  });

  it('aborts startup when the :8080 listen fails; a pending credential server never opens afterwards', async () => {
    const { startFakeGithubApp } = await import('./testGithubApp.js');
    const { requestToken } = await import('./credCli.js');
    const gh = await startFakeGithubApp({ appId: '9', installationId: '8', account: 'acme', repos: ['a'] });
    const dir = mkdtempSync(join(tmpdir(), 'fh-listen-fail-'));
    writeFileSync(join(dir, 'key.pem'), gh.privatePem, { mode: 0o400 });
    const cfgPath = join(dir, 'config.yaml');
    writeFileSync(cfgPath, CONFIG + `github: { appId: 9, installationId: 8, keyFile: ${join(dir, 'key.pem')} }\n`);
    // Slow to answer: the :8080 failure (near-instant) and its abort must land first.
    const probe = createHttpServer((_q, r) => void setTimeout(() => r.end('ok'), 300));
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
    const probeUrl = `http://127.0.0.1:${(probe.address() as AddressInfo).port}/healthz/ready`;
    const port = await freePort();
    const credPort = await freePort();
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(port, '0.0.0.0', () => r()));
    try {
      await expect(runHost({
        env: {
          FLEET_HOST_PORT: String(port), FLEET_HOST_CONFIG: cfgPath, FLEET_HOST_STATE: join(dir, 'state'), CLAUDE_FLEET_BROKER_SOCKET: join(dir, 'b.sock'),
          FLEET_HOST_CRED_TCP_PORT: String(credPort), FLEET_HOST_REQUIRE_MESH: '1', FLEET_MESH_READY_URL: probeUrl
        },
        exit: vi.fn(), proc: new EventEmitter(), logSink: () => undefined, authFactory: () => ({ id: 'github', verify }),
        brokerOps: fakeBroker([]).ops, githubApiBase: gh.url
      })).rejects.toThrow(/EADDRINUSE/);
      await new Promise((r) => setTimeout(r, 500));
      await expect(requestToken({ host: '127.0.0.1', port: credPort }, { repositories: ['a'] })).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    } finally {
      blocker.close();
      probe.close();
      await gh.close();
    }
  });

  it('refuses FLEET_HOST_CRED_TCP_PORT without FLEET_HOST_REQUIRE_MESH=1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fh-cred-tcp-refuse-'));
    const cfgPath = join(dir, 'config.yaml');
    writeFileSync(cfgPath, CONFIG);
    const [port, credPort] = [await freePort(), await freePort()];
    await expect(runHost({
      env: {
        FLEET_HOST_PORT: String(port), FLEET_HOST_CONFIG: cfgPath, FLEET_HOST_STATE: join(dir, 'state'), CLAUDE_FLEET_BROKER_SOCKET: join(dir, 'b.sock'),
        FLEET_HOST_CRED_TCP_PORT: String(credPort)
      },
      exit: vi.fn(), proc: new EventEmitter(), logSink: () => undefined, authFactory: () => ({ id: 'github', verify }), brokerOps: fakeBroker([]).ops
    })).rejects.toThrow('FLEET_HOST_CRED_TCP_PORT and FLEET_HOST_MCP_TCP_PORT need FLEET_HOST_REQUIRE_MESH=1');
  });

  it('refuses FLEET_HOST_MCP_TCP_PORT without FLEET_HOST_REQUIRE_MESH=1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fh-mcp-tcp-refuse-'));
    const cfgPath = join(dir, 'config.yaml');
    writeFileSync(cfgPath, CONFIG);
    const [port, mcpPort] = [await freePort(), await freePort()];
    await expect(runHost({
      env: {
        FLEET_HOST_PORT: String(port), FLEET_HOST_CONFIG: cfgPath, FLEET_HOST_STATE: join(dir, 'state'), CLAUDE_FLEET_BROKER_SOCKET: join(dir, 'b.sock'),
        FLEET_HOST_MCP_TCP_PORT: String(mcpPort), FLEET_HOST_MCP_ADDR: `127.0.0.1:${mcpPort}`
      },
      exit: vi.fn(), proc: new EventEmitter(), logSink: () => undefined, authFactory: () => ({ id: 'github', verify }), brokerOps: fakeBroker([]).ops
    })).rejects.toThrow('FLEET_HOST_CRED_TCP_PORT and FLEET_HOST_MCP_TCP_PORT need FLEET_HOST_REQUIRE_MESH=1');
  });

  it('refuses FLEET_HOST_MCP_TCP_PORT and FLEET_HOST_MCP_ADDR set alone (D86, moved from readHostEnv)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fh-mcp-together-'));
    const cfgPath = join(dir, 'config.yaml');
    writeFileSync(cfgPath, CONFIG);
    const [port, mcpPort] = [await freePort(), await freePort()];
    await expect(runHost({
      env: {
        FLEET_HOST_PORT: String(port), FLEET_HOST_CONFIG: cfgPath, FLEET_HOST_STATE: join(dir, 'state'), CLAUDE_FLEET_BROKER_SOCKET: join(dir, 'b.sock'),
        FLEET_HOST_MCP_TCP_PORT: String(mcpPort), FLEET_HOST_REQUIRE_MESH: '1'
      },
      exit: vi.fn(), proc: new EventEmitter(), logSink: () => undefined, authFactory: () => ({ id: 'github', verify }), brokerOps: fakeBroker([]).ops
    })).rejects.toThrow('FLEET_HOST_MCP_TCP_PORT and FLEET_HOST_MCP_ADDR are set together');
  });

  it('serves the configured workspace id after one start load', async () => {
    const r = await start();
    expect(await whoami(r)).toMatchObject({ status: 200, body: { workspace: { id: ID_A, name: 'smoke' } } });
    expect(msgs(r).filter((m) => m.msg === 'config reloaded')).toEqual([expect.objectContaining({ reason: 'start' })]);
  });

  it('reports a minted id when the config has none', async () => {
    const r = await start('workspace: { name: smoke }\ngrants:\n  - { team: acme/platform, tier: session }\n');
    const id = (await whoami(r)).body.workspace?.id;
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('refuses to start on an invalid config', async () => {
    await expect(start('workspace: {}\n')).rejects.toThrow(/host config rejected/);
  });

  it('applies a SIGHUP reload: a removed grant closes open sockets with 4403', async () => {
    const r = await start();
    const ws = await openEvents(r);
    const closed = new Promise<number>((res) => ws.once('close', (c) => res(c)));
    writeFileSync(r.cfgPath, `workspace: { id: ${ID_A}, name: renamed }\n`);
    r.proc.emit('SIGHUP');
    expect(await closed).toBe(4403);
    expect((await whoami(r)).status).toBe(403);
  });

  it('refuses a reload that changes workspace.id and keeps serving the old config', async () => {
    const r = await start();
    writeFileSync(r.cfgPath, CONFIG.replace(ID_A, ID_B).replace('smoke', 'renamed'));
    r.proc.emit('SIGHUP');
    await vi.waitFor(() => expect(msgs(r).some((m) => m.msg.startsWith('config reload rejected'))).toBe(true));
    expect((await whoami(r)).body.workspace).toMatchObject({ id: ID_A, name: 'smoke' });
  });

  it('warns when trustedProxyHops is above 0', async () => {
    const r = await start(CONFIG + 'trustedProxyHops: 1\n');
    expect(
      msgs(r).some((m) => m.level === 'warn' && m.msg.includes('trustedProxyHops') && m.msg.includes('per-address limiting keys on the Twingate connector here; leave 0'))
    ).toBe(true);
    const quiet = await start();
    expect(msgs(quiet).some((m) => m.msg.includes('trustedProxyHops'))).toBe(false);
  });

  it('prunes dead session owners on its own timer with no /events subscriber', async () => {
    const r = await start(CONFIG, { ownerPruneMs: 30 });
    const list = vi.spyOn(r.broker.ops, 'list');
    await vi.waitFor(() => expect(list).toHaveBeenCalled());
  });

  it('a standby never lists the broker', async () => {
    const taken: LeaseStore = { tryAcquire: async () => null, renew: async () => false, release: async () => undefined };
    const broker = fakeBroker();
    const list = vi.spyOn(broker.ops, 'list');
    const dir = mkdtempSync(join(tmpdir(), 'fh-main-'));
    writeFileSync(join(dir, 'c.yaml'), CONFIG);
    const host = await runHost({
      env: { FLEET_HOST_PORT: String(await freePort()), FLEET_HOST_CONFIG: join(dir, 'c.yaml'), FLEET_HOST_STATE: join(dir, 's') },
      leaseStore: taken,
      exit: vi.fn(),
      proc: new EventEmitter(),
      logSink: () => undefined,
      brokerOps: broker.ops,
      ownerPruneMs: 10
    });
    await new Promise((res) => setTimeout(res, 100));
    await host.shutdown(0);
    expect(list).not.toHaveBeenCalled();
  });
});

describe('SIGHUP', () => {
  it('is handled from the first tick of startup and through shutdown', async () => {
    const proc = new EventEmitter();
    const dir = mkdtempSync(join(tmpdir(), 'fh-main-'));
    writeFileSync(join(dir, 'c.yaml'), CONFIG);
    const pending = runHost({
      env: { FLEET_HOST_PORT: String(await freePort()), FLEET_HOST_CONFIG: join(dir, 'c.yaml'), FLEET_HOST_STATE: join(dir, 's') },
      exit: vi.fn(),
      proc,
      logSink: () => undefined,
      brokerOps: fakeBroker().ops
    });
    expect(proc.listenerCount('SIGHUP')).toBe(1);
    proc.emit('SIGHUP');
    const host = await pending;
    await host.shutdown(0);
    expect(proc.listenerCount('SIGHUP')).toBe(1);
    proc.emit('SIGHUP');
  });
});

describe('SIGTERM', () => {
  it('revokes sockets, then releases the lease, then finishes close, then exits 0', async () => {
    const order: string[] = [];
    const inner = memoryLeaseStore();
    let r!: Rig;
    let ws!: WebSocket;
    const store: LeaseStore = {
      tryAcquire: inner.tryAcquire,
      renew: inner.renew,
      async release(h, e) {
        order.push(`release:${r.host.server.listening ? 'listening' : 'closed'}`);
        await new Promise((res) => setTimeout(res, 150));
        await inner.release(h, e);
        order.push('released');
      }
    };
    r = await start(CONFIG, { leaseStore: store });
    ws = await openEvents(r);
    ws.once('close', (code) => order.push(`ws-close:${code}`));
    r.exit.mockImplementation((code: number) => order.push(`exit:${code}:${r.host.server.listening ? 'listening' : 'closed'}`));
    r.proc.emit('SIGTERM');
    await vi.waitFor(() => expect(r.exit).toHaveBeenCalled(), { timeout: 5000 });
    expect(order).toEqual(['release:listening', 'ws-close:1001', 'released', 'exit:0:closed']);
    expect(await inner.tryAcquire('other', Date.now(), 30_000)).not.toBeNull();
  });
});

describe('crash guard', () => {
  it('an uncaught exception releases the lease (bounded) and exits 1 without draining', async () => {
    const inner = memoryLeaseStore();
    const r = await start(CONFIG, { leaseStore: inner });
    r.proc.emit('uncaughtException', new Error(`boom Bearer ${TOKEN}`));
    r.proc.emit('unhandledRejection', new Error('second'));
    await vi.waitFor(() => expect(r.exit).toHaveBeenCalledWith(1));
    expect(r.exit).toHaveBeenCalledTimes(1);
    expect(r.host.server.listening).toBe(true);
    expect(await inner.tryAcquire('other', Date.now(), 30_000)).not.toBeNull();
    expect(msgs(r).filter((m) => m.level === 'error' && /uncaught|unhandled/.test(m.msg))).toHaveLength(2);
    expect(r.logs.join('\n')).not.toContain(TOKEN);
  });

  it('revokes sockets and refuses new requests before the bounded lease release', async () => {
    const order: string[] = [];
    const inner = memoryLeaseStore();
    let r!: Rig;
    const store: LeaseStore = {
      tryAcquire: inner.tryAcquire,
      renew: inner.renew,
      async release(h, e) {
        const res = await fetch(`${r.url}/whoami`, { headers: { Authorization: `Bearer ${TOKEN}` } });
        order.push(`whoami:${res.status}`);
        await new Promise((done) => setTimeout(done, 150));
        await inner.release(h, e);
        order.push('released');
      }
    };
    r = await start(CONFIG, { leaseStore: store });
    const ws = await openEvents(r);
    ws.once('close', (code) => order.push(`ws-close:${code}`));
    r.proc.emit('uncaughtException', new Error('boom'));
    await vi.waitFor(() => expect(r.exit).toHaveBeenCalledWith(1));
    expect(order.at(-1)).toBe('released');
    expect(order.slice(0, -1).sort()).toEqual(['whoami:503', 'ws-close:1011']);
  });

  it('exits 1 even when releasing the lease hangs', async () => {
    const inner = memoryLeaseStore();
    const store: LeaseStore = { tryAcquire: inner.tryAcquire, renew: inner.renew, release: () => new Promise(() => undefined) };
    const r = await start(CONFIG, { leaseStore: store, fatalStopMs: 50 });
    r.proc.emit('uncaughtException', new Error('boom'));
    await vi.waitFor(() => expect(r.exit).toHaveBeenCalledWith(1), { timeout: 1000 });
  });
});

describe('broker polling', () => {
  it('skips a tick while the previous poll is still in flight', async () => {
    const broker = fakeBroker(['s1']);
    let calls = 0;
    broker.ops.list = () => {
      calls++;
      return new Promise(() => undefined);
    };
    const r = await start(CONFIG, { brokerOps: broker.ops, brokerPollMs: 10 });
    const ws = await openEvents(r);
    await vi.waitFor(() => expect(calls).toBe(1));
    await new Promise((res) => setTimeout(res, 100));
    expect(calls).toBe(1);
    ws.close();
  });
});

describe('runHost with db: listen first', () => {
  it('accepts at once while the db is unreachable: /healthz 503 connecting, routes 503 host starting; SIGTERM still exits promptly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fh-main-'));
    const cfgPath = join(dir, 'config.yaml');
    const dead = await freePort();
    writeFileSync(cfgPath, `${CONFIG}db: { connectionString: "postgres://u@127.0.0.1:${dead}/fleet" }\n`);
    const port = await freePort();
    const proc = new EventEmitter();
    const exit = vi.fn();
    const logs: string[] = [];
    const host = await runHost({
      env: { FLEET_HOST_PORT: String(port), FLEET_HOST_CONFIG: cfgPath, FLEET_HOST_STATE: join(dir, 'state'), CLAUDE_FLEET_BROKER_SOCKET: join(dir, 'b.sock') },
      exit, proc, logSink: (l) => logs.push(l), authFactory: () => ({ id: 'github', verify }), brokerOps: fakeBroker([]).ops
    });
    const url = `http://127.0.0.1:${port}`;
    const h = await fetch(`${url}/healthz`);
    expect(h.status).toBe(503);
    expect(await h.json()).toEqual({ status: 'starting', lease: 'standby', db: 'connecting' });
    const w = await fetch(`${url}/whoami`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(w.status).toBe(503);
    expect(w.headers.get('retry-after')).toBe('5');
    expect(await w.json()).toEqual({ error: 'host starting' });
    await vi.waitFor(() => expect(logs.join('\n')).toMatch(/host db unavailable; retrying/));
    const t0 = Date.now();
    proc.emit('SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(host.server.listening).toBe(false);
    expect(logs.join('\n')).not.toMatch(/lease acquired/);
  });

  it('an invalid db block still fails at start, before listening', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fh-main-'));
    const cfgPath = join(dir, 'config.yaml');
    writeFileSync(cfgPath, `${CONFIG}db: { env: FLEET_DB_UNSET }\n`);
    await expect(runHost({
      env: { FLEET_HOST_PORT: String(await freePort()), FLEET_HOST_CONFIG: cfgPath, FLEET_HOST_STATE: join(dir, 'state'), CLAUDE_FLEET_BROKER_SOCKET: join(dir, 'b.sock') },
      exit: vi.fn(), proc: new EventEmitter(), logSink: () => undefined, authFactory: () => ({ id: 'github', verify }), brokerOps: fakeBroker([]).ops
    })).rejects.toThrow(/FLEET_DB_UNSET is not set/);
  });
});

describe('isDbUnavailable', () => {
  it('is true for connection-level failures only', () => {
    const e = (code: string, message = 'x') => Object.assign(new Error(message), { code });
    for (const err of [e('ECONNREFUSED'), e('ETIMEDOUT'), e('08006'), e('57P01'), new Error('Connection terminated unexpectedly'), new Error('timeout exceeded when trying to connect'), new Error('Client has encountered a connection error and is not queryable')]) {
      expect(isDbUnavailable(err)).toBe(true);
    }
    for (const err of [e('42P01'), e('28P01'), new Error('pgvector is not installed'), new TypeError('x is undefined'), new Error('Client was closed and is not queryable'), null]) {
      expect(isDbUnavailable(err)).toBe(false);
    }
  });
});

describe('runHost behind the mesh check', () => {
  const open: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of open.splice(0)) await c();
  });

  async function meshRig(status: number | null | (() => number), keyFile?: string, meshWaitMs = 300) {
    const { startFakeGithubApp } = await import('./testGithubApp.js');
    const gh = await startFakeGithubApp({ appId: '9', installationId: '8', account: 'acme', repos: ['a'] });
    let probe: HttpServer | null = null;
    let probeUrl = `http://127.0.0.1:${await freePort()}/healthz/ready`;
    if (status !== null) {
      probe = createHttpServer((_q, r) => { r.statusCode = typeof status === 'number' ? status : status(); r.end(); });
      await new Promise<void>((r) => probe!.listen(0, '127.0.0.1', () => r()));
      probeUrl = `http://127.0.0.1:${(probe.address() as AddressInfo).port}/healthz/ready`;
    }
    const dir = mkdtempSync(join(tmpdir(), 'fh-mesh-'));
    writeFileSync(join(dir, 'key.pem'), gh.privatePem, { mode: 0o400 });
    const cfgPath = join(dir, 'config.yaml');
    writeFileSync(cfgPath, CONFIG + `github: { appId: 9, installationId: 8, keyFile: ${keyFile ?? join(dir, 'key.pem')} }\n`);
    const [port, credPort] = [await freePort(), await freePort()];
    const logs: string[] = [];
    const exit = vi.fn();
    const host = await runHost({
      env: {
        FLEET_HOST_PORT: String(port), FLEET_HOST_CONFIG: cfgPath, FLEET_HOST_STATE: join(dir, 'state'), CLAUDE_FLEET_BROKER_SOCKET: join(dir, 'b.sock'),
        FLEET_HOST_CRED_TCP_PORT: String(credPort), FLEET_HOST_REQUIRE_MESH: '1', FLEET_MESH_READY_URL: probeUrl
      },
      exit, proc: new EventEmitter(), logSink: (l) => logs.push(l), authFactory: () => ({ id: 'github', verify }),
      brokerOps: fakeBroker([]).ops, githubApiBase: gh.url, meshWaitMs
    });
    open.push(async () => {
      await host.shutdown(0);
      probe?.close();
      await gh.close();
    });
    return { url: `http://127.0.0.1:${port}`, cred: { host: '127.0.0.1', port: credPort }, logs, exit };
  }

  it('opens the credential port once the sidecar is ready, and /healthz says mesh ready', async () => {
    const { requestToken } = await import('./credCli.js');
    const r = await meshRig(200);
    await vi.waitFor(async () => expect(await (await fetch(`${r.url}/healthz`)).json()).toEqual({ status: 'ok', lease: 'holder', db: 'none', mesh: 'ready' }));
    await vi.waitFor(async () => expect(await requestToken(r.cred, { repositories: ['a'] })).toMatch(/^ghs_fake/));
  });

  it('keeps the credential port closed while checking', async () => {
    const { requestToken } = await import('./credCli.js');
    let ready = false;
    const r = await meshRig(() => (ready ? 200 : 503), undefined, 10_000);
    const res = await fetch(`${r.url}/healthz`);
    expect([res.status, await res.json()]).toEqual([503, { status: 'unhealthy', lease: 'holder', db: 'none', mesh: 'checking' }]);
    await expect(requestToken(r.cred, { repositories: ['a'] })).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    ready = true;
    await vi.waitFor(async () => expect(await requestToken(r.cred, { repositories: ['a'] })).toMatch(/^ghs_fake/), { timeout: 5_000 });
  });

  it('exits 1 when the credential server fails to start after the check', async () => {
    const r = await meshRig(200, join(tmpdir(), 'fh-mesh-no-such-key.pem'));
    await vi.waitFor(() => expect(r.exit).toHaveBeenCalledWith(1));
    expect(r.logs.map((l) => JSON.parse(l) as { level: string; msg: string })).toContainEqual(expect.objectContaining({
      level: 'error', msg: 'credential server start failed; exiting'
    }));
  });

  for (const [what, status] of [['answers 503', 503], ['is absent', null]] as const) {
    it(`keeps the credential port closed and is unready with mesh missing when the sidecar ${what}`, async () => {
      const { requestToken } = await import('./credCli.js');
      const r = await meshRig(status);
      await vi.waitFor(async () => {
        const res = await fetch(`${r.url}/healthz`);
        expect([res.status, await res.json()]).toEqual([503, { status: 'unhealthy', lease: 'holder', db: 'none', mesh: 'missing' }]);
      });
      await expect(requestToken(r.cred, { repositories: ['a'] })).rejects.toMatchObject({ code: 'ECONNREFUSED' });
      expect(r.logs.map((l) => JSON.parse(l) as { level: string; msg: string })).toContainEqual(expect.objectContaining({
        level: 'error', msg: 'no Istio sidecar: credential and MCP ports stay closed; broker connections are plaintext and a STRICT peer will refuse them'
      }));
    });
  }
});
