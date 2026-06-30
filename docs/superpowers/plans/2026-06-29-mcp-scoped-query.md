# Scoped state-DB `query` + cheaper aggregation tools — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a workspace-scoped read-only `query` tool plus cheaper aggregation surfaces (richer `list_events`, `session_summary`, ISO timestamps) to the `claude-fleet-state` MCP server, cutting the token cost of read-heavy analysis (#174).

**Architecture:** All work is in `src/main/mcpServer.ts` and `src/main/mcpServer.test.ts`. `query` runs arbitrary read-only SQL against a **per-call in-memory snapshot** that is seeded only with the caller's allowed-workspace rows (ATTACH the real DB → `CREATE TABLE … AS SELECT … WHERE workspace_id IN (…)` → DETACH), so isolation is structural rather than parser-enforced. No DB schema migration — every needed column already exists.

**Tech Stack:** TypeScript (Node, ESM `.js` import specifiers), `better-sqlite3` 12.10.0, vitest.

## Global Constraints

- **No DB schema migration.** All fields used already exist in `events`/`sessions` (db.ts).
- **Scoping comes only from `ctx.allowedWorkspaces`** (host-assigned). No tool takes a `workspace_id`/`caller_id` argument to widen scope; a passed `workspace_id` may only *narrow*.
- **`raw_jsonl` is excluded by default** from any new surface; it is the largest + most sensitive column (#146).
- **ESM imports use `.js` specifiers** (e.g. `import { costFor } from './pricing.js'`), matching the existing file.
- **Reuse existing helpers:** `DEFAULT_LIMIT` (200), `MAX_LIMIT` (1000), `clampLimit`, `inClause`, `sessionAllowed`, `EVENT_COLS`, `costFor`.
- **Spec-maintenance rule:** `docs/SPEC.md` §9/§11 must be updated in the same change (data-model + security-model change).
- **Run tests with:** `npx vitest run src/main/mcpServer.test.ts`. (Env note: this container needs the prebuilt `better-sqlite3` binary copied into `/workspace/claude-fleet/node_modules/better-sqlite3/build/Release/` and a stub `node_modules/electron/path.txt` — see the `run-unit-tests-env` memory. The suite is already green after that one-time setup.)

---

## Task 1: Surface existing columns + `tool_name` filter + `columns` projection in `list_events`

**Files:**
- Modify: `src/main/mcpServer.ts` (the `EVENT_COLS` constant near line 459; the `list_events` tool near lines 587–619)
- Test: `src/main/mcpServer.test.ts`

**Interfaces:**
- Consumes: existing `EVENT_COLS`, `clampLimit`, `sessionAllowed`, `ToolCtx`.
- Produces: `list_events` accepting optional `tool_name` (string) and `columns` (string[]) args; default projection now also includes `tool_input, tool_use_id, tool_result_is_error`. A module-level allowlist `EVENT_COL_ALLOWLIST: Set<string>` (the set of selectable column names).

- [ ] **Step 1: Extend the test DB helper with the migration-4 columns**

In `src/main/mcpServer.test.ts`, the `makeDb()` `CREATE TABLE events` is missing the tool-detail columns. Replace the events DDL and the event-insert so rows carry tool detail. Change the `events` table definition to:

```ts
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL, workspace_id TEXT NOT NULL, ts INTEGER,
      type TEXT NOT NULL, subtype TEXT, uuid TEXT, parent_uuid TEXT, model TEXT,
      input_tokens INTEGER, output_tokens INTEGER, cache_read_input_tokens INTEGER,
      cache_creation_input_tokens INTEGER, service_tier TEXT, tool_name TEXT,
      tool_use_id TEXT, tool_input TEXT, tool_result_is_error INTEGER,
      raw_jsonl TEXT NOT NULL, dedup_key TEXT NOT NULL, UNIQUE(session_id, dedup_key)
    );
```

Then replace the `ev` insert + its two `.run(...)` calls with rows that include tool detail:

```ts
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
```

- [ ] **Step 2: Write the failing tests for the new `list_events` behavior**

Add a new `describe` block to `src/main/mcpServer.test.ts`:

```ts
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/main/mcpServer.test.ts -t "list_events richer"`
Expected: FAIL (tool_input undefined / unknown-column not thrown).

- [ ] **Step 4: Add the column allowlist and extend `EVENT_COLS`**

In `src/main/mcpServer.ts`, replace the `EVENT_COLS` definition (near line 459) with:

```ts
// Curated event columns (omit raw_jsonl by default — it's large/sensitive and
// the extract columns below cover the common needs). tool_input/tool_use_id/
// tool_result_is_error carry the parsed which-file/which-command detail (#174).
const EVENT_COLS =
  'id, session_id, workspace_id, ts, type, subtype, model, tool_name, tool_use_id, tool_input, tool_result_is_error, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, service_tier';

// Columns a caller may request via list_events `columns` projection. Excludes
// raw_jsonl by design (#146) — use the `query` tool with include_raw for that.
const EVENT_COL_ALLOWLIST = new Set(
  EVENT_COLS.split(',').map((c) => c.trim()).concat(['uuid', 'parent_uuid'])
);
```

- [ ] **Step 5: Extend the `list_events` tool**

Replace the `list_events` tool object (the one near lines 587–619) with:

```ts
  {
    name: 'list_events',
    description:
      'List events for a session in id order (omits the raw JSONL body). tool_input carries the ' +
      'parsed which-file/which-command detail. Optional: type, tool_name, since (epoch ms on ts), ' +
      'limit, and columns (array projecting a subset of the curated columns).',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        type: { type: 'string' },
        tool_name: { type: 'string' },
        since: { type: 'number' },
        limit: { type: 'number', description: `default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}` },
        columns: { type: 'array', items: { type: 'string' }, description: 'subset of the curated columns' }
      },
      required: ['session_id']
    },
    run: (db, a, ctx) => {
      if (typeof a.session_id !== 'string') throw new Error('session_id is required');
      if (!sessionAllowed(db, a.session_id, ctx.allowedWorkspaces)) {
        throw new Error('not authorized to read this session');
      }
      let cols = EVENT_COLS;
      if (Array.isArray(a.columns)) {
        const names = a.columns.map((c) => String(c));
        for (const n of names) {
          if (!EVENT_COL_ALLOWLIST.has(n)) throw new Error(`unknown column: ${n}`);
        }
        if (names.length > 0) cols = names.join(', ');
      }
      const where = ['session_id = ?'];
      const p: unknown[] = [a.session_id];
      if (typeof a.type === 'string') {
        where.push('type = ?');
        p.push(a.type);
      }
      if (typeof a.tool_name === 'string') {
        where.push('tool_name = ?');
        p.push(a.tool_name);
      }
      if (typeof a.since === 'number') {
        where.push('ts >= ?');
        p.push(a.since);
      }
      const sql = `SELECT ${cols} FROM events WHERE ${where.join(' AND ')} ORDER BY id ASC LIMIT ?`;
      return db.prepare(sql).all(...p, clampLimit(a.limit));
    }
  },
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/main/mcpServer.test.ts`
Expected: PASS (all prior tests + the new `list_events richer` block).

