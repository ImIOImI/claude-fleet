import { beforeEach, describe, expect, it } from 'vitest';
import { ingestLine, stateKysely, tokensSpentSince, tokensSpentSinceQuery, withRawSqlite } from './db.js';
import { isPg, openTestState } from './store/testStore.js';

const NOW = Date.parse('2026-07-01T12:00:00Z');
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const assistant = (uuid: string, ts: number, usage: Record<string, number>) =>
  JSON.stringify({ type: 'assistant', uuid, timestamp: iso(ts), message: { model: 'claude-sonnet-4-6', usage, content: [{ type: 'text', text: 'x' }] } });

beforeEach(async () => { await openTestState('cf-rolling-spend-'); });

describe('tokensSpentSince', () => {
  it('sums every token type for events inside the window, across sessions and workspaces', async () => {
    await ingestLine('01A', 's1', assistant('a1', NOW - 1 * HOUR, { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 }));
    await ingestLine('01A', 's1', assistant('a2', NOW - 6 * HOUR, { input_tokens: 1000 }));
    await ingestLine('01B', 's2', assistant('b1', NOW - 4 * HOUR, { output_tokens: 5 }));
    await ingestLine('01B', 's3', assistant('c1', NOW - 9 * HOUR, { output_tokens: 7000 }));
    expect(await tokensSpentSince(NOW - 5 * HOUR)).toBe(10 + 20 + 30 + 40 + 5);
  });

  it('is 0 with no events, or none inside the window', async () => {
    expect(await tokensSpentSince(NOW - 5 * HOUR)).toBe(0);
    await ingestLine('01A', 's1', assistant('old', NOW - 8 * HOUR, { input_tokens: 9 }));
    expect(await tokensSpentSince(NOW - 5 * HOUR + 1)).toBe(0);
  });
});

describe.skipIf(isPg)('tokensSpentSince plan', () => {
  it('walks session ids and the window through idx_events_session_ts, never scanning events', async () => {
    const c = tokensSpentSinceQuery(NOW - 5 * HOUR).compile(stateKysely());
    const plan = (await withRawSqlite((d) => d.prepare(`EXPLAIN QUERY PLAN ${c.sql}`).all(...(c.parameters as unknown[])) as Array<{ detail: string }>))!
      .map((r) => r.detail);
    expect(plan.some((d) => /SCAN e\b|SCAN events\b/.test(d))).toBe(false);
    expect(plan.some((d) => d.includes('idx_events_session_ts') && d.includes('session_id=? AND ts>?'))).toBe(true);
  });
});
