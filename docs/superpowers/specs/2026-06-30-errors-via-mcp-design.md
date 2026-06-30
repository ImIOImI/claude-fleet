# Errors via MCP + Help-menu host-file affordances — design

**Date:** 2026-06-30
**Status:** approved (brainstorm), pending implementation
**Branch:** `worktree-obs-rail-fallback`

## Motivation

While investigating why the observability rail blanks for a session (the broker→claude
mapping was suspected absent), there was no sanctioned way for an in-workspace agent to
read host-side errors or "why is this panel degraded" signals. `error.log` lives in the
host Electron `userData` dir, which a workspace container cannot reach (security
invariant, SPEC §9), and the MCP read surface exposes only `list_sessions` / `get_session`
/ `get_cost` / `list_events` — no errors, no diagnostics. As a stopgap, diagnostics were
written to the bind-mounted `/shared` folder. This design replaces that hack with a
first-class, scoped, queryable error surface, plus a human affordance to reach the data
folder from the app's Help menu.

(Note: CLAUDE.md advertises `query` / `session_summary` / `broker_sessions` MCP access
that is **not implemented** — see Out-of-scope follow-ups.)

## Goals

- An in-workspace agent can read **its own** workspace's errors via MCP to self-diagnose
  failures and degraded panels.
- Operational failures (attach/broker, ingest, MCP socket) and app-level crashes are
  recorded in a structured, queryable store.
- A human can open the host `userData` folder (and the log) from the Help menu.
- Crash logging stays robust — it must not depend on SQLite being healthy.

## Non-goals

- Re-exposing rendered panel output via MCP (couples the contract to renderer formatting).
- A cross-workspace "manager observes experts" error view (comes "for free" via the
  existing read-grant scoping, but is not the design target).
- Fixing the deeper broker→claude mapping-learning durability (separate follow-up).

## Consumer & scoping

Primary consumer: the **in-workspace agent (self)**. Reads are scoped to the caller's own
workspace plus any read grants (the existing `ctx.allowedWorkspaces` mechanism), plus
global (NULL-workspace) crash rows.

## Data model — new `errors` table (migration → `user_version` 5)

```sql
CREATE TABLE errors (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,   -- epoch ms (matches events.ts convention)
  workspace_id TEXT,               -- NULL = global/app-level (crashes); else attributable
  session_id   TEXT,               -- NULL = not session-scoped or claude UUID unknown; else CLAUDE session UUID
  source       TEXT NOT NULL,      -- 'main' | 'renderer'
  level        TEXT NOT NULL,      -- 'error' | 'warn' | 'info'
  type         TEXT NOT NULL,      -- 'uncaughtException', 'pty-attach-failed', 'mapping-unresolved', …
  message      TEXT NOT NULL,
  stack        TEXT,
  extra        TEXT                -- JSON (the existing logError `extra`; holds broker_session_id when that's all we have)
);
CREATE INDEX idx_errors_workspace_ts ON errors(workspace_id, ts);
CREATE INDEX idx_errors_session ON errors(session_id);
```

- `session_id` is the **claude session UUID** (the canonical key the rest of the schema
  joins on), NOT the broker session id. Call sites that know only the broker id resolve to
  the UUID best-effort via `lookupBrokerSession` at record time; if the mapping is absent,
  `session_id` stays NULL (itself an honest signal). The raw broker id goes in `extra`.
- `level` keeps non-fatal degraded-panel signals (`warn`/`info`) from reading as crashes
  (`error`).
- **Retention:** prune on insert — keep the most recent ~2000 rows (bounded; cheap via the
  ts index). Keeps the cost/observability DB small.

## Write path — Approach A (augment `logError` via an injected sink)

`errorLog.ts` stays dependency-free and crash-safe:

- `LogPayload` gains optional `workspaceId?`, `sessionId?`, `level?` (default `'error'`).
- Add `setErrorSink(fn)` + a module-local `sink`. `logError` appends to `error.log`
  **first and unconditionally** (unchanged behavior), then calls `try { sink?.(row) } catch {}`.
  A wedged DB never breaks crash logging; `errorLog.ts` imports nothing heavy.
- At startup, register a sink → `db.recordError(row)` (inserts + prunes).
- **Attribution:** operational call sites pass `workspaceId` (many already carry it in
  `extra` — hoist to the top-level field) and `sessionId` where known; crashes pass
  neither → both NULL.

