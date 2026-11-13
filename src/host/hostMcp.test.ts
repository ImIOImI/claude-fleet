import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callTool, handleMcpRequestForTests, initReadSource, MAX_IN_FLIGHT_PER_CONNECTION, releaseReadSource, setInboxHandlers, setReadScopeResolver } from '../main/mcpCore.js';
import { EmbedderUnavailable } from '../main/embedderClient.js';
import type { OwnedReadSource } from '../main/store/readSource.js';
import type { EmbedFn } from '../main/vectors.js';
import { createLogger } from './log.js';
import { HOST_MCP_BRIDGE, HOST_MCP_TOOLS, HOST_SEARCH_TOOL, hostMcpArgs, hostMcpTools, startHostMcp, type HostMcp } from './hostMcp.js';

const WS = '01JC0000000000000000000000';
const scopes: string[][] = [];
const rs = {
  queryFlavor: null,
  close: async () => undefined,
  forgetCaller: async () => undefined,
  sessionWorkspace: async () => WS,
  tokenGroups: async () => [],
  listSessions: async (scope: ReadonlySet<string>) => { scopes.push([...scope]); return []; },
  searchEmbeddings: async (_q: Float32Array, scope: ReadonlySet<string>) => {
    scopes.push([...scope]);
    return [{ sessionId: 's1', workspaceId: WS, kind: 'turn', ts: 1, text: 'hit', score: 0.9 }];
  }
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

async function start(lines: string[], maxConnections?: number, now?: () => number, embed?: EmbedFn) {
  dir = mkdtempSync(join(tmpdir(), 'hm-'));
  const socketPath = join(dir, 'run', 'mcp.sock');
  mcp = await startHostMcp({ listen: { path: socketPath }, workspaceId: WS, readSource: rs, log: createLogger((l) => lines.push(l)), maxConnections, now, embed });
  return socketPath;
}

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
    // The oversize line never counts as an rpc line, so the close is logged.
    await vi.waitFor(() => expect(lines.some((l) => /"level":"debug".*"msg":"mcp-conn-closed"/.test(l))).toBe(true));
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
    await expect(startHostMcp({ listen: { path: socketPath }, workspaceId: WS, readSource: rs, log: createLogger(() => undefined) })).rejects.toThrow(/not a socket/);
    const list = handleMcpRequestForTests('tools/list') as { tools: unknown[] };
    expect(list.tools.length).toBeGreaterThan(HOST_MCP_TOOLS.size);
  });
});

describe('HOST_MCP_TOOLS', () => {
  it('serves query; search_transcripts only with an embedder', () => {
    expect(HOST_MCP_TOOLS.has('query')).toBe(true);
    expect(HOST_MCP_TOOLS.has('search_transcripts')).toBe(false);
    expect(HOST_MCP_TOOLS.size).toBe(20);
    for (const t of ['notify', 'propose_automation', 'propose_automation_change', 'get_proposal']) expect(HOST_MCP_TOOLS.has(t)).toBe(true);
    expect(HOST_MCP_TOOLS.has('cost_by_owner')).toBe(true);
    expect(HOST_MCP_TOOLS.has('mark_useful')).toBe(true);
    expect(HOST_SEARCH_TOOL).toBe('search_transcripts');
    expect(hostMcpTools(true).size).toBe(21);
    expect(hostMcpTools(true).has('search_transcripts')).toBe(true);
    expect(hostMcpTools(false)).toBe(HOST_MCP_TOOLS);
  });
});

