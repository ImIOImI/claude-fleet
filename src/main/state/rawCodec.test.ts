import { describe, expect, it } from 'vitest';
import { deflateLine, rawLine, stripLine, STUB_HEAD_CHARS } from './rawCodec.js';

const NOW = 1_800_000_000_000;

const toolResult = (content: unknown) => JSON.stringify({
  type: 'user', uuid: 'u-1', parentUuid: 'p-1', timestamp: '2026-09-01T00:00:00Z', sessionId: 's',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content }] },
  toolUseResult: { stdout: 'x'.repeat(9000) },
});

describe('stripLine', () => {
  it('stubs a tool_result line, keeping ids, the error flag, size and the head', () => {
    const line = toolResult('y'.repeat(9000));
    const stub = JSON.parse(stripLine(line, NOW)!);
    expect(stub.toolUseResult).toBeUndefined();
    expect(stub.uuid).toBe('u-1');
    expect(stub.timestamp).toBe('2026-09-01T00:00:00Z');
    expect(stub.message.content[0]).toEqual({
      type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: 'y'.repeat(STUB_HEAD_CHARS),
    });
    expect(stub.fleetStripped).toEqual({ bytes: Buffer.byteLength(line), at: NOW });
  });

  it('flattens array tool_result content into its head text', () => {
    const stub = JSON.parse(stripLine(toolResult([{ type: 'text', text: 'hello' }]), NOW)!);
    expect(stub.message.content[0].content).toBe(JSON.stringify([{ type: 'text', text: 'hello' }]));
  });

  it('defaults a missing is_error to false', () => {
    const line = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } });
    expect(JSON.parse(stripLine(line, NOW)!).message.content[0].is_error).toBe(false);
  });

  it('strips an oversized tool_use input but keeps file_path and text blocks', () => {
    const line = JSON.stringify({
      type: 'assistant', uuid: 'a-1',
      message: { content: [
        { type: 'text', text: 'writing the file' },
        { type: 'tool_use', id: 'toolu_2', name: 'Write', input: { file_path: '/w/a.ts', content: 'z'.repeat(5000) } },
      ] },
    });
    const stub = JSON.parse(stripLine(line, NOW)!);
    expect(stub.message.content[0]).toEqual({ type: 'text', text: 'writing the file' });
    expect(stub.message.content[1].input.file_path).toBe('/w/a.ts');
    expect(stub.message.content[1].input.content).toBe(`${'z'.repeat(200)}…`);
    expect(stub.message.content[1].name).toBe('Write');
    expect(stub.fleetStripped.bytes).toBe(Buffer.byteLength(line));
  });

  it('caps a kept field at 4096 chars', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [
      { type: 'tool_use', id: 't', name: 'Bash', input: { command: 'c'.repeat(6000) } },
    ] } });
    expect(JSON.parse(stripLine(line, NOW)!).message.content[0].input.command).toHaveLength(4096);
  });

  it('leaves small tool inputs, text rows, stripped rows and junk alone', () => {
    const small = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'Read', input: { file_path: '/a' } }] } });
    expect(stripLine(small, NOW)).toBeNull();
    expect(stripLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }), NOW)).toBeNull();
    expect(stripLine(stripLine(toolResult('y'), NOW)!, NOW)).toBeNull();
    expect(stripLine('not json', NOW)).toBeNull();
    expect(stripLine(JSON.stringify({ type: 'user', message: { content: 'plain prompt' } }), NOW)).toBeNull();
  });
});

describe('rawLine', () => {
  it('inflates raw_z, else returns raw_jsonl', () => {
    const line = toolResult('q'.repeat(3000));
    expect(rawLine({ raw_jsonl: '', raw_z: deflateLine(line) })).toBe(line);
    expect(rawLine({ raw_jsonl: line, raw_z: null })).toBe(line);
    expect(rawLine({ raw_jsonl: line, raw_z: Buffer.alloc(0) })).toBe(line);
  });

  it('round-trips non-ASCII text', () => {
    const line = JSON.stringify({ t: 'héllo — 日本語 🚀'.repeat(100) });
    expect(rawLine({ raw_jsonl: '', raw_z: deflateLine(line) })).toBe(line);
  });

  it('reads a corrupt raw_z as raw_jsonl, or throws when strict', () => {
    expect(rawLine({ raw_jsonl: '', raw_z: Buffer.from('nope') })).toBe('');
    expect(() => rawLine({ raw_jsonl: '', raw_z: Buffer.from('nope') }, true)).toThrow();
  });
});
