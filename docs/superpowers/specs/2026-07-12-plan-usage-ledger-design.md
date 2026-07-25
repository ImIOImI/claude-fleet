# Design: claude-fleet-wide token-spend ledger + `plan_usage` MCP tool

**Status:** approved design, pre-implementation.
**Date:** 2026-07-12.

## Problem

When the operator hit a Claude subscription limit (a 429 "You've hit your
session limit · resets 6pm (UTC)"), the fleet-state DB accounted for only ~$33
of API-list-equivalent spend in the active 5-hour window — visibly far below
what a real limit-hit implies. Investigation showed the DB does not see all of
claude-fleet's own token spend:

- **Local (non-container) backend workspaces** (SPEC § Local backend) run
  `claude` against the host's **real `~/.claude`**, so their transcripts land in
  `~/.claude/projects/<encoded-workspaceRoot>/`, **not** in
  `<userData>/state/<id>/.claude/projects/-workspace/`. The `JsonlWatcher` only
  tails the latter, so local-workspace spend is invisible to the DB.
- **Subagent transcripts** (`<session>/subagents/agent-*.jsonl`) are deliberately
  skipped (`depth:0`), so Task/committee subagent spend is uncounted.

The goal: aggregate **all of claude-fleet's own token spend** into a
globally-available view, exposed over the MCP server so any workspace can see
the app-wide total — the basis for an eventual "percentage of plan remaining"
signal in the observability rail.

## Scope

**In:**
1. Ingest local-backend workspace transcripts (attributed to their real id).
2. Ingest subagent transcripts (attributed to parent session + workspace).
3. Capture Anthropic's account-level limit signals as calibration anchors.
4. A global aggregate `plan_usage` MCP tool (non-private, totals only).

**Out (explicit non-goals):**
- **Cross-device / account-wide sync — never.** This is about the usage of the
  claude-fleet application only. The operator's *personal* non-fleet `claude`
  and other machines/claude.ai are not counted. Consequence: `plan_usage.usedPct`
  measures **claude-fleet's** plan consumption, not the whole Anthropic account.
- **Observability rail UI redesign — deferred.** This spec adds the IPC channel
  so the renderer *can* consume the aggregate; the visual rail work is separate.

## Model: hybrid (bottom-up telemetry + top-down anchors)

Continuous account-wide `%` cannot be derived from local data (claude.ai web
has no local log; Anthropic only reports true remaining/reset at throttle
moments). So:

- **Bottom-up** (pieces 1–2): sum all fleet-visible token spend, priced by
  `pricing.ts`, for continuous estimate and attribution.
- **Top-down anchors** (piece 3): the 429 reset messages and any populated
  `rateLimits` payloads are the only **account-wide-true** checkpoints; they
  pin the window bounds and the `capUsd` denominator.

## Piece 1 — completeness: count all three fleet transcript sources

All spend attributes to a **real `workspace_id`** — there is no synthetic
"host" bucket.

### 1a. Local-backend workspaces (`src/main/jsonlWatcher.ts`)

- For each `kind:'local'` workspace, compute its host transcript directory:
  `join(os.homedir(), '.claude', 'projects', encode(workspaceRoot))` and
  register it with the watcher, attributed to that workspace's real id.
- Because host paths don't carry the `<...>/.claude/projects/-workspace/`
  marker the container derivation relies on (`jsonlWatcher.ts` workspace
  resolution), the watcher keeps a `Map<hostProjectDir → workspaceId>` for its
  registered local dirs and consults it first when resolving a changed file's
  owning workspace.
- We register only each workspace's **specific** project subdir, never the whole
  `~/.claude/projects` tree — so the operator's unrelated personal projects in
  the same tree are never ingested.
- Registered for every `kind:'local'` workspace at startup and on
  `workspace:create`; unregistered on `workspace:remove`.
- **Load-bearing detail (must be pinned by a test):** `encode(workspaceRoot)`
  must match claude's exact cwd→project-dir sanitization (e.g. `/home/a/proj`
  → `-home-a-proj`). A drift here silently ingests nothing.

### 1b. Subagent transcripts (`src/main/jsonlWatcher.ts`)

- Lift the `depth:0` skip for the `<session>/subagents/` subpath so
  `agent-*.jsonl` files are watched and ingested.
- Attribute each subagent event to the **parent session's** `session_id` and
  `workspace_id`, so subagent token usage rolls up into that session's and the
  app-wide totals.
- No double-count: subagent API calls exist only in these separate files; the
  parent transcript does not restate their `usage`.

