import { describe, expect, it } from 'vitest';
import { parseSessionsPage, parseSummary, RemoteShapeError } from './remoteRows';

const W = '01JC0000000000000000000000';
const good = { id: 's1', workspaceId: W, aiTitle: 'T\u202eitle', firstUserMessage: 'x'.repeat(900), userSetName: null, startedAt: 1, lastActiveAt: 2, eventCount: 3, usd: 0.5, tags: ['a', 7], headless: false };

describe('parseSessionsPage', () => {
  it('keeps valid rows, cleans text, drops foreign or malformed rows', () => {
    const p = parseSessionsPage({ rows: [good, { ...good, id: 'bad id' }, { ...good, id: 's2', workspaceId: 'OTHER' }, { ...good, id: 's3', usd: Infinity }], next: { lastActiveAt: 2, id: 's1' } }, W);
    expect(p.rows.map((r) => r.id)).toEqual(['s1']);
    expect(p.rows[0].aiTitle).toBe('T itle');
    expect(p.rows[0].firstUserMessage).toHaveLength(500);
    expect(p.rows[0].tags).toEqual(['a']);
    expect(p.next).toEqual({ lastActiveAt: 2, id: 's1' });
  });

  it('throws on a bad envelope or cursor', () => {
    expect(() => parseSessionsPage(null, W)).toThrow(RemoteShapeError);
    expect(() => parseSessionsPage({ rows: Array(201).fill(good), next: null }, W)).toThrow(RemoteShapeError);
    expect(() => parseSessionsPage({ rows: [], next: { lastActiveAt: -1, id: 's' } }, W)).toThrow(RemoteShapeError);
  });
});

describe('parseSummary', () => {
  const s = {
    sessionId: 's1', title: 't', model: 'm', startedAt: 1, lastActiveAt: 2, eventCount: 3, inputTokens: 1, outputTokens: 1,
    cacheReadInputTokens: 0, cacheCreationInputTokens: 0, usd: 0.1, lastTurnContextTokens: null, contextWindowTokens: 200000,
    topTools: [{ name: 'Bash', count: 2 }], recentToolCalls: [{ name: 'Bash', input: 'ls\n-la', durationMs: 3, status: 'ok', ts: 1 }],
    costSeries: [0.1], tokenSeries: [10],
  };
  it('accepts a summary and caps arrays', () => {
    const out = parseSummary({ ...s, costSeries: Array(500).fill(1) })!;
    expect(out.costSeries).toHaveLength(200);
    expect(out.recentToolCalls[0].input).toBe('ls -la');
  });
  it('null stays null; malformed throws', () => {
    expect(parseSummary(null)).toBeNull();
    expect(() => parseSummary({ ...s, contextWindowTokens: 'x' })).toThrow(RemoteShapeError);
    expect(() => parseSummary({ ...s, recentToolCalls: {} })).toThrow(RemoteShapeError);
  });
  it('drops a bad recent tool call and keeps the rest', () => {
    const ok = s.recentToolCalls[0];
    const calls = [{ ...ok, status: 'boom' }, { ...ok, durationMs: -1 }, { ...ok, ts: 1.5 }, { ...ok, name: 7 }, { ...ok, input: {} }, null, 'x', { ...ok, name: 'Read' }];
    const out = parseSummary({ ...s, recentToolCalls: calls })!;
    expect(out.recentToolCalls.map((c) => c.name)).toEqual(['Read']);
  });
});

describe('remote reply caps', () => {
  it('drops rows with bad numbers, flags or ids; caps tags at 20 × 64', () => {
    const bad = [
      { ...good, id: 'a', usd: -1 }, { ...good, id: 'b', eventCount: 1.5 }, { ...good, id: 'c', startedAt: -1 },
      { ...good, id: 'd', lastActiveAt: '2' }, { ...good, id: 'e', headless: 'no' }, { ...good, id: 'f', tags: 'x' },
      { ...good, id: 'g', aiTitle: 7 }, { ...good, id: 'x'.repeat(129) }, 'row', null
    ];
    const tags = Array.from({ length: 30 }, (_, i) => `${i}`.padEnd(100, 't'));
    const p = parseSessionsPage({ rows: [...bad, { ...good, id: 'ok', tags }], next: undefined }, W);
    expect(p.rows.map((r) => r.id)).toEqual(['ok']);
    expect(p.rows[0].tags).toHaveLength(20);
    expect(p.rows[0].tags.every((t) => t.length === 64)).toBe(true);
    expect(p.next).toBeNull();
  });

  it('refuses a page whose rows are not an array or whose cursor id is malformed', () => {
    expect(() => parseSessionsPage({ rows: {}, next: null }, W)).toThrow(RemoteShapeError);
    expect(() => parseSessionsPage({ rows: [], next: { lastActiveAt: 1, id: 'a b' } }, W)).toThrow(RemoteShapeError);
    expect(() => parseSessionsPage({ rows: [], next: { lastActiveAt: 1.5, id: 'a' } }, W)).toThrow(RemoteShapeError);
    expect(parseSessionsPage({ rows: Array(200).fill(good), next: null }, W).rows).toHaveLength(200);
  });

  it('caps summary arrays and strings', () => {
    const base = {
      sessionId: null, title: 'y'.repeat(900), model: 'm'.repeat(300), startedAt: null, lastActiveAt: null, eventCount: 0, inputTokens: 0,
      outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, usd: 0, lastTurnContextTokens: 5, contextWindowTokens: 1,
      topTools: Array(30).fill({ name: 'n'.repeat(100), count: 1 }),
      recentToolCalls: Array(80).fill({ name: 'B', input: 'i'.repeat(5000), durationMs: null, status: 'pending', ts: null }),
      costSeries: [], tokenSeries: Array.from({ length: 300 }, (_, i) => i)
    };
    const out = parseSummary(base)!;
    expect(out.title).toHaveLength(500);
    expect(out.model).toHaveLength(128);
    expect(out.topTools).toHaveLength(20);
    expect(out.topTools[0].name).toHaveLength(64);
    expect(out.recentToolCalls).toHaveLength(50);
    expect(out.recentToolCalls[0].input).toHaveLength(2000);
    expect(out.tokenSeries).toHaveLength(200);
    expect(out.tokenSeries[0]).toBe(100);
  });

  it('throws on a malformed summary field', () => {
    const s = {
      sessionId: 's', title: null, model: null, startedAt: 1, lastActiveAt: 1, eventCount: 0, inputTokens: 0, outputTokens: 0,
      cacheReadInputTokens: 0, cacheCreationInputTokens: 0, usd: 0, lastTurnContextTokens: null, contextWindowTokens: 1,
      topTools: [], recentToolCalls: [], costSeries: [], tokenSeries: []
    };
    expect(parseSummary(s)).toMatchObject({ sessionId: 's' });
    for (const bad of [
      { sessionId: 'a b' }, { title: 3 }, { usd: NaN }, { inputTokens: -1 }, { startedAt: 'x' }, { topTools: {} },
      { topTools: [{ name: 'x', count: -1 }] }, { usd: -0.01 }, { usd: Infinity },
      { costSeries: [Infinity] }, { costSeries: [-1] }, { tokenSeries: 'x' }, { tokenSeries: [1.5] }, { tokenSeries: [-1] }
    ]) {
      expect(() => parseSummary({ ...s, ...bad }), JSON.stringify(bad)).toThrow(RemoteShapeError);
    }
    expect(() => parseSummary('x')).toThrow(RemoteShapeError);
  });
});