- [ ] **Step 7: Commit**

```bash
git add src/main/mcpServer.ts src/main/mcpServer.test.ts
git commit -m "feat(mcp): richer list_events — parsed tool columns, tool_name filter, column projection (#174)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: ISO timestamp fields on the typed read tools

**Files:**
- Modify: `src/main/mcpServer.ts` (`list_sessions`, `get_session`, `list_events` run bodies)
- Test: `src/main/mcpServer.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: a module-level helper `withIso(row, fields)` that adds `<field>_iso` ISO strings; sessions rows gain `started_at_iso` + `last_active_at_iso`, event rows gain `ts_iso`.

- [ ] **Step 1: Write the failing test**

Add to `src/main/mcpServer.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/mcpServer.test.ts -t "ISO timestamps"`
Expected: FAIL (`last_active_at_iso` undefined).

- [ ] **Step 3: Add the `withIso` helper**

In `src/main/mcpServer.ts`, just after `clampLimit` (near line 446), add:

```ts
/** Return a shallow copy of `row` with an ISO sibling (`<field>_iso`) for each
 *  named epoch-ms field that holds a finite number. Null/0/missing → no sibling.
 *  Lets clients bucket by UTC day without shelling out to `date` (#174). */
function withIso<T extends Record<string, unknown>>(row: T, fields: string[]): T {
  const out: Record<string, unknown> = { ...row };
  for (const f of fields) {
    const v = row[f];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
      out[`${f}_iso`] = new Date(v).toISOString();
    }
  }
  return out as T;
}
```

