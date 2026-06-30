# Errors via MCP + Help-menu host-file affordances — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give an in-workspace agent a scoped, queryable error/diagnostic surface via MCP, and a human a Help-menu link to the host data folder — replacing the temporary `/shared` diagnostics hack.

**Architecture:** A new `errors` table in the existing `state.db`, fed by augmenting `logError` with a crash-safe injected sink. A new scoped `list_errors` MCP tool reads it. The temporary `mapping-diag` signals fold into the table as `warn`/`info` rows. A custom Electron application menu adds Open Data Folder / Open Log under Help.

**Tech Stack:** TypeScript, Electron (main process), better-sqlite3, MCP server (`mcpServer.ts`), vitest, Playwright.

## Global Constraints

- Design doc: `docs/superpowers/specs/2026-06-30-errors-via-mcp-design.md` (authoritative).
- `errorLog.ts` MUST stay dependency-free and never throw: file append happens first and unconditionally; the DB sink is best-effort in a `try/catch`.
- MCP reads MUST stay scoped: caller sees its own workspace (`ctx.allowedWorkspaces`) + global (NULL-`workspace_id`) rows only; a caller-supplied `workspace_id` may only narrow.
- `session_id` in the `errors` table is the **claude session UUID**, never the broker session id.
- Errors-table retention cap: `ERRORS_RETENTION = 2000` (most recent rows kept).
- Per `.claude/rules/spec-maintenance.md`, `docs/SPEC.md` is updated in this same change (Task 8).
- DB-touching vitest needs the prebuilt `better-sqlite3` binary + electron path stub already used by the project's unit-test setup.
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

### Task 1: `errors` table migration + `recordError` (db.ts)

**Files:**
- Modify: `src/main/db.ts` (add migration step → `user_version` 5; add `recordError` + `ERRORS_RETENTION`)
- Test: `src/main/db.test.ts` (create)

**Interfaces:**
- Consumes: existing `openDb(userDataDir)`, `closeDb()`, `openDbOrThrow()`, `lookupBrokerSession(workspaceId, brokerSessionId)`.
- Produces:
  - `export const ERRORS_RETENTION = 2000`
  - `export interface ErrorRow { ts: number; source: string; type: string; message: string; stack?: string; extra?: Record<string, unknown>; workspaceId?: string; sessionId?: string; level?: string }`
  - `export function recordError(row: ErrorRow): void` — inserts one row (resolving `session_id` from `extra.brokerSessionId` via `lookupBrokerSession` when `sessionId` is absent), then prunes to the most recent `ERRORS_RETENTION` rows.

- [ ] **Step 1: Write the failing test**

Create `src/main/db.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb, recordError, learnBrokerSessionMapping, ERRORS_RETENTION } from './db.js';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'cf-db-'));
  openDb(dir);
  return dir;
}

afterEach(() => closeDb());

describe('recordError', () => {
  it('inserts a row with all fields', () => {
    const dir = freshDb();
    try {
      recordError({ ts: 1000, source: 'main', type: 'pty-attach-failed', message: 'boom',
        level: 'error', workspaceId: 'ws-a', extra: { foo: 1 } });
      const db = openDb(dir);
      const row = db.prepare('SELECT * FROM errors').get() as Record<string, unknown>;
      expect(row.type).toBe('pty-attach-failed');
      expect(row.workspace_id).toBe('ws-a');
      expect(row.level).toBe('error');
      expect(JSON.parse(row.extra as string)).toEqual({ foo: 1 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('resolves session_id from a broker id in extra via the mapping', () => {
    const dir = freshDb();
    try {
      learnBrokerSessionMapping('ws-a', 'broker-1', 'claude-uuid-1');
      recordError({ ts: 1, source: 'main', type: 'x', message: 'm', workspaceId: 'ws-a',
        extra: { brokerSessionId: 'broker-1' } });
      const db = openDb(dir);
      const row = db.prepare('SELECT session_id FROM errors').get() as { session_id: string };
      expect(row.session_id).toBe('claude-uuid-1');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('leaves session_id NULL when the broker mapping is absent', () => {
    const dir = freshDb();
    try {
      recordError({ ts: 1, source: 'main', type: 'mapping-unresolved', message: 'm',
        level: 'warn', workspaceId: 'ws-a', extra: { brokerSessionId: 'unmapped' } });
      const db = openDb(dir);
      const row = db.prepare('SELECT session_id FROM errors').get() as { session_id: string | null };
      expect(row.session_id).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('prunes to the most recent ERRORS_RETENTION rows', () => {
    const dir = freshDb();
    try {
      for (let i = 0; i < ERRORS_RETENTION + 5; i++) {
        recordError({ ts: i, source: 'main', type: 't', message: `m${i}` });
      }
      const db = openDb(dir);
      const count = (db.prepare('SELECT COUNT(*) AS c FROM errors').get() as { c: number }).c;
      expect(count).toBe(ERRORS_RETENTION);
      const oldest = db.prepare('SELECT MIN(ts) AS m FROM errors').get() as { m: number };
      expect(oldest.m).toBe(5); // first 5 pruned
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/db.test.ts`
Expected: FAIL — `recordError` / `ERRORS_RETENTION` not exported, and/or `no such table: errors`.

