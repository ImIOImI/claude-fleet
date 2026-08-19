// Cross-workspace isolation regression for the fleet-state MCP surface (#146).
//
// The leak: scoped reads were gated behind an opt-in env flag that defaulted
// OFF, so by default a workspace's read tools returned EVERY workspace's
// sessions, costs, and (via the raw `query` hatch) full transcript bodies.
// These tests pin the two halves of the fix:
//   1. The default allowed-read set is the caller's OWN workspace - never
//      "unrestricted" (no flag required).
//   2. The typed read tools, given a caller-scoped context, never surface
//      another workspace's rows; and the scoped `query` tool (#174) uses a
//      per-call in-memory snapshot so isolation is structural, not row-filtered.

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TOOLS, resolveAllowedWorkspaces, setInputWaitHandler, setSessionMappingHandler, setSummaryStatusHandler, setQueryEmbedder, setUsageRecorder, setConfigResolver, _resetTelemetryForTests, type ToolCtx } from './mcpServer.js';
import { EMBED_DIM, EMBED_MODEL_ID } from './vectors.js';
import { closeDb, openDb } from './db.js';
import { PerfStore } from './perfStore.js';
import { initPerf, shutdownPerf } from './perf.js';
import { disarmSentinel } from './perfSentinel.js';
import type { EffectivePerfConfig } from './perfConfig.js';

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
  db.exec(`
    CREATE TABLE errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, workspace_id TEXT,
      session_id TEXT, source TEXT NOT NULL, level TEXT NOT NULL, type TEXT NOT NULL,
      message TEXT NOT NULL, stack TEXT, extra TEXT
    );
    CREATE TABLE session_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      tags TEXT,
      source_max_event_id INTEGER NOT NULL,
      from_ts INTEGER,
      to_ts INTEGER,
      model TEXT,
      generated_at INTEGER NOT NULL,
      UNIQUE(session_id, source_max_event_id)
    );
    CREATE TABLE session_tags (
      workspace_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      PRIMARY KEY (session_id, tag)
    );
    CREATE TABLE usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      workspace_id TEXT NOT NULL,
      session_id TEXT,
      kind TEXT NOT NULL,
      detail TEXT
    );
  `);
  const err = db.prepare(
    'INSERT INTO errors (ts, workspace_id, session_id, source, level, type, message) VALUES (?,?,?,?,?,?,?)'
  );
  err.run(1000, WS_A, 'sa', 'main', 'warn', 'mapping-unresolved', 'A degraded');
  err.run(2000, WS_B, 'sb', 'main', 'error', 'pty-attach-failed', 'B secret error');
  err.run(3000, null, null, 'main', 'error', 'uncaughtException', 'global crash');
  return db;
}

