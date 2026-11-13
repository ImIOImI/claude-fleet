// Two fleet-host processes' worth of runHost on one schema. db.ts is a module
// singleton, so only one holder may have its stores open at a time.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import pg from 'pg';
import * as db from '../main/db.js';
import { IdentityError, type IdentityProvider } from '../main/identity/types.js';
import { isPg, testPgSchema, type TestPg } from '../main/store/testStore.js';
import { partitionIdFor, publishedSessionId } from '../main/publish/protocol.js';
import { migratePostgres } from '../main/store/pgMigrate.js';
import { postgresKysely } from '../main/store/postgres.js';
import { HOST_PG_SESSION } from './hostDb.js';
import { HOST_TRACK } from './hostSchema.js';
import { WORKSPACE_ID_FILE } from './hostState.js';
import { EXIT_DB_UNAVAILABLE, runHost, type RunHostOptions } from './main.js';
import { postgresLeaseStore } from './pgLease.js';
import { fakeBroker, jsonFrame, person, TOKEN } from './testFakes.js';
import { hostMcpArgs } from './hostMcp.js';
import { EMBED_MODEL_ID } from '../main/vectors.js';
import { FrameType } from '../main/broker.js';
import WebSocket from 'ws';

const FAKE = fileURLToPath(new URL('../main/__fixtures__/fake-embedder.mjs', import.meta.url));
const ID = '01JC0000000000000000000000';
const OTHER = '01JC0000000000000000000009';
const verify: IdentityProvider['verify'] = async (t) => {
  if (t !== TOKEN) throw new IdentityError('unauthorized', 'bad credentials', 401);
  return person('owner', 1, ['acme/platform']);
};

