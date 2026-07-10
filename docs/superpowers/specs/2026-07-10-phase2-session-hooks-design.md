# Phase 2: session hooks — mapping ground truth, LLM summaries with tags, value-signal collection

**Date:** 2026-07-10
**Status:** approved (design review with Troy, this session)
**Builds on:** semantic transcript search Phase 1 (#185, shipped v0.5.2), deterministic session ids (#198), verified mappings (#204)

## Problem

Three gaps left after v0.5.2:

1. **Tab↔session drift.** Session ids are host-assigned at spawn (#198) and resume-verified (#204), but `/clear` starts a new claude session id inside the same tab and the host never hears about it — even verified mappings drift. Claude itself is the only authority on its current session id.
2. **No session summaries.** The ingest path for `session-summary` events (→ `session_summaries` + embedding) shipped in Phase 1 and is fully dormant: nothing produces the events. `search_transcripts` has turn-level results only; there is no "what was this session about" layer and no concept tags.
3. **No value signals.** Transcript data grows without bound; eventual compaction needs to know which sessions/concepts are *valuable*. Value signals only exist if collected from the start — every week without collection is a week future compaction has to guess about.

## Design

### A. Broker exports tab identity into claude's environment

The broker sets `CLAUDE_FLEET_BROKER_SESSION_ID=<its session id>` in the env of every claude it spawns (`broker/internal/…/newSession` — the broker already knows its id; no protocol change). `localSessions.ts` sets the same var for local spawns. Hooks run in claude's process env, so every hook knows which tab it belongs to.

### B. SessionStart hook → ground-truth verified mapping

New `docker/runner/session-report.sh`, registered under **`SessionStart`** in `hooks.settings.json` (fires on startup, resume, **and clear** — the drift case). It reads `session_id` from the hook payload and the broker id from env, then calls a new MCP tool:

- **`report_session_mapping { brokerSessionId, sessionId }`** — writes the caller's own workspace mapping via `learnBrokerSessionMapping` (verified=1: this is claude's own testimony). Logs `mapping-remapped` when it corrects drift. Caller identity is ambient (same trust model as `signal_input_wait`); the tool can only ever affect the caller's own workspace.

Transport, timeout (2s), fire-and-forget semantics, and the `CF_*_SINK` test seam all mirror `input-wait-report.sh`.

### C. Stop hook → debounced LLM summary + tags (sidecar JSONL)

New `docker/runner/summarize.sh`, registered under **`Stop`**:

1. **Debounce — human prompts, not lines.** Transcript lines are a bad novelty proxy: one tool-heavy turn emits dozens of lines (tool_use + results), so a line threshold would fire on every turn exactly when sessions are busiest. Instead count **typed user prompts** (in claude JSONL, human messages carry *string* content; tool results carry content *arrays* — a one-line jq discriminator) against `<uuid>.fleet.state`. Re-summarize only when **≥ `CF_SUMMARY_MIN_NEW_PROMPTS` (default 3)** new human prompts have landed since the last summary **and ≥ `CF_SUMMARY_MIN_INTERVAL_S` (default 120)** seconds have passed since the last summarizer run. Worst-case cost: one haiku call per three human messages, capped at one per two minutes — bounded by typing speed, invariant to tool storms. Most Stop firings cost one jq pass.
2. **Generate — chapter summaries, not a rolling whole-session summary.** A long "wandering" session (days, many subjects) compressed into one 3-sentence blurb generalizes into uselessness. Instead each firing summarizes only the **window since the last summary** (the ~3+ new prompts — time-local, therefore topic-coherent), producing an append-only sequence of focused *chapters*. Extract the window's turn text (jq, cap ~8k chars), prepend the previous chapter's summary as one line of continuity context ("Previously: …"), pipe to `claude -p --model haiku` (env-overridable: `CF_SUMMARY_MODEL`) **in the background** with a prompt demanding strict JSON `{ "summary": "...", "tags": ["..."] }` — ≤3 sentences about this window, 3–6 lowercase concept tags. Runs on the workspace's own credentials (in-container auth). Validate with jq; discard on parse failure (log to stderr, never block). Window-only input also keeps the prompt small regardless of session length.
3. **Deliver:** append `{"type":"session-summary","summary","tags","sessionId","model","fromEventTs","toEventTs"}` to the sidecar `<uuid>.fleet.jsonl` — **never** to claude's live transcript (appending to it corrupts `--resume`).

**Known risk (resolve during implementation):** the `claude -p` run writes its own throwaway transcript. Run it from `/tmp` and verify the watcher doesn't index it; fallback: filter at ingest by cwd. Cost profile: ≤ one haiku call per 3 human prompts and ≥120s apart, on the workspace's own auth.

### D. Watcher + ingest

- `JsonlWatcher` learns the sidecar convention: `*.fleet.jsonl` ingests under the session id from the filename stem and **never** fires `new-session` (cannot touch the pending-attach fallback path).
- `ingestLine`'s `session-summary` handling changes from upsert-one-per-session to **append-one-chapter-per-event** (dedup key unchanged: `source_max_event_id`); `tags[]` accumulate into `session_tags` via `INSERT OR IGNORE` (union across chapters — a wandering session correctly carries many tags). Chapters are append-only, so each embeds exactly once and the old "stale summary embedding on re-summarization" backlog item **evaporates** — no cleanup path needed.

### E. Value-signal collection (collection now; scoring/compaction is Phase 3)

Append-only **`usage_events`** table; scores are always derived at read time, never stored destructively.

Signals recorded:

| kind | producer | notes |
|---|---|---|
| `search-impression` | `search_transcripts` | one per distinct session id returned; `detail` carries the query text (queries are a census of in-demand concepts) |
| `clickthrough` | `get_session` / `session_summary` / `list_events` / `get_cost` | recorded when the target session appeared in one of the caller's `search_transcripts` results within the last 5 minutes (per-caller in-memory ring in mcpServer) |
| `marked-useful` | new MCP tool **`mark_useful { sessionId, note? }`** | explicit agent feedback; the `search_transcripts` tool description instructs agents to call it when a result leads to their answer |
| `resumed` | host, at CREATE-with-`--resume` (docker + local) | a human reopening a session is the strongest implicit vote |

**Read-only invariant preserved:** the MCP server's DB handle stays readonly. All writes (`report_session_mapping`, `mark_useful`, usage events) go through handlers injected by `ipc.ts` (the `signal_input_wait` / committee-handler pattern), which own the writable connection.

### F. Data model (migration v8)

```sql
-- session_summaries becomes CHAPTERED: rebuild from (session_id PRIMARY KEY)
-- to append-only rows, one per summarized window. Existing rows (if any)
-- migrate as chapter rows unchanged.
CREATE TABLE session_summaries_v8 (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id          TEXT NOT NULL,
  workspace_id        TEXT NOT NULL,
  summary             TEXT NOT NULL,
  tags                TEXT,                 -- JSON array for this chapter
  source_max_event_id INTEGER NOT NULL,     -- dedup key (unchanged semantics)
  from_ts             INTEGER,
  to_ts               INTEGER,
  model               TEXT,
  generated_at        INTEGER NOT NULL,
  UNIQUE(session_id, source_max_event_id)
);
-- (copy old rows, drop old table, rename)
CREATE INDEX idx_session_summaries_session ON session_summaries_v8(session_id, generated_at);

CREATE TABLE session_tags (
  workspace_id TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  tag          TEXT NOT NULL,
  PRIMARY KEY (session_id, tag)
);
CREATE INDEX idx_session_tags_workspace ON session_tags(workspace_id, tag);

CREATE TABLE usage_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,
  workspace_id TEXT NOT NULL,
  session_id   TEXT,
  kind         TEXT NOT NULL,    -- 'search-impression' | 'clickthrough' | 'marked-useful' | 'resumed'
  detail       TEXT              -- JSON: {query} on impressions, {note} on marks, …
);
CREATE INDEX idx_usage_events_session ON usage_events(session_id, kind);
CREATE INDEX idx_usage_events_workspace_ts ON usage_events(workspace_id, ts);
```

### G. MCP surface changes (contract tests must move in lockstep — unit `mcpServer.test.ts` + e2e `tests/mcp-*.spec.ts`)

- New tools: `report_session_mapping`, `mark_useful` (write-via-injected-handler, caller-scoped).
- `query` snapshot gains `session_summaries`, `session_tags`, `usage_events` (all carry `workspace_id` → structural scoping unchanged); tool description updated. Tag cloud = `SELECT tag, COUNT(*) FROM session_tags GROUP BY tag` for any agent.
- `search_transcripts` description gains the mark-useful instruction; starts returning `kind='summary'` hits for real — one per *chapter*, so a hit lands on the relevant stretch of a long session (its `from_ts`/`to_ts` locate it in time).

### H. Version-skew safety

- New runner image ships both scripts + updated `hooks.settings.json` in the same layer (no #182-style missing-file crash).
- Old image + new app: hooks absent, features dormant.
- New image + old app: `report_session_mapping` / `mark_useful` return a clean unknown-tool error the fire-and-forget scripts ignore.
- Existing workspaces adopt on image pull + container recreate.

## Testing

- **Bash (sink seam, mirroring `input-wait-report.test.sh`):** session-report payload/env handling; summarize debounce (no-op under threshold), strict-JSON validation (malformed LLM output discarded), sidecar append format.
- **Vitest:** watcher sidecar routing (ingests, never fires new-session); tags ingest + replace semantics; stale summary-embedding cleanup; migration v8; both new tools (scoping, injected-handler wiring); impression/clickthrough recording incl. the 5-minute ring.
- **E2E:** MCP contract spec update.
- **Gate before merge:** build the runner image and smoke the hooks against it (established rule from the v0.4.0 spawn-crash incident).

## Non-goals (this phase)

- Tag-cloud UI (data only; renderer follow-up once real data exists).
- Local-workspace hooks (local claude doesn't receive `--settings` today).
- Summary backfill for historical/dead sessions (turn-level index already covers them).
- **Value scoring, tiering, and compaction — Phase 3**, spec'd separately once collected data exists. Sketch agreed: derived score = Σ weight(kind) × exponential decay (≈30-day half-life); compaction = tiering (hot: turn embeddings → warm: summary+tags only → cold: title only), demotion by score, promotion on renewed engagement; JSONL remains source of truth so every demotion is reversible by re-index.
