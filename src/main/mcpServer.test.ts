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
import { TOOLS, resolveAllowedWorkspaces, setInputWaitHandler, setQueryEmbedder, type ToolCtx } from './mcpServer.js';
import { EMBED_DIM } from './vectors.js';

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
    expect(names.map((r) => r.name).sort()).toEqual(['broker_sessions', 'events', 'sessions']);
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

describe('search_transcripts is workspace-scoped (#146)', () => {
  it('never returns a hit outside the caller allowed set', async () => {
    // Insert one embedding row per workspace directly into the test db.
    const enc = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
    const unit = () => { const v = new Float32Array(EMBED_DIM); v[0] = 1; return v; };
    db.prepare(`CREATE TABLE IF NOT EXISTS embeddings (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT, session_id TEXT, kind TEXT, ref_event_id INTEGER, ts INTEGER, text TEXT, model_id TEXT, dim INTEGER, vec BLOB, dedup_key TEXT, UNIQUE(session_id,kind,dedup_key))`).run();
    const ins = db.prepare(`INSERT INTO embeddings (workspace_id,session_id,kind,ref_event_id,ts,text,model_id,dim,vec,dedup_key) VALUES (?,?,?,?,?,?,?,?,?,?)`);
    ins.run(WS_A, 'sa', 'turn', 1, 1000, 'A content', 'Xenova/bge-small-en-v1.5', EMBED_DIM, enc(unit()), 't1');
    ins.run(WS_B, 'sb', 'turn', 2, 2000, 'B secret content', 'Xenova/bge-small-en-v1.5', EMBED_DIM, enc(unit()), 't2');

    setQueryEmbedder(async (texts) => texts.map(() => unit()));
    const hits = (await tool('search_transcripts').run(db, { query: 'anything' }, ctxA)) as Array<{ workspace_id?: string; workspaceId?: string }>;
    const wss = hits.map((h) => h.workspaceId ?? h.workspace_id);
    expect(wss).not.toContain(WS_B);
  });
});