- [ ] **Step 3: Add the migration step**

In `src/main/db.ts`, inside `migrate(d)`, after the `user_version = 4` block, add:

```ts
  if ((d.pragma('user_version', { simple: true }) as number) < 5) {
    d.exec(`
      CREATE TABLE errors (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        ts           INTEGER NOT NULL,
        workspace_id TEXT,
        session_id   TEXT,
        source       TEXT NOT NULL,
        level        TEXT NOT NULL,
        type         TEXT NOT NULL,
        message      TEXT NOT NULL,
        stack        TEXT,
        extra        TEXT
      );
      CREATE INDEX idx_errors_workspace_ts ON errors(workspace_id, ts);
      CREATE INDEX idx_errors_session ON errors(session_id);
    `);
    d.pragma('user_version = 5');
  }
```

- [ ] **Step 4: Add `ERRORS_RETENTION`, `ErrorRow`, and `recordError`**

In `src/main/db.ts` (near the other exports; `lookupBrokerSession` is already defined in this file):

```ts
export const ERRORS_RETENTION = 2000;

export interface ErrorRow {
  ts: number;
  source: string;
  type: string;
  message: string;
  stack?: string;
  extra?: Record<string, unknown>;
  workspaceId?: string;
  sessionId?: string;
  level?: string;
}

export function recordError(row: ErrorRow): void {
  const d = openDbOrThrow();
  // Resolve the claude session UUID: prefer an explicit sessionId; else, if the
  // caller only knew the broker id, best-effort resolve it via the mapping
  // (NULL when unmapped — itself an honest signal).
  let sessionId = row.sessionId ?? null;
  if (!sessionId && row.workspaceId && typeof row.extra?.brokerSessionId === 'string') {
    sessionId = lookupBrokerSession(row.workspaceId, row.extra.brokerSessionId as string);
  }
  d.prepare(`
    INSERT INTO errors (ts, workspace_id, session_id, source, level, type, message, stack, extra)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.ts,
    row.workspaceId ?? null,
    sessionId,
    row.source,
    row.level ?? 'error',
    row.type,
    row.message,
    row.stack ?? null,
    row.extra ? JSON.stringify(row.extra) : null
  );
  d.prepare(`
    DELETE FROM errors WHERE id NOT IN (
      SELECT id FROM errors ORDER BY id DESC LIMIT ?
    )
  `).run(ERRORS_RETENTION);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/main/db.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/main/db.ts src/main/db.test.ts
git commit -m "feat(db): errors table + recordError with retention and session resolution

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: crash-safe error sink in `errorLog.ts`

**Files:**
- Modify: `src/main/errorLog.ts`
- Test: `src/main/errorLog.test.ts` (create)

