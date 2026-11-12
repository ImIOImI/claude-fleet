// The core alone: no perf tools, an exposed-tool filter, and a pluggable log sink.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import type { OwnedReadSource } from './store/readSource.js';
import {
  callTool, currentReadSource, handleMcpRequestForTests, initReadSource, releaseReadSource, serveMcpConnection, SERVER_INSTRUCTIONS, setExposedTools,
  setMcpLogSink, setReadScopeResolver, MCP_CONN_LOG_AFTER_MS, STANDING_RULE, TOOLS, type McpLogEntry
} from './mcpCore.js';

afterEach(() => {
  releaseReadSource();
  setExposedTools(null);
  setMcpLogSink(null);
});

describe('mcpCore', () => {
  it('serves no perf tools without the desktop shell', () => {
    expect(TOOLS.some((t) => t.name.startsWith('perf_'))).toBe(false);
  });

  it('limits tools/list and tools/call to the exposed set', async () => {
    setExposedTools(new Set(['list_sessions', 'post_todo']));
    const list = handleMcpRequestForTests('tools/list') as { tools: Array<{ name: string }> };
    expect(list.tools.map((t) => t.name)).toEqual(['list_sessions', 'post_todo']);
    await expect(callTool({ name: 'query', arguments: { sql: 'select 1' } }, 'W1')).rejects.toThrow('Unknown tool: query');
  });

  describe('connection rows', () => {
    afterEach(() => vi.useRealTimers());
    const rpcLine = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n';
    const open = (rows: McpLogEntry[], transport: 'unix' | 'tcp' = 'unix') => {
      setMcpLogSink((e) => rows.push(e));
      // Not a PassThrough: it would echo each reply back in as a request.
      const sock = Object.assign(new EventEmitter(), { setEncoding: () => undefined, write: () => true, destroy: () => undefined }) as unknown as Socket;
      serveMcpConnection(sock, 'W1', transport);
      return sock;
    };

    it('writes nothing for a short connection that answered every request', async () => {
      const rows: McpLogEntry[] = [];
      const sock = open(rows);
      sock.emit('data', rpcLine);
      await new Promise((r) => setTimeout(r, 10));
      sock.emit('close');
      expect(rows).toEqual([]);
    });

    it('logs the close of a connection that carried no rpc lines', () => {
      const rows: McpLogEntry[] = [];
      const sock = open(rows);
      sock.emit('close');
      expect(rows.map((r) => [r.type, r.level, r.workspaceId])).toEqual([['mcp-conn-closed', 'info', 'W1']]);
    });

    it('a close with a request in flight logs nothing itself; the reply that finds it gone logs mcp-reply-dropped', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      initReadSource(null);
      setReadScopeResolver(async (id) => { await gate; return [id]; });
      const rows: McpLogEntry[] = [];
      const sock = open(rows) as Socket & { destroyed?: boolean };
      sock.emit('data', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_sessions', arguments: {} } }) + '\n');
      await new Promise((r) => setTimeout(r, 10));
      sock.destroyed = true;
      sock.emit('close');
      expect(rows.find((r) => r.type === 'mcp-conn-closed')).toBeUndefined();
      release();
      await new Promise((r) => setTimeout(r, 10));
      setReadScopeResolver(async (id) => [id]);
      expect(rows.find((r) => r.type === 'mcp-reply-dropped')).toMatchObject({ level: 'warn', extra: { method: 'tools/call', tool: 'list_sessions' } });
    });

    it('logs the accept and close of a long-lived connection', () => {
      vi.useFakeTimers();
      const rows: McpLogEntry[] = [];
      const sock = open(rows);
      sock.emit('data', rpcLine);
      vi.advanceTimersByTime(MCP_CONN_LOG_AFTER_MS);
      sock.emit('close');
      expect(rows.map((r) => r.type)).toEqual(['mcp-conn', 'mcp-conn-closed']);
    });

    it('defaults to unix but logs tcp when passed', () => {
      const unixRows: McpLogEntry[] = [];
      open(unixRows).emit('close');
      expect(unixRows[0]).toMatchObject({ type: 'mcp-conn-closed', message: expect.stringContaining('mcp unix connection') });
      const tcpRows: McpLogEntry[] = [];
      open(tcpRows, 'tcp').emit('close');
      expect(tcpRows[0]).toMatchObject({ type: 'mcp-conn-closed', message: expect.stringContaining('mcp tcp connection') });
    });
  });

  it('advertises instructions only for tools it serves', () => {
    const instructions = () => (handleMcpRequestForTests('initialize') as { instructions?: string }).instructions;
    expect(instructions()).toBe(`${STANDING_RULE}\n\n${SERVER_INSTRUCTIONS}`);
    setExposedTools(new Set(['list_sessions', 'expose_port']));
    expect(instructions()).toBe(SERVER_INSTRUCTIONS);
    setExposedTools(new Set(['list_sessions', 'record_claim']));
    expect(handleMcpRequestForTests('initialize')).not.toHaveProperty('instructions');
    setExposedTools(new Set(['list_sessions', 'record_claim', 'search_claims']));
    expect(instructions()).toBe(STANDING_RULE);
    setExposedTools(new Set(['list_sessions']));
    expect(handleMcpRequestForTests('initialize')).not.toHaveProperty('instructions');
  });

  it('initReadSource closes the source it replaces', () => {
    const closed: string[] = [];
    const fake = (n: string) => ({ close: async () => { closed.push(n); } }) as unknown as OwnedReadSource;
    const a = fake('a');
    initReadSource(a);
    initReadSource(a);
    expect(closed).toEqual([]);
    initReadSource(null);
    expect(closed).toEqual(['a']);
    expect(currentReadSource()).toBeNull();
  });
});
