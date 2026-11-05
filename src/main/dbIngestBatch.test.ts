// state.db ingest port (async store part 2a). The characterization snapshot
// was recorded on the pre-port synchronous ingestLine; every later version of
// the ingest path must reproduce it byte-for-byte.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import * as db from './db.js';
import { WS, S, at, FIXTURE, dump } from './state/ingestFixture.js';
import { openTestState, queryRows, type TestState } from './store/testStore.js';

let dir: string;
let raw: Database.Database;
let st: TestState;
beforeEach(async () => {
  st = await openTestState('cf-ingest-batch-');
  dir = st.dir;
});
afterEach(async () => {
  await st.close();
});

describe('ingest characterization (recorded on the pre-port code)', () => {
  it('line-by-line ingest of the fixture produces the recorded state', async () => {
    const results = [];
    for (const line of FIXTURE) results.push(await db.ingestLine(WS, S, line));
    expect(results).toMatchSnapshot('results');
    expect(await dump()).toMatchSnapshot('state');
  });

  it('a trailing ts-less line nulls last_active_at (pre-existing MAX(…, NULL) rule, preserved)', async () => {
    for (const line of FIXTURE) await db.ingestLine(WS, S, line);
    await db.ingestLine(WS, S, JSON.stringify({ type: 'ai-title', aiTitle: 'light', sessionId: S }));
    expect((await queryRows('SELECT started_at, last_active_at FROM sessions WHERE id = ?', [S]))[0]).toMatchSnapshot();
  });
});

describe('ingestBatch (async store part 2a)', () => {
  it('one batch produces exactly the line-by-line state and per-line results', async () => {
    const lineResults = [];
    for (const line of FIXTURE) lineResults.push(await db.ingestLine(WS, S, line));
    const lineState = await dump();
    await st.close();
    st = await openTestState('cf-ingest-batch-');
    dir = st.dir;
    expect(await db.ingestBatch(WS, S, FIXTURE)).toEqual(lineResults);
    expect(await dump()).toEqual(lineState);
  });

  it('returns one result per line, in input order, malformed included', async () => {
    const results = await db.ingestBatch(WS, S, ['{"nope', FIXTURE[3], FIXTURE[3]]);
    expect(results).toEqual([
      { inserted: false, sessionId: S, type: 'malformed' },
      { inserted: true, sessionId: S, type: 'user' },
      { inserted: false, sessionId: S, type: 'user' },
    ]);
  });

  it('splits into INGEST_TX_LINES transactions without changing the outcome', async () => {
    const n = db.INGEST_TX_LINES * 2 + 7;
    const lines = Array.from({ length: n }, (_, i) =>
      JSON.stringify({ type: 'assistant', uuid: `big-${i % (n - 3)}`, timestamp: at(i % 50), message: { model: 'claude-opus-4-1', usage: { input_tokens: 1, output_tokens: 1 } } }),
    );
    const results = await db.ingestBatch(WS, S, lines);
    expect(results).toHaveLength(n);
    expect(results.filter((r) => r.inserted)).toHaveLength(n - 3); // the last 3 replay earlier uuids across a chunk boundary
    expect((await queryRows('SELECT COUNT(*) AS n FROM events'))[0]).toEqual({ n: n - 3 });
    expect((await queryRows('SELECT event_count FROM session_costs WHERE session_id = ?', [S]))[0]).toEqual({ event_count: n - 3 });
  });

  it('a failing line rolls back its whole chunk and rejects', async () => {
    await queryRows('DROP TABLE session_tags'); // the session-summary line's tag insert will throw
    await expect(db.ingestBatch(WS, S, FIXTURE)).rejects.toThrow(/session_tags/);
    expect((await queryRows('SELECT COUNT(*) AS n FROM events'))[0]).toEqual({ n: 0 });
    expect((await queryRows('SELECT COUNT(*) AS n FROM session_costs'))[0]).toEqual({ n: 0 });
  });

  it('promotes a parked remap inside the batch that makes its session real', async () => {
    await db.ingestLine(WS, 'claude-real', FIXTURE[3]);
    await db.learnBrokerSessionMapping(WS, 'tab-1', 'claude-real');
    expect(await db.recordBrokerSessionMapping(WS, 'tab-1', 'claude-next')).toEqual({ mode: 'deferred', previous: 'claude-real' });
    expect(await db.lookupBrokerSession(WS, 'tab-1')).toBe('claude-real');
    await db.ingestBatch(WS, 'claude-next', [FIXTURE[4], FIXTURE[6]]);
    expect(await db.lookupBrokerSession(WS, 'tab-1')).toBe('claude-next');
    expect((await queryRows('SELECT pending_claude_session_id FROM broker_sessions'))[0]).toEqual({ pending_claude_session_id: null });
  });

  it('a remap racing the first batch of its session always ends committed, never stranded', async () => {
    await db.ingestLine(WS, 'claude-real', FIXTURE[3]);
    await db.learnBrokerSessionMapping(WS, 'tab-1', 'claude-real');
    await Promise.all([
      db.recordBrokerSessionMapping(WS, 'tab-1', 'claude-next'),
      db.ingestBatch(WS, 'claude-next', [FIXTURE[4]]),
    ]);
    expect((await queryRows('SELECT claude_session_id, pending_claude_session_id FROM broker_sessions'))[0])
      .toEqual({ claude_session_id: 'claude-next', pending_claude_session_id: null });
  });

  it('closeDb waits for an in-flight batch before closing', async () => {
    const pending = db.ingestBatch(WS, S, FIXTURE);
    await db.closeDb();
    await expect(pending).resolves.toHaveLength(FIXTURE.length);
    await st.open(); // afterEach closes it again
    expect((await queryRows('SELECT COUNT(*) AS n FROM events'))[0]).toEqual({ n: 15 });
  });
});