## MCP read surface — new `list_errors` tool

```
list_errors(workspace_id?, session_id?, level?, type?, since?, limit?) → rows (newest-first, ts + ts_iso)
```

- **Scoping rule:** `WHERE (workspace_id IN (allowed) OR workspace_id IS NULL)`. A caller
  sees its own workspace's errors plus global crashes. A caller-supplied `workspace_id`
  can only narrow within `allowed`, never widen (same guard as `list_sessions`).
  `session_id` only narrows within already-visible rows.
- Read-only handle (`rodb`), clamped limit, `ts_iso` sibling — consistent with existing tools.

## Fold in the temporary `mapping-diag` signals (retire the `/shared` hack)

Remove `src/main/mappingDiag.ts` and its `void mappingDiag(...)` call sites. Replace the
two genuinely-diagnostic signals with permanent `logError` calls recorded into the table:

- `type:'mapping-unresolved'`, `level:'warn'`, `workspace_id` set, `session_id` NULL — the
  "why is the rail blank" signal (logged from `summaryForBrokerSession`'s no-mapping path,
  deduped per workspace/tab as today).
- `type:'new-session-dropped'`, `level:'info'`, `workspace_id` set — the restart-race
  signature (the `dropped-empty-queue` case in the `new-session` handler).

Drop the noisy attach-mode / resolved-hit logs.

## Help-menu host-file affordances

The app currently uses Electron's **default** application menu (File/Edit/View/Window/Help)
because it never calls `setApplicationMenu`. Electron has no "append to the default Help
submenu" API, so:

- At `app.whenReady`, build a custom menu (`Menu.buildFromTemplate` → `setApplicationMenu`)
  that mirrors the defaults via **`role`-based submenus** (File/Edit/View/Window unchanged,
  plus the macOS `appMenu` conditional for cross-platform correctness), adding under
  **Help**: **Open Data Folder** (`app.getPath('userData')`) and **Open Log** (`getLogPath()`).
- Handlers run in main and reuse the WSL-aware open logic
  (`RUNNING_IN_WSL ? openPathViaExplorer : shell.openPath`). Extract that helper from
  `ipc.ts` into a small `openHostPath.ts` so the menu module doesn't depend on `ipc.ts`.
- No new IPC needed (menu clicks are main-side). The existing `app:openErrorLog` stays for
  the toast.

## SPEC.md updates (same change, per `.claude/rules/spec-maintenance.md`)

- §6 — the `errors` table in the observability data model.
- §11 + the IPC/MCP channel list — the `list_errors` tool + scoping rule; the `LogPayload`
  contract gaining `workspaceId`/`sessionId`/`level`.
- §5 (user flows) — the Help-menu items.

## Testing

- **Unit (vitest):**
  - `db.recordError`: insert; retention prune keeps ≤N, newest retained; `session_id`
    resolution from broker id (present → UUID, absent → NULL).
  - `errorLog`: `setErrorSink` invoked; file append still happens; sink failure swallowed
    (crash-safety).
  - `mcpServer.test.ts`: `list_errors` scoping — caller sees own-workspace + NULL-global
    rows but **not** another workspace's; `session_id`/`level`/`since` filters. (Extends the
    cross-workspace isolation regression test.)
- **e2e (CI):** per the MCP-contract-tests convention, the tool surface is pinned by
  `mcpServer.test.ts` **and** `tests/mcp-*.spec.ts` — update both. Native-menu clicks are
  hard to drive in Playwright, so the Help-menu items are covered at the handler/IPC level,
  not e2e.
- DB-touching vitest needs the prebuilt `better-sqlite3` binary + electron path stub in
  base `node_modules` (per project run-unit-tests setup).

## Security considerations

- App-level crash rows have NULL `workspace_id` and are visible to **every** workspace
  (accepted): crash messages/stacks are treated as non-private. Operational errors are
  workspace-scoped and stay private.
- Reads remain read-only and mediated by main; no new filesystem path into the DB.

## Out-of-scope follow-ups

- **CLAUDE.md drift:** it documents `query` / `session_summary` / `broker_sessions` MCP
  access that isn't implemented. Either implement or correct the doc (separate change).
- **Mapping-learning durability:** the broker→claude mapping is learn-once with no repair
  path on reconnect (persist learned claude UUID into `sessions.json` + replay on attach).
  The `mapping-unresolved` signal added here makes this diagnosable; the fix is separate.
