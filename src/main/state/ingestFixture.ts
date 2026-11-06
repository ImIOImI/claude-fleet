// The state.db ingest fixture shared by the ingest and read characterization
// tests. Test support only: never imported by app code.
import { sql } from 'kysely';
import { stateKysely } from '../db.js';

export const WS = '01WSINGEST';
export const S = 'sess-ingest';

export const at = (s: number): string => new Date(Date.UTC(2026, 6, 1, 0, 0, s)).toISOString();

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
export async function dump(): Promise<Record<string, unknown[]>> {
  const q = async (sqlText: string): Promise<unknown[]> => (await sql.raw(sqlText).execute(stateKysely())).rows as unknown[];
  return {
    events: await q(`SELECT id, session_id, workspace_id, ts, type, subtype, uuid, parent_uuid, model, input_tokens, output_tokens,
                      cache_read_input_tokens, cache_creation_input_tokens, service_tier, tool_name, tool_use_id, tool_input,
                      tool_result_is_error, dedup_key FROM events ORDER BY id`),
    sessions: await q(`SELECT * FROM sessions ORDER BY id`),
    session_costs: await q(`SELECT * FROM session_costs ORDER BY session_id, workspace_id, model, service_tier`),
    session_stats: await q(`SELECT * FROM session_stats ORDER BY session_id`),
    session_tool_counts: await q(`SELECT * FROM session_tool_counts ORDER BY session_id, tool_name`),
    session_summaries: await q(`SELECT * FROM session_summaries ORDER BY id`),
    session_tags: await q(`SELECT * FROM session_tags ORDER BY session_id, tag`),
    usage_anchors: await q(`SELECT * FROM usage_anchors ORDER BY id`),
  };
}
