// The fleet-state read tools on both history stores: the same fixture through
// sqliteReadSource (the MCP read-only connection) and pgReadSource must give
// the same results, scoped to the caller's workspaces.
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as db from './db.js';
import { TOOLS, setQueryEmbedder, setUsageRecorder, type ToolCtx } from './mcpServer.js';
import { costFor } from './pricing.js';
import { sqliteReadSource } from './sqliteReadSource.js';
import { pgReadSource } from './store/pgReadSource.js';
import type { ReadSource } from './store/readSource.js';
import { isPg, openTestState, queryRows, type TestState } from './store/testStore.js';
import { EMBED_DIM, EMBED_MODEL_ID, encodeVector } from './vectors.js';

const WS_A = '01WORKSPACEAAAAAAAAAAAAAAA';
const WS_B = '01WORKSPACEBBBBBBBBBBBBBBB';
const ctxA: ToolCtx = { callerId: WS_A, allowedWorkspaces: new Set([WS_A]) };
const unit = (i: number): Float32Array => { const v = new Float32Array(EMBED_DIM); v[i] = 1; return v; };

let st: TestState;
let rs: ReadSource;

async function seed(): Promise<void> {
  await queryRows(
    'INSERT INTO sessions (id, workspace_id, started_at, last_active_at, ai_title) VALUES (?,?,?,?,?), (?,?,?,?,?), (?,?,?,?,?)',
    ['sa', WS_A, 900, 1000, 'A session', 'sa-old', WS_A, 100, null, 'A untouched', 'sb', WS_B, 1900, 2000, 'B secret'],
  );
  const ev = 'INSERT INTO events (session_id, workspace_id, ts, type, model, service_tier, input_tokens, output_tokens, tool_name, tool_input, raw_jsonl, dedup_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)';
  await queryRows(ev, ['sa', WS_A, 1000, 'assistant', 'claude-x', 'standard', 10, 20, null, null, '{}', 'a1']);
  await queryRows(ev, ['sa', WS_A, 1100, 'assistant', 'claude-x', 'standard', 0, 0, 'Bash', 'npm test', '{}', 'a2']);
  await queryRows(ev, ['sa', WS_A, 1200, 'assistant', 'claude-x', 'standard', 0, 0, 'Edit', '/workspace/foo.ts', '{}', 'a3']);
  await queryRows(ev, ['sa', WS_A, 1300, 'assistant', null, null, 5, 7, null, null, '{}', 'a4']);
  await queryRows(ev, ['sb', WS_B, 2000, 'assistant', 'claude-x', 'standard', 99, 99, 'Bash', 'cat secret', '{}', 'b1']);
  const err = "INSERT INTO errors (ts, workspace_id, session_id, source, level, type, message) VALUES (?, ?, ?, 'main', ?, 'x', ?)";
  await queryRows(err, [1, WS_A, 'sa', 'warn', 'A degraded']);
  await queryRows(err, [2, WS_B, 'sb', 'error', 'B secret error']);
  await queryRows(err, [3, null, null, 'error', 'global crash']);
  await db.insertEmbeddings([
    { workspaceId: WS_A, sessionId: 'sa', kind: 'turn', refEventId: 1, ts: 1000, text: 'A content', modelId: EMBED_MODEL_ID, dim: EMBED_DIM, vec: encodeVector(unit(0)), dedupKey: 'ea' },
    { workspaceId: WS_B, sessionId: 'sb', kind: 'turn', refEventId: 5, ts: 2000, text: 'B secret content', modelId: EMBED_MODEL_ID, dim: EMBED_DIM, vec: encodeVector(unit(0)), dedupKey: 'eb' },
  ]);
}

function tool(name: string) {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}
const run = (name: string, args: Record<string, unknown>, ctx: ToolCtx = ctxA) => tool(name).run(rs, args, ctx);

