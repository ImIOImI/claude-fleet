// Two fleet-host processes' worth of runHost on one schema. db.ts is a module
// singleton, so only one holder may have its stores open at a time.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { connect, createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import * as db from '../main/db.js';
import { IdentityError, type IdentityProvider } from '../main/identity/types.js';
import { isPg, testPgSchema, type TestPg } from '../main/store/testStore.js';
import { runHost, type RunHostOptions } from './main.js';
import { fakeBroker, person, TOKEN } from './testFakes.js';

const ID = '01JC0000000000000000000000';
const verify: IdentityProvider['verify'] = async (t) => {
  if (t !== TOKEN) throw new IdentityError('unauthorized', 'bad credentials', 401);
  return person('owner', 1, ['acme/platform']);
};

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

describe.skipIf(!isPg)('runHost on Postgres', () => {
  let t: TestPg | null = null;
  const hosts: Awaited<ReturnType<typeof runHost>>[] = [];
  afterEach(async () => {
    for (const h of hosts.splice(0)) await h.shutdown(0);
    await t?.drop();
    t = null;
  });

  async function start(opts: Partial<RunHostOptions> = {}) {
    t ??= await testPgSchema();
    const dir = mkdtempSync(join(tmpdir(), 'fh-pg-'));
    const cfgPath = join(dir, 'config.yaml');
    const dbBlock = JSON.stringify({ connectionString: process.env.PG_TEST_URL, schema: t.schema, poolMax: 2 });
    writeFileSync(cfgPath, `workspace: { id: ${ID}, name: smoke }\ngrants:\n  - { team: acme/platform, tier: session }\ndb: ${dbBlock}\n`);
    const port = await freePort();
    const exit = vi.fn();
    const logs: string[] = [];
    const host = await runHost({
      env: { FLEET_HOST_PORT: String(port), FLEET_HOST_CONFIG: cfgPath, FLEET_HOST_STATE: join(dir, 'state'), CLAUDE_FLEET_BROKER_SOCKET: join(dir, 'b.sock') },
      exit, proc: new EventEmitter(), logSink: (l) => logs.push(l), authFactory: () => ({ id: 'github', verify }),
      brokerOps: fakeBroker([]).ops, leaseRenewMs: 200, leaseTtlMs: 10_000,
      ...opts
    });
    hosts.push(host);
    return { url: `http://127.0.0.1:${port}`, host, exit, logs };
  }
  const leader = async (url: string) => (await fetch(`${url}/leader`)).status;
  const storesOpen = () => vi.waitFor(() => expect(() => db.stateKysely()).not.toThrow(), { timeout: 10_000 });

  it('one holder and one ready standby; the standby takes over after the holder stops', async () => {
    const a = await start();
    await vi.waitFor(async () => expect(await leader(a.url)).toBe(200), { timeout: 10_000 });
    await storesOpen();
    const b = await start();
    expect(await leader(b.url)).toBe(503);
    await vi.waitFor(async () => expect(await (await fetch(`${b.url}/healthz`)).json()).toEqual({ status: 'ok', lease: 'standby', db: 'ok' }), { timeout: 10_000 });
    await a.host.shutdown(0);
    await vi.waitFor(async () => expect(await leader(b.url)).toBe(200), { timeout: 5_000 });
    await storesOpen();
    const row = await t!.pool.query(`SELECT holder, epoch FROM ${t!.schema}.host_lease`);
    expect(row.rows[0].epoch).toBe(2);
    await db.recordUsageEvent({ workspaceId: ID, sessionId: null, kind: 'resumed' });
  }, 30_000);

  it('a stale holder’s store write fails and the process exits 1', async () => {
    const a = await start({ leaseRenewMs: 10_000, leaseTtlMs: 30_000 });
    await vi.waitFor(async () => expect(await leader(a.url)).toBe(200), { timeout: 10_000 });
    await storesOpen();
    await db.recordUsageEvent({ workspaceId: ID, sessionId: null, kind: 'resumed' });
    await t!.pool.query(`UPDATE ${t!.schema}.host_lease SET holder = 'intruder', epoch = epoch + 1, expires_at = clock_timestamp() + interval '1 minute'`);
    await expect(db.recordUsageEvent({ workspaceId: ID, sessionId: null, kind: 'resumed' })).rejects.toThrow(/lease lost/);
    await vi.waitFor(() => expect(a.exit).toHaveBeenCalledWith(1));
    expect(a.logs.join('\n')).toMatch(/write fenced off/);
  }, 30_000);
});