- [ ] **Step 4: Apply `withIso` in the three tools**

In `list_sessions`'s run, replace the final `return db.prepare(sql).all(...p, clampLimit(a.limit));` with:

```ts
      const rows = db.prepare(sql).all(...p, clampLimit(a.limit)) as Array<Record<string, unknown>>;
      return rows.map((r) => withIso(r, ['started_at', 'last_active_at']));
```

In `get_session`'s run, replace `return row;` (the final allowed-row return) with:

```ts
      return withIso(row as Record<string, unknown>, ['started_at', 'last_active_at']);
```

In `list_events`'s run (from Task 1), replace the final `return db.prepare(sql).all(...p, clampLimit(a.limit));` with:

```ts
      const rows = db.prepare(sql).all(...p, clampLimit(a.limit)) as Array<Record<string, unknown>>;
      return rows.map((r) => withIso(r, ['ts']));
```

(Note: when a `columns` projection omits `ts`, `withIso` simply adds nothing — safe.)

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run src/main/mcpServer.test.ts`
Expected: PASS (all tests).

- [ ] **Step 6: Commit**

```bash
git add src/main/mcpServer.ts src/main/mcpServer.test.ts
git commit -m "feat(mcp): ISO timestamp siblings on list_sessions/get_session/list_events (#174)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `session_summary(id)` convenience tool

**Files:**
- Modify: `src/main/mcpServer.ts` (add a tool to the `TOOLS` array; reuse `costFor`, `sessionAllowed`, `withIso`)
- Test: `src/main/mcpServer.test.ts`

**Interfaces:**
- Consumes: `costFor(model, service_tier, tokens)` from `./pricing.js` (already imported); `sessionAllowed`; `withIso`.
- Produces: `session_summary` tool returning
  `{ session_id, filesEdited: string[], filesEditedCount, commands: string[], commandsCount, usd, inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, started_at, last_active_at, started_at_iso, last_active_at_iso }`.

- [ ] **Step 1: Write the failing tests**

Add to `src/main/mcpServer.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run src/main/mcpServer.test.ts -t "session_summary"`
Expected: FAIL (`tool session_summary not found`).

- [ ] **Step 3: Implement the tool**

In `src/main/mcpServer.ts`, add this object to the `TOOLS` array (place it immediately after the `list_events` tool, before the `committee_*` tools). `MAX_SUMMARY_ITEMS` caps each list:

```ts
  {
    name: 'session_summary',
    description:
      'One-call summary of a session: distinct files edited (Write/Edit/NotebookEdit), commands run ' +
      '(Bash), token totals + derived USD, and the UTC time span (epoch ms + ISO). Lists are capped; ' +
      '*Count fields give the true totals. Collapses list_events + get_cost into one request (#174).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run: (db, a, ctx) => {
      if (typeof a.id !== 'string') throw new Error('id is required');
      if (!sessionAllowed(db, a.id, ctx.allowedWorkspaces)) {
        throw new Error('not authorized to read this session');
      }
      const MAX_SUMMARY_ITEMS = 100;
      const distinctInputs = (names: string[]): { items: string[]; count: number } => {
        const placeholders = names.map(() => '?').join(',');
        const rows = db
          .prepare(
            `SELECT DISTINCT tool_input FROM events
             WHERE session_id = ? AND tool_name IN (${placeholders}) AND tool_input IS NOT NULL
             ORDER BY tool_input`
          )
          .all(a.id, ...names) as Array<{ tool_input: string }>;
        const items = rows.map((r) => r.tool_input);
        return { items: items.slice(0, MAX_SUMMARY_ITEMS), count: items.length };
      };
      const files = distinctInputs(['Write', 'Edit', 'NotebookEdit']);
      const cmds = distinctInputs(['Bash']);

      // Token totals + USD — same aggregation as get_cost.
      const costRows = db
        .prepare(
          `SELECT model, service_tier,
                  SUM(COALESCE(input_tokens,0)) AS input,
                  SUM(COALESCE(output_tokens,0)) AS output,
                  SUM(COALESCE(cache_read_input_tokens,0)) AS cacheRead,
                  SUM(COALESCE(cache_creation_input_tokens,0)) AS cacheCreate
           FROM events WHERE session_id = ? AND type = 'assistant'
           GROUP BY model, service_tier`
        )
        .all(a.id) as Array<{
        model: string | null;
        service_tier: string | null;
        input: number;
        output: number;
        cacheRead: number;
        cacheCreate: number;
      }>;
      let usd = 0;
      const totals = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
      for (const r of costRows) {
        const tokens = {
          inputTokens: r.input,
          outputTokens: r.output,
          cacheReadInputTokens: r.cacheRead,
          cacheCreationInputTokens: r.cacheCreate
        };
        usd += costFor(r.model, r.service_tier, tokens);
        totals.inputTokens += r.input;
        totals.outputTokens += r.output;
        totals.cacheReadInputTokens += r.cacheRead;
        totals.cacheCreationInputTokens += r.cacheCreate;
      }

      const span = db
        .prepare(`SELECT MIN(ts) AS started_at, MAX(ts) AS last_active_at FROM events WHERE session_id = ?`)
        .get(a.id) as { started_at: number | null; last_active_at: number | null };

      return withIso(
        {
          session_id: a.id,
          filesEdited: files.items,
          filesEditedCount: files.count,
          commands: cmds.items,
          commandsCount: cmds.count,
          usd,
          ...totals,
          started_at: span.started_at,
          last_active_at: span.last_active_at
        },
        ['started_at', 'last_active_at']
      );
    }
  },
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/main/mcpServer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/mcpServer.ts src/main/mcpServer.test.ts
git commit -m "feat(mcp): session_summary tool — files/commands/cost/timespan in one call (#174)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Scoped `query` tool (snapshot mechanism)

**Files:**
- Modify: `src/main/mcpServer.ts` (add a `buildSnapshot` helper + the `query` tool; rewrite the "no query" comment block near lines 620–623)
- Test: `src/main/mcpServer.test.ts` (including replacing the obsolete "no query tool" test at lines 105–109)

**Interfaces:**
- Consumes: `Database` (already imported), `randomBytes` (already imported), `clampLimit`, `inClause`, `ToolCtx`.
- Produces: `query` tool with args `{ sql: string, params?: unknown[], include_raw?: boolean, max_rows?: number }`, returning the result rows (array). A module-level `MAX_QUERY_BYTES = 50_000`.

**Snapshot mechanism (verified working):** open `new Database(':memory:')`; `ATTACH` the source DB file (path from `db.name`) under a random alias; `CREATE TABLE … AS SELECT … WHERE workspace_id IN (allowed)` for `events`/`sessions`/`broker_sessions` (events excludes `raw_jsonl` unless `include_raw`); `DETACH`; then compile + run the user SQL against the in-memory copy. Because the source is detached before the user SQL runs, no statement can reach unfiltered rows.

- [ ] **Step 1: Replace the obsolete "no query" test and add the `query` test suite**

In `src/main/mcpServer.test.ts`, **delete** the existing block (lines 105–109):

```ts
describe('raw SQL escape hatch is removed (#146)', () => {
  it('exposes no `query` tool that could read other workspaces’ raw transcripts', () => {
    expect(TOOLS.find((t) => t.name === 'query')).toBeUndefined();
  });
});
```

The test DB built by `makeDb()` is `:memory:`, but `query` needs a file path to ATTACH (`db.name`). Add a **file-backed** DB helper and a matching ctx near the top of the test file (after `makeDb`):

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
```