**Interfaces:**
- Consumes: `db.ErrorRow` (type-only import).
- Produces:
  - `LogPayload` gains optional `workspaceId?: string; sessionId?: string; level?: 'error' | 'warn' | 'info'`.
  - `export function setErrorSink(fn: ((row: ErrorRow) => void) | null): void`
  - `logError` appends to the file first (ISO ts, unchanged), then calls the sink with `{ ...payload, ts: <epoch ms> }`, swallowing sink errors.

- [ ] **Step 1: Write the failing test**

Create `src/main/errorLog.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logError, setErrorSink } from './errorLog.js';

afterEach(() => setErrorSink(null));

describe('error sink', () => {
  it('forwards each logError to the registered sink with an epoch-ms ts', () => {
    const seen: unknown[] = [];
    setErrorSink((row) => seen.push(row));
    logError({ source: 'main', type: 't', message: 'm', workspaceId: 'ws-a', level: 'warn' });
    expect(seen).toHaveLength(1);
    const row = seen[0] as Record<string, unknown>;
    expect(row.type).toBe('t');
    expect(row.workspaceId).toBe('ws-a');
    expect(row.level).toBe('warn');
    expect(typeof row.ts).toBe('number'); // epoch ms, not ISO string
  });

  it('never throws when the sink throws (crash-safety)', () => {
    setErrorSink(() => { throw new Error('db wedged'); });
    expect(() => logError({ source: 'main', type: 't', message: 'm' })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/errorLog.test.ts`
Expected: FAIL — `setErrorSink` is not exported.

- [ ] **Step 3: Extend `LogPayload`, add the sink**

In `src/main/errorLog.ts`:

```ts
import type { ErrorRow } from './db.js';
```

Extend the interface:

```ts
interface LogPayload {
  source: Source;
  type: string;
  message: string;
  stack?: string;
  extra?: Record<string, unknown>;
  workspaceId?: string;
  sessionId?: string;
  level?: 'error' | 'warn' | 'info';
}
```

Add module state + setter (near `let logPath`):

```ts
let sink: ((row: ErrorRow) => void) | null = null;

/** Register a best-effort DB sink for structured error rows. */
export function setErrorSink(fn: ((row: ErrorRow) => void) | null): void {
  sink = fn;
}
```

Rewrite `logError` so the file append stays first and unconditional, then the sink runs best-effort:

```ts
export function logError(payload: LogPayload): void {
  const tsMs = Date.now();
  try {
    const row = { ts: new Date(tsMs).toISOString(), ...payload };
    appendFileSync(ensureLogPath(), JSON.stringify(row) + '\n', 'utf8');
  } catch {
    // see comment below
  }
  try {
    sink?.({ ts: tsMs, ...payload });
  } catch {
    // DB sink is best-effort — a wedged DB must never break crash logging.
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/errorLog.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire the sink at startup**

In `src/main/index.ts`, inside the `app.whenReady().then(...)` block, after the DB is opened and `installMainProcessHandlers()` is called, register the sink:

```ts
import { setErrorSink } from './errorLog.js';
import { recordError } from './db.js';
// ...
setErrorSink((row) => recordError(row));
```

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck`
Expected: clean.