/** A TCP front for the test server's Unix socket that refuses connections until opened. */
async function gatedProxy(): Promise<{ url: string; open(): void; close(): Promise<void> }> {
  const u = new URL(process.env.PG_TEST_URL!);
  const sock = join(u.searchParams.get('host')!, `.s.PGSQL.${u.searchParams.get('port') || u.port || '5432'}`);
  let open = false;
  const conns = new Set<Socket>();
  const srv: Server = createServer((c) => {
    if (!open) return c.destroy();
    const up = connect(sock);
    conns.add(c).add(up);
    c.pipe(up).pipe(c);
    const done = () => { c.destroy(); up.destroy(); };
    c.on('error', done).on('close', done);
    up.on('error', done).on('close', done);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const { port } = srv.address() as AddressInfo;
  return {
    url: `postgres://${u.username}@127.0.0.1:${port}${u.pathname}`,
    open: () => (open = true),
    close: async () => {
      for (const c of conns) c.destroy();
      await new Promise<void>((r) => srv.close(() => r()));
    }
  };
}

describe.skipIf(!isPg)('runHost on Postgres: start and stop', () => {
  let t: TestPg | null = null;
  afterEach(async () => {
    vi.restoreAllMocks();
    await t?.drop();
    t = null;
  });

  async function boot(dbUrl: string, extra: Partial<RunHostOptions> = {}) {
    t ??= await testPgSchema();
    const dir = mkdtempSync(join(tmpdir(), 'fh-pg-'));
    const cfgPath = join(dir, 'config.yaml');
    writeFileSync(cfgPath, `workspace: { id: ${ID}, name: smoke }\ngrants:\n  - { team: acme/platform, tier: session }\ndb: ${JSON.stringify({ connectionString: dbUrl, schema: t.schema, poolMax: 2 })}\n`);
    const port = await freePort();
    const exit = vi.fn();
    const proc = new EventEmitter();
    const logs: string[] = [];
    const host = await runHost({
      env: { FLEET_HOST_PORT: String(port), FLEET_HOST_CONFIG: cfgPath, FLEET_HOST_STATE: join(dir, 'state'), CLAUDE_FLEET_BROKER_SOCKET: join(dir, 'b.sock') },
      exit, proc, logSink: (l) => logs.push(l), authFactory: () => ({ id: 'github', verify }),
      brokerOps: fakeBroker([]).ops, leaseRenewMs: 200, leaseTtlMs: 10_000, ...extra
    });
    return { url: `http://127.0.0.1:${port}`, host, exit, proc, logs };
  }
  const whoami = (url: string) => fetch(`${url}/whoami`, { headers: { Authorization: `Bearer ${TOKEN}` } });

  it('listens before the db is reachable, then turns ready and serves once it is', async () => {
    const proxy = await gatedProxy();
    try {
      const a = await boot(proxy.url);
      const h = await fetch(`${a.url}/healthz`);
      expect(h.status).toBe(503);
      expect(await h.json()).toEqual({ status: 'starting', lease: 'standby', db: 'connecting' });
      expect((await whoami(a.url)).status).toBe(503);
      await vi.waitFor(() => expect(a.logs.join('\n')).toMatch(/host db unavailable; retrying/));
      proxy.open();
      await vi.waitFor(async () => expect(await (await fetch(`${a.url}/healthz`)).json()).toEqual({ status: 'ok', lease: 'holder', db: 'ok' }), { timeout: 10_000 });
      expect((await whoami(a.url)).status).toBe(200);
      await a.host.shutdown(0);
      expect(a.exit).toHaveBeenCalledWith(0);
    } finally {
      await proxy.close();
    }
  }, 30_000);

  it('SIGTERM shutdown is bounded when the pools never finish ending', async () => {
    const a = await boot(process.env.PG_TEST_URL!, { storeCloseMs: 300 });
    await vi.waitFor(async () => expect((await fetch(`${a.url}/leader`)).status).toBe(200), { timeout: 10_000 });
    await vi.waitFor(() => expect(() => db.stateKysely()).not.toThrow(), { timeout: 10_000 });
    const hung: pg.Pool[] = [];
    const realEnd = pg.Pool.prototype.end;
    vi.spyOn(pg.Pool.prototype, 'end').mockImplementation(function (this: pg.Pool) {
      hung.push(this);
      return new Promise<void>(() => undefined);
    });
    const t0 = Date.now();
    a.proc.emit('SIGTERM');
    await vi.waitFor(() => expect(a.exit).toHaveBeenCalledWith(0), { timeout: 10_000 });
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(hung.length).toBe(2);
    expect(a.logs.join('\n')).toMatch(/store close timed out/);
    vi.restoreAllMocks();
    for (const p of hung) await (realEnd as (this: pg.Pool) => Promise<void>).call(p).catch(() => undefined);
  }, 30_000);
});
