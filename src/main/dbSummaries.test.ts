import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ingestLine, unembeddedSummaries } from './db.js';
import { EMBED_MODEL_ID } from './vectors.js';
import { openTestState, queryRows, type TestState } from './store/testStore.js';

const WS = '01WS', SES = 'ses-1';
const line = (o: object) => JSON.stringify(o);
const userLine = (uuid: string, content: string) =>
  JSON.stringify({ type: 'user', uuid, timestamp: '2026-07-01T00:00:00Z', message: { content } });
let st: TestState;
beforeEach(async () => { st = await openTestState('cf-sum-'); });
afterEach(async () => { await st.close(); });

describe('session-summary ingest', () => {
  it('routes a session-summary event into session_summaries as a pending embedding', async () => {
    await ingestLine(WS, SES, line({ type: 'user', uuid: 'u1', timestamp: '2026-07-01T00:00:00Z', message: { content: 'hi' } }));
    await ingestLine(WS, SES, line({ type: 'session-summary', summary: 'Worked on the broker reconnect bug.', timestamp: '2026-07-01T00:01:00Z' }));
    const pending = await unembeddedSummaries(EMBED_MODEL_ID);
    expect(pending.length).toBe(1);
    expect(pending[0].summary).toContain('broker reconnect');
    expect(pending[0].sourceMaxEventId).toBeGreaterThan(0);
  });

  it('appends chapter rows per source_max_event_id, never replaces (#207)', async () => {
    await ingestLine(WS, SES, userLine('u1', 'first prompt'));
    await ingestLine(WS, SES, JSON.stringify({ type: 'session-summary', summary: 'chapter one', tags: ['a', 'b'], model: 'haiku' }));
    await ingestLine(WS, SES, userLine('u2', 'second prompt'));
    await ingestLine(WS, SES, JSON.stringify({ type: 'session-summary', summary: 'chapter two', tags: ['b', 'c'], model: 'haiku' }));
    const rows = (await queryRows('SELECT summary FROM session_summaries WHERE session_id = ? ORDER BY id', [SES])) as Array<{ summary: string }>;
    expect(rows.map((r) => r.summary)).toEqual(['chapter one', 'chapter two']);
  });

  it('accumulates tags as a union across chapters', async () => {
    await ingestLine(WS, SES, userLine('u1', 'x'));
    await ingestLine(WS, SES, JSON.stringify({ type: 'session-summary', summary: 's1', tags: ['a', 'b'] }));
    await ingestLine(WS, SES, userLine('u2', 'y'));
    await ingestLine(WS, SES, JSON.stringify({ type: 'session-summary', summary: 's2', tags: ['b', 'c'] }));
    const tags = (await queryRows('SELECT tag FROM session_tags WHERE session_id = ? ORDER BY tag', [SES])) as Array<{ tag: string }>;
    expect(tags.map((t) => t.tag)).toEqual(['a', 'b', 'c']);
  });
});