```bash
git add src/main/errorLog.ts src/main/errorLog.test.ts src/main/index.ts
git commit -m "feat(errorLog): crash-safe DB sink + workspace/session/level fields

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `list_errors` MCP tool (mcpServer.ts)

**Files:**
- Modify: `src/main/mcpServer.ts` (append a tool to the `TOOLS` array; reuse `inClause`, `clampLimit`)
- Test: `src/main/mcpServer.test.ts` (add a `describe('list_errors')`)

**Interfaces:**
- Consumes: existing `inClause(col, allowed)`, `clampLimit(n)`, `ToolCtx { callerId, allowedWorkspaces }`.
- Produces: a `list_errors` tool returning rows newest-first with a `ts_iso` sibling.

- [ ] **Step 1: Write the failing test**

In `src/main/mcpServer.test.ts`, extend `makeDb()` to also create + seed an `errors` table (add inside the `db.exec(...)` schema string and after the existing seed inserts):

```ts
  // (add to the CREATE block in makeDb)
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
```

Then add the test:

```ts
describe('list_errors', () => {
  const tool = TOOLS.find((t) => t.name === 'list_errors')!;
  const ctx = (allowed: string[]): ToolCtx => ({
    callerId: allowed[0], allowedWorkspaces: new Set(allowed)
  });

  it('returns own-workspace errors + global (NULL) rows, never another workspace', () => {
    const db = makeDb();
    const rows = tool.run(db, {}, ctx([WS_A])) as Array<Record<string, unknown>>;
    const types = rows.map((r) => r.type);
    expect(types).toContain('mapping-unresolved'); // WS_A
    expect(types).toContain('uncaughtException');  // global
    expect(types).not.toContain('pty-attach-failed'); // WS_B — must be hidden
  });

  it('includes a ts_iso sibling and orders newest-first', () => {
    const db = makeDb();
    const rows = tool.run(db, {}, ctx([WS_A])) as Array<Record<string, unknown>>;
    expect(typeof rows[0].ts_iso).toBe('string');
    expect(rows[0].ts as number).toBeGreaterThanOrEqual(rows[rows.length - 1].ts as number);
  });

  it('filters by level', () => {
    const db = makeDb();
    const rows = tool.run(db, { level: 'warn' }, ctx([WS_A])) as Array<Record<string, unknown>>;
    expect(rows.every((r) => r.level === 'warn')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/mcpServer.test.ts`
Expected: FAIL — `tool` is `undefined` (no `list_errors` in `TOOLS`).

- [ ] **Step 3: Add the tool**

In `src/main/mcpServer.ts`, append to the `TOOLS` array (after `list_events`, before the committee tools):

```ts
  {
    name: 'list_errors',
    description:
      'List recorded errors/diagnostics (newest first). Scoped to your workspace plus global app-level crashes. Optional filters: workspace_id, session_id, level, type, since (epoch ms on ts), limit.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string' },
        session_id: { type: 'string' },
        level: { type: 'string', description: "'error' | 'warn' | 'info'" },
        type: { type: 'string' },
        since: { type: 'number', description: 'epoch ms, ts >= since' },
        limit: { type: 'number', description: `default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}` }
      }
    },
    run: (db, a, ctx) => {
      const where: string[] = [];
      const p: unknown[] = [];
      // Always: own workspace(s) OR a global (NULL-workspace) crash row.
      const { sql: scopeSql, params } = inClause('workspace_id', ctx.allowedWorkspaces);
      where.push(`(${scopeSql} OR workspace_id IS NULL)`);
      p.push(...params);
      if (typeof a.workspace_id === 'string') { where.push('workspace_id = ?'); p.push(a.workspace_id); }
      if (typeof a.session_id === 'string') { where.push('session_id = ?'); p.push(a.session_id); }
      if (typeof a.level === 'string') { where.push('level = ?'); p.push(a.level); }
      if (typeof a.type === 'string') { where.push('type = ?'); p.push(a.type); }
      if (typeof a.since === 'number') { where.push('ts >= ?'); p.push(a.since); }
      const sql = `SELECT * FROM errors WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`;
      const rows = db.prepare(sql).all(...p, clampLimit(a.limit)) as Array<Record<string, unknown>>;
      return rows.map((r) => ({ ...r, ts_iso: new Date(r.ts as number).toISOString() }));
    }
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/mcpServer.test.ts`
Expected: PASS (existing isolation tests + 3 new `list_errors` tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/mcpServer.ts src/main/mcpServer.test.ts
git commit -m "feat(mcp): scoped list_errors read tool

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: extract `openHostPath.ts` (refactor)

**Files:**
- Create: `src/main/openHostPath.ts`
- Modify: `src/main/ipc.ts` (remove the local `RUNNING_IN_WSL` + `openPathViaExplorer`; import from the new module; replace the three `RUNNING_IN_WSL ? openPathViaExplorer(x) : shell.openPath(x)` call sites with `openHostPath(x)`)

**Interfaces:**
- Produces:
  - `export const RUNNING_IN_WSL: boolean`
  - `export function openHostPath(path: string): Promise<string>` — WSL-aware reveal; resolves `''` on success or an error string, never rejects.

- [ ] **Step 1: Create the module (no behavior change — verified by typecheck + existing e2e)**

Create `src/main/openHostPath.ts` (move the exact logic out of `ipc.ts`):

```ts
import { shell } from 'electron';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isWslEnvironment } from './wsl.js';

/** Detected once at load: are we running under WSL? */
export const RUNNING_IN_WSL = ((): boolean => {
  let procVersion = '';
  try {
    procVersion = readFileSync('/proc/version', 'utf8');
  } catch {
    /* not linux / no procfs */
  }
  return isWslEnvironment({
    platform: process.platform,
    wslDistroName: process.env.WSL_DISTRO_NAME,
    procVersion
  });
})();

function openPathViaExplorer(path: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('wslpath', ['-w', path], (err, stdout) => {
      if (err) { resolve(`wslpath failed: ${err.message}`); return; }
      const winPath = stdout.trim();
      if (!winPath) { resolve('wslpath returned an empty path'); return; }
      execFile('explorer.exe', [winPath], () => { /* exits 1 even on success — ignore */ });
      resolve('');
    });
  });
}