Now add the `query` suite:

```ts
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

  it('returns only the caller’s rows for a plain select', () => {
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
    expect(rows[0].raw_jsonl).toBe('{"a":1}'); // A's own row only
  });

  it('rejects writes / DDL / multi-statement', () => {
    expect(() => run({ sql: "INSERT INTO events (session_id) VALUES ('x')" })).toThrow(/read-only/i);
    expect(() => run({ sql: 'DROP TABLE events' })).toThrow(/read-only/i);
    expect(() => run({ sql: 'UPDATE sessions SET ai_title = 1' })).toThrow(/read-only/i);
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
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run src/main/mcpServer.test.ts -t "scoped query"`
Expected: FAIL (`tool query not found`).

- [ ] **Step 3: Add the `buildSnapshot` helper + `MAX_QUERY_BYTES`**

In `src/main/mcpServer.ts`, near the other helpers (after `inClause`, ~line 467), add:

```ts
const MAX_QUERY_BYTES = 50_000;

// Columns copied into a query snapshot's events table (raw_jsonl appended only
// when include_raw). Mirrors the real events schema minus dedup_key.
const SNAPSHOT_EVENT_COLS =
  'id, session_id, workspace_id, ts, type, subtype, uuid, parent_uuid, model, ' +
  'input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, ' +
  'service_tier, tool_name, tool_use_id, tool_input, tool_result_is_error';

/** Build a throwaway in-memory DB containing ONLY the caller's allowed-workspace
 *  rows, copied from the source DB at `srcPath` (the live state.db). The source
 *  is DETACHed before the caller's SQL ever runs, so isolation is structural:
 *  no subquery/UNION/sqlite_master trick can reach unfiltered rows (#146). The
 *  caller owns the returned DB and must close it. */
function buildSnapshot(srcPath: string, allowed: Set<string>, includeRaw: boolean): Database.Database {
  const mem = new Database(':memory:');
  const alias = 'src_' + randomBytes(6).toString('hex');
  const { sql: scope, params } = inClause('workspace_id', allowed);
  // ATTACH the real DB. Path is escaped into the statement (ATTACH filename is
  // not reliably bindable); paths never contain single quotes in practice, but
  // double any just in case.
  const attached = srcPath.replace(/'/g, "''");
  mem.exec(`ATTACH DATABASE '${attached}' AS ${alias}`);
  try {
    const eventCols = includeRaw ? `${SNAPSHOT_EVENT_COLS}, raw_jsonl` : SNAPSHOT_EVENT_COLS;
    mem.prepare(
      `CREATE TABLE events AS SELECT ${eventCols} FROM ${alias}.events WHERE ${scope}`
    ).run(...params);
    mem.prepare(`CREATE TABLE sessions AS SELECT * FROM ${alias}.sessions WHERE ${scope}`).run(...params);
    mem.prepare(
      `CREATE TABLE broker_sessions AS SELECT * FROM ${alias}.broker_sessions WHERE ${scope}`
    ).run(...params);
  } finally {
    mem.exec(`DETACH ${alias}`);
  }
  return mem;
}
```

- [ ] **Step 4: Add the `query` tool and rewrite the comment block**

In `src/main/mcpServer.ts`, replace the comment block near lines 620–623 (the "NOTE: there is intentionally no raw `query`…" paragraph) with:

```ts
  // `query` runs arbitrary READ-ONLY SQL against a per-call in-memory SNAPSHOT
  // seeded only with the caller's allowed-workspace rows (buildSnapshot). The
  // real DB is DETACHed before the caller's SQL runs, so isolation is structural
  // — no join/UNION/subquery/sqlite_master trick can reach another workspace's
  // rows (#146/§9). raw_jsonl is excluded unless include_raw, and even then only
  // the caller's own rows are present. The reader-only guard rejects writes/DDL.
```

Then add this tool object immediately below that comment (before the `committee_*` tools):

```ts
  {
    name: 'query',
    description:
      'Run a single read-only SQL statement against your workspace data. Tables: events, sessions, ' +
      'broker_sessions — pre-filtered to the rows you may read, so SELECT freely (joins, aggregates, ' +
      'GROUP BY, datetime(ts/1000,"unixepoch") for UTC). raw_jsonl is excluded unless include_raw=true. ' +
      'Args: sql (required), params (array of bound ? values), include_raw (bool), max_rows (default ' +
      `${DEFAULT_LIMIT}, max ${MAX_LIMIT}). Writes/DDL/multi-statement are rejected.`,
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string' },
        params: { type: 'array' },
        include_raw: { type: 'boolean' },
        max_rows: { type: 'number', description: `default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}` }
      },
      required: ['sql']
    },
    run: (db, a, ctx) => {
      if (typeof a.sql !== 'string') throw new Error('sql is required');
      const params = Array.isArray(a.params) ? a.params : [];
      const includeRaw = a.include_raw === true;
      const maxRows = clampLimit(a.max_rows);
      const srcPath = db.name; // live state.db path; ':memory:' in some tests
      const snap = buildSnapshot(srcPath, ctx.allowedWorkspaces, includeRaw);
      try {
        const stmt = snap.prepare(a.sql);
        if (!stmt.reader) throw new Error('read-only SELECT statements only');
        const rows = stmt.all(...params) as unknown[];
        const capped = rows.slice(0, maxRows);
        const json = JSON.stringify(capped);
        if (json.length > MAX_QUERY_BYTES) {
          throw new Error(
            `result too large (${json.length} bytes > ${MAX_QUERY_BYTES}); add LIMIT or aggregate server-side`
          );
        }
        return capped;
      } finally {
        snap.close();
      }
    }
  },
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run src/main/mcpServer.test.ts`
Expected: PASS (all suites including `scoped query`).

- [ ] **Step 6: Commit**

