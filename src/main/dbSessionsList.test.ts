// listSessions() tags enrichment: each row carries the tags of its LATEST
// tagged summary chapter (ordered as emitted), [] when none exists.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  ingestLine, listSessions, listSessionsQuery, LIST_TITLE_CHARS, sessionsWithPendingTurns, latestActivityByWorkspace, latestSessionId,
  stateKysely, withRawSqlite,
} from './db.js';
import { EMBED_MODEL_ID } from './vectors.js';
import { explainPlan } from './state/explainPlan.js';
import { openTestState, isPg, type TestState } from './store/testStore.js';

const WS = '01WS';
const userLine = (uuid: string, content: string) =>
  JSON.stringify({ type: 'user', uuid, timestamp: '2026-07-01T00:00:00Z', message: { content } });
const summaryLine = (summary: string, tags?: string[]) =>
  JSON.stringify({ type: 'session-summary', summary, tags, model: 'haiku' });

let st: TestState;
beforeEach(async () => { st = await openTestState('cf-sesslist-'); });
afterEach(async () => { await st.close(); });

describe('listSessions tags', () => {
  it('returns [] for a session with no summary', async () => {
    await ingestLine(WS, 'ses-a', userLine('u1', 'hello'));
    const rows = await listSessions();
    expect(rows).toHaveLength(1);
    expect(rows[0].tags).toEqual([]);
  });

  it('returns the latest tagged chapter tags, in emitted order', async () => {
    await ingestLine(WS, 'ses-a', userLine('u1', 'first'));
    await ingestLine(WS, 'ses-a', summaryLine('chapter one', ['broker', 'reconnect']));
    await ingestLine(WS, 'ses-a', userLine('u2', 'second'));
    await ingestLine(WS, 'ses-a', summaryLine('chapter two', ['mcp', 'bridge']));
    const rows = await listSessions();
    expect(rows[0].tags).toEqual(['mcp', 'bridge']);
  });

  it('skips untagged later chapters (latest TAGGED chapter wins)', async () => {
    await ingestLine(WS, 'ses-a', userLine('u1', 'first'));
    await ingestLine(WS, 'ses-a', summaryLine('tagged', ['ci']));
    await ingestLine(WS, 'ses-a', userLine('u2', 'second'));
    await ingestLine(WS, 'ses-a', summaryLine('untagged later chapter'));
    const rows = await listSessions();
    expect(rows[0].tags).toEqual(['ci']);
  });

  it('scopes by workspace and tags the right rows', async () => {
    await ingestLine(WS, 'ses-a', userLine('u1', 'x'));
    await ingestLine(WS, 'ses-a', summaryLine('s', ['alpha']));
    await ingestLine('01WS2', 'ses-b', userLine('u2', 'y'));
    const rows = await listSessions(WS);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('ses-a');
    expect(rows[0].tags).toEqual(['alpha']);
  });
});

describe('listSessions title head', () => {
  it(`returns at most ${LIST_TITLE_CHARS} chars of the first user message, short ones whole`, async () => {
    const long = 'é'.repeat(LIST_TITLE_CHARS + 2000);
    await ingestLine(WS, 'ses-long', userLine('u1', long));
    await ingestLine(WS, 'ses-short', userLine('u2', 'short prompt'));
    const byId = new Map((await listSessions()).map((r) => [r.id, r]));
    expect(byId.get('ses-long')!.firstUserMessage).toBe('é'.repeat(LIST_TITLE_CHARS));
    expect(byId.get('ses-short')!.firstUserMessage).toBe('short prompt');
  });

  it.skipIf(isPg)('session query is one scan plus the indexed headless probe (EXPLAIN QUERY PLAN pin)', async () => {
    for (const ws of [undefined, WS]) {
      const plan = await withRawSqlite((d) => explainPlan(d, listSessionsQuery(stateKysely(), ws)));
      expect(plan).toMatch(/SEARCH b USING INDEX idx_broker_sessions_claude \(claude_session_id=\?\)/);
      expect(plan).not.toMatch(/\bevents\b/);
    }
  });
});

describe('latestActivityByWorkspace', () => {
  const at = (uuid: string, ts: string) =>
    JSON.stringify({ type: 'user', uuid, timestamp: ts, message: { content: 'x' } });

  it('equals listSessions(ws)[0]?.lastActiveAt for each workspace; absent when it has no sessions', async () => {
    await ingestLine('ws-a', 'a1', at('u1', '2026-07-01T00:00:00Z'));
    await ingestLine('ws-a', 'a2', at('u2', '2026-07-01T00:05:00Z'));
    await ingestLine('ws-b', 'b1', JSON.stringify({ type: 'ai-title', aiTitle: 't', sessionId: 'b1' }));
    const got = await latestActivityByWorkspace(['ws-a', 'ws-b', 'ws-none']);
    for (const ws of ['ws-a', 'ws-b']) {
      expect(got.get(ws)).toBe((await listSessions(ws))[0]?.lastActiveAt ?? null);
    }
    expect(got.get('ws-a')).toBe(Date.parse('2026-07-01T00:05:00Z'));
    expect(got.get('ws-b')).toBeNull();
    expect(got.has('ws-none')).toBe(false);
  });
});

describe('sessionsWithPendingTurns order', () => {
  const at = (uuid: string, ts: string | null) =>
    JSON.stringify({ type: 'user', uuid, ...(ts ? { timestamp: ts } : {}), message: { content: 'x' } });

  it('matches listSessions() order, including NULL last_active_at sessions tied by id', async () => {
    await ingestLine('ws-e', 'e1', at('u1', '2026-07-01T00:00:00Z'));
    await ingestLine('ws-f', 'f1', at('u2', '2026-07-01T00:05:00Z'));
    // A timestamp-less line leaves last_active_at NULL: COALESCE(..., 0) DESC sorts it last, ties by id.
    for (const id of ['s-b', 's-a', 's-c']) await ingestLine('ws-g', id, at(`u-${id}`, null));

    const ids = await sessionsWithPendingTurns(EMBED_MODEL_ID);
    expect(ids).toEqual((await listSessions()).map((s) => s.id));
    expect(ids).toEqual(['f1', 'e1', 's-a', 's-b', 's-c']);
  });
});

describe('latestSessionId', () => {
  it('matches listSessions(ws)[0]?.id, including when the only session has a NULL last_active_at', async () => {
    await ingestLine('ws-c', 'c1', userLine('u1', 'first'));
    await ingestLine('ws-c', 'c2', userLine('u2', 'second'));
    expect(await latestSessionId('ws-c')).toBe((await listSessions('ws-c'))[0]?.id ?? null);

    // A light session (only a timestamp-less line) never gets a real
    // last_active_at; it must still resolve as "latest" when it's the only one.
    await ingestLine('ws-d', 'd1', JSON.stringify({ type: 'ai-title', aiTitle: 't', sessionId: 'd1' }));
    expect(await latestSessionId('ws-d')).toBe('d1');
    expect(await latestSessionId('ws-d')).toBe((await listSessions('ws-d'))[0]?.id ?? null);

    expect(await latestSessionId('ws-none')).toBeNull();
  });

  it('orders sessions tied on last_active_at by id', async () => {
    for (const id of ['s-b', 's-a', 's-c']) {
      await ingestLine('ws-tie', id, JSON.stringify({ type: 'ai-title', aiTitle: id, sessionId: id }));
    }
    expect((await listSessions('ws-tie')).map((s) => s.id)).toEqual(['s-a', 's-b', 's-c']);
    expect(await latestSessionId('ws-tie')).toBe('s-a');
  });
});
