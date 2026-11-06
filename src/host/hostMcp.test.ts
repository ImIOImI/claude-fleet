import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleMcpRequestForTests, setInboxHandlers, setReadScopeResolver } from '../main/mcpCore.js';
import type { OwnedReadSource } from '../main/store/readSource.js';
import { createLogger } from './log.js';
import { HOST_MCP_TOOLS, startHostMcp, type HostMcp } from './hostMcp.js';

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

async function start(lines: string[], maxConnections?: number) {
  dir = mkdtempSync(join(tmpdir(), 'hm-'));
  const socketPath = join(dir, 'run', 'mcp.sock');
  mcp = await startHostMcp({ socketPath, socketGroup: null, workspaceId: WS, readSource: rs, log: createLogger((l) => lines.push(l)), maxConnections });
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
    const p = await start(lines, 1);
    const first = connect(p);
    await new Promise((r) => first.once('connect', r));
    const second = connect(p);
    second.write(PING);
    expect(await closedWith(second)).toBe('');
    expect(lines.some((l) => /"level":"warn".*too many open/.test(l))).toBe(true);
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
