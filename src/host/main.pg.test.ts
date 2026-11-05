// Two fleet-host processes' worth of runHost on one schema. db.ts is a module
// singleton, so only one holder may have its stores open at a time.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
      brokerOps: fakeBroker([]).ops, leaseRenewMs: 200, leaseTtlMs: 1_000,
      ...opts
    });
    hosts.push(host);
    return { url: `http://127.0.0.1:${port}`, host, exit, logs };
  }
  const leader = async (url: string) => (await fetch(`${url}/leader`)).status;
  const storesOpen = () => vi.waitFor(() => expect(() => db.stateKysely()).not.toThrow(), { timeout: 10_000 });

  it('one holder and one ready standby; the standby takes over after the holder stops', async () => {
    const a = await start();
    await vi.waitFor(async () => expect(await leader(a.url)).toBe(200));
    await storesOpen();
    const b = await start();
    expect(await leader(b.url)).toBe(503);
    await vi.waitFor(async () => expect(await (await fetch(`${b.url}/healthz`)).json()).toEqual({ status: 'ok', lease: 'standby', db: 'ok' }));
    await a.host.shutdown(0);
    await vi.waitFor(async () => expect(await leader(b.url)).toBe(200), { timeout: 5_000 });
    await storesOpen();
    const row = await t!.pool.query(`SELECT holder, epoch FROM ${t!.schema}.host_lease`);
    expect(row.rows[0].epoch).toBe(2);
    await db.recordUsageEvent({ workspaceId: ID, sessionId: null, kind: 'resumed' });
  }, 30_000);

  it('a stale holder’s store write fails and the process exits 1', async () => {
    const a = await start({ leaseRenewMs: 10_000, leaseTtlMs: 30_000 });
    await vi.waitFor(async () => expect(await leader(a.url)).toBe(200));
    await storesOpen();
    await db.recordUsageEvent({ workspaceId: ID, sessionId: null, kind: 'resumed' });
    await t!.pool.query(`UPDATE ${t!.schema}.host_lease SET holder = 'intruder', epoch = epoch + 1, expires_at = clock_timestamp() + interval '1 minute'`);
    await expect(db.recordUsageEvent({ workspaceId: ID, sessionId: null, kind: 'resumed' })).rejects.toThrow(/lease lost/);
    await vi.waitFor(() => expect(a.exit).toHaveBeenCalledWith(1));
    expect(a.logs.join('\n')).toMatch(/write fenced off/);
  }, 30_000);
});
