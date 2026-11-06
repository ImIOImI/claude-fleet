// The core alone: no perf tools, an exposed-tool filter, and a pluggable log sink.
import { afterEach, describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import type { Socket } from 'node:net';
import { callTool, handleMcpRequestForTests, serveMcpConnection, setExposedTools, setMcpLogSink, TOOLS, type McpLogEntry } from './mcpCore.js';

afterEach(() => {
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

  it('sends connection rows to the log sink', () => {
    const rows: McpLogEntry[] = [];
    setMcpLogSink((e) => rows.push(e));
    const sock = new PassThrough() as unknown as Socket;
    serveMcpConnection(sock, 'W1');
    sock.emit('close');
    expect(rows.map((r) => r.type)).toEqual(['mcp-conn', 'mcp-conn-closed']);
    expect(rows[0].workspaceId).toBe('W1');
  });
});