/** Reveal a host path in the OS file manager (WSL-aware). Never rejects. */
export function openHostPath(path: string): Promise<string> {
  return RUNNING_IN_WSL ? openPathViaExplorer(path) : Promise.resolve(shell.openPath(path));
}
```

- [ ] **Step 2: Update `ipc.ts` to use it**

In `src/main/ipc.ts`: delete the local `RUNNING_IN_WSL` const and the `openPathViaExplorer` function; add `import { openHostPath, RUNNING_IN_WSL } from './openHostPath.js';`. Replace each `RUNNING_IN_WSL ? openPathViaExplorer(x) : shell.openPath(x)` with `openHostPath(x)`. (Keep `RUNNING_IN_WSL` imported if other code still references it; otherwise drop it from the import.)

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean (no unused-symbol or missing-import errors).

- [ ] **Step 4: Commit**

```bash
git add src/main/openHostPath.ts src/main/ipc.ts
git commit -m "refactor: extract WSL-aware openHostPath helper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Help-menu affordances (appMenu.ts)

**Files:**
- Create: `src/main/appMenu.ts`
- Create: `src/main/appMenu.test.ts`
- Modify: `src/main/index.ts` (call `installAppMenu()` at `whenReady`)

**Interfaces:**
- Consumes: `openHostPath` (Task 4), `getLogPath` (errorLog), Electron `app`/`Menu`.
- Produces:
  - `export function buildAppMenuTemplate(actions: { openDataFolder: () => void; openLog: () => void }): Electron.MenuItemConstructorOptions[]` (pure — testable).
  - `export function installAppMenu(): void` (builds + sets the menu with real actions; not unit-tested).

- [ ] **Step 1: Write the failing test**

Create `src/main/appMenu.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { buildAppMenuTemplate } from './appMenu.js';

describe('buildAppMenuTemplate', () => {
  it('adds Open Data Folder and Open Log under a Help submenu, wired to the actions', () => {
    const openDataFolder = vi.fn();
    const openLog = vi.fn();
    const template = buildAppMenuTemplate({ openDataFolder, openLog });

    const help = template.find((m) => m.role === 'help' || m.label === 'Help');
    expect(help).toBeDefined();
    const items = (help!.submenu as Array<{ label?: string; click?: () => void }>) ?? [];
    const labels = items.map((i) => i.label);
    expect(labels).toContain('Open Data Folder');
    expect(labels).toContain('Open Log');

    items.find((i) => i.label === 'Open Data Folder')!.click!();
    items.find((i) => i.label === 'Open Log')!.click!();
    expect(openDataFolder).toHaveBeenCalledOnce();
    expect(openLog).toHaveBeenCalledOnce();
  });

  it('preserves the standard role-based submenus', () => {
    const template = buildAppMenuTemplate({ openDataFolder: () => {}, openLog: () => {} });
    const roles = template.map((m) => m.role);
    expect(roles).toContain('editMenu');
    expect(roles).toContain('viewMenu');
    expect(roles).toContain('windowMenu');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/appMenu.test.ts`