## Piece 2 — anchor capture (`usage_anchors`, schema v9)

New table; rebuildable from JSONL like every other cache table.

```sql
CREATE TABLE usage_anchors (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,   -- observed (source event ts)
  workspace_id TEXT,               -- provenance (a real fleet id)
  session_id   TEXT,
  kind         TEXT NOT NULL,      -- 'limit-hit' (429) | 'throttle' (populated rateLimits)
  http_status  INTEGER,            -- 429, etc.
  scope        TEXT,               -- 'session' | 'weekly' | 'opus-weekly' (parsed)
  reset_at     INTEGER,            -- parsed reset (epoch ms)
  window_start INTEGER,            -- reset_at - 5h for session scope (derived)
  message      TEXT,               -- human reset text
  rate_limits  TEXT,               -- raw rateLimits JSON when present
  dedup_key    TEXT NOT NULL,      -- source event uuid
  UNIQUE(dedup_key)
);
```

- `ingestLine` writes a row when it sees a 429 assistant event
  (`error:"rate_limit"`, `apiErrorStatus:429` — carries the reset text) or a
  `system/api_error` event whose `error.rateLimits` is non-null.
- The reset text (`"resets 6pm (UTC)"`) parses to `reset_at`; for `session`
  scope, `window_start = reset_at − 5h` gives the active block bounds.
- Anchors are account-wide-true even though the bottom-up ledger is fleet-only.

## Piece 3 — `plan_usage` MCP tool (`src/main/mcpServer.ts`)

A new tool, callable by **any** workspace with **no grant** — the same
non-private aggregate carve-out already used for global crash rows
(`list_errors` NULL-`workspace_id` rows).

Returns **app-wide aggregates only**:

```
{
  window:       { start_iso, end_iso, source: 'anchor' | 'rolling' },
  spend:        { usd, inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens },
  byModel:      [ { model, usd } ],
  byBackend:    [ { backend: 'container' | 'local', usd } ],
  latestAnchor: { kind, scope, reset_at_iso, message } | null,
  estimate:     { capUsd, usedPct, basis: 'calibrated' | 'seed' }
}
```

- **No per-workspace breakdown.** That is the one cross-workspace disclosure we
  avoid; a caller gets its *own* detail from `get_cost`. `byModel`/`byBackend`
  are coarse and non-identifying.
- Reads every `workspace_id` via server-side `SUM`/`GROUP BY`, priced by
  `pricing.ts` exactly like `get_cost` — it **bypasses the query snapshot**
  (which is per-caller scoped) but is structurally incapable of emitting a row
  finer than model/backend. **The privacy contract: totals cross the boundary;
  transcript content and per-workspace detail never do.**
- **Window:** the latest `usage_anchors` row whose scope covers `at`
  (real bounds, e.g. today's 13:00–18:00 block); falls back to a trailing
  `window_s` (default 5h) when no anchor exists.
- **`estimate`:** `usedPct = spend.usd / capUsd`. `capUsd` seeds from the window
  cost recomputed at the most recent `limit-hit` anchor — now including local +
  subagent spend, so no longer the $33 undercount. `basis:'seed'` until enough
  anchors accumulate to fit `capUsd`; a later calibration pass (its own project)
  refines it. Low-confidence/`null` when uncalibrated rather than a fake number.

Args: `plan_usage({ window_s?, at? })`.

## IPC

Add `observability:planUsage` (main → renderer request) returning the same
aggregate shape, so the observability rail can consume it later without a
second data path. No rail UI in this spec.

## SPEC.md updates (same change as implementation)

- **§7 Data model** — local-backend + subagent ingestion; `usage_anchors`
  table; schema bump to v9.
- **In-container SQLite access via MCP** — the `plan_usage` tool and its
  aggregate-only, no-grant carve-out (totals only; no per-workspace rows).
- **§9 Security model** — the totals-cross-not-content rule and the explicit
  no-per-workspace-breakdown constraint for `plan_usage`; local-workspace
  ingestion reads only each workspace's own registered project dir.

## Testing

- `encode(workspaceRoot)` matches claude's real sanitization (unit, pinned).
- Local-workspace file → resolved to its real `workspace_id` (watcher test).
- Subagent `agent-*.jsonl` events roll up to parent session/workspace, no
  double-count (watcher test).
- 429 and populated-`rateLimits` events produce correct `usage_anchors` rows;
  reset-text parse → `reset_at`/`window_start` (unit).
- `plan_usage` sums across workspaces, never emits per-workspace/content rows,
  and is callable without a grant (mcpServer test).
```
