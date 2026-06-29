// Cross-workspace isolation regression for the fleet-state MCP surface (#146).
//
// The leak: scoped reads were gated behind an opt-in env flag that defaulted
// OFF, so by default a workspace's read tools returned EVERY workspace's
// sessions, costs, and (via the raw `query` hatch) full transcript bodies.
// These tests pin the two halves of the fix:
//   1. The default allowed-read set is the caller's OWN workspace - never
//      "unrestricted" (no flag required).
//   2. The typed read tools, given a caller-scoped context, never surface
//      another workspace's rows; and the unscopable raw `query` hatch is gone.

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TOOLS, resolveAllowedWorkspaces, type ToolCtx } from './mcpServer.js';

const WS_A = '01WORKSPACEAAAAAAAAAAAAAAA';
const WS_B = '01WORKSPACEBBBBBBBBBBBBBBB';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL, workspace_id TEXT NOT NULL, ts INTEGER,
      type TEXT NOT NULL, subtype TEXT, uuid TEXT, parent_uuid TEXT, model TEXT,
      input_tokens INTEGER, output_tokens INTEGER, cache_read_input_tokens INTEGER,
      cache_creation_input_tokens INTEGER, service_tier TEXT, tool_name TEXT,
      tool_use_id TEXT, tool_input TEXT, tool_result_is_error INTEGER,
      raw_jsonl TEXT NOT NULL, dedup_key TEXT NOT NULL, UNIQUE(session_id, dedup_key)
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, cwd TEXT, started_at INTEGER,
      last_active_at INTEGER, ai_title TEXT, first_user_message TEXT, user_set_name TEXT
    );
    CREATE TABLE broker_sessions (
      workspace_id TEXT NOT NULL, broker_session_id TEXT NOT NULL,
      claude_session_id TEXT NOT NULL, learned_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, broker_session_id)
    );
  `);
  const sess = db.prepare(
    'INSERT INTO sessions (id, workspace_id, last_active_at, ai_title) VALUES (?,?,?,?)'
  );
  sess.run('sa', WS_A, 1000, 'A session');
  sess.run('sb', WS_B, 2000, 'B session (secret)');
  const ev = db.prepare(
    `INSERT INTO events (session_id, workspace_id, ts, type, model, input_tokens, output_tokens,
       service_tier, tool_name, tool_use_id, tool_input, tool_result_is_error, raw_jsonl, dedup_key)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  // A's session: one assistant token event + two tool_use events (a Bash and an Edit).
  ev.run('sa', WS_A, 1000, 'assistant', 'claude-x', 10, 20, 'standard', null, null, null, null, '{"a":1}', 'da');
  ev.run('sa', WS_A, 1100, 'assistant', 'claude-x', 0, 0, 'standard', 'Bash', 'u1', 'npm test', null, '{}', 'da2');
  ev.run('sa', WS_A, 1200, 'assistant', 'claude-x', 0, 0, 'standard', 'Edit', 'u2', '/workspace/foo.ts', null, '{}', 'da3');
  ev.run('sb', WS_B, 2000, 'assistant', 'claude-x', 99, 99, 'standard', null, null, null, null, '{"secret":true}', 'db');
  return db;
}

function tool(name: string) {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}

// A connection bound to workspace A: it may read only its own workspace.
const ctxA: ToolCtx = { callerId: WS_A, allowedWorkspaces: new Set([WS_A]) };

let db: Database.Database;
beforeEach(() => {
  db = makeDb();
});
afterEach(() => {
  db.close();
});

describe('default read scope (#146)', () => {
  it('defaults to the caller\'s OWN workspace, never unrestricted', async () => {
    const allowed = await resolveAllowedWorkspaces(WS_A);
    expect([...allowed]).toEqual([WS_A]);
  });
});