describe('session owners on the host', () => {
  it('get_cost carries the owner and cost_by_owner groups the whole scope, partitions included', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hm-'));
    const ann = { kind: 'user', provider: 'github', id: '7', login: 'ann', name: null, avatarUrl: null } as const;
    const seen: unknown[] = [];
    const owners = {
      ownersOf: async (ids: readonly string[], ws: readonly string[]) => { seen.push(['ownersOf', ids, ws]); return new Map([['s1', ann]]); },
      ownerCosts: async (ws: readonly string[], o?: { since?: number }) => { seen.push(['ownerCosts', ws, o]); return [{ owner: ann, sessions: 1, usd: 2 }]; }
    };
    const sock = join(dir, 'mcp.sock');
    mcp = await startHostMcp({ listen: { path: sock }, workspaceId: WS, readSource: rs, log: createLogger(() => undefined), owners, scope: async () => ['pub_a'] });
    const call = (id: number, name: string, args: object) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    const out = await rpc(sock, [call(1, 'get_cost', { session_id: 's1' }), call(2, 'cost_by_owner', { since: 5 })]);
    const by = new Map(out.map((m) => [m.id, JSON.parse(m.result.content[0].text)]));
    expect(by.get(1)).toMatchObject({ session_id: 's1', owner: ann });
    expect(by.get(2)).toEqual([{ owner: ann, sessions: 1, usd: 2 }]);
    expect(seen).toHaveLength(2);
    expect(seen).toEqual(expect.arrayContaining([['ownersOf', ['s1'], [WS, 'pub_a']], ['ownerCosts', [WS, 'pub_a'], { since: 5 }]]));
  });

  it('closing the host MCP drops the owner handlers', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hm-'));
    const owners = { ownersOf: async () => new Map([['s1', { kind: 'user', provider: 'github', id: '7', login: 'ann', name: null, avatarUrl: null } as const]]), ownerCosts: async () => [] };
    mcp = await startHostMcp({ listen: { path: join(dir, 'mcp.sock') }, workspaceId: WS, readSource: rs, log: createLogger(() => undefined), owners });
    await mcp.close();
    mcp = null;
    initReadSource(rs);
    setReadScopeResolver(async () => [WS]);
    const r = (await callTool({ name: 'get_cost', arguments: { session_id: 's1' } }, WS)) as { content: Array<{ text: string }> };
    expect(JSON.parse(r.content[0].text)).not.toHaveProperty('owner');
    releaseReadSource();
  });
});

describe('search_transcripts on the host', () => {
  const unitEmbed: EmbedFn = async (t) => t.map(() => new Float32Array(384).fill(1 / Math.sqrt(384)));
  const search = (id: number, args: object) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'search_transcripts', arguments: args } });
  const names = (m: Record<string, any>) => m.result.tools.map((t: { name: string }) => t.name) as string[];

  it('embeds in the sidecar and searches only the hosted workspace', async () => {
    const p = await start([], undefined, undefined, unitEmbed);
    const [list, hit, other] = await rpc(p, [
      { jsonrpc: '2.0', id: 1, method: 'tools/list' }, search(2, { query: 'x' }), search(3, { query: 'x', workspace_id: 'other' })
    ]).then((ms) => [1, 2, 3].map((id) => ms.find((m) => m.id === id)!));
    expect(new Set(names(list))).toEqual(hostMcpTools(true));
    expect(JSON.parse(hit.result.content[0].text)).toEqual([expect.objectContaining({ sessionId: 's1', text: 'hit' })]);
    expect(JSON.parse(other.result.content[0].text)).toEqual([]);
    expect(scopes).toEqual([[WS]]);
  });

  it('is not served without an embedder', async () => {
    const p = await start([]);
    const [list, call] = await rpc(p, [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }, search(2, { query: 'x' })])
      .then((ms) => [1, 2].map((id) => ms.find((m) => m.id === id)!));
    expect(names(list)).toHaveLength(20);
    expect(call.error.message).toBe('Unknown tool: search_transcripts');
    expect(scopes).toEqual([]);
  });

  it('answers embedder sidecar unavailable when the sidecar can’t run', async () => {
    const p = await start([], undefined, undefined, async () => { throw new EmbedderUnavailable('not installed: /x'); });
    const [call] = await rpc(p, [search(1, { query: 'x' })]);
    expect(call.result.isError).toBe(true);
    expect(call.result.content[0].text).toContain('embedder sidecar unavailable');
  });

  it('drops the embedder when the MCP closes', async () => {
    await start([], undefined, undefined, unitEmbed);
    await mcp!.close();
    mcp = null;
    initReadSource(rs);
    try {
      const res = await handleMcpRequestForTests('tools/call', { name: 'search_transcripts', arguments: { query: 'x' } }) as { content: Array<{ text: string }> };
      expect(res.content[0].text).toContain('transcript search index is unavailable');
    } finally {
      releaseReadSource();
    }
  });
});

