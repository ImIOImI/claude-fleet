import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { parseIngestLine, foldSessionTouch } from './ingestParse.js';

describe('parseIngestLine', () => {
  it('returns null for a partial / invalid line', () => {
    expect(parseIngestLine('{"type":"assistant","uu')).toBeNull();
  });

  it('keys on uuid when present, else the sha256 of the raw line', () => {
    expect(parseIngestLine(JSON.stringify({ type: 'user', uuid: 'u1' }))?.dedupKey).toBe('u1');
    const light = JSON.stringify({ type: 'ai-title', aiTitle: 't' });
    expect(parseIngestLine(light)?.dedupKey).toBe(createHash('sha256').update(light).digest('hex'));
  });

  it('extracts usage, model and the first tool_use block', () => {
    const p = parseIngestLine(JSON.stringify({
      type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-07-01T00:00:00.000Z',
      message: { model: 'claude-opus-4-1', usage: { input_tokens: 1, output_tokens: 2, service_tier: 'standard' },
        content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'x'.repeat(200) } }] },
    }));
    expect(p?.event).toMatchObject({
      ts: Date.parse('2026-07-01T00:00:00.000Z'), type: 'assistant', uuid: 'a1', parent_uuid: 'u1',
      model: 'claude-opus-4-1', input_tokens: 1, output_tokens: 2, cache_read_input_tokens: null,
      service_tier: 'standard', tool_name: 'Bash', tool_use_id: 'tu1', tool_result_is_error: null,
    });
    expect(p?.event.tool_input).toHaveLength(160); // 159 chars + '…'
  });

  it('extracts a tool_result id and its error flag', () => {
    const p = parseIngestLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true }] } }));
    expect(p?.event).toMatchObject({ tool_name: null, tool_use_id: 'tu1', tool_result_is_error: 1 });
  });
});

describe('foldSessionTouch (the per-line sessions upsert, folded)', () => {
  it('a new row starts at the first line', () => {
    expect(foldSessionTouch(undefined, [5, 9, 7])).toEqual({ started_at: 5, last_active_at: 9 });
  });

  it('keeps an existing started_at and takes the max last_active_at', () => {
    expect(foldSessionTouch({ started_at: 1, last_active_at: 10 }, [4, 12, 11])).toEqual({ started_at: 1, last_active_at: 12 });
  });

  it('fills a NULL started_at from the first non-null ts', () => {
    expect(foldSessionTouch(undefined, [null, null, 3, 8])).toEqual({ started_at: 3, last_active_at: 8 });
  });

  it('a ts-less line nulls last_active_at — SQLite MAX(x, NULL) is NULL (#475, preserved)', () => {
    expect(foldSessionTouch({ started_at: 1, last_active_at: 10 }, [12, null])).toEqual({ started_at: 1, last_active_at: null });
    expect(foldSessionTouch({ started_at: 1, last_active_at: 10 }, [null, 4])).toEqual({ started_at: 1, last_active_at: 4 });
  });

  it('returns undefined only when there is no row and no line', () => {
    expect(foldSessionTouch(undefined, [])).toBeUndefined();
    expect(foldSessionTouch({ started_at: 1, last_active_at: 2 }, [])).toEqual({ started_at: 1, last_active_at: 2 });
  });
});