describe('typed read tools are workspace-scoped (#146)', () => {
  it('list_sessions returns only the caller\'s sessions', () => {
    const rows = tool('list_sessions').run(db, {}, ctxA) as Array<{ workspace_id: string }>;
    expect(rows.length).toBe(1);
    expect(rows.every((r) => r.workspace_id === WS_A)).toBe(true);
  });

  it('list_sessions cannot escape scope by naming another workspace', () => {
    const rows = tool('list_sessions').run(db, { workspace_id: WS_B }, ctxA) as unknown[];
    expect(rows).toEqual([]);
  });

  it('get_session hides another workspace\'s session', () => {
    expect(tool('get_session').run(db, { id: 'sb' }, ctxA)).toBeNull();
    expect(tool('get_session').run(db, { id: 'sa' }, ctxA)).not.toBeNull();
  });

  it('get_cost refuses another workspace\'s session', () => {
    expect(() => tool('get_cost').run(db, { session_id: 'sb' }, ctxA)).toThrow(/not authorized/i);
    expect(() => tool('get_cost').run(db, { session_id: 'sa' }, ctxA)).not.toThrow();
  });

  it('list_events refuses another workspace\'s session', () => {
    expect(() => tool('list_events').run(db, { session_id: 'sb' }, ctxA)).toThrow(/not authorized/i);
  });
});

describe('raw SQL escape hatch is removed (#146)', () => {
  it('exposes no query tool that could read other workspaces raw transcripts', () => {
    expect(TOOLS.find((t) => t.name === 'query')).toBeUndefined();
  });
});

describe('list_events richer projection (#174)', () => {
  it('includes parsed tool-detail columns by default', () => {
    const rows = tool('list_events').run(db, { session_id: 'sa' }, ctxA) as Array<Record<string, unknown>>;
    const edit = rows.find((r) => r.tool_name === 'Edit')!;
    expect(edit.tool_input).toBe('/workspace/foo.ts');
    expect(edit).toHaveProperty('tool_use_id', 'u2');
    expect(edit).toHaveProperty('tool_result_is_error');
  });

  it('filters by tool_name', () => {
    const rows = tool('list_events').run(db, { session_id: 'sa', tool_name: 'Bash' }, ctxA) as unknown[];
    expect(rows.length).toBe(1);
    expect((rows[0] as { tool_input: string }).tool_input).toBe('npm test');
  });

  it('projects only requested columns', () => {
    const rows = tool('list_events').run(
      db, { session_id: 'sa', tool_name: 'Edit', columns: ['tool_name', 'tool_input'] }, ctxA
    ) as Array<Record<string, unknown>>;
    expect(Object.keys(rows[0]).sort()).toEqual(['tool_input', 'tool_name']);
  });

  it('rejects unknown column names', () => {
    expect(() =>
      tool('list_events').run(db, { session_id: 'sa', columns: ['raw_jsonl; DROP TABLE events'] }, ctxA)
    ).toThrow(/unknown column/i);
  });
});

describe('ISO timestamps (#174)', () => {
  it('list_sessions adds ISO siblings for epoch fields', () => {
    const rows = tool('list_sessions').run(db, {}, ctxA) as Array<Record<string, unknown>>;
    expect(rows[0].last_active_at_iso).toBe(new Date(1000).toISOString());
  });

  it('list_events adds ts_iso', () => {
    const rows = tool('list_events').run(db, { session_id: 'sa', tool_name: 'Bash' }, ctxA) as Array<Record<string, unknown>>;
    expect(rows[0].ts_iso).toBe(new Date(1100).toISOString());
  });
});

describe('session_summary (#174)', () => {
  it('summarizes files, commands, cost and time span for an allowed session', () => {
    const s = tool('session_summary').run(db, { id: 'sa' }, ctxA) as Record<string, unknown>;
    expect(s.session_id).toBe('sa');
    expect(s.filesEdited).toEqual(['/workspace/foo.ts']);
    expect(s.commands).toEqual(['npm test']);
    expect(s.last_active_at).toBe(1200);
    expect(s.last_active_at_iso).toBe(new Date(1200).toISOString());
    expect(typeof s.usd).toBe('number');
    expect(s.inputTokens).toBe(10);
  });

  it('refuses a session outside the allowed set', () => {
    expect(() => tool('session_summary').run(db, { id: 'sb' }, ctxA)).toThrow(/not authorized/i);
  });
});
