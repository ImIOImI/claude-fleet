import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleMcpRequestForTests, MAX_IN_FLIGHT_PER_CONNECTION, setInboxHandlers, setReadScopeResolver } from '../main/mcpCore.js';
import type { OwnedReadSource } from '../main/store/readSource.js';
import { createLogger } from './log.js';
import { HOST_MCP_BRIDGE, HOST_MCP_TOOLS, hostMcpArgs, startHostMcp, type HostMcp } from './hostMcp.js';

const WS = '01JC0000000000000000000000';
const scopes: string[][] = [];
const rs = {
  queryFlavor: null,
  close: async () => undefined,
  forgetCaller: async () => undefined,
  listSessions: async (scope: ReadonlySet<string>) => { scopes.push([...scope]); return []; }
} as unknown as OwnedReadSource;

let mcp: HostMcp | null = null;
let dir = '';
afterEach(async () => {
  await mcp?.close();
  mcp = null;
  setInboxHandlers(null);
  scopes.length = 0;
  rmSync(dir, { recursive: true, force: true });
});

async function start(lines: string[], maxConnections?: number, now?: () => number) {
  dir = mkdtempSync(join(tmpdir(), 'hm-'));
  const socketPath = join(dir, 'run', 'mcp.sock');
  mcp = await startHostMcp({ socketPath, socketGroup: null, workspaceId: WS, readSource: rs, log: createLogger((l) => lines.push(l)), maxConnections, now });
  return socketPath;
}

function rpc(path: string, msgs: object[]): Promise<Array<Record<string, any>>> {
  return new Promise((resolve, reject) => {
    const c: Socket = connect(path);
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

/** Resolves with what the server sent before it closed the connection. */
function closedWith(c: Socket): Promise<string> {
  let got = '';
  c.setEncoding('utf8');
  c.on('data', (d) => { got += d; });
  c.on('error', () => undefined);
  return new Promise((r) => c.once('close', () => r(got)));
}

const PING = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n';

describe('startHostMcp', () => {
  it('serves only the host tool set, as the hosted workspace', async () => {
    const seen: string[] = [];
    setInboxHandlers({
      post: async (callerId) => { seen.push(callerId); return { id: 't1' }; },
      update: async () => ({}), list: async () => [], notify: async () => ({})
    });
    const p = await start([]);
    const [init, list, perf, post, sessions] = await rpc(p, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'perf_status', arguments: {} } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'post_todo', arguments: { title: 'x' } } },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'list_sessions', arguments: { workspace_id: 'OTHER' } } }
    ]);
    const byId = new Map([init, list, perf, post, sessions].map((m) => [m.id, m]));
    expect(byId.get(1)!.result.serverInfo.name).toBe('claude-fleet-state');
    expect(byId.get(1)!.result).not.toHaveProperty('instructions');
    expect(new Set(byId.get(2)!.result.tools.map((t: { name: string }) => t.name))).toEqual(HOST_MCP_TOOLS);
    expect(byId.get(3)!.error.message).toBe('Unknown tool: perf_status');
    expect(byId.get(4)!.result.isError).toBeUndefined();
    expect(seen).toEqual([WS]);
    expect(scopes).toEqual([[WS]]);
  });

  it('fixes the read scope to the hosted workspace even if a resolver was set before', async () => {
    setReadScopeResolver(async (id) => [id, 'GRANTED']);
    const p = await start([]);
    await rpc(p, [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_sessions', arguments: {} } }]);
    expect(scopes).toEqual([[WS]]);
  });

  it('makes the socket 0600 in a 0700 directory', async () => {
    const p = await start([]);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(statSync(join(p, '..')).mode & 0o777).toBe(0o700);
  });

  it('refuses connections past the cap and accepts again once one closes', async () => {
    const lines: string[] = [];
    let t = 1_000_000;
    const p = await start(lines, 1, () => t);
    const first = connect(p);
    await new Promise((r) => first.once('connect', r));
    const refusals = () => lines.filter((l) => /too many open/.test(l)).map((l) => JSON.parse(l) as { level: string; refused: number });
    for (let i = 0; i < 3; i++) {
      const extra = connect(p);
      extra.write(PING);
      expect(await closedWith(extra)).toBe('');
    }
    expect(refusals()).toEqual([expect.objectContaining({ level: 'warn', refused: 1 })]);
    t += 60_000;
    const late = connect(p);
    expect(await closedWith(late)).toBe('');
    expect(refusals().map((r) => r.refused)).toEqual([1, 3]);
    first.destroy();
    await new Promise((r) => setTimeout(r, 50));
    const [pong] = await rpc(p, [{ jsonrpc: '2.0', id: 9, method: 'ping' }]);
    expect(pong).toEqual({ jsonrpc: '2.0', id: 9, result: {} });
  });

  it('logs connection rows at debug and keeps the 1 MiB line cap', async () => {
    const lines: string[] = [];
    const p = await start(lines);
    const [over] = await rpc(p, [{ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(1 << 20) } }]);
    expect(over.error.code).toBe(-32600);
    expect(lines.some((l) => /"level":"debug".*"msg":"mcp-conn"/.test(l))).toBe(true);
  });

  it('removes the socket on close', async () => {
    const p = await start([]);
    await mcp!.close();
    mcp = null;
    expect(existsSync(p)).toBe(false);
  });

  it('fails to start over a regular file and serves every tool again afterwards', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hm-'));
    const socketPath = join(dir, 'mcp.sock');
    writeFileSync(socketPath, 'x');
    await expect(startHostMcp({ socketPath, socketGroup: null, workspaceId: WS, readSource: rs, log: createLogger(() => undefined) })).rejects.toThrow(/not a socket/);
    const list = handleMcpRequestForTests('tools/list') as { tools: unknown[] };
    expect(list.tools.length).toBeGreaterThan(HOST_MCP_TOOLS.size);
  });
});