Expected: FAIL — cannot find `./appMenu.js` / `buildAppMenuTemplate`.

- [ ] **Step 3: Implement `appMenu.ts`**

Create `src/main/appMenu.ts`:

```ts
import { app, Menu, type MenuItemConstructorOptions } from 'electron';
import { getLogPath } from './errorLog.js';
import { openHostPath } from './openHostPath.js';

interface MenuActions {
  openDataFolder: () => void;
  openLog: () => void;
}

/**
 * Build the application-menu template. Electron has no "append to the default
 * Help submenu" API, so we supply a full template using role-based submenus
 * (File/Edit/View/Window behave identically to the default) and add our items
 * under Help. The macOS app-name submenu is included only on darwin. Pure +
 * exported so the Help items can be unit-tested without an Electron runtime.
 */
export function buildAppMenuTemplate(actions: MenuActions): MenuItemConstructorOptions[] {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Open Data Folder', click: () => actions.openDataFolder() },
        { label: 'Open Log', click: () => actions.openLog() }
      ]
    }
  ];
  return template;
}

/** Build the menu with real actions and install it as the application menu. */
export function installAppMenu(): void {
  const template = buildAppMenuTemplate({
    openDataFolder: () => void openHostPath(app.getPath('userData')),
    openLog: () => void openHostPath(getLogPath())
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/appMenu.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Install the menu at startup**

In `src/main/index.ts`, inside `app.whenReady().then(...)`, add `import { installAppMenu } from './appMenu.js';` and call `installAppMenu();` (after `installMainProcessHandlers()`).

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck`
Expected: clean.

```bash
git add src/main/appMenu.ts src/main/appMenu.test.ts src/main/index.ts
git commit -m "feat(menu): Open Data Folder + Open Log under Help

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: record mapping-diagnostic signals into the errors table

**Note:** These signals are NET-NEW on this baseline — the temporary `/shared`
`mappingDiag.ts` from the earlier investigation was never committed here. There
is nothing to remove; we add two `logError` signals that now flow into the
errors table and are reachable via `list_errors`.

**Files:**
- Modify: `src/main/ipc.ts` (add a module-scoped dedupe set; emit `new-session-dropped` (info) in the `new-session` handler; emit `mapping-unresolved`/`mapping-stale-session` (warn) in the `observability:summaryForBrokerSession` handler)

**Interfaces:**
- Consumes: `logError`, `lookupBrokerSession`, `summaryForBrokerSession` (all already imported in `ipc.ts`).

- [ ] **Step 1: Add a module-scoped dedupe set**

In `src/main/ipc.ts`, after the `committeeBusy` map declaration, add:

```ts
// Dedupe set so the per-tab summary lookup (polled on every observability push)
// records each unresolved (workspace:tab:outcome) only once per run.
const mappingUnresolvedSeen = new Set<string>();
```

- [ ] **Step 2: Emit `new-session-dropped` (info)**

In the `jsonlWatcher.on('new-session', ...)` handler, replace `if (!brokerSessionId) return;` with:

```ts
      if (!brokerSessionId) {
        logError({
          source: 'main',
          type: 'new-session-dropped',
          level: 'info',
          message: `new-session for ${claudeSessionId} had no pending attach to pair with`,
          workspaceId,
          extra: { claudeSessionId }
        });
        return;
      }
