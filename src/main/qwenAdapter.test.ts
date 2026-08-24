import { describe, it, expect } from 'vitest';
import { mapQwenRecord } from './qwenAdapter.js';

// Real qwen-code Content type (from @google/genai) uses `parts[]` not `content[]`.
// Fixtures corrected from the brief's draft which used `content[]`.

const parse = (line: string | null) => (line ? JSON.parse(line) : null);

describe('mapQwenRecord', () => {
  it('maps an assistant record with usage + model', () => {
    const out = parse(mapQwenRecord({
      type: 'assistant', uuid: 'u1', parentUuid: 'p0', timestamp: '2026-08-24T00:00:00.000Z',
      model: 'qwen3-coder:30b',
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, cachedContentTokenCount: 5 },
      message: { role: 'model', parts: [{ text: 'hello' }] }
    }));
    expect(out.type).toBe('assistant');
    expect(out.uuid).toBe('u1');
    expect(out.message.model).toBe('qwen3-coder:30b');
    expect(out.message.usage.input_tokens).toBe(100);
    expect(out.message.usage.output_tokens).toBe(20);
    expect(out.message.usage.cache_read_input_tokens).toBe(5);
    expect(out.message.usage.service_tier).toBe('standard');
  });

  it('maps a tool call (functionCall → tool_use)', () => {
    const out = parse(mapQwenRecord({
      type: 'assistant', uuid: 'u2', timestamp: '2026-08-24T00:00:01.000Z', model: 'qwen3-coder:30b',
      message: { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'a.ts' } } }] }
    }));
    const tu = out.message.content.find((b: { type: string }) => b.type === 'tool_use');
    expect(tu).toMatchObject({ type: 'tool_use', name: 'read_file', input: { path: 'a.ts' } });
    expect(typeof tu.id).toBe('string');
  });

  it('maps a tool result (functionResponse → tool_result)', () => {
    const out = parse(mapQwenRecord({
      type: 'tool_result', uuid: 'u3', timestamp: '2026-08-24T00:00:02.000Z',
      toolCallResult: { callId: 'call_1', status: 'success' },
      message: { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { content: 'x' } } }] }
    }));
    const tr = out.message.content.find((b: { type: string }) => b.type === 'tool_result');
    expect(tr).toMatchObject({ type: 'tool_result', tool_use_id: 'call_1', is_error: false });
  });

  it('maps a user record so first_user_message fills', () => {
    const out = parse(mapQwenRecord({
      type: 'user', uuid: 'u4', timestamp: '2026-08-24T00:00:03.000Z',
      message: { role: 'user', parts: [{ text: 'do the thing' }] }
    }));
    expect(out.type).toBe('user');
    expect(out.message.content).toContain('do the thing');
  });

  it('returns null for a system/unmappable record', () => {
    expect(mapQwenRecord({ type: 'system', subtype: 'session_model' })).toBeNull();
  });
});