// query ATTACHes db.name, so it needs a real file (not :memory:). Mirror makeDb's
// rows into a temp-file DB. Returns the db + a cleanup fn.
function makeFileDb(): { db: Database.Database; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-q-'));
  const path = join(dir, 'state.db');
  const fileDb = new Database(path);
  fileDb.exec(`
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
    CREATE TABLE session_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      tags TEXT,
      source_max_event_id INTEGER NOT NULL,
      from_ts INTEGER,
      to_ts INTEGER,
      model TEXT,
      generated_at INTEGER NOT NULL,
      UNIQUE(session_id, source_max_event_id)
    );
    CREATE TABLE session_tags (
      workspace_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      PRIMARY KEY (session_id, tag)
    );
    CREATE TABLE usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      workspace_id TEXT NOT NULL,
      session_id TEXT,
      kind TEXT NOT NULL,
      detail TEXT
    );
    CREATE TABLE perf_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      workspace_id TEXT,
      session_id TEXT,
      name TEXT,
      dur_ms REAL,
      trace_id TEXT,
      span_id TEXT,
      meta TEXT
    );
  `);
  const sess = fileDb.prepare('INSERT INTO sessions (id, workspace_id, last_active_at, ai_title) VALUES (?,?,?,?)');
  sess.run('sa', WS_A, 1000, 'A session');
  sess.run('sb', WS_B, 2000, 'B session (secret)');
  const ev = fileDb.prepare(
    `INSERT INTO events (session_id, workspace_id, ts, type, raw_jsonl, dedup_key) VALUES (?,?,?,?,?,?)`
  );
  ev.run('sa', WS_A, 1000, 'assistant', '{"a":1}', 'da');
  ev.run('sb', WS_B, 2000, 'assistant', '{"secret":true}', 'db');
  return { db: fileDb, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
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

describe('scoped query tool (#174)', () => {
  let fdb: Database.Database;
  let cleanup: () => void;
  beforeEach(() => {
    ({ db: fdb, cleanup } = makeFileDb());
  });
  afterEach(() => {
    fdb.close();
    cleanup();
  });
  const run = (args: Record<string, unknown>) => tool('query').run(fdb, args, ctxA);

  it('returns only the caller\'s rows for a plain select', () => {
    const rows = run({ sql: 'SELECT workspace_id FROM sessions' }) as Array<{ workspace_id: string }>;
    expect(rows.every((r) => r.workspace_id === WS_A)).toBe(true);
    expect(rows.length).toBe(1);
  });

  it('cannot reach another workspace via UNION / subquery / where', () => {
    const r1 = run({ sql: "SELECT * FROM sessions WHERE workspace_id = '" + WS_B + "'" }) as unknown[];
    expect(r1).toEqual([]);
    const r2 = run({ sql: 'SELECT count(*) AS n FROM events' }) as Array<{ n: number }>;
    expect(r2[0].n).toBe(1); // only A's event is in the snapshot
  });

  it('cannot introspect/escape via sqlite_master', () => {
    const names = run({ sql: 'SELECT name FROM sqlite_master ORDER BY name' }) as Array<{ name: string }>;
    expect(names.map((r) => r.name).sort()).toEqual(
      ['broker_sessions', 'events', 'perf_events', 'session_summaries', 'session_tags', 'sessions', 'usage_events']
    );
  });

  it('omits raw_jsonl by default and includes it only with include_raw', () => {
    expect(() => run({ sql: 'SELECT raw_jsonl FROM events' })).toThrow(); // column not in snapshot
    const rows = run({ sql: 'SELECT raw_jsonl FROM events', include_raw: true }) as Array<{ raw_jsonl: string }>;
    expect(rows[0].raw_jsonl).toBe('{"a":1}'); // A\'s own row only
  });

  it('rejects writes / DDL / multi-statement', () => {
    expect(() => run({ sql: "INSERT INTO events (session_id) VALUES ('x')" })).toThrow(/read-only/i);
    expect(() => run({ sql: 'DROP TABLE events' })).toThrow(/read-only/i);
    expect(() => run({ sql: 'UPDATE sessions SET ai_title = 1' })).toThrow(/read-only/i);
    expect(() => run({ sql: 'SELECT 1; SELECT 2' })).toThrow();
  });

  it('caps result rows via max_rows', () => {
    const rows = run({ sql: 'SELECT 1 AS x FROM sessions, events', max_rows: 1 }) as unknown[];
    expect(rows.length).toBe(1);
  });

  it('supports bound params', () => {
    const rows = run({ sql: 'SELECT id FROM sessions WHERE id = ?', params: ['sa'] }) as Array<{ id: string }>;
    expect(rows).toEqual([{ id: 'sa' }]);
  });
});

describe('query snapshot exposes phase-2 tables, workspace-scoped (#207)', () => {
  let fdb: Database.Database;
  let cleanup: () => void;
  beforeEach(() => {
    ({ db: fdb, cleanup } = makeFileDb());
  });
  afterEach(() => {
    fdb.close();
    cleanup();
  });
  const run = (args: Record<string, unknown>) => tool('query').run(fdb, args, ctxA);

  it('session_tags are readable and scoped', () => {
    fdb.prepare(`INSERT INTO session_tags VALUES (?, 'sa', 'broker')`).run(WS_A);
    fdb.prepare(`INSERT INTO session_tags VALUES (?, 'sb', 'secret-tag')`).run(WS_B);
    const rows = run({ sql: 'SELECT tag FROM session_tags ORDER BY tag' }) as Array<{ tag: string }>;
    expect(rows.map((r) => r.tag)).toEqual(['broker']);
  });

  it('session_summaries are readable and scoped', () => {
    fdb.prepare(`INSERT INTO session_summaries (session_id, workspace_id, summary, source_max_event_id, generated_at) VALUES (?, ?, ?, ?, ?)`).run('sa', WS_A, 'A summary', 1, 1000);
    fdb.prepare(`INSERT INTO session_summaries (session_id, workspace_id, summary, source_max_event_id, generated_at) VALUES (?, ?, ?, ?, ?)`).run('sb', WS_B, 'B secret summary', 2, 2000);
    const rows = run({ sql: 'SELECT session_id FROM session_summaries ORDER BY session_id' }) as Array<{ session_id: string }>;
    expect(rows.map((r) => r.session_id)).toEqual(['sa']);
  });

  it('usage_events are readable and scoped', () => {
    fdb.prepare(`INSERT INTO usage_events (ts, workspace_id, session_id, kind) VALUES (?, ?, ?, ?)`).run(1000, WS_A, 'sa', 'marked-useful');
    fdb.prepare(`INSERT INTO usage_events (ts, workspace_id, session_id, kind) VALUES (?, ?, ?, ?)`).run(2000, WS_B, 'sb', 'secret-event');
    const rows = run({ sql: 'SELECT kind FROM usage_events ORDER BY kind' }) as Array<{ kind: string }>;
    expect(rows.map((r) => r.kind)).toEqual(['marked-useful']);
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

  it('rejects raw_jsonl in the columns projection', () => {
    expect(() => tool('list_events').run(db, { session_id: 'sa', columns: ['raw_jsonl'] }, ctxA)).toThrow(/unknown column/i);
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

describe('list_errors', () => {
  const t = TOOLS.find((t) => t.name === 'list_errors')!;
  const ctx = (allowed: string[]): ToolCtx => ({
    callerId: allowed[0], allowedWorkspaces: new Set(allowed)
  });

  it('returns own-workspace errors + global (NULL) rows, never another workspace', () => {
    const rows = t.run(db, {}, ctx([WS_A])) as Array<Record<string, unknown>>;
    const types = rows.map((r) => r.type);
    expect(types).toContain('mapping-unresolved'); // WS_A
    expect(types).toContain('uncaughtException');  // global
    expect(types).not.toContain('pty-attach-failed'); // WS_B — must be hidden
  });

  it('includes a ts_iso sibling and orders newest-first', () => {
    const rows = t.run(db, {}, ctx([WS_A])) as Array<Record<string, unknown>>;
    expect(typeof rows[0].ts_iso).toBe('string');
    expect(rows[0].ts as number).toBeGreaterThanOrEqual(rows[rows.length - 1].ts as number);
  });

  it('filters by level', () => {
    const rows = t.run(db, { level: 'warn' }, ctx([WS_A])) as Array<Record<string, unknown>>;
    expect(rows.every((r) => r.level === 'warn')).toBe(true);
  });

  it('workspace_id filter preserves global (NULL) crash rows', () => {
    // An agent narrowing to its own workspace must still see global app crashes.
    const rows = t.run(db, { workspace_id: WS_A }, ctx([WS_A])) as Array<Record<string, unknown>>;
    const types = rows.map((r) => r.type);
    expect(types).toContain('mapping-unresolved'); // WS_A own row
    expect(types).toContain('uncaughtException');  // global NULL row
    expect(types).not.toContain('pty-attach-failed'); // WS_B — must stay hidden
  });
});

describe('signal_input_wait', () => {
  const ctx: ToolCtx = { callerId: 'ws-A', allowedWorkspaces: new Set(['ws-A']) };
  const tool = () => TOOLS.find((t) => t.name === 'signal_input_wait')!;

  afterEach(() => setInputWaitHandler(() => {}));

  it('forwards (callerId, sessionId, waiting) to the injected handler', () => {
    const calls: Array<[string, string, boolean]> = [];
    setInputWaitHandler((c, s, w) => calls.push([c, s, w]));
    tool().run({} as never, { sessionId: 'sess-1', waiting: true }, ctx);
    expect(calls).toEqual([['ws-A', 'sess-1', true]]);
  });

  it('rejects bad args', () => {
    setInputWaitHandler(() => {});
    expect(() => tool().run({} as never, { sessionId: 'x' }, ctx)).toThrow(/required/);
  });
});

describe('report_session_mapping (#207)', () => {
  afterEach(() => setSessionMappingHandler(() => {}));
  it('forwards (callerId, brokerSessionId, sessionId) to the injected handler', () => {
    const calls: Array<[string, string, string]> = [];
    setSessionMappingHandler((c, b, s) => calls.push([c, b, s]));
    tool('report_session_mapping').run({} as never, { brokerSessionId: 'tab-1', sessionId: 'uuid-9' }, ctxA);
    expect(calls).toEqual([[WS_A, 'tab-1', 'uuid-9']]);
  });
  it('rejects bad args', () => {
    setSessionMappingHandler(() => {});
    expect(() => tool('report_session_mapping').run({} as never, { brokerSessionId: 'x' }, ctxA)).toThrow(/required/);
  });
});

describe('report_summary_status (#230)', () => {
  afterEach(() => setSummaryStatusHandler(() => {}));
  it('forwards (callerId, sessionId, phase, detail) to the injected handler', () => {
    const calls: Array<[string, string, string, Record<string, unknown>]> = [];
    setSummaryStatusHandler((c, s, p, d) => calls.push([c, s, p, d]));
    tool('report_summary_status').run({} as never, { sessionId: 'uuid-9', phase: 'rejected', detail: { rawLen: 12 } }, ctxA);
    expect(calls).toEqual([[WS_A, 'uuid-9', 'rejected', { rawLen: 12 }]]);
  });
  it('defaults detail to {} and tolerates a non-object detail', () => {
    const calls: Array<Record<string, unknown>> = [];
    setSummaryStatusHandler((_c, _s, _p, d) => calls.push(d));
    tool('report_summary_status').run({} as never, { sessionId: 'uuid-9', phase: 'attempt' }, ctxA);
    tool('report_summary_status').run({} as never, { sessionId: 'uuid-9', phase: 'attempt', detail: 'nope' }, ctxA);
    expect(calls).toEqual([{}, {}]);
  });
  it('rejects bad args', () => {
    setSummaryStatusHandler(() => {});
    expect(() => tool('report_summary_status').run({} as never, { sessionId: 'x' }, ctxA)).toThrow(/required/);
  });
});

describe('search_transcripts is workspace-scoped (#146)', () => {
  it('never returns a hit outside the caller allowed set', async () => {
    // Insert one embedding row per workspace directly into the test db.
    const enc = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
    const unit = () => { const v = new Float32Array(EMBED_DIM); v[0] = 1; return v; };
    db.prepare(`CREATE TABLE IF NOT EXISTS embeddings (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT, session_id TEXT, kind TEXT, ref_event_id INTEGER, ts INTEGER, text TEXT, model_id TEXT, dim INTEGER, vec BLOB, dedup_key TEXT, UNIQUE(session_id,kind,dedup_key))`).run();
    const ins = db.prepare(`INSERT INTO embeddings (workspace_id,session_id,kind,ref_event_id,ts,text,model_id,dim,vec,dedup_key) VALUES (?,?,?,?,?,?,?,?,?,?)`);
    ins.run(WS_A, 'sa', 'turn', 1, 1000, 'A content', EMBED_MODEL_ID, EMBED_DIM, enc(unit()), 't1');
    ins.run(WS_B, 'sb', 'turn', 2, 2000, 'B secret content', EMBED_MODEL_ID, EMBED_DIM, enc(unit()), 't2');

    setQueryEmbedder(async (texts) => texts.map(() => unit()));
    const hits = (await tool('search_transcripts').run(db, { query: 'anything' }, ctxA)) as Array<{ workspace_id?: string; workspaceId?: string }>;
    const wss = hits.map((h) => h.workspaceId ?? h.workspace_id);
    expect(wss).not.toContain(WS_B);
    expect(wss).toContain(WS_A);
  });
});

describe('mark_useful + get_config (#207)', () => {
  afterEach(() => { setUsageRecorder(() => {}); setConfigResolver(() => ({})); });

  it('mark_useful records a marked-useful usage event for an allowed session', () => {
    const events: unknown[] = [];
    setUsageRecorder((e) => events.push(e));
    tool('mark_useful').run(db, { sessionId: 'sa', note: 'led me to the fix' }, ctxA);
    expect(events).toEqual([{ workspaceId: WS_A, sessionId: 'sa', kind: 'marked-useful', detail: { note: 'led me to the fix' } }]);
  });

  it("mark_useful refuses a session outside the caller's allowed set", () => {
    setUsageRecorder(() => { throw new Error('must not be called'); });
    expect(() => tool('mark_useful').run(db, { sessionId: 'sb' }, ctxA)).toThrow(/not found/);
  });

  it('get_config returns the resolver output for the caller', async () => {
    setConfigResolver((callerId) => ({ summarizer: { model: 'haiku', minNewTurns: 20 }, workspaceId: callerId }));
    const out = await tool('get_config').run(db, {}, ctxA) as Record<string, unknown>;
    expect(out.workspaceId).toBe(WS_A);
  });
});

// ---------------------------------------------------------------------------
// callTool diagnostics: every tool-call failure must land in the error log
// with a stack (the #194 packaged-app crash surfaced as a bare one-line
// message with no server-side trace), and calls that stall must leave a
// breadcrumb saying WHICH stage hung (the first-call-hang investigation).
// ---------------------------------------------------------------------------
import { vi } from 'vitest';
import { setErrorSink } from './errorLog.js';
import { callTool, _setDbForTests, setReadScopeResolver } from './mcpServer.js';
import type { ErrorRow } from './db.js';

describe('callTool diagnostics', () => {
  let rows: ErrorRow[] = [];
  let harness: { db: Database.Database; cleanup: () => void } | null = null;

  beforeEach(() => {
    rows = [];
    setErrorSink((r) => rows.push(r));
  });
  afterEach(() => {
    setErrorSink(null);
    _setDbForTests(null);
    setReadScopeResolver(async (id) => [id]);
    vi.useRealTimers();
    harness?.cleanup();
    harness = null;
  });

  it('logs mcp-tool-error with a stack when a tool throws, still returning an MCP error result', async () => {
    harness = makeFileDb();
    _setDbForTests(harness.db);
    const res = (await callTool(
      { name: 'query', arguments: { sql: 'DEFINITELY NOT SQL' } },
      WS_A
    )) as { isError?: boolean };
    expect(res.isError).toBe(true); // caller-facing behavior unchanged
    const row = rows.find((r) => r.type === 'mcp-tool-error');
    expect(row).toBeDefined();
    expect(row!.level).toBe('error');
    expect(row!.workspaceId).toBe(WS_A);
    expect(row!.extra?.tool).toBe('query');
    expect(row!.stack).toBeTruthy();
  });

  it('watchdog logs mcp-call-stalled with the stuck stage when a call hangs', async () => {
    vi.useFakeTimers();
    harness = makeFileDb();
    _setDbForTests(harness.db);
    setReadScopeResolver(() => new Promise(() => {})); // never resolves
    void callTool({ name: 'list_sessions', arguments: {} }, WS_A);
    await vi.advanceTimersByTimeAsync(10_000);
    const row = rows.find((r) => r.type === 'mcp-call-stalled');
    expect(row).toBeDefined();
    expect(row!.level).toBe('warn');
    expect(row!.extra?.stage).toBe('resolve-allowed');
    expect(row!.extra?.tool).toBe('list_sessions');
  });

  it('logs mcp-slow-call when scope resolution is slow but completes', async () => {
    vi.useFakeTimers();
    harness = makeFileDb();
    _setDbForTests(harness.db);
    setReadScopeResolver(
      (id) => new Promise((resolve) => setTimeout(() => resolve([id]), 3_000))
    );
    const p = callTool({ name: 'list_sessions', arguments: {} }, WS_A);
    await vi.advanceTimersByTimeAsync(3_000);
    await p;
    const row = rows.find((r) => r.type === 'mcp-slow-call');
    expect(row).toBeDefined();
    expect(row!.extra?.tool).toBe('list_sessions');
    expect(row!.extra?.resolveMs).toBeGreaterThanOrEqual(2_000);
  });
});

// ---------------------------------------------------------------------------
// Implicit usage telemetry (#207): search impressions, click-throughs
// ---------------------------------------------------------------------------

/** Insert one embedding row for (ws, ses) — reuses the INSERT pattern from
 *  the search-scoping describe above. */
function seedEmbedding(testDb: Database.Database, ws: string, ses: string): void {
  const enc = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  const unit = () => { const v = new Float32Array(EMBED_DIM); v[0] = 1; return v; };
  testDb.prepare(`CREATE TABLE IF NOT EXISTS embeddings (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT, session_id TEXT, kind TEXT, ref_event_id INTEGER, ts INTEGER, text TEXT, model_id TEXT, dim INTEGER, vec BLOB, dedup_key TEXT, UNIQUE(session_id,kind,dedup_key))`).run();
  testDb.prepare(`INSERT OR IGNORE INTO embeddings (workspace_id,session_id,kind,ref_event_id,ts,text,model_id,dim,vec,dedup_key) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(ws, ses, 'turn', 1, 1000, 'A content', EMBED_MODEL_ID, EMBED_DIM, enc(unit()), 't1-' + ses);
}

describe('implicit usage telemetry (#207)', () => {
  beforeEach(() => _resetTelemetryForTests());
  afterEach(() => setUsageRecorder(() => {}));

  it('search_transcripts records one impression per distinct result session, carrying the query', async () => {
    const events: Array<Record<string, unknown>> = [];
    setUsageRecorder((e) => events.push(e as Record<string, unknown>));
    setQueryEmbedder(async (texts) => texts.map(() => { const v = new Float32Array(EMBED_DIM); v[0] = 1; return v; }));
    // seed one embedding row for WS_A (reuse the insert helper pattern from the scoping describe)
    seedEmbedding(db, WS_A, 'sa');
    await tool('search_transcripts').run(db, { query: 'the broker hang' }, ctxA);
    const imp = events.filter((e) => e.kind === 'search-impression');
    expect(imp).toHaveLength(1);
    expect(imp[0].sessionId).toBe('sa');
    expect((imp[0].detail as Record<string, unknown>).query).toBe('the broker hang');
  });

  it('a read of a recently-searched session records a clickthrough', async () => {
    const events: Array<Record<string, unknown>> = [];
    setUsageRecorder((e) => events.push(e as Record<string, unknown>));
    setQueryEmbedder(async (texts) => texts.map(() => { const v = new Float32Array(EMBED_DIM); v[0] = 1; return v; }));
    seedEmbedding(db, WS_A, 'sa');
    await tool('search_transcripts').run(db, { query: 'x' }, ctxA);
    tool('get_session').run(db, { id: 'sa' }, ctxA);
    expect(events.some((e) => e.kind === 'clickthrough' && e.sessionId === 'sa')).toBe(true);
  });

  it('a read WITHOUT a recent search records no clickthrough', () => {
    const events: Array<Record<string, unknown>> = [];
    setUsageRecorder((e) => events.push(e as Record<string, unknown>));
    tool('get_session').run(db, { id: 'sa' }, ctxA);
    expect(events.filter((e) => e.kind === 'clickthrough')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// perf tools — perf_status, perf_set, perf_events in query snapshot
// ---------------------------------------------------------------------------
const PERF_ON: EffectivePerfConfig = {
  recording: true, recordingSource: 'settings',
  otlp: { enabled: false, endpoint: null, source: 'settings' }
};

describe('perf tools', () => {
  it('perf_status and perf_set are registered with the pinned schemas', () => {
    const status = TOOLS.find((t) => t.name === 'perf_status');
    const set = TOOLS.find((t) => t.name === 'perf_set');
    expect(status).toBeDefined();
    expect(set).toBeDefined();
    expect(set!.inputSchema).toEqual({
      type: 'object',
      properties: { enabled: { type: 'boolean' } },
      required: ['enabled']
    });
  });

  it('perf_set rejects export-config arguments', async () => {
    const set = TOOLS.find((t) => t.name === 'perf_set')!;
    await expect(
      set.run(db, { enabled: true, endpoint: 'http://evil:4318' }, ctxA)
    ).rejects.toThrow(/export/i);
    await expect(
      set.run(db, { enabled: true, otlp: { enabled: true } }, ctxA)
    ).rejects.toThrow(/export/i);
  });

  it('perf_set rejects when CLAUDE_FLEET_PERF=0', async () => {
    const saved = process.env.CLAUDE_FLEET_PERF;
    process.env.CLAUDE_FLEET_PERF = '0';
    try {
      const set = TOOLS.find((t) => t.name === 'perf_set')!;
      // Both enabled: false and enabled: true should be rejected
      await expect(
        set.run(db, { enabled: false }, ctxA)
      ).rejects.toThrow(/CLAUDE_FLEET_PERF/i);
      await expect(
        set.run(db, { enabled: true }, ctxA)
      ).rejects.toThrow(/CLAUDE_FLEET_PERF/i);
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_FLEET_PERF;
      else process.env.CLAUDE_FLEET_PERF = saved;
    }
  });

  describe('perf_status with live runtime', () => {
    let perfDir: string;
    beforeEach(() => {
      perfDir = mkdtempSync(join(tmpdir(), 'mcp-perf-'));
      const perfDb = openDb(perfDir);
      const store = new PerfStore(perfDb);
      initPerf(store, PERF_ON);
    });
    afterEach(async () => {
      await shutdownPerf();
      closeDb();
      rmSync(perfDir, { recursive: true, force: true });
    });

    it('perf_status returns status without throwing', async () => {
      const statusTool = TOOLS.find((t) => t.name === 'perf_status')!;
      const result = await statusTool.run(db, {}, ctxA);
      expect(result).toHaveProperty('enabled');
      expect(result).toHaveProperty('source');
      expect(result).toHaveProperty('otlp');
      expect(result).toHaveProperty('eventCounts');
    });
  });

  describe('perf_events in query snapshot', () => {
    let fdb: Database.Database;
    let cleanup: () => void;
    beforeEach(() => {
      ({ db: fdb, cleanup } = makeFileDb());
    });
    afterEach(() => {
      fdb.close();
      cleanup();
    });

    it('scopes perf_events to allowed workspaces + app-global rows', () => {
      fdb.prepare(`INSERT INTO perf_events (ts, kind, workspace_id, name, dur_ms) VALUES (1, 'pty_window', ?, 'claude_fleet.pty.bytes', NULL)`).run(WS_A);
      fdb.prepare(`INSERT INTO perf_events (ts, kind, workspace_id, name, dur_ms) VALUES (2, 'pty_window', ?, 'claude_fleet.pty.bytes', NULL)`).run(WS_B);
      fdb.prepare(`INSERT INTO perf_events (ts, kind, dur_ms) VALUES (3, 'stall', 80)`).run();
      const rows = tool('query').run(fdb, { sql: 'SELECT kind, workspace_id FROM perf_events ORDER BY ts' }, ctxA) as Array<{ kind: string; workspace_id: string | null }>;
      expect(rows).toEqual([
        { kind: 'pty_window', workspace_id: WS_A },
        { kind: 'stall', workspace_id: null }
      ]);
    });
  });

  describe('perf_sentinel_set', () => {
    let perfDir: string;
    beforeEach(() => {
      perfDir = mkdtempSync(join(tmpdir(), 'mcp-sentinel-'));
      const perfDb = openDb(perfDir);
      const store = new PerfStore(perfDb);
      initPerf(store, PERF_ON);
    });
    afterEach(async () => {
      disarmSentinel();
      await shutdownPerf();
      closeDb();
      rmSync(perfDir, { recursive: true, force: true });
    });

    it('perf_sentinel_set is registered with the pinned schema', () => {
      const t = TOOLS.find((x) => x.name === 'perf_sentinel_set')!;
      expect(t).toBeDefined();
      expect(t.inputSchema).toEqual({
        type: 'object',
        properties: { enabled: { type: 'boolean' }, ttlHours: { type: 'number' } },
        required: ['enabled']
      });
    });

    it('perf_sentinel_set arms (with ttl), reports via perf_status, and disarms', async () => {
      const t = TOOLS.find((x) => x.name === 'perf_sentinel_set')!;
      const armed = await t.run(db, { enabled: true, ttlHours: 1 }, ctxA);
      expect((armed as { sentinel: { enabled: boolean; expiresAt: number | null } }).sentinel.enabled).toBe(true);
      expect((armed as { sentinel: { expiresAt: number | null } }).sentinel.expiresAt).not.toBeNull();
      const disarmed = await t.run(db, { enabled: false }, ctxA);
      expect((disarmed as { sentinel: { enabled: boolean } }).sentinel.enabled).toBe(false);
    });

    it('perf_sentinel_set validates ttlHours and rejects extra args', async () => {
      const t = TOOLS.find((x) => x.name === 'perf_sentinel_set')!;
      await expect(t.run(db, { enabled: true, ttlHours: 0 }, ctxA)).rejects.toThrow(/ttlHours/);
      await expect(t.run(db, { enabled: true, ttlHours: 169 }, ctxA)).rejects.toThrow(/ttlHours/);
      await expect(t.run(db, { enabled: true, endpoint: 'http://evil' }, ctxA)).rejects.toThrow(/unexpected/);
    });

    it('perf_sentinel_set refuses to arm while recording is disabled', async () => {
      const PERF_OFF: EffectivePerfConfig = {
        recording: false, recordingSource: 'settings',
        otlp: { enabled: false, endpoint: null, source: 'settings' }
      };
      // Shut down the perf-on runtime and restart with recording disabled
      await shutdownPerf();
      closeDb();
      rmSync(perfDir, { recursive: true, force: true });
      perfDir = mkdtempSync(join(tmpdir(), 'mcp-sentinel-off-'));
      const perfDb = openDb(perfDir);
      const store = new PerfStore(perfDb);
      initPerf(store, PERF_OFF);

      const t = TOOLS.find((x) => x.name === 'perf_sentinel_set')!;
      await expect(t.run(db, { enabled: true }, ctxA)).rejects.toThrow(/recording/);
      // disarm must still work while recording is off:
      await expect(t.run(db, { enabled: false }, ctxA)).resolves.toBeTruthy();
    });
  });
});
