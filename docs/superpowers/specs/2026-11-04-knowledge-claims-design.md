# Knowledge claims, phase 1: record, search, and background capture

**Date:** 2026-11-04
**Status:** Approved 2026-11-04; revised the same day (search-triggered capture + configurable settings, §5/§5a)
**Supersedes:** #206 (Phase 3 session value scoring and tiering)
**Related:** #476 (state.db growth and `query` freeze), #465 (runtime decision gate), Rust embedder sidecar spec (separate, parallel), state.db retention spec (separate)

## Problem

Durable knowledge in our sessions disappears. The root cause of a bug, the reason a design was rejected, or a gotcha that took an hour to find lives only in a transcript. Transcripts lose it in three ways:

- **Compaction.** Detail is summarized out of the live context.
- **Claude Code's transcript cleanup.** `cleanupPeriodDays` defaults to 30, and we don't override it, so the files are deleted.
- **Retention.** The `state.db` retention work strips old tool output and compresses old text turns.

The current plan for deciding what to keep (#206) scores *sessions* with usage signals: impressions, click-throughs, `mark_useful`, resumes. Those signals barely accumulated (3 `marked-useful` and 0 click-throughs across 82 sessions in one workspace). They also judge the wrong unit: a session isn't valuable, the few things learned in it are.

## Goal

Capture durable knowledge as **claims**: short, deliberate, attributed statements. Make them searchable by every agent in the fleet. Capture them continuously in the background so nothing depends on an agent remembering to write them down.

Primary consumer: **agents**, over MCP. Secondary, later: **expert libraries** (`/shared/fleet-expertise`).

## Phasing (whole initiative)

| Phase | Scope | Spec |
|---|---|---|
| **1 (this spec)** | Claims store + `record_claim` / `search_claims` / `retract_claim`; standing rule in MCP instructions; background capture via headless session forks | this document |
| 0 (parallel) | Rust embedder sidecar replaces in-process transformers.js + onnxruntime | separate |
| 2 | Topic pages: merge claims into living per-topic records (B from A) | later |
| 3 | Chapter-hook claim extraction (`summarize.sh` emits claims) + backfill from retained text turns | later |
| 4 | Export topic pages into expert libraries | later |

Phase 1 ships on the **current** embedder behind the existing `embed(texts) → vectors` interface. The Rust sidecar swaps in underneath without changes here.

## Design

### 1. Data model (`inbox.db`, next schema version after v5)

Claims are authoritative and agent-authored; they don't exist in any JSONL. So they live in `inbox.db`, which is never dropped or rebuilt, not in the rebuildable `state.db`. Access goes through the async Kysely store layer (#455), with no synchronous reads on the main thread.

```sql
CREATE TABLE claims (
  id             TEXT PRIMARY KEY,            -- ULID
  text           TEXT NOT NULL,               -- one claim, <= 600 chars
  kind           TEXT NOT NULL,               -- decision | fact | gotcha | root-cause | rejected
  topics         TEXT NOT NULL,               -- JSON array, 1-3 slugs ([a-z0-9-]{2,40})
  refs           TEXT,                        -- JSON array: "#476", "PR #478", "src/main/mcpServer.ts"
  visibility     TEXT NOT NULL DEFAULT 'fleet', -- fleet | private
  status         TEXT NOT NULL DEFAULT 'current', -- current | superseded | retracted
  superseded_by  TEXT,                        -- claim id
  retract_reason TEXT,
  workspace_id   TEXT NOT NULL,               -- authoring workspace, host-stamped
  confirmations  INTEGER NOT NULL DEFAULT 1,  -- near-duplicate re-records
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE TABLE claim_sources (                  -- provenance; one row per record event
  claim_id     TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  session_id   TEXT,                          -- NULL when not attributable (see §3)
  via          TEXT NOT NULL,                 -- agent | capture
  capture_run  TEXT,                          -- capture_runs.id when via = capture
  ts           INTEGER NOT NULL
);
CREATE TABLE claim_vectors (
  claim_id TEXT PRIMARY KEY, model_id TEXT NOT NULL, vec BLOB NOT NULL
);
CREATE VIRTUAL TABLE claims_fts USING fts5(text, topics, content='claims', content_rowid='rowid');
CREATE TABLE capture_runs (
  id               TEXT PRIMARY KEY,          -- ULID; doubles as the run token
  workspace_id     TEXT NOT NULL,
  session_id       TEXT NOT NULL,             -- the live session that was forked
  fork_session_id  TEXT,                      -- the fork's claude session id, once known
  trigger          TEXT NOT NULL,             -- ctx-60 | ctx-85 | turns
  status           TEXT NOT NULL,             -- running | done | failed | timed-out
  claims_recorded  INTEGER NOT NULL DEFAULT 0,
  usage            TEXT,                      -- JSON: tokens / cost reported by the fork
  error            TEXT,
  started_at       INTEGER NOT NULL,
  ended_at         INTEGER
);
```

Vectors use the same model id as transcript search, so query and claim vectors are comparable. They can always be recomputed from `text` after a model change.

### 2. MCP tools (fleet-state server; available to every workspace)

**`record_claim({ text, kind, topics, refs?, visibility?, supersedes?, capture_run? })`**
1. Validate the shape (lengths, kind enum, topic slug format, 1–3 topics).
2. **Secret filter.** Reject text or refs that match secret patterns (GitHub, AWS, OpenAI and Anthropic key formats, private-key blocks, connection strings with credentials, generic high-entropy `key=`/`token=` values). The error names the pattern class, never echoes the match.
3. **Near-duplicate check.** Embed the text and compare against current claims visible to the caller. At cosine ≥ 0.92 with the same `kind`, don't insert. Instead increment `confirmations`, bump `updated_at`, add a `claim_sources` row, and return the existing id with `deduped: true`.
4. **`supersedes`**: the target must be visible to the caller. Mark it `superseded` and set `superseded_by`.
5. **Provenance** is host-stamped: `workspace_id` from the MCP caller identity. `capture_run`, if given, must match a `running` capture run for the caller's workspace. Then `via = capture` and `session_id` = the run's forked session. Otherwise `via = agent`, `session_id = NULL` (see §3).
6. Returns `{ id, deduped, suggestedTopics }`. `suggestedTopics` lists the most-used existing topics near this claim, so agents converge on shared slugs.

**`search_claims({ query, topics?, kind?, include_superseded?, limit? })`**
- Hybrid ranking: FTS5 (BM25) and vector cosine, combined by reciprocal rank fusion. Exact tokens like `#476` hit via keywords; symptom-phrased questions hit via vectors.
- Visible set: every `fleet` claim plus the caller's own `private` claims. Excludes `superseded` and `retracted` unless `include_superseded`.
- Returns claim fields plus provenance (workspace name and id, session id if known, date, `via`, `confirmations`) and the superseding claim's id when one exists.
- Brute-force vector scoring is fine at expected scale (thousands of claims; ~10K × 384 dims is a few ms).

**`retract_claim({ id, reason })`**: only the authoring workspace may retract.

**Out of this phase:** browsing UI, editing claim text (supersede instead), topic pages.

### 3. Session attribution

MCP caller identity is per workspace, not per session (§11 Fleet-state MCP), so a claim an agent records in a live session can't be tied to a specific session today. Phase 1 accepts `session_id = NULL` for `via = agent`. Capture runs carry exact attribution through the run token. Per-session attribution for live agents (for example the bridge forwarding `CLAUDE_FLEET_BROKER_SESSION_ID`) is a follow-up, not a blocker.

### 4. Standing rule (MCP server `instructions`)

The fleet-state server returns an `instructions` string in its MCP `initialize` result. Claude Code injects it as a system reminder on the first turn, in every workspace (container, WSL, local). That needs no image change, loadout, or hook. It's truncated at 2,048 characters, so the rule stays well under that. Draft:

> Fleet knowledge: when you settle a decision, find a root cause, learn a non-obvious fact or gotcha, or rule something out (and why), call `record_claim` with one short self-contained sentence or two, 1–3 topic slugs, and refs (issue/PR/file). Before re-investigating something, call `search_claims` — another session may already know. Never put secrets in claims; use `visibility: "private"` for workspace-specific details.

### 5. Background capture

The app launches a **headless fork** of a live session that extracts claims, without touching the live session.

**Triggers** (revised 2026-11-04 after the feasibility gate measured $0.34–$0.53 per fork at ~50K context; see the gate results). Every value below is a per-workspace setting (§5a).
- **Search hit (primary).** After a `search_transcripts`, `search_claims` or `query` call returns, the app takes the top **N** distinct sessions the results reference (default **3**) and queues a capture for each that:
  - has never been captured, or has grown by at least `recaptureAfterTurns` (default **30**) user turns since its last capture;
  - is not the caller's own session (when known) and not a capture fork.

  The search response is never delayed. The capture prompt carries the search query, so the fork extracts what made the session relevant as well as general learnings.
- **Context fill (safety net before compaction).** Fill comes from the newest assistant event's usage: `input + cache_read + cache_creation` tokens ÷ the model's window (200K, or 1M for `[1m]` models; the model comes from the JSONL). A capture fires when fill first crosses each configured band. The default is **`[0.85]`**, one capture right before Claude Code would auto-compact. Bands reset when a compaction boundary is ingested.
- **Periodic (optional).** Every `turnsEvery` user turns. Default **off**.
- **Guards:**
  - At most one running capture per session, and at least 10 minutes between captures of the same session.
  - At most **2** concurrent captures app-wide; extra triggers queue. A queued trigger is dropped when a newer trigger for the same session replaces it, or after 15 minutes in the queue.
  - An **app-wide daily cap** (default **40** captures per local calendar day; global setting). Triggers over the cap are dropped and counted.
  - Never for automation runs, for capture forks themselves, or for sessions whose workspace has capture disabled.

**Execution** goes through the existing per-backend launch paths (`docker exec` into the container; the local or WSL launcher on the host), with the session's cwd:

```
claude -p "<capture prompt>" --resume <session-id> --fork-session \
  --model <session model> \
  --allowedTools mcp__claude-fleet-state__record_claim,mcp__claude-fleet-state__search_claims \
  --max-turns 12 --output-format json
```

- The **same model** as the session by default (setting `model: "session"`), so the re-read of the conversation prefix hits the prompt cache. A specific model id may be configured instead; it gets no cache benefit.
- **Tools are restricted** to the two claims tools, so the fork can't read files, run commands, or call other MCP tools.
- The **capture prompt** includes the run token (passed to `record_claim` as `capture_run`), the workspace's top existing topics, and, for search-hit captures, the search query ("someone searched for … and this session matched; what was it about and what did it learn?"). It instructs: search before recording; only durable, cross-session-useful knowledge; at most 10 claims; record nothing if nothing new; no secrets.
- **Wall-clock timeout:** 5 minutes. On timeout the fork process is killed and the run is marked `timed-out`.
- From the JSON output, the app records `fork_session_id`, usage (tokens and cost) and status in `capture_runs`. `claims_recorded` is counted from `claim_sources`.

**Fork bookkeeping:** the fork writes its own transcript into the workspace's projects directory, so the JSONL watcher will ingest it as a session. Sessions whose id appears as `capture_runs.fork_session_id` are filed under a collapsed **Knowledge capture** group in the Sessions rail, like automation runs (#448). Their cost stays in usage totals.

### 5a. Capture settings (per workspace, editable in the UI and by Claude)

The manifest field `knowledgeCapture` is an object (absent = all defaults). The parser is an allowlist, and every value is clamped to its range on read and on write:

| Field | Default | Range |
|---|---|---|
| `enabled` | `true` | boolean |
| `onSearchHit` | `true` | boolean |
| `searchTopSessions` | `3` | 1–5 |
| `recaptureAfterTurns` | `30` | 10–500 |
| `contextBands` | `[0.85]` | 0–4 values, each 0.50–0.95 (deduplicated, sorted) |
| `turnsEvery` | `0` (off) | 0, or 10–500 |
| `model` | `"session"` | `"session"` or a model id matching `^claude-[a-z0-9.\-\[\]]{1,60}$` |
| `transcriptRetentionDays` | `365` | 30–3650 |
| `captureVisibility` | `"fleet"` | `fleet` / `private`; the default visibility the capture prompt asks the fork to use |

The task-10 `knowledgeCapture: false` boolean becomes `{ enabled: false }`. A manifest still holding the boolean is read as that.

**Global settings** (config.json, Settings → Diagnostics, UI only):
- `knowledgeCapture` kill switch (default on, from task 10)
- `knowledgeCaptureDailyCap` (default 40, range 0–500; 0 = no captures)

**UI:** a **Knowledge capture** disclosure in the edit-workspace form, with one control per field, replaces the task-10 checkbox.

**Claude edits, via two new MCP tools** (fleet-state; caller's own workspace only):
- `get_capture_settings()` → the effective settings, with defaults filled in, plus the global cap and how many captures have run today.
- `set_capture_settings({ ...partial, reason })`:
  1. Validates and clamps each field, and rejects unknown fields.
  2. Classifies the change. It **increases cost** if it turns `enabled` or `onSearchHit` on, raises `searchTopSessions`, lowers `recaptureAfterTurns`, adds a band or lowers one, turns `turnsEvery` on or lowers it, or changes `model` away from `"session"`. Any other change (including `transcriptRetentionDays` and `captureVisibility`) is cost-neutral or cost-reducing.
  3. **Cost-reducing or neutral** changes apply immediately: the manifest is written through the main process, a change-log row is appended, and a low-priority notification is sent ("<workspace> changed its knowledge-capture settings: …").
  4. **Cost-increasing** changes apply immediately only when the workspace is `inbox.trusted`. Otherwise they become a **proposal** in the existing proposals flow (approve or reject, like automation proposals). The response then says `{ status: "proposed", proposalId }`.
- Change log: `capture_settings_log(id, workspace_id, ts, actor 'user'|'workspace', before JSON, after JSON, reason, applied 0|1, proposal_id)` in inbox.db (v7).

**Transcript retention:** the app makes `transcriptRetentionDays` effective as Claude Code's `cleanupPeriodDays`, so search-hit captures can still fork sessions older than Claude's 30-day default.
- **Container:** written into the container user's Claude settings file (bind-mounted state) at container start and when the setting changes.
- **Local and WSL:** passed on the app's own `claude` launches as `--settings '{"cleanupPeriodDays":N}'`.

Limitation: the user's own non-app `claude` runs on the same machine still apply their own `cleanupPeriodDays`. The workspace form says so.

### 6. Retiring `mark_useful`

Remove the `search_transcripts` description text that tells agents to call `mark_useful`. Keep the tool and `usage_events` working for compatibility. Close #206 as superseded by this spec.

### 7. Security model (SPEC §9 addition)

- `fleet` claims are an **intentional, agent-authored exception to workspace isolation**. They're short statements an agent chose to publish, not transcript content. `private` claims stay with the authoring workspace.
- The secret filter is a backstop, not a guarantee. The standing rule and capture prompt both forbid secrets.
- Capture forks run with tools restricted to the two claims tools. They read only the conversation the user's own session already holds.
- Provenance (`workspace_id`, `via`, `capture_run` → `session_id`) is host-stamped. Agents can't forge another workspace's or session's authorship.

## Feasibility gate (first implementation task)

The docs don't guarantee that `--resume <id> --fork-session` is safe while the original session is live. Before building the trigger and execution path, run an empirical test in a runner container and a local workspace:

- Fork a session that is actively mid-turn, repeatedly.
- Then verify the live transcript is byte-identical apart from its own appends, `--resume` of the original still works, and the fork's transcript is separate.
- Also confirm that `--allowedTools` with MCP tool names works in `-p` mode on our pinned version (2.1.281), and measure cache-hit cost on a long session.

If forking a live session is unsafe, fall back to forking a **snapshot**: copy the JSONL to a temp session id and resume that.

## Testing

- **Unit tests:**
  - Claim validation and the secret filter (positive and negative corpus).
  - Near-duplicate merge, supersede and retract rules.
  - Visibility scoping in `search_claims` (fleet, private, other-workspace private never visible).
  - RRF ranking with a stub embedder.
  - `capture_run` token validation (wrong workspace, finished run, and unknown token are all rejected).
  - The trigger policy as a pure function (fill thresholds, reset on compaction, turn counter, guards, concurrency cap).
- **Store tests** on the async Kysely layer, plus the migration from v5 with backup.
- **MCP contract tests:** update `mcpServer.test.ts` and `tests/mcp-*.spec.ts` for the three new tools and the `instructions` field (see the MCP contract test convention).
- **Capture execution** with a fake `claude` binary that emits canned JSON and calls `record_claim` through the real MCP socket.
- **Not testable in-container:** the Electron app, the Sessions-rail grouping, and real forks on the Windows host. Those are host-eyeball items in the PR.

## Measurement

- Per session: claims recorded via agent vs. via capture.
- Per capture run: tokens, cost, duration, claims, dedup rate.
- Perf spans: `claude_fleet.claims.record`, `claude_fleet.claims.search`, `claude_fleet.capture.run`.

These tune the thresholds, the capture prompt, and whether the standing rule alone pulls its weight.

## Out of scope

Topic pages (phase 2), chapter-hook extraction and backfill (phase 3), expert library export (phase 4), the Rust embedder (separate spec), `state.db` retention (separate spec), a claims browsing or editing UI, and per-session attribution for live agents.