```

- [ ] **Step 3: Emit `mapping-unresolved` (warn) from the summary handler**

Replace the `observability:summaryForBrokerSession` handler body (currently a single `summaryForBrokerSession(...)` return) with:

```ts
  ipcMain.handle(
    'observability:summaryForBrokerSession',
    (_e, workspaceId: string, brokerSessionId: string) => {
      const summary = summaryForBrokerSession(workspaceId, brokerSessionId);
      // A blank rail's root signal: a no-mapping outcome here is why the per-tab
      // summary is null. mapped-no-session = stale mapping. Deduped per
      // (workspace:tab:outcome) so the frequent rail polls log each state once.
      const claudeId = lookupBrokerSession(workspaceId, brokerSessionId);
      const outcome = claudeId ? (summary ? 'resolved' : 'mapped-no-session') : 'no-mapping';
      const key = `${workspaceId}:${brokerSessionId}:${outcome}`;
      if (outcome !== 'resolved' && !mappingUnresolvedSeen.has(key)) {
        mappingUnresolvedSeen.add(key);
        logError({
          source: 'main',
          type: outcome === 'no-mapping' ? 'mapping-unresolved' : 'mapping-stale-session',
          level: 'warn',
          message: `per-tab summary ${outcome} for broker ${brokerSessionId}`,
          workspaceId,
          extra: { brokerSessionId, claudeSessionId: claudeId, outcome }
        });
      }
      return summary;
    }
  );
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc.ts
git commit -m "feat(obs): record mapping-unresolved/new-session-dropped diagnostics

The mapping-unresolved (warn) and new-session-dropped (info) signals now go
through logError into the errors table, reachable via list_errors — the
sanctioned replacement for the temporary /shared diagnostics.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: e2e MCP contract test for `list_errors`

**Files:**
- Modify: the MCP e2e spec under `tests/` (the `tests/mcp-*.spec.ts` that enumerates the tool surface)

**Interfaces:**
- Consumes: the running app's MCP socket harness used by the existing MCP e2e specs.

- [ ] **Step 1: Locate the tool-surface assertion**

Run: `rg -n "list_sessions|list_events|tools/list|expect.*tool" tests/mcp-*.spec.ts`
Expected: find where the spec asserts the set of available tool names.

- [ ] **Step 2: Add `list_errors` to the expected tool set**

In that spec, add `'list_errors'` to the asserted list of tool names (matching the file's existing style — array membership or snapshot).

- [ ] **Step 3: Run the e2e spec**

Run: `npx playwright test tests/mcp-*.spec.ts`
Expected: PASS (needs a display — WSLg/Xvfb, as the suite already requires).

- [ ] **Step 4: Commit**

```bash
git add tests/
git commit -m "test(e2e): pin list_errors in the MCP tool surface

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: SPEC.md updates

**Files:**
- Modify: `docs/SPEC.md`

- [ ] **Step 1: Data model (§6 / data-model section)**

Add the `errors` table to the sqlite schema description: columns (`id, ts, workspace_id NULL, session_id NULL [claude UUID], source, level, type, message, stack, extra`), the two indexes, the `ERRORS_RETENTION = 2000` prune-on-insert policy, and that it is fed by `logError`'s injected sink (file append stays primary + crash-safe).

- [ ] **Step 2: MCP surface (§11) + IPC/channel list**

Document `list_errors(workspace_id?, session_id?, level?, type?, since?, limit?) → rows (newest-first, ts_iso)` with the scoping rule: own workspace (`allowedWorkspaces`) + global NULL rows; caller `workspace_id` only narrows. Note `LogPayload` gained `workspaceId/sessionId/level`. Note the `errors` table is read-only via MCP like the rest.

- [ ] **Step 3: User flows (§5) + security model**

Add the Help-menu items (Open Data Folder → `userData`, Open Log → `error.log`, WSL-aware via `openHostPath`). In the security model, note global crash rows (NULL `workspace_id`) are visible to every workspace (accepted; crash text treated as non-private), while operational errors stay workspace-scoped.

- [ ] **Step 4: Commit**

```bash
git add docs/SPEC.md
git commit -m "docs(spec): errors table, list_errors MCP tool, Help-menu affordances

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Full gate

- [ ] **Step 1: Unit tests**

Run: `npm run test:unit`
Expected: PASS (incl. `db.test.ts`, `errorLog.test.ts`, `appMenu.test.ts`, `mcpServer.test.ts`).

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: success.

- [ ] **Step 4: (If a display is available) e2e**

Run: `npm run test:e2e`
Expected: PASS, including the MCP tool-surface spec.
```