describe(`fleet-state read tools on ${isPg ? 'Postgres' : 'SQLite'}`, () => {
  beforeEach(async () => {
    st = await openTestState('cf-mcp-rs-');
    await seed();
    rs = isPg ? pgReadSource({ isolation: null }) : sqliteReadSource(new Database(join(st.dir, 'state.db'), { readonly: true, fileMustExist: true }));
  });
  afterEach(async () => {
    await rs.close();
    await st.close();
  });

  it('list_sessions: the caller\'s sessions, newest first, a NULL last_active_at last', async () => {
    expect(await run('list_sessions', {})).toEqual([
      { id: 'sa', workspace_id: WS_A, cwd: null, started_at: 900, last_active_at: 1000, ai_title: 'A session', first_user_message: null, user_set_name: null,
        started_at_iso: new Date(900).toISOString(), last_active_at_iso: new Date(1000).toISOString() },
      { id: 'sa-old', workspace_id: WS_A, cwd: null, started_at: 100, last_active_at: null, ai_title: 'A untouched', first_user_message: null, user_set_name: null,
        started_at_iso: new Date(100).toISOString() },
    ]);
    expect(await run('list_sessions', { workspace_id: WS_B })).toEqual([]);
    expect((await run('list_sessions', { since: 500 }) as Array<{ id: string }>).map((r) => r.id)).toEqual(['sa']);
    expect((await run('list_sessions', { limit: 1 }) as unknown[]).length).toBe(1);
  });

  it('get_session hides another workspace\'s session', async () => {
    expect(await run('get_session', { id: 'sb' })).toBeNull();
    expect(await run('get_session', { id: 'sa' })).toMatchObject({ id: 'sa', ai_title: 'A session' });
  });

  it('get_cost sums per (model, tier) and refuses another workspace', async () => {
    const usd = costFor(null, null, { inputTokens: 5, outputTokens: 7, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 })
      + costFor('claude-x', 'standard', { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
    expect(await run('get_cost', { session_id: 'sa' })).toEqual({
      session_id: 'sa', usd, inputTokens: 15, outputTokens: 27, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
    });
    await expect(run('get_cost', { session_id: 'sb' })).rejects.toThrow(/not authorized/);
  });

  it('list_events: id order, filters and projection; another workspace refused', async () => {
    expect(await run('list_events', { session_id: 'sa', columns: ['id', 'tool_name'] })).toEqual([
      { id: 1, tool_name: null }, { id: 2, tool_name: 'Bash' }, { id: 3, tool_name: 'Edit' }, { id: 4, tool_name: null },
    ]);
    expect(await run('list_events', { session_id: 'sa', tool_name: 'Bash', columns: ['tool_input', 'ts'] })).toEqual([
      { tool_input: 'npm test', ts: 1100, ts_iso: new Date(1100).toISOString() },
    ]);
    expect((await run('list_events', { session_id: 'sa', since: 1200 }) as unknown[]).length).toBe(2);
    await expect(run('list_events', { session_id: 'sb' })).rejects.toThrow(/not authorized/);
  });

  it('session_summary: files, commands, cost and span', async () => {
    const s = await run('session_summary', { id: 'sa' }) as Record<string, unknown>;
    expect(s).toMatchObject({
      session_id: 'sa', filesEdited: ['/workspace/foo.ts'], filesEditedCount: 1, commands: ['npm test'], commandsCount: 1,
      inputTokens: 15, outputTokens: 27, started_at: 1000, last_active_at: 1300,
    });
    await expect(run('session_summary', { id: 'sb' })).rejects.toThrow(/not authorized/);
  });

  it('list_errors: own and global rows, newest first; a workspace_id only narrows', async () => {
    const msgs = async (args: Record<string, unknown>) => (await run('list_errors', args) as Array<{ message: string }>).map((r) => r.message);
    expect(await msgs({})).toEqual(['global crash', 'A degraded']);
    expect(await msgs({ workspace_id: WS_B })).toEqual(['global crash']);
    expect(await msgs({ level: 'warn' })).toEqual(['A degraded']);
  });

  it('search_transcripts never returns another workspace\'s hit', async () => {
    setQueryEmbedder(async (texts) => texts.map(() => unit(0)));
    const hits = await run('search_transcripts', { query: 'anything' }) as Array<{ workspaceId: string; text: string; score: number }>;
    expect(hits.map((h) => [h.workspaceId, h.text])).toEqual([[WS_A, 'A content']]);
    expect(hits[0].score).toBeCloseTo(1, 5);
    expect(await run('search_transcripts', { query: 'anything', workspace_id: WS_B })).toEqual([]);
  });

  it('mark_useful records for an allowed session and refuses another workspace\'s', async () => {
    const events: unknown[] = [];
    setUsageRecorder((e) => { events.push(e); });
    await run('mark_useful', { sessionId: 'sa' });
    await expect(run('mark_useful', { sessionId: 'sb' })).rejects.toThrow(/not found/);
    expect(events).toEqual([{ workspaceId: WS_A, sessionId: 'sa', kind: 'marked-useful', detail: undefined }]);
    setUsageRecorder(() => {});
  });
});