describe('hostMcpArgs', () => {
  it('names claude-fleet-state and points the bridge at the socket', () => {
    const args = hostMcpArgs({ unix: '/run/fleet/mcp.sock' });
    expect(args).toHaveLength(1);
    expect(args[0].startsWith('--mcp-config=')).toBe(true);
    expect(JSON.parse(args[0].slice('--mcp-config='.length))).toEqual({
      mcpServers: { 'claude-fleet-state': { type: 'stdio', command: 'node', args: [HOST_MCP_BRIDGE], env: { CLAUDE_FLEET_MCP_UNIX: '/run/fleet/mcp.sock', CLAUDE_FLEET_MCP_TCP: '' } } }
    });
  });
});

describe('startHostMcp, more', () => {
  it('private mode: refuses a symlink at the socket path', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hm-'));
    mkdirSync(join(dir, 'run'));
    const socketPath = join(dir, 'run', 'mcp.sock');
    symlinkSync(join(dir, 'elsewhere'), socketPath);
    await expect(startHostMcp({ listen: { path: socketPath }, workspaceId: WS, readSource: rs, log: createLogger(() => undefined) })).rejects.toThrow(/not a socket/);
  });

  it('allows one instance per process', async () => {
    const p = await start([]);
    await expect(startHostMcp({ listen: { path: p + '2' }, workspaceId: WS, readSource: rs, log: createLogger(() => undefined) }))
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

describe('startHostMcp on TCP', () => {
  it('serves the tools on a port, caller fixed to the hosted workspace, and leaves no socket file', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hm-'));
    mcp = await startHostMcp({ listen: { port: 0, host: '127.0.0.1' }, workspaceId: WS, readSource: rs, log: createLogger(() => undefined) });
    expect(mcp.port).toBeGreaterThan(0);
    const [list, sessions] = await rpc({ host: '127.0.0.1', port: mcp.port! }, [
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_sessions', arguments: {} } }
    ]).then((ms) => [1, 2].map((id) => ms.find((m) => m.id === id)!));
    expect(list.result.tools).toHaveLength(HOST_MCP_TOOLS.size);
    expect(sessions.result.isError).toBeUndefined();
    expect(scopes).toEqual([[WS]]);
  });
  it('logs the connection as tcp, not unix', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hm-'));
    const lines: string[] = [];
    mcp = await startHostMcp({ listen: { port: 0, host: '127.0.0.1' }, workspaceId: WS, readSource: rs, log: createLogger((l) => lines.push(l)) });
    const at = { host: '127.0.0.1', port: mcp.port! };
    // An oversize line never counts as an rpc line, so the close is logged (as in the unix case above).
    const [over] = await rpc(at, [{ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(1 << 20) } }]);
    expect(over.error.code).toBe(-32600);
    await vi.waitFor(() => expect(lines.some((l) => /"msg":"mcp-conn-closed"/.test(l) && l.includes('mcp tcp connection'))).toBe(true));
  });
  it('keeps the connection cap and 1 MiB line cap, and treats a token-shaped first line as a bad request', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hm-'));
    mcp = await startHostMcp({ listen: { port: 0, host: '127.0.0.1' }, workspaceId: WS, readSource: rs, log: createLogger(() => undefined), maxConnections: 1 });
    const at = { host: '127.0.0.1', port: mcp.port! };
    const first = connect(at);
    await new Promise((r) => first.once('connect', r));
    const extra = connect(at);
    extra.write(PING);
    expect(await closedWith(extra)).toBe('');
    first.destroy();
    await new Promise((r) => setTimeout(r, 50));
    const [over] = await rpc(at, [{ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(1 << 20) } }]);
    expect(over.error.code).toBe(-32600);
    await new Promise((r) => setTimeout(r, 50));
    const c = connect(at);
    c.on('error', () => undefined);
    c.write('0123456789abcdef0123456789abcdef\n');
    c.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_sessions', arguments: { workspace_id: 'OTHER' } } }) + '\n');
    let buf = '';
    c.setEncoding('utf8');
    c.on('data', (d) => { buf += d; });
    await vi.waitFor(() => expect(buf.trim().split('\n')).toHaveLength(2));
    c.destroy();
    const [bad, call] = buf.trim().split('\n').map((l) => JSON.parse(l));
    expect(bad.error.code).toBe(-32700);
    expect(call.result.isError).toBeUndefined();
    expect(scopes).toEqual([[WS]]);
  });
});

