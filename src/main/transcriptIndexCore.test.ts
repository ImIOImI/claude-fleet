import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ingestLine } from './db.js';
import { extractText, indexSessionTurnsWith, type SpanAsync } from './transcriptIndexCore.js';
import { EMBED_DIM } from './vectors.js';
import { openTestState, type TestState } from './store/testStore.js';

describe('transcriptIndexCore', () => {
  it('exports the loop without perf and keeps extractText', () => {
    expect(typeof indexSessionTurnsWith).toBe('function');
    expect(extractText({ content: [{ type: 'text', text: ' a ' }] })).toBe('a');
  });

  describe('indexSessionTurnsWith', () => {
    let st: TestState;
    beforeEach(async () => { st = await openTestState('cf-idxcore-'); });
    afterEach(async () => { await st.close(); });

    it('spans each pending read and retires tool-only rows in the same pass', async () => {
      const calls: Array<[string, unknown]> = [];
      const span: SpanAsync = (name, fn, attrs) => { calls.push([name, attrs]); return fn(); };
      await ingestLine('01WS', 'ses-1', JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-07-01T00:00:00Z', message: { content: 'hi' } }));
      await ingestLine('01WS', 'ses-1', JSON.stringify({ type: 'assistant', uuid: 'a1', timestamp: '2026-07-01T00:00:01Z', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }));
      const embed = async (texts: string[]) => texts.map(() => { const v = new Float32Array(EMBED_DIM); v[0] = 1; return v; });
      expect(await indexSessionTurnsWith(span, 'ses-1', embed)).toBe(1);
      expect(calls).toEqual([
        ['claude_fleet.index.pending_turns', { session_id: 'ses-1' }],
        ['claude_fleet.index.pending_turns', { session_id: 'ses-1' }],
      ]);
    });
  });
});
