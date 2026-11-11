import { describe, expect, it } from 'vitest';
import { mergeHits } from './searchMerge';

const h = (sessionId: string, score: number, ts: number | null = 1) => ({ sessionId, workspaceId: 'W', workspaceName: 'w', kind: 'turn' as const, ts, text: 't', score });
describe('mergeHits', () => {
  it('orders by score, ties by origin, session and ts, and cuts at limit', () => {
    const out = mergeHits([{ origin: 'local', hits: [h('a', 0.9), h('b', 0.5)] }, { origin: 'H', hits: [h('c', 0.9), h('d', 0.7)] }], 3);
    expect(out.map((x) => `${x.origin}:${x.sessionId}`)).toEqual(['H:c', 'local:a', 'H:d']);
  });

  it('keeps every hit of a session (no dedupe) and orders equal sessions by ts', () => {
    const out = mergeHits([{ origin: 'H', hits: [h('a', 0.5, 9), h('a', 0.5, 2), h('a', 0.5, null)] }], 10);
    expect(out.map((x) => x.ts)).toEqual([null, 2, 9]);
  });

  it('ties on score break by session id in byte order', () => {
    const out = mergeHits([{ origin: 'H', hits: [h('b', 0.5), h('B', 0.5), h('a', 0.5)] }], 10);
    expect(out.map((x) => x.sessionId)).toEqual(['B', 'a', 'b']);
  });

  it('stamps each hit with its source origin and does not trust a hit-level origin', () => {
    const out = mergeHits([{ origin: 'H', hits: [{ ...h('a', 0.5), origin: 'local' } as never] }], 10);
    expect(out[0].origin).toBe('H');
  });

  it('returns nothing for limit 0 and an empty input', () => {
    expect(mergeHits([{ origin: 'H', hits: [h('a', 0.5)] }], 0)).toEqual([]);
    expect(mergeHits([], 5)).toEqual([]);
  });
});