describe('hostMcpArgs on TCP', () => {
  it('points the bridge at the address with no token file', () => {
    const [arg] = hostMcpArgs({ tcp: 'fleet-agent-host.platform-ops.svc:8082' });
    expect(JSON.parse(arg.slice('--mcp-config='.length))).toEqual({
      mcpServers: { 'claude-fleet-state': { type: 'stdio', command: 'node', args: [HOST_MCP_BRIDGE], env: { CLAUDE_FLEET_MCP_TCP: 'fleet-agent-host.platform-ops.svc:8082', CLAUDE_FLEET_MCP_UNIX: '' } } }
    });
  });
});

describe('published partitions on the host MCP', () => {
  it('reads the hosted workspace plus every partition, resolved on each call', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hm-'));
    const socketPath = join(dir, 'run', 'mcp.sock');
    let parts = ['pub_a'];
    mcp = await startHostMcp({ listen: { path: socketPath }, workspaceId: WS, readSource: rs, log: createLogger(() => undefined), scope: async () => parts });
    const call = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'list_sessions', arguments: {} } });
    await rpc(socketPath, [call(1)]);
    parts = ['pub_a', 'pub_b'];
    await rpc(socketPath, [call(2)]);
    expect(scopes).toEqual([[WS, 'pub_a'], [WS, 'pub_a', 'pub_b']]);
  });

  it('search_transcripts searches the partitions too', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hm-'));
    const socketPath = join(dir, 'run', 'mcp.sock');
    const unitEmbed: EmbedFn = async (t) => t.map(() => new Float32Array(384).fill(1 / Math.sqrt(384)));
    mcp = await startHostMcp({
      listen: { path: socketPath }, workspaceId: WS, readSource: rs, log: createLogger(() => undefined), embed: unitEmbed, scope: async () => ['pub_a']
    });
    await rpc(socketPath, [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_transcripts', arguments: { query: 'x' } } }]);
    expect(scopes).toEqual([[WS, 'pub_a']]);
  });

  it('without a scope, reads only the hosted workspace', async () => {
    const p = await start([]);
    await rpc(p, [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_sessions', arguments: {} } }]);
    expect(scopes).toEqual([[WS]]);
  });

  it('serves mark_useful through the holder’s recorder, for a session in scope only', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hm-'));
    const socketPath = join(dir, 'run', 'mcp.sock');
    const recorded: unknown[] = [];
    const withSession = { ...rs, sessionWorkspace: async (_scope: ReadonlySet<string>, id: string) => (id === 'p1' ? 'pub_a' : null) } as unknown as OwnedReadSource;
    mcp = await startHostMcp({
      listen: { path: socketPath }, workspaceId: WS, readSource: withSession, log: createLogger(() => undefined),
      scope: async () => ['pub_a'], recordUsage: async (e) => void recorded.push(e)
    });
    const mark = (id: number, sessionId: string) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'mark_useful', arguments: { sessionId } } });
    const [ok, missing] = await rpc(socketPath, [mark(1, 'p1'), mark(2, 'nope')]).then((ms) => [1, 2].map((id) => ms.find((m) => m.id === id)!));
    expect(JSON.parse(ok.result.content[0].text)).toEqual({ ok: true });
    expect(missing.result.isError).toBe(true);
    expect(recorded).toEqual([{ workspaceId: WS, sessionId: 'p1', kind: 'marked-useful', detail: undefined }]);
  });

  it('drops the recorder on close: mark_useful answers unavailable on the next start', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hm-'));
    const socketPath = join(dir, 'run', 'mcp.sock');
    const withSession = { ...rs, sessionWorkspace: async () => WS } as unknown as OwnedReadSource;
    const first = await startHostMcp({ listen: { path: socketPath }, workspaceId: WS, readSource: withSession, log: createLogger(() => undefined), recordUsage: async () => undefined });
    await first.close();
    mcp = await startHostMcp({ listen: { path: socketPath }, workspaceId: WS, readSource: withSession, log: createLogger(() => undefined) });
    const [r] = await rpc(socketPath, [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'mark_useful', arguments: { sessionId: 's1' } } }]);
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toMatch(/usage recording is unavailable/);
  });
});
