# Design: scoped state-DB `query` + cheaper aggregation tools (#174)

**Status:** approved (design), pending implementation
**Issue:** [#174](https://github.com/ImIOImI/claude-fleet/issues/174) — *claude-fleet-state MCP: expose query + parsed/projected events to cut token cost of aggregation*
**Scope:** `src/main/mcpServer.ts` (+ tests), `docs/SPEC.md`, the `fleet-log` skill, this workspace's `CLAUDE.md`.

## Problem

The `claude-fleet-state` MCP tools make read-heavy aggregation (e.g. the `fleet-log`
skill) far more token-expensive than necessary. Surfaced concretely:

1. The documented workhorse `query` tool is **not exposed** — it was deliberately
   removed for cross-workspace isolation (#146, SPEC §9/§11), so every analysis
   pulls full rows and reassembles client-side.
2. `list_events` returns `tool_name` but not *which* file/command — the parsed
   detail lives in columns that aren't projected, forcing transcript-JSONL reads
   off disk.
3. Unfiltered/unprojected `list_events` blows the tool-result size limit (~58–63k
   chars per session) and spills to disk.
4. Timestamps are epoch ms; clients shell out to `date` to bucket by UTC day.

## Key findings that shape the design

- **better-sqlite3 (12.10.0) does not expose SQLite's authorizer** (`set_authorizer`
  exists only in the bundled C source, not the JS API). The textbook row-level
  security mechanism is therefore unavailable — isolation must be structural.
- **`events` already carries the parsed detail.** `tool_input` (db.ts
  `summarizeToolInput`) picks out `command` / `file_path` / `path` / `pattern` /
  `url` / `description` (capped 160 chars); `tool_name`, `tool_use_id`,
  `tool_result_is_error`, model and all token columns are structured too. No schema
  change is needed for any deliverable.
- **`events.workspace_id` and `sessions.workspace_id` are both `NOT NULL`** and
  indexed, so row-level scoping is a clean `WHERE workspace_id IN (…)` filter.
- **`raw_jsonl` is the verbatim transcript line** — the full `message.content[]`
  (complete tool inputs, tool-result bodies, assistant/thinking text), unparsed.
  It is the largest and most sensitive column; it is the thing #146 forbids
  crossing workspaces. It is excluded from snapshots by default.

## Deliverables

Four changes, all in `src/main/mcpServer.ts`. No DB schema migration.

### 1. `query` — read-only SQL, scoped by construction (snapshot approach)

A new tool that runs arbitrary read-only SQL against a **per-call in-memory
snapshot** containing only the caller's allowed-workspace rows.

**Args**

| arg | type | default | notes |
|-----|------|---------|-------|
| `sql` | string | — | required; a single read-only statement |
| `params` | array | `[]` | bound parameters for the statement |
| `include_raw` | boolean | `false` | include the `raw_jsonl` column in the events snapshot |
| `max_rows` | number | `DEFAULT_LIMIT` (200), capped at `MAX_LIMIT` (1000) | hard row cap on the result |

**Per-call flow**

1. Open `new Database(':memory:')` — a throwaway.
2. `ATTACH '<state.db>' AS base_<random>` read-only; the random alias is
   unguessable so user SQL can't reference it even if it learned of `ATTACH`.
3. Copy **only allowed-workspace rows** into the memory DB:
   - `CREATE TABLE main.events  AS SELECT <cols; raw_jsonl only if include_raw> FROM base_x.events  WHERE workspace_id IN (…)`
   - `CREATE TABLE main.sessions AS SELECT * FROM base_x.sessions WHERE workspace_id IN (…)`
   - `CREATE TABLE main.broker_sessions AS SELECT * FROM base_x.broker_sessions WHERE workspace_id IN (…)`
   (Recreate the workspace/session indexes on the copies for query perf — optional, cheap.)
4. **`DETACH base_x`.** The memory DB now physically contains only allowed rows;
   the real DB is unreachable from any subsequent statement.
5. Compile with `db.prepare(sql)` and assert `stmt.reader === true`. This both
   rejects writes/DDL and enforces a single statement (better-sqlite3 compiles only
   the first). A non-reader statement → tool error.
6. `stmt.all(...params)`, enforcing `max_rows` and a serialized-byte ceiling
   (~50 KB). On overflow return a clear "add LIMIT / aggregate server-side" error
   rather than spilling to disk.
7. Close the memory DB (always, in `finally`).

**Why this is safe.** Isolation is structural: other workspaces' rows are not in
the DB being queried, so no subquery, `UNION`, CTE, or `sqlite_master`
introspection can reach them. There is no SQL-parsing blocklist to keep airtight.
This *replaces* the prior "there is deliberately no `query`" stance with "`query`
runs against a scoped snapshot," preserving the #146 / SPEC §9 invariant by
construction rather than by omission.

**Cost.** A snapshot is built per call — cheap for the common single-workspace
case, especially with `raw_jsonl` excluded. Per-call snapshot caching is a possible
future optimization; not built (YAGNI).

### 2. Richer `list_events`

- Add `tool_input`, `tool_use_id`, `tool_result_is_error` to the default
  `EVENT_COLS` projection.
- Add an optional `tool_name` filter (`WHERE tool_name = ?`).
- Add an optional `columns` projection: an array validated against an allowlist of
  the known event column names; unknown names are rejected. Omitted → default cols.

This fixes "which file/command" (problem 2) and the size blowups (problem 3)
without ever touching `raw_jsonl`.

### 3. `session_summary(id)`

Scoped via the existing `sessionAllowed` check. One call returns:

- `filesEdited` — distinct `tool_input` where `tool_name IN ('Write','Edit','NotebookEdit')`
- `commands` — `tool_input` where `tool_name = 'Bash'`
- `cost` + token totals — reuse the `get_cost` aggregation
- `startedAt` / `lastActiveAt` — both epoch ms and ISO

List sizes are capped (e.g. first N distinct entries, with a count) so the result
stays small. Collapses the current list-events + get-cost + jq sequence into one
request — the exact shape `fleet-log` needs per session.

### 4. Human-readable timestamps

`list_sessions`, `get_session`, `list_events`, and `session_summary` gain ISO
sibling fields (e.g. `ts_iso`, `last_active_at_iso`) derived via
`new Date(ms).toISOString()` (skipping null/0). `query` is self-serve — the model
can call SQLite's `datetime(ts/1000,'unixepoch')`.

## Security model change

- `query` now exists. Its safety rests entirely on the snapshot: a fresh in-memory
  DB seeded only with `WHERE workspace_id IN (allowedWorkspaces)` rows, queried
  after the real DB is detached. The caller can run any read-only SQL but can only
  ever see rows it was already entitled to via the typed tools.
- `include_raw` exposes `raw_jsonl` **only for the caller's own allowed rows** —
  scoping is unchanged by the flag.
- `allowedWorkspaces` continues to come from `ctx` (host-assigned, never from the
  wire); `query` does not take a `workspace_id`/`caller_id` argument.

## Spec & docs updates (same commit)

- **`docs/SPEC.md` §11** (Fleet-state MCP) and the §9 isolation-invariant wording:
  describe `query` and the snapshot mechanism; note the new/extended typed tools.
  Required under `.claude/rules/spec-maintenance.md` (data-model + security-model change).
- **`src/main/mcpServer.ts`** — rewrite the "NOTE: there is intentionally no raw
  `query`" comment block to describe the snapshot mechanism.
- **`fleet-log` skill** and this workspace's **`CLAUDE.md`** — reflect that `query`
  is live and snapshot-scoped (not "disabled when scoped reads are on").

## Testing (TDD)

Extend `src/main/mcpServer.test.ts`:

- **Cross-workspace isolation regression for `query`** — a query attempting to read
  another workspace's rows directly, via `UNION`, via subquery, and via
  `sqlite_master` introspection all return no foreign rows.
- **Read-only guard** — `INSERT` / `UPDATE` / `DROP` / `ATTACH` / multi-statement
  SQL are rejected by the `reader` assertion.
- **Caps** — `max_rows` truncation and the byte ceiling produce a clear error
  instead of an oversized payload.
- **`include_raw`** — off by default; on, returns `raw_jsonl` only for allowed rows.
- **Richer `list_events`** — new columns present; `tool_name` filter and `columns`
  projection behave; unknown column names rejected.
- **`session_summary`** — aggregates files/commands/cost/tokens/time-span; denied
  for a session outside the allowed set.
- **Timestamps** — ISO fields present and correct on the typed tools.

## Non-goals

- No DB schema migration (all needed fields exist).
- No per-call snapshot caching (future optimization only).
- No fleet-global / unscoped read mode — `query` is always snapshot-scoped.