describe('HOST_MCP_TOOLS', () => {
  it('serves query and still refuses search_transcripts', () => {
    expect(HOST_MCP_TOOLS.has('query')).toBe(true);
    expect(HOST_MCP_TOOLS.has('search_transcripts')).toBe(false);
    expect(HOST_MCP_TOOLS.size).toBe(14);
  });
});

describe('hostMcpArgs', () => {
  it('names claude-fleet-state and points the bridge at the socket', () => {
    const args = hostMcpArgs('/run/fleet/mcp.sock');
    expect(args).toHaveLength(1);
    expect(args[0].startsWith('--mcp-config=')).toBe(true);
    expect(JSON.parse(args[0].slice('--mcp-config='.length))).toEqual({
      mcpServers: { 'claude-fleet-state': { type: 'stdio', command: 'node', args: [HOST_MCP_BRIDGE], env: { CLAUDE_FLEET_MCP_UNIX: '/run/fleet/mcp.sock', CLAUDE_FLEET_MCP_TCP: '' } } }
    });
  });
});

describe('startHostMcp, more', () => {
  it('group mode: serves a 0660 socket in the group from a prepped directory', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hm-'));
    const gid = process.getgid!();
    const d = join(dir, 'mcp');
    mkdirSync(d);
    chmodSync(d, 0o2750);
    const socketPath = join(d, 'mcp.sock');
    writeFileSync(socketPath, 'planted');
    mcp = await startHostMcp({ socketPath, socketGroup: gid, workspaceId: WS, readSource: rs, log: createLogger(() => undefined) });
    const st = lstatSync(socketPath);
    expect([st.isSocket(), st.mode & 0o777, st.gid]).toEqual([true, 0o660, gid]);
    const [pong] = await rpc(socketPath, [{ jsonrpc: '2.0', id: 1, method: 'ping' }]);
    expect(pong.result).toEqual({});
  });

  it('private mode: refuses a symlink at the socket path', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hm-'));
    mkdirSync(join(dir, 'run'));
    const socketPath = join(dir, 'run', 'mcp.sock');
    symlinkSync(join(dir, 'elsewhere'), socketPath);
    await expect(startHostMcp({ socketPath, socketGroup: null, workspaceId: WS, readSource: rs, log: createLogger(() => undefined) })).rejects.toThrow(/not a socket/);
  });

  it('allows one instance per process', async () => {
    const p = await start([]);
    await expect(startHostMcp({ socketPath: p + '2', socketGroup: null, workspaceId: WS, readSource: rs, log: createLogger(() => undefined) }))
      .rejects.toThrow(/already serving/);
    await mcp!.close();
    mcp = null;
    await start([]);
  });

  it('keeps the per-connection in-flight cap', async () => {
    const hold: Array<() => void> = [];
    setInboxHandlers({
      post: () => new Promise((r) => hold.push(() => r({ id: 't' }))),
      update: async () => ({}), list: async () => [], notify: async () => ({})
    });
    const p = await start([]);
    const call = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'post_todo', arguments: { title: 'x' } } });
    const c = connect(p);
    c.setEncoding('utf8');
    let buf = '';
    c.on('data', (d) => { buf += d; });
    for (let i = 1; i <= MAX_IN_FLIGHT_PER_CONNECTION + 1; i++) c.write(JSON.stringify(call(i)) + '\n');
    await expect.poll(() => buf.includes('"id":' + (MAX_IN_FLIGHT_PER_CONNECTION + 1))).toBe(true);
    const busy = JSON.parse(buf.trim().split('\n')[0]);
    expect(busy).toMatchObject({ id: MAX_IN_FLIGHT_PER_CONNECTION + 1, error: { code: -32000 } });
    expect(hold.length).toBe(MAX_IN_FLIGHT_PER_CONNECTION);
    for (const r of hold) r();
    c.destroy();
  });
});
