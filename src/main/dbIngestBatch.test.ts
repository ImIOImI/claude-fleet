// state.db ingest port (async store part 2a). The characterization snapshot
// was recorded on the pre-port synchronous ingestLine; every later version of
// the ingest path must reproduce it byte-for-byte.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import * as db from './db.js';

const WS = '01WSINGEST';
const S = 'sess-ingest';

const at = (s: number): string => new Date(Date.UTC(2026, 6, 1, 0, 0, s)).toISOString();

/** One line of every shape ingest treats specially, plus replays + junk. */
export const FIXTURE: string[] = [
  JSON.stringify({ type: 'system', uuid: 'sys1', timestamp: at(0), cwd: '/workspace/app', subtype: 'init' }),
  JSON.stringify({ type: 'user', uuid: 'u1', timestamp: at(1), message: { role: 'user', content: '<command-name>/clear</command-name>' } }),
  JSON.stringify({ type: 'user', uuid: 'u2', timestamp: at(2), isMeta: true, message: { role: 'user', content: 'meta, never a title' } }),
  JSON.stringify({ type: 'user', uuid: 'u3', timestamp: at(3), message: { role: 'user', content: 'fix the reconnect bug' } }),
  JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u3', timestamp: at(4), message: { model: 'claude-opus-4-1', usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 5, service_tier: 'standard' }, content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls -la' } }] } }),
  JSON.stringify({ type: 'user', uuid: 'u4', timestamp: at(5), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: 'nope' }] } }),
  JSON.stringify({ type: 'assistant', uuid: 'a2', timestamp: at(6), message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 3, output_tokens: 7 }, content: [{ type: 'tool_use', id: 'tu2', name: 'Read', input: { file_path: '/x.ts' } }] } }),
  JSON.stringify({ type: 'user', uuid: 'u5', timestamp: at(7), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'ok' }] } }),
  JSON.stringify({ type: 'ai-title', aiTitle: 'Reconnect bug', sessionId: S }),
  JSON.stringify({ type: 'last-prompt', lastPrompt: 'a later prompt', sessionId: S }),
  '{"type":"assistant","uuid":"broken',
  JSON.stringify({ type: 'assistant', uuid: 'a3', timestamp: at(9), error: 'rate_limit', isApiErrorMessage: true, apiErrorStatus: 429, message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit · resets 6pm (UTC)" }] } }),
  JSON.stringify({ type: 'session-summary', summary: 'Fixed the reconnect bug.', tags: ['Broker', ' reconnect ', 7], model: 'haiku', fromEventTs: at(1), toEventTs: at(9), timestamp: at(10) }),
  JSON.stringify({ type: 'ai-title', aiTitle: 'Reconnect bug, fixed', sessionId: S }),
  JSON.stringify({ type: 'assistant', uuid: 'a1', timestamp: at(4), message: { model: 'claude-opus-4-1', usage: { input_tokens: 10, output_tokens: 20 } } }),
  JSON.stringify({ type: 'system', uuid: 'sys2', timestamp: at(11), cwd: '/elsewhere' }),
  JSON.stringify({ type: 'assistant', uuid: 'a4', timestamp: at(12), message: { model: 'claude-opus-4-1', usage: { input_tokens: 50000, output_tokens: 1, cache_read_input_tokens: 2 }, content: [{ type: 'tool_use', id: 'tu3', name: 'Bash', input: { command: 'npm test' } }] } }),
];

/** Every ingest-maintained table, in primary-key order, minus raw_jsonl. */
export function dump(raw: Database.Database): Record<string, unknown[]> {
  const q = (sqlText: string): unknown[] => raw.prepare(sqlText).all();
  return {
    events: q(`SELECT id, session_id, workspace_id, ts, type, subtype, uuid, parent_uuid, model, input_tokens, output_tokens,
                      cache_read_input_tokens, cache_creation_input_tokens, service_tier, tool_name, tool_use_id, tool_input,
                      tool_result_is_error, dedup_key FROM events ORDER BY id`),
    sessions: q(`SELECT * FROM sessions ORDER BY id`),
    session_costs: q(`SELECT * FROM session_costs ORDER BY session_id, workspace_id, model, service_tier`),
    session_stats: q(`SELECT * FROM session_stats ORDER BY session_id`),
    session_tool_counts: q(`SELECT * FROM session_tool_counts ORDER BY session_id, tool_name`),
    session_summaries: q(`SELECT * FROM session_summaries ORDER BY id`),
    session_tags: q(`SELECT * FROM session_tags ORDER BY session_id, tag`),
    usage_anchors: q(`SELECT * FROM usage_anchors ORDER BY id`),
  };
}

let dir: string;
let raw: Database.Database;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cf-ingest-batch-'));
  raw = db.openDb(dir);
});
afterEach(async () => {
  await db.closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe('ingest characterization (recorded on the pre-port code)', () => {
  it('line-by-line ingest of the fixture produces the recorded state', async () => {
    const results = [];
    for (const line of FIXTURE) results.push(await db.ingestLine(WS, S, line));
    expect(results).toMatchSnapshot('results');
    expect(dump(raw)).toMatchSnapshot('state');
  });

  it('a trailing ts-less line nulls last_active_at (pre-existing MAX(…, NULL) rule, preserved)', async () => {
    for (const line of FIXTURE) await db.ingestLine(WS, S, line);
    await db.ingestLine(WS, S, JSON.stringify({ type: 'ai-title', aiTitle: 'light', sessionId: S }));
    expect(raw.prepare('SELECT started_at, last_active_at FROM sessions WHERE id = ?').get(S)).toMatchSnapshot();
  });
});

describe('ingestBatch (async store part 2a)', () => {
  it('one batch produces exactly the line-by-line state and per-line results', async () => {
    const lineResults = [];
    for (const line of FIXTURE) lineResults.push(await db.ingestLine(WS, S, line));
    const lineState = dump(raw);
    await db.closeDb();
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), 'cf-ingest-batch-'));
    raw = db.openDb(dir);
    expect(await db.ingestBatch(WS, S, FIXTURE)).toEqual(lineResults);
    expect(dump(raw)).toEqual(lineState);
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
    expect(raw.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: n - 3 });
    expect(raw.prepare('SELECT event_count FROM session_costs WHERE session_id = ?').get(S)).toEqual({ event_count: n - 3 });
  });

  it('a failing line rolls back its whole chunk and rejects', async () => {
    raw.exec('DROP TABLE session_tags'); // the session-summary line's tag insert will throw
    await expect(db.ingestBatch(WS, S, FIXTURE)).rejects.toThrow(/session_tags/);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 0 });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM session_costs').get()).toEqual({ n: 0 });
  });

  it('promotes a parked remap inside the batch that makes its session real', async () => {
    await db.ingestLine(WS, 'claude-real', FIXTURE[3]);
    await db.learnBrokerSessionMapping(WS, 'tab-1', 'claude-real');
    expect(await db.recordBrokerSessionMapping(WS, 'tab-1', 'claude-next')).toEqual({ mode: 'deferred', previous: 'claude-real' });
    expect(db.lookupBrokerSession(WS, 'tab-1')).toBe('claude-real');
    await db.ingestBatch(WS, 'claude-next', [FIXTURE[4], FIXTURE[6]]);
    expect(db.lookupBrokerSession(WS, 'tab-1')).toBe('claude-next');
    expect(raw.prepare('SELECT pending_claude_session_id FROM broker_sessions').get()).toEqual({ pending_claude_session_id: null });
  });

  it('a remap racing the first batch of its session always ends committed, never stranded', async () => {
    await db.ingestLine(WS, 'claude-real', FIXTURE[3]);
    await db.learnBrokerSessionMapping(WS, 'tab-1', 'claude-real');
    await Promise.all([
      db.recordBrokerSessionMapping(WS, 'tab-1', 'claude-next'),
      db.ingestBatch(WS, 'claude-next', [FIXTURE[4]]),
    ]);
    expect(raw.prepare('SELECT claude_session_id, pending_claude_session_id FROM broker_sessions').get())
      .toEqual({ claude_session_id: 'claude-next', pending_claude_session_id: null });
  });

  it('closeDb waits for an in-flight batch before closing', async () => {
    const pending = db.ingestBatch(WS, S, FIXTURE);
    await db.closeDb();
    await expect(pending).resolves.toHaveLength(FIXTURE.length);
    raw = db.openDb(dir); // afterEach closes it again
    expect(raw.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 15 });
  });
});