```bash
git add src/main/mcpServer.ts src/main/mcpServer.test.ts
git commit -m "feat(mcp): scoped read-only query tool via per-call snapshot (#174)

Isolation is structural — query runs against an in-memory copy seeded only with
the caller's allowed-workspace rows, with the source DB detached before user SQL
runs. Replaces the prior 'no query' stance while preserving the #146/§9 invariant.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Spec + docs sync

**Files:**
- Modify: `docs/SPEC.md` — exact lines confirmed: **29** (top-level invariant), **900**, **904** (the §11 invariant paragraph), **917–919** (tool list), **927**, **1002**.
- Modify: `/workspace/CLAUDE.md` (the `claude-fleet-state` MCP tool descriptions — the `query` bullet, and the `list_events` line).

**Note:** the `fleet-log` skill referenced by #174 is **not a file in either repo** (it's an external/user skill — `grep` finds it only in transcripts). It is therefore out of scope for in-repo edits; updating it is the skill owner's follow-up. Do not invent a file for it.

**Interfaces:** docs only; no code.

- [ ] **Step 1: Re-confirm the SPEC lines**

Run: `grep -n "raw \`query\`\|no raw-SQL\|list_events\|query tool no longer\|escape hatch" docs/SPEC.md`
Expected: lines around 29, 900, 904, 917–919, 927, 1002 (numbers may have shifted slightly — match on text).

- [ ] **Step 2: Update the §11 tool list (lines ~917–919)**

Change the `list_events` bullet to note it returns parsed tool columns (`tool_input`/`tool_use_id`/`tool_result_is_error`) plus a `tool_name` filter and `columns` projection. Add a `session_summary` bullet (files edited / commands run / token totals + USD / UTC span in one call). **Replace** line ~919 (`(No raw query/arbitrary-SQL tool — removed for workspace isolation, #146.)`) with:

```
- `query({ sql, params?, include_raw?, max_rows? })` → a single read-only SQL statement run against a per-call in-memory **snapshot** seeded only with the caller's allowed-workspace rows. The real DB is DETACHed before the statement runs, so joins/`UNION`/subqueries/`sqlite_master` introspection cannot reach another workspace's rows. `raw_jsonl` excluded unless `include_raw`; writes/DDL/multi-statement rejected; capped by `max_rows` + a ~50KB result ceiling.
```

Also note the typed tools now return ISO sibling fields (`*_iso`) for epoch-ms columns.

- [ ] **Step 3: Reword the §11 invariant paragraph (line ~904) and the related lines (29, 900, 927, 1002)**

These currently assert "there is deliberately **no raw `query`** tool" / "no raw-SQL tool" / "the raw `query` tool no longer exists." Reword each to reflect the snapshot model **without weakening the isolation claim**, e.g.:

> `query` runs arbitrary read-only SQL, but only against a per-call snapshot seeded with `WHERE workspace_id IN (allowedWorkspaces)` rows and detached from the real DB before the statement executes — so isolation is **structural** (the other workspaces' rows are not present to be read), not dependent on SQL parsing. The `CLAUDE_FLEET_SCOPED_READS` flag remains gone; there is still no fleet-global mode.

Keep the "everything reachable via MCP is read-only or mediated by the main process" §9 invariant intact. Line 927 ("no raw-SQL surface to document"): change to note `query`'s tables (`events`/`sessions`/`broker_sessions`) and that `raw_jsonl` is opt-in.

- [ ] **Step 4: Update `/workspace/CLAUDE.md`**

Replace the `query` bullet ("Disabled when scoped reads are on — use the typed tools instead.") with a line describing the snapshot-scoped `query` (tables, `include_raw`, caps). Add `session_summary` to the typed-tools list and note `list_events` now carries parsed tool columns + `tool_name`/`columns`.

- [ ] **Step 5: Verify the whole unit suite is green and commit**

Run: `npx vitest run src/main/mcpServer.test.ts`
Expected: PASS.

```bash
git add docs/SPEC.md /workspace/CLAUDE.md
git commit -m "docs: sync SPEC §9/§11 + CLAUDE.md for scoped query & new MCP tools (#174)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-review notes

- **Spec coverage:** Task 1 → richer `list_events` (problems 2,3); Task 2 → timestamps (problem 4); Task 3 → `session_summary`; Task 4 → scoped `query` (problem 1) + snapshot security model; Task 5 → SPEC/docs sync. All four spec deliverables + the docs requirement are covered.
- **Type consistency:** `withIso` defined in Task 2 and reused in Task 3; `inClause`/`clampLimit`/`sessionAllowed`/`costFor`/`EVENT_COLS` are pre-existing; `buildSnapshot`/`SNAPSHOT_EVENT_COLS`/`MAX_QUERY_BYTES`/`EVENT_COL_ALLOWLIST` are introduced before use.
- **Mechanism verified:** the ATTACH → scoped `CREATE TABLE AS SELECT` → DETACH → `stmt.reader` guard chain was confirmed working against the real `better-sqlite3` build (scoped copy excluded the other workspace; writes are non-readers; post-detach alias unreachable; `sqlite_master` shows only the copy).
- **Test ordering caveat:** Task 4 deletes the obsolete "no query tool" test (lines 105–109) — do not skip that deletion or the suite will fail.