const hostEnv = (dir: string, port: number, cfgPath: string): NodeJS.ProcessEnv => ({
  FLEET_HOST_PORT: String(port), FLEET_HOST_CONFIG: cfgPath, FLEET_HOST_STATE: join(dir, 'state'),
  CLAUDE_FLEET_BROKER_SOCKET: join(dir, 'b.sock'), FLEET_HOST_PROJECTS: join(dir, 'projects'),
  FLEET_HOST_MCP_SOCKET: join(dir, 'run', 'mcp.sock')
});

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

  async function start(opts: Partial<RunHostOptions> = {}, prepare?: (dir: string) => void, extraConfig = '', extraEnv?: (dir: string) => NodeJS.ProcessEnv) {
    t ??= await testPgSchema();
    const dir = mkdtempSync(join(tmpdir(), 'fh-pg-'));
    prepare?.(dir);
    const cfgPath = join(dir, 'config.yaml');
    const dbBlock = JSON.stringify({ env: 'FLEET_TEST_PG_URL', schema: t.schema, poolMax: 2 });
    writeFileSync(cfgPath, `workspace: { id: ${ID}, name: smoke }\ngrants:\n  - { team: acme/platform, tier: session }\ndb: ${dbBlock}\n${extraConfig}`);
    const port = await freePort();
    const exit = vi.fn();
    const logs: string[] = [];
    const proc = new EventEmitter();
    const host = await runHost({
      env: { ...hostEnv(dir, port, cfgPath), FLEET_TEST_PG_URL: process.env.PG_TEST_URL, ...extraEnv?.(dir) },
      exit, proc, logSink: (l) => logs.push(l), authFactory: () => ({ id: 'github', verify }),
      brokerOps: fakeBroker([]).ops, leaseRenewMs: 200, leaseTtlMs: 1_000,
      ...opts
    });
    hosts.push(host);
    return { url: `http://127.0.0.1:${port}`, host, exit, logs, dir, cfgPath, proc };
  }
  const leader = async (url: string) => (await fetch(`${url}/leader`)).status;
  const storesOpen = () => vi.waitFor(() => expect(() => db.stateKysely()).not.toThrow(), { timeout: 10_000 });

  const mcpSock = (dir: string) => join(dir, 'run', 'mcp.sock');
  const isSocket = (p: string) => existsSync(p) && lstatSync(p).isSocket();
  function rpc(at: string | { host: string; port: number }, msgs: object[]): Promise<Array<Record<string, any>>> {
    return new Promise((resolve, reject) => {
      const c: Socket = connect(typeof at === 'string' ? { path: at } : at);
      let buf = '';
      c.setEncoding('utf8');
      c.on('data', (d) => {
        buf += d;
        const lines = buf.trim().split('\n').filter(Boolean);
        if (lines.length >= msgs.length) { c.destroy(); resolve(lines.map((l) => JSON.parse(l))); }
      });
      c.on('error', reject);
      for (const m of msgs) c.write(JSON.stringify(m) + '\n');
    });
  }

  it('only the lease holder serves the MCP socket, as the hosted workspace, and it closes on shutdown', async () => {
    t ??= await testPgSchema();
    await migratePostgres(postgresKysely(t.pool), t.schema, HOST_TRACK);
    expect(await postgresLeaseStore(postgresKysely(t.pool), ID).tryAcquire('elsewhere', 0, 60_000)).toBe(1);
    const a = await start();
    await vi.waitFor(async () => expect(await (await fetch(`${a.url}/healthz`)).json()).toMatchObject({ lease: 'standby', db: 'ok' }), { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 1_000));
    expect(existsSync(mcpSock(a.dir))).toBe(false);
    await t.pool.query(`UPDATE ${t.schema}.host_lease SET expires_at = clock_timestamp() - interval '1 second'`);
    await vi.waitFor(async () => expect(await leader(a.url)).toBe(200), { timeout: 10_000 });
    await vi.waitFor(() => expect(isSocket(mcpSock(a.dir))).toBe(true), { timeout: 10_000 });
    const [list, todo] = await rpc(mcpSock(a.dir), [
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'post_todo', arguments: { title: 'from a session' } } }
    ]);
    const byId = new Map([list, todo].map((m) => [m.id, m]));
    expect(byId.get(1)!.result.tools.map((x: { name: string }) => x.name)).toContain('list_sessions');
    expect(byId.get(2)!.result.isError).toBeUndefined();
    const rows = await t.pool.query(`SELECT title, source_kind, source_id FROM ${t.schema}.todos`);
    expect(rows.rows).toEqual([{ title: 'from a session', source_kind: 'workspace', source_id: ID }]);
    await a.host.shutdown(0);
    expect(existsSync(mcpSock(a.dir))).toBe(false);
  }, 40_000);

  it('viewer CREATEs carry the MCP config when db is set', async () => {
    const broker = fakeBroker([]);
    const a = await start({ brokerOps: broker.ops });
    await vi.waitFor(async () => expect(await leader(a.url)).toBe(200), { timeout: 10_000 });
    const ws = new WebSocket(`${a.url.replace('http', 'ws')}/attach`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
    ws.send(jsonFrame(FrameType.CREATE, { id: 'v1', cols: 80, rows: 24 }));
    await vi.waitFor(() => expect(broker.created).toHaveLength(1), { timeout: 5_000 });
    ws.close();
    expect(broker.created[0].args.at(-1)).toBe(hostMcpArgs({ unix: mcpSock(a.dir) })[0]);
  }, 30_000);

  it('a viewer CREATE records its verified owner, fenced on the holder, before the broker starts claude', async () => {
    const broker = fakeBroker([]);
    const a = await start({ brokerOps: broker.ops });
    await vi.waitFor(async () => expect(await leader(a.url)).toBe(200), { timeout: 10_000 });
    const ws = new WebSocket(`${a.url.replace('http', 'ws')}/attach`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
    ws.send(jsonFrame(FrameType.CREATE, { id: 'v2', cols: 80, rows: 24, owner: { login: 'mallory', id: 666 } }));
    await vi.waitFor(() => expect(broker.created).toHaveLength(1), { timeout: 10_000 });
    ws.close();
    const args = broker.created[0].args;
    const sid = args[args.indexOf('--session-id') + 1];
    const rows = await t!.pool.query(`SELECT broker_session_id, session_id, workspace_id, kind, provider, account_id, login FROM ${t!.schema}.session_owners`);
    expect(rows.rows).toEqual([{ broker_session_id: 'v2', session_id: sid, workspace_id: ID, kind: 'user', provider: 'github', account_id: '1', login: 'owner' }]);
  }, 30_000);

  it('a viewer may pin a published id never, and a non-v4 id only when this host already owns it', async () => {
    const broker = fakeBroker([]);
    const a = await start({ brokerOps: broker.ops });
    await vi.waitFor(async () => expect(await leader(a.url)).toBe(200), { timeout: 10_000 });
    const PUB = '0b7e6c1e-1f6a-4c55-9c39-6f1f8d6c2a11';
    const V1 = 'a8098c1a-f86e-11da-bd1a-00112444be1e';
    await t!.pool.query(`INSERT INTO ${t!.schema}.publish_partitions (partition_id, owner_provider, owner_id, owner_login, source_workspace_id, created_at)
      VALUES ('pub_a', 'github', '9', 'cat', $1, 1)`, [OTHER]);
    await t!.pool.query(`INSERT INTO ${t!.schema}.publish_sessions (session_id, partition_id, source_session_id, first_published_at, last_published_at)
      VALUES ($1, 'pub_a', 'src', 1, 1)`, [PUB]);
    const ws = new WebSocket(`${a.url.replace('http', 'ws')}/attach`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
    const replies: Array<Record<string, unknown>> = [];
    ws.on('message', (d: Buffer) => { if (d[4] === FrameType.CREATED) replies.push(JSON.parse(d.subarray(5).toString('utf8'))); });
    ws.send(jsonFrame(FrameType.CREATE, { id: 'p1', args: ['--session-id', PUB] }));
    ws.send(jsonFrame(FrameType.CREATE, { id: 'p2', args: ['--resume', V1] }));
    await vi.waitFor(() => expect(replies).toHaveLength(2), { timeout: 10_000 });
    await t!.pool.query(`INSERT INTO ${t!.schema}.session_owners (broker_session_id, session_id, workspace_id, kind, provider, account_id, login, name, avatar_url, started_at)
      VALUES ('old', $1, $2, 'user', 'github', '1', 'owner', NULL, NULL, 1)`, [V1, ID]);
    ws.send(jsonFrame(FrameType.CREATE, { id: 'p3', args: ['--resume', V1] }));
    await vi.waitFor(() => expect(replies).toHaveLength(3), { timeout: 10_000 });
    ws.close();
    expect(replies).toEqual([
      { id: 'p1', ok: false, error: 'forbidden: unsupported session id' },
      { id: 'p2', ok: false, error: 'forbidden: unsupported session id' },
      { id: 'p3', ok: true }
    ]);
    expect(broker.created.map((c) => c.id)).toEqual(['p3']);
  }, 30_000);

  it('viewer CREATEs dial FLEET_HOST_MCP_ADDR when the MCP is on TCP', async () => {
    const broker = fakeBroker([]);
    const port = await freePort();
    const probe = createHttpServer((_q, r) => r.end('ok'));
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
    try {
      const readyUrl = `http://127.0.0.1:${(probe.address() as AddressInfo).port}/healthz/ready`;
      const a = await start({ brokerOps: broker.ops }, undefined, '', () => ({
        FLEET_HOST_MCP_TCP_PORT: String(port), FLEET_HOST_MCP_ADDR: 'fleet-agent-host.platform-ops.svc:8082',
        FLEET_HOST_REQUIRE_MESH: '1', FLEET_MESH_READY_URL: readyUrl
      }));
      await vi.waitFor(async () => expect(await leader(a.url)).toBe(200), { timeout: 10_000 });
      const ws = new WebSocket(`${a.url.replace('http', 'ws')}/attach`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
      ws.send(jsonFrame(FrameType.CREATE, { id: 'v1', cols: 80, rows: 24 }));
      await vi.waitFor(() => expect(broker.created).toHaveLength(1), { timeout: 5_000 });
      ws.close();
      expect(broker.created[0].args.at(-1)).toBe(hostMcpArgs({ tcp: 'fleet-agent-host.platform-ops.svc:8082' })[0]);
    } finally {
      probe.close();
    }
  }, 30_000);

  it('a failed MCP start keeps the holder and retries until it serves', async () => {
    const a = await start({ mcpRetryMs: 100 }, (dir) => {
      mkdirSync(join(dir, 'run'), { recursive: true });
      writeFileSync(mcpSock(dir), 'not a socket');
    });
    await vi.waitFor(async () => expect(await leader(a.url)).toBe(200), { timeout: 10_000 });
    await vi.waitFor(() => expect(a.logs.filter((l) => l.includes('mcp start failed; retrying')).length).toBeGreaterThanOrEqual(2), { timeout: 10_000 });
    expect(await leader(a.url)).toBe(200);
    expect(a.exit).not.toHaveBeenCalled();
    rmSync(mcpSock(a.dir));
    await vi.waitFor(() => expect(isSocket(mcpSock(a.dir))).toBe(true), { timeout: 10_000 });
    expect(await leader(a.url)).toBe(200);
  }, 30_000);

  it('reconciles config automations on start and on reload', async () => {
    const auto = (msg: string) => `automations:\n  - definition: { name: nightly, triggers: [{ schedule: { cron: "0 3 * * *" } }], steps: [{ id: go, prompt: { workspace: $self, mode: fresh, message: ${msg} } }] }\n`;
    const a = await start({}, undefined, auto('one'));
    await vi.waitFor(async () => expect(await leader(a.url)).toBe(200), { timeout: 10_000 });
    const versions = async () => (await t!.pool.query(`SELECT name, version, origin FROM ${t!.schema}.automations`)).rows;
    await vi.waitFor(async () => expect(await versions()).toEqual([{ name: 'nightly', version: 1, origin: JSON.stringify({ source: 'host-config' }) }]), { timeout: 10_000 });
    writeFileSync(a.cfgPath, readFileSync(a.cfgPath, 'utf8').replace(auto('one'), auto('two')));
    a.proc.emit('SIGHUP');
    await vi.waitFor(async () => expect((await versions())[0].version).toBe(2), { timeout: 10_000 });
  }, 30_000);

  it('automation RPC: reads the holder runtime; an action is claimed in the fenced ledger once and recorded as the person', async () => {
    const auto = 'automations:\n  - definition: { name: nightly, triggers: [{ manual: {} }], steps: [{ id: go, prompt: { workspace: $self, mode: fresh, message: hi } }] }\n';
    const a = await start({}, undefined, auto);
    await vi.waitFor(async () => expect(await leader(a.url)).toBe(200), { timeout: 10_000 });
    const call = async (channel: string, args: unknown[]) => {
      const res = await fetch(`${a.url}/rpc/${channel}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ args })
      });
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };
    await vi.waitFor(async () => expect((await call('automations:list', [])).body.result.rows.map((r: { name: string }) => r.name)).toEqual(['nightly']), { timeout: 10_000 });
    const RID = '0b6f8f0e-4b1c-4c2a-9a0e-1f2e3d4c5b6a';
    const one = await call('inbox:create', [{ requestId: RID, input: { title: 'look' } }]);
    const two = await call('inbox:create', [{ requestId: RID, input: { title: 'look' } }]);
    expect([one.body.result.replayed, two.body.result.replayed]).toEqual([false, true]);
    expect(two.body.result.result).toEqual(one.body.result.result);
    const todos = await t!.pool.query(`SELECT title, source_kind, source_id FROM ${t!.schema}.todos`);
    expect(todos.rows).toEqual([{ title: 'look', source_kind: 'user', source_id: 'owner' }]);
    const ledger = await t!.pool.query(`SELECT actor, request_id, channel, error FROM ${t!.schema}.host_action_requests`);
    expect(ledger.rows).toEqual([{ actor: 'github:1', request_id: RID, channel: 'inbox:create', error: null }]);
    expect((await call('inbox:counts', [])).body.result).toMatchObject({ open: 1 });
  }, 30_000);

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

  it('history RPC reads only the hosted workspace, whatever the arguments say', async () => {
    const a = await start();
    await vi.waitFor(async () => expect(await leader(a.url)).toBe(200), { timeout: 10_000 });
    await storesOpen();
    await t!.pool.query(`INSERT INTO ${t!.schema}.sessions (id, workspace_id, last_active_at) VALUES ('h1', $1, 5), ('h2', $1, NULL), ('o1', $2, 9)`, [ID, OTHER]);
    const call = async (channel: string, args: unknown[]) => {
      const res = await fetch(`${a.url}/rpc/${channel}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ args })
      });
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };
    // The stores open before startHolder resolves; history answers 503 until it does.
    await vi.waitFor(async () => expect((await call('history:summary', [])).status).toBe(200), { timeout: 10_000 });
    const page = await call('history:sessions', [{ after: { lastActiveAt: 99, id: 'o1', workspaceId: OTHER }, limit: 1, workspaceId: OTHER }, OTHER]);
    expect(page.status).toBe(200);
    expect(page.body.result.rows.map((r: { id: string; workspaceId: string }) => [r.id, r.workspaceId])).toEqual([['h1', ID]]);
    const rest = await call('history:sessions', [{ after: page.body.result.next, limit: 1 }]);
    expect(rest.body.result).toMatchObject({ rows: [{ id: 'h2', workspaceId: ID }], next: null });
    expect((await call('history:summary', [])).body.result.sessionId).toBe('h1');
    expect(await call('history:summary', ['o1'])).toEqual({ status: 200, body: { ok: true, result: null } });
    expect((await call('history:sessions', [{ limit: 500 }])).status).toBe(400);
  }, 30_000);

  it('history RPC shows each session’s owner and groups cost by owner', async () => {
    const SID = '22222222-3333-4444-8555-666666666666';
    const broker = fakeBroker([]);
    const a = await start({ brokerOps: broker.ops });
    await vi.waitFor(async () => expect(await leader(a.url)).toBe(200), { timeout: 10_000 });
    await storesOpen();
    const ws = new WebSocket(`${a.url.replace('http', 'ws')}/attach`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
    ws.send(jsonFrame(FrameType.CREATE, { id: 'v3', args: ['--session-id', SID] }));
    await vi.waitFor(() => expect(broker.created).toHaveLength(1), { timeout: 10_000 });
    ws.close();
    await t!.pool.query(`INSERT INTO ${t!.schema}.sessions (id, workspace_id, last_active_at) VALUES ($1, $2, 5), ('u1', $2, 4)`, [SID, ID]);
    await t!.pool.query(`INSERT INTO ${t!.schema}.session_costs (session_id, workspace_id, model, service_tier, input_tokens, output_tokens,
      cache_read_input_tokens, cache_creation_input_tokens, event_count) VALUES ($1, $2, 'claude-opus-4-1', '', 1000, 0, 0, 0, 1)`, [SID, ID]);
    const call = async (channel: string, args: unknown[]) => {
      const res = await fetch(`${a.url}/rpc/${channel}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ args })
      });
      return (await res.json()) as Record<string, any>;
    };
    await vi.waitFor(async () => expect((await call('history:sessions', [{}])).ok).toBe(true), { timeout: 10_000 });
    const page = await call('history:sessions', [{}]);
    expect(page.result.rows.map((r: { id: string; owner: { login: string } | null }) => [r.id, r.owner?.login ?? null])).toEqual([[SID, 'owner'], ['u1', null]]);
    const owners = await call('history:owners', []);
    expect(owners.result.rows).toEqual([
      { owner: { kind: 'user', provider: 'github', id: '1', login: 'owner', name: null, avatarUrl: null }, sessions: 1, usd: expect.any(Number) }
    ]);
  }, 30_000);

  it('POST /publish lands under the caller’s partition, scrubbed, idempotent, and stays out of history', async () => {
    const hostSecret = `fake-host-${'q'.repeat(12)}`;
    const a = await start({}, undefined, '', () => ({ FAKE_SERVICE_TOKEN: hostSecret }));
    await vi.waitFor(async () => expect(await leader(a.url)).toBe(200), { timeout: 10_000 });
    await storesOpen();
    const SRC = '01JC0000000000000000000005';
    const SID = '11111111-2222-4333-8444-555555555555';
    const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` };
    const publish = async (events: string[]) => {
      const res = await fetch(`${a.url}/publish`, { method: 'POST', headers: auth, body: JSON.stringify({ sourceWorkspaceId: SRC, sessionId: SID, events }) });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    const line = JSON.stringify({ type: 'user', uuid: 'u1', sessionId: SID, timestamp: '2026-11-05T00:00:00Z', message: { role: 'user', content: `token ghp_${'A'.repeat(36)} and ${hostSecret}` } });
    // 503 until the holder's publish store is up.
    await vi.waitFor(async () => expect((await publish([line])).status).toBe(200), { timeout: 10_000 });
    const part = partitionIdFor({ provider: 'github', id: 1 }, SRC);
    const sid = publishedSessionId(part, SID);
    const rows = (await t!.pool.query(`SELECT workspace_id, raw_jsonl FROM ${t!.schema}.events WHERE session_id = $1`, [sid])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].workspace_id).toBe(part);
    expect(rows[0].raw_jsonl).not.toContain('ghp_');
    expect(rows[0].raw_jsonl).not.toContain(hostSecret);
    expect(rows[0].raw_jsonl).toContain('[redacted:FAKE_SERVICE_TOKEN]');
    expect(await publish([line])).toEqual({ status: 200, body: { ok: true, accepted: 1, inserted: 0 } });
    const hist = await fetch(`${a.url}/rpc/history:sessions`, { method: 'POST', headers: auth, body: JSON.stringify({ args: [{}] }) });
    expect(((await hist.json()) as { result: { rows: unknown[] } }).result.rows).toEqual([]);
    expect(a.logs.join('\n')).not.toContain(hostSecret);
  }, 30_000);

  it('serves the id from host_meta and keeps the state file in step', async () => {
    const a = await start();
    await vi.waitFor(async () => expect(await leader(a.url)).toBe(200), { timeout: 10_000 });
    const meta = await t!.pool.query(`SELECT workspace_id FROM ${t!.schema}.host_meta`);
    expect(meta.rows).toEqual([{ workspace_id: ID }]);
    expect(JSON.parse(readFileSync(join(a.dir, 'state', WORKSPACE_ID_FILE), 'utf8')).id).toBe(ID);
  }, 30_000);

  it('refuses to start when config workspace.id differs from host_meta', async () => {
    t ??= await testPgSchema();
    await migratePostgres(postgresKysely(t.pool), t.schema, HOST_TRACK);
    await t.pool.query(`INSERT INTO ${t.schema}.host_meta VALUES (TRUE, $1, 0)`, [OTHER]);
    const a = await start();
    await vi.waitFor(() => expect(a.exit).toHaveBeenCalledWith(1), { timeout: 10_000 });
    expect(a.logs.join('\n')).toMatch(new RegExp(`host start failed.*${OTHER}.*${ID}`));
  }, 30_000);

  it('the holder ingests transcripts written in its container, offsets included', async () => {
    const a = await start();
    await vi.waitFor(async () => expect(await leader(a.url)).toBe(200), { timeout: 10_000 });
    await storesOpen();
    const sid = '22222222-2222-4222-8222-222222222222';
    const proj = join(a.dir, 'projects', '-workspace');
    mkdirSync(proj, { recursive: true });
    const text = JSON.stringify({ type: 'user', uuid: 'u1', sessionId: sid, timestamp: '2026-11-05T00:00:00Z', message: { role: 'user', content: 'hi' } }) + '\n';
    writeFileSync(join(proj, `${sid}.jsonl`), text);
    await vi.waitFor(async () => {
      const r = await t!.pool.query(`SELECT COUNT(*)::int AS n FROM ${t!.schema}.events WHERE workspace_id = $1 AND session_id = $2`, [ID, sid]);
      expect(r.rows[0].n).toBe(1);
    }, { timeout: 10_000 });
    const off = await t!.pool.query(`SELECT byte_offset FROM ${t!.schema}.host_ingest_offsets`);
    expect(off.rows.map((r) => Number(r.byte_offset))).toEqual([Buffer.byteLength(text)]);
  }, 30_000);

  it('the holder rescans transcripts every FLEET_HOST_RESCAN_MS', async () => {
    const every = vi.spyOn(globalThis, 'setInterval');
    try {
      const a = await start({}, undefined, '', () => ({ FLEET_HOST_RESCAN_MS: '4321' }));
      await vi.waitFor(async () => expect(await leader(a.url)).toBe(200), { timeout: 10_000 });
      await storesOpen();
      await vi.waitFor(() => expect(every.mock.calls.some((c) => c[1] === 4321)).toBe(true), { timeout: 10_000 });
    } finally {
      every.mockRestore();
    }
  }, 30_000);

  describe('search.embedder (D79)', () => {
    const SID = '33333333-3333-4333-8333-333333333333';
    const embedFiles = (dir: string) => {
      mkdirSync(join(dir, 'embed', 'model', 'onnx'), { recursive: true });
      writeFileSync(join(dir, 'embed', 'model', 'tokenizer.json'), '{}');
      writeFileSync(join(dir, 'embed', 'model', 'onnx', 'model_quantized.onnx'), '');
    };
    /** Live processes started with this host's --model-dir. */
    const sidecars = (dir: string): number => {
      const needle = join(dir, 'embed', 'model');
      let n = 0;
      for (const pid of readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
        try { if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').includes(needle)) n++; } catch { /* exited */ }
      }
      return n;
    };
    async function boot(extraConfig: string, fakeEnv: NodeJS.ProcessEnv = { FAKE_MODE: 'ok' }) {
      const a = await start({ embedder: { launch: { bin: process.execPath, args: [FAKE] }, env: fakeEnv } },
        embedFiles, extraConfig, (dir) => ({ FLEET_HOST_EMBED_DIR: join(dir, 'embed') }));
      await vi.waitFor(async () => expect(await leader(a.url)).toBe(200), { timeout: 10_000 });
      await storesOpen();
      const proj = join(a.dir, 'projects', '-workspace');
      mkdirSync(proj, { recursive: true });
      writeFileSync(join(proj, `${SID}.jsonl`),
        JSON.stringify({ type: 'user', uuid: 'u1', sessionId: SID, timestamp: '2026-11-05T00:00:00Z', message: { role: 'user', content: 'index me' } }) + '\n');
      await vi.waitFor(async () => {
        const r = await t!.pool.query(`SELECT COUNT(*)::int AS n FROM ${t!.schema}.events WHERE session_id = $1`, [SID]);
        expect(r.rows[0].n).toBe(1);
      }, { timeout: 10_000 });
      return a;
    }
    const embedded = async () => (await t!.pool.query(`SELECT COUNT(*)::int AS n FROM ${t!.schema}.embeddings WHERE text <> ''`)).rows[0].n as number;
    const unit = Array(384).fill(1 / Math.sqrt(384));
    const searchRpc = async (url: string) => {
      const res = await fetch(`${url}/rpc/history:search`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ args: [{ vector: unit, modelId: EMBED_MODEL_ID, limit: 5 }] })
      });
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };
    const mcpTools = async (dir: string): Promise<string[]> => {
      await vi.waitFor(() => expect(isSocket(mcpSock(dir))).toBe(true), { timeout: 10_000 });
      const [list] = await rpc(mcpSock(dir), [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
      return list.result.tools.map((x: { name: string }) => x.name);
    };

    it('on: the holder indexes ingested turns through the sidecar', async () => {
      const a = await boot('');
      await vi.waitFor(async () => expect(await embedded()).toBe(1), { timeout: 10_000 });
      expect(a.logs.join('\n')).not.toMatch(/embedder unavailable/);
      expect(sidecars(a.dir)).toBe(1);
      expect(await mcpTools(a.dir)).toContain('search_transcripts');
      const [found] = await rpc(mcpSock(a.dir), [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_transcripts', arguments: { query: 'index me' } } }]);
      expect(JSON.parse(found.result.content[0].text)).toEqual([expect.objectContaining({ sessionId: SID, workspaceId: ID, text: 'index me' })]);
      await vi.waitFor(async () => expect((await searchRpc(a.url)).status).toBe(200), { timeout: 10_000 });
      const rpcHits = await searchRpc(a.url);
      expect(rpcHits.body.result.modelId).toBe(EMBED_MODEL_ID);
      expect(rpcHits.body.result.hits).toEqual([expect.objectContaining({ sessionId: SID, workspaceId: ID, text: 'index me' })]);
      await a.host.shutdown(0);
      await vi.waitFor(() => expect(sidecars(a.dir)).toBe(0), { timeout: 5_000 });
    }, 30_000);

    it('on: the holder indexes published turns as they arrive', async () => {
      const a = await boot('');
      await vi.waitFor(async () => expect(await embedded()).toBe(1), { timeout: 10_000 });
      const SRC = '01JC0000000000000000000005';
      const line = JSON.stringify({ type: 'user', uuid: 'p1', sessionId: SID, timestamp: '2026-11-05T00:00:00Z', message: { role: 'user', content: 'published phrase' } });
      const res = await fetch(`${a.url}/publish`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ sourceWorkspaceId: SRC, sessionId: SID, events: [line] })
      });
      expect(res.status).toBe(200);
      const part = partitionIdFor({ provider: 'github', id: 1 }, SRC);
      await vi.waitFor(async () => {
        const r = await t!.pool.query(`SELECT workspace_id, text FROM ${t!.schema}.embeddings WHERE session_id = $1`, [publishedSessionId(part, SID)]);
        expect(r.rows).toEqual([{ workspace_id: part, text: 'published phrase' }]);
      }, { timeout: 10_000 });
      const pubSid = publishedSessionId(part, SID);
      await mcpTools(a.dir);
      const call = (id: number, name: string, args: object) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
      const [sessions, found, marked] = await rpc(mcpSock(a.dir), [
        call(1, 'list_sessions', {}), call(2, 'search_transcripts', { query: 'published phrase' }), call(3, 'mark_useful', { sessionId: pubSid })
      ]).then((ms) => [1, 2, 3].map((id) => ms.find((m) => m.id === id)!));
      expect(JSON.parse(sessions.result.content[0].text).map((x: { id: string; workspace_id: string }) => [x.id, x.workspace_id]).sort())
        .toEqual([[SID, ID], [pubSid, part]].sort());
      expect(JSON.parse(found.result.content[0].text)).toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: pubSid, workspaceId: part })]));
      expect(JSON.parse(marked.result.content[0].text)).toEqual({ ok: true });
      const marks = await t!.pool.query(`SELECT workspace_id, session_id, origin FROM ${t!.schema}.usage_events WHERE kind = 'marked-useful'`);
      expect(marks.rows).toEqual([{ workspace_id: ID, session_id: pubSid, origin: part }]);
      await vi.waitFor(async () => expect((await searchRpc(a.url)).status).toBe(200), { timeout: 10_000 });
      const viewer = (await searchRpc(a.url)).body.result.hits as Array<{ sessionId: string; workspaceId: string }>;
      expect(viewer.map((h) => [h.sessionId, h.workspaceId])).toEqual([[SID, ID]]);
    }, 30_000);

    it('on: stop lets the in-flight batch land before the sidecar and the stores close', async () => {
      const marker = join(mkdtempSync(join(tmpdir(), 'fh-emb-')), 'asked');
      const a = await boot('', { FAKE_MODE: 'slow', FAKE_DELAY_MS: '700', FAKE_STATE: marker });
      await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: 10_000 });
      await a.host.shutdown(0);
      expect(await embedded()).toBe(1);
      expect(a.logs.join('\n')).not.toMatch(/transcript index failed|index backfill failed/);
      await vi.waitFor(() => expect(sidecars(a.dir)).toBe(0), { timeout: 5_000 });
    }, 30_000);

    it('on: a superseded holder’s index insert is fenced off and the process exits 1', async () => {
      const marker = join(mkdtempSync(join(tmpdir(), 'fh-emb-')), 'asked');
      const a = await boot('', { FAKE_MODE: 'slow', FAKE_DELAY_MS: '700', FAKE_STATE: marker });
      await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: 10_000 });
      await t!.pool.query(`UPDATE ${t!.schema}.host_lease SET holder = 'intruder', epoch = epoch + 1, expires_at = clock_timestamp() + interval '1 minute'`);
      await vi.waitFor(() => expect(a.exit).toHaveBeenCalledWith(1), { timeout: 10_000 });
      expect(a.logs.join('\n')).toMatch(/write fenced off/);
      expect(await embedded()).toBe(0);
    }, 30_000);

    it('off: no sidecar, no indexing, and nothing logged about an embedder', async () => {
      const a = await boot('search: { embedder: false }\n');
      await new Promise((r) => setTimeout(r, 2_000));
      expect(await embedded()).toBe(0);
      expect(sidecars(a.dir)).toBe(0);
      const tools = await mcpTools(a.dir);
      expect(tools).toContain('list_sessions');
      expect(tools).not.toContain('search_transcripts');
      expect(await searchRpc(a.url)).toEqual({ status: 503, body: { ok: false, error: 'search unavailable' } });
      expect(a.logs.join('\n')).not.toMatch(/embedder/);
    }, 30_000);
  });

  it('a store migration longer than TTL − renew runs unfenced: the holder keeps its lease', async () => {
    const slow = { track: 'slow_test', baselineVersion: 1, baseline: 'SELECT pg_sleep(2)', steps: [] };
    const a = await start({ extraStoreTracks: [slow] });
    await vi.waitFor(async () => expect(await leader(a.url)).toBe(200), { timeout: 10_000 });
    await storesOpen();
    expect(a.exit).not.toHaveBeenCalled();
    expect(a.logs.join('\n')).not.toMatch(/lease lost/);
    const row = await t!.pool.query(`SELECT epoch FROM ${t!.schema}.host_lease`);
    expect(row.rows[0].epoch).toBe(1);
    const v = await t!.pool.query(`SELECT version FROM ${t!.schema}.schema_migrations WHERE track = 'slow_test'`);
    expect(v.rows).toHaveLength(1);
  }, 30_000);

  it('a fenced store transaction held past TTL − renew doesn’t cost the holder its lease', async () => {
    const a = await start();
    await vi.waitFor(async () => expect(await leader(a.url)).toBe(200), { timeout: 10_000 });
    await storesOpen();
    await db.stateKysely().transaction().execute(async (trx) => {
      await sql`select 1`.execute(trx);
      await new Promise((r) => setTimeout(r, 2_000));
    });
    expect(a.exit).not.toHaveBeenCalled();
    expect(a.logs.join('\n')).not.toMatch(/lease lost|lease store error/);
    const row = await t!.pool.query(`SELECT epoch FROM ${t!.schema}.host_lease`);
    expect(Number(row.rows[0].epoch)).toBe(1);
  }, 30_000);

  it('the holder’s store connections carry the host session timeouts', async () => {
    const a = await start();
    await vi.waitFor(async () => expect(await leader(a.url)).toBe(200), { timeout: 10_000 });
    await storesOpen();
    const show = async (n: string) => (await sql<Record<string, string>>`${sql.raw(`SHOW ${n}`)}`.execute(db.stateKysely())).rows[0][n];
    expect(await show('idle_in_transaction_session_timeout')).toBe(`${HOST_PG_SESSION.idleInTransactionMs / 1000}s`);
    expect(await show('statement_timeout')).toBe(`${HOST_PG_SESSION.statementTimeoutMs / 1000}s`);
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

  it('serves the MCP on its TCP port once the sidecar is ready, never without one', async () => {
    const probe = createHttpServer((_q, r) => r.end('ok'));
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
    try {
      const readyUrl = `http://127.0.0.1:${(probe.address() as AddressInfo).port}/healthz/ready`;
      const tcpEnv = (port: number, url: string) => () => ({
        FLEET_HOST_MCP_TCP_PORT: String(port), FLEET_HOST_MCP_ADDR: `127.0.0.1:${port}`, FLEET_HOST_REQUIRE_MESH: '1', FLEET_MESH_READY_URL: url
      });
      const p1 = await freePort();
      const a = await start({}, undefined, '', tcpEnv(p1, readyUrl));
      await vi.waitFor(async () => expect(await leader(a.url)).toBe(200), { timeout: 10_000 });
      await vi.waitFor(async () => {
        const [list] = await rpc({ host: '127.0.0.1', port: p1 }, [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
        expect(list.result.tools.map((x: { name: string }) => x.name)).toContain('list_sessions');
      }, { timeout: 10_000 });
      expect(existsSync(mcpSock(a.dir))).toBe(false);
      await a.host.shutdown(0);

      const p2 = await freePort();
      const b = await start({ meshWaitMs: 300 }, undefined, '', tcpEnv(p2, `http://127.0.0.1:${await freePort()}/healthz/ready`));
      await vi.waitFor(async () => expect(await leader(b.url)).toBe(200), { timeout: 10_000 });
      await vi.waitFor(async () => expect(await (await fetch(`${b.url}/healthz`)).json()).toMatchObject({ status: 'unhealthy', mesh: 'missing' }), { timeout: 10_000 });
      await new Promise((r) => setTimeout(r, 500));
      await expect(rpc({ host: '127.0.0.1', port: p2 }, [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }])).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    } finally {
      probe.close();
    }
  }, 40_000);
});

/** A TCP front for the test server (Unix socket or TCP) that refuses connections until opened. */
async function gatedProxy(): Promise<{ url: string; open(): void; cut(): void; close(): Promise<void> }> {
  const u = new URL(process.env.PG_TEST_URL!);
  const sockDir = u.searchParams.get('host');
  const upstream = (): Socket => sockDir
    ? connect(join(sockDir, `.s.PGSQL.${u.searchParams.get('port') || u.port || '5432'}`))
    : connect(Number(u.port || 5432), u.hostname);
  let open = false;
  const conns = new Set<Socket>();
  const srv: Server = createServer((c) => {
    if (!open) return c.destroy();
    const up = upstream();
    conns.add(c).add(up);
    c.pipe(up).pipe(c);
    const done = () => { c.destroy(); up.destroy(); };
    c.on('error', done).on('close', done);
    up.on('error', done).on('close', done);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const { port } = srv.address() as AddressInfo;
  const proxied = new URL(u);
  proxied.hostname = '127.0.0.1';
  proxied.port = String(port);
  proxied.searchParams.delete('host');
  proxied.searchParams.delete('port');
  return {
    url: proxied.toString(),
    open: () => (open = true),
    cut: () => {
      open = false;
      for (const c of conns) c.destroy();
    },
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
    writeFileSync(cfgPath, `workspace: { id: ${ID}, name: smoke }\ngrants:\n  - { team: acme/platform, tier: session }\ndb: ${JSON.stringify({ env: 'FLEET_TEST_PG_URL', schema: t.schema, poolMax: 2 })}\n`);
    const port = await freePort();
    const exit = vi.fn();
    const proc = new EventEmitter();
    const logs: string[] = [];
    const host = await runHost({
      env: { ...hostEnv(dir, port, cfgPath), FLEET_TEST_PG_URL: dbUrl },
      exit, proc, logSink: (l) => logs.push(l), authFactory: () => ({ id: 'github', verify }),
      brokerOps: fakeBroker([]).ops, leaseRenewMs: 200, leaseTtlMs: 1_000, ...extra
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

  it(`a holder that loses the db exits ${EXIT_DB_UNAVAILABLE}, not 1`, async () => {
    const proxy = await gatedProxy();
    proxy.open();
    try {
      const a = await boot(proxy.url, { storeCloseMs: 500 });
      await vi.waitFor(async () => expect((await fetch(`${a.url}/leader`)).status).toBe(200), { timeout: 10_000 });
      await vi.waitFor(() => expect(() => db.stateKysely()).not.toThrow(), { timeout: 10_000 });
      proxy.cut();
      await vi.waitFor(() => expect(a.exit).toHaveBeenCalled(), { timeout: 15_000 });
      expect(a.exit).toHaveBeenCalledWith(EXIT_DB_UNAVAILABLE);
    } finally {
      await proxy.close();
    }
  }, 30_000);

  it(`a db connection failure after the pool opens exits ${EXIT_DB_UNAVAILABLE}, not 1`, async () => {
    t ??= await testPgSchema();
    await migratePostgres(postgresKysely(t.pool), t.schema, HOST_TRACK);
    // host_meta reads fail with a connection-class SQLSTATE once the host track is migrated.
    await t.pool.query(`CREATE FUNCTION ${t.schema}.meta_down() RETURNS TABLE (singleton boolean, workspace_id text, created_at bigint)
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'connection failure' USING ERRCODE = '08006'; END $$`);
    await t.pool.query(`DROP TABLE ${t.schema}.host_meta`);
    await t.pool.query(`CREATE VIEW ${t.schema}.host_meta AS SELECT * FROM ${t.schema}.meta_down()`);
    const a = await boot(process.env.PG_TEST_URL!);
    await vi.waitFor(() => expect(a.exit).toHaveBeenCalled(), { timeout: 10_000 });
    expect(a.exit).toHaveBeenCalledWith(EXIT_DB_UNAVAILABLE);
    expect(a.logs.join('\n')).toMatch(/host start failed/);
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
