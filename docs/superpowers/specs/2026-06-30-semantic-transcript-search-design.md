# Design: Semantic transcript search for agents

**Date:** 2026-06-30
**Status:** Approved (brainstorming) — pending implementation plan
**Repo:** `claude-fleet`

## Problem

Agents (Claude sessions running inside claude-fleet workspaces, including the
committee manager) cannot retrieve relevant *past* transcript content by meaning.
The observability pipeline stores every JSONL line in `events`, but the only
extract columns are metadata (tokens, model, tool name, timestamps). The actual
conversation content lives inside the `raw_jsonl` blob, nested in Anthropic's
`message.content[]` format, and the MCP read surface deliberately exposes **no**
transcript bodies (`list_events` omits `raw_jsonl`; there is intentionally no
raw-SQL `query` tool — mcpServer.ts:620 — because raw bodies "can't be safely
confined to the caller's workspace", #146).

We want agents to ask "have I/we worked on something like this before?" and get
back the most semantically relevant past turns and sessions — **without**
weakening the cross-workspace confinement model.

## Decisions locked during brainstorming

- **Friction to remove:** semantic search over transcript content (not better
  parsing of metadata, not raw summaries alone).
- **Consumer & scope:** *both* self-recall (an agent over its own workspace) and
  grant-scoped cross-workspace search (the committee manager over experts it
  holds a `read` grant on). One shared index, one tool, filtered by
  `allowedWorkspaces`.
- **Embeddings:** local, on-host, **WASM backend** (no new native module). No
  transcript text leaves the host. No new vault secret.
- **What to index:** conversation text (user prompts + assistant text replies),
  **plus** a per-session summary. Tool inputs/results are *not* embedded.
- **Approach:** incremental index on ingest + brute-force cosine search (vs lazy
  on-demand, vs a sidecar/sqlite-vec service).
- **Vector storage:** Float32 BLOBs in a new table in `state.db`; brute-force
  cosine in JS. No `sqlite-vec` (would reintroduce a per-platform compiled
  extension — the cross-build burden we are avoiding).
- **Summary generation:** **in-runner hook** (the same pattern the dormant
  `ai-title` hook anticipates) writes a `session-summary` light event into the
  JSONL; the watcher ingests it and the indexer embeds it. No new
  main-process outbound-LLM path.

## Architecture & components

All main-process, slotting into the existing **watcher → SQLite → scoped-MCP-tool**
spine.

- **`src/main/embeddings.ts`** *(new)* — wraps a local WASM embedding model
  (`transformers.js`, `bge-small-en-v1.5`, 384-dim, L2-normalized so cosine =
  dot product). Lazy-loads the model on first use; model files cached under
  `<userData>`. Exposes `embed(texts: string[]): Promise<Float32Array[]>` and a
  stable `MODEL_ID` string.
- **`src/main/transcriptIndex.ts`** *(new)* — the indexer. Hooks the ingest
  path, extracts turn text, debounces, embeds, and writes vectors. Owns
  `searchTranscripts(queryText, allowedWorkspaces, opts)` and the startup
  backfill sweep.
- **`src/main/db.ts`** — migration `user_version = 5` adds two tables; helpers
  for vector upsert/scan and summary read/write.
- **`src/main/mcpServer.ts`** — one new scoped tool, `search_transcripts`.

## Data model (migration v5 — embeddings are rebuildable from JSONL, clean-slate OK)

```sql
CREATE TABLE embeddings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  kind         TEXT NOT NULL,          -- 'turn' | 'summary'
  ref_event_id INTEGER,                -- events.id for 'turn'; NULL for 'summary'
  ts           INTEGER,
  text         TEXT NOT NULL,          -- snippet embedded (returned + rehydrated)
  model_id     TEXT NOT NULL,          -- embedding model identity → reindex on change
  dim          INTEGER NOT NULL,
  vec          BLOB NOT NULL,          -- Float32 little-endian, dim*4 bytes
  dedup_key    TEXT NOT NULL,
  UNIQUE(session_id, kind, dedup_key)
);
CREATE INDEX idx_emb_workspace ON embeddings(workspace_id);
CREATE INDEX idx_emb_session   ON embeddings(session_id);

CREATE TABLE session_summaries (
  session_id          TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL,
  summary             TEXT NOT NULL,
  source_max_event_id INTEGER NOT NULL,  -- high-water mark for regeneration
  model               TEXT,
  generated_at        INTEGER NOT NULL
);
```

## Indexing data flow

1. Watcher ingests a line (unchanged). After a successful `events` insert, the
   indexer is notified (in-process callback from the ingest path).
2. For `user`/`assistant` events with **non-empty text** (parsed from
   `message.content`, string-or-blocks; `tool_use`/`tool_result` blocks skipped),
   the text is trimmed and capped (~2000 chars), enqueued, and embedded in a
   **debounced background batch** off the hot ingest path. One `embeddings` row
   per message, `kind='turn'`, `ref_event_id = events.id`, `dedup_key = event uuid`.
3. A `session-summary` light event (from the in-runner hook) is stored in
   `session_summaries` and embedded as `kind='summary'`,
   `dedup_key = source_max_event_id`.
4. **Backfill:** on startup, a sweep embeds any `events`/summary rows lacking an
   `embeddings` row, and re-embeds rows whose stored `model_id` differs from the
   current `MODEL_ID`.

## Per-session summary generation (in-runner hook)

- A hook inside the runner container summarizes the session and appends a
  `session-summary` light event to the JSONL transcript:
  `{ "type": "session-summary", "summary": "...", "timestamp": "..." }`.
- The watcher ingests it like any other line; `ingestLine` routes the
  `session-summary` type into `session_summaries` (analogous to how `ai-title`
  routes into `sessions.ai_title`), recording `source_max_event_id`.
- The indexer embeds the summary text as `kind='summary'`.
- Regeneration: the hook re-emits when the session accrues meaningful new content;
  the `source_max_event_id` high-water mark makes re-embedding idempotent.
- Rationale: keeps the main process out of the LLM-calling business, reuses the
  container's own credentials and the JSONL→SQLite spine, and matches the grain
  of the planned `ai-title` hook. Tradeoff: summaries are produced only while/
  where claude runs (not for arbitrary historical sessions on demand) — acceptable,
  since summaries accumulate as sessions run and are embedded on ingest.

## Search & the MCP tool

New tool **`search_transcripts`**:

- **Input:** `query` (string, required); `limit` (default 10, max 50); optional
  `workspace_id` (narrows, never widens); optional `kind` ('turn' | 'summary').
- **Run:** embed the query → load candidate `embeddings` rows
  `WHERE workspace_id IN (allowedWorkspaces)` (+ optional narrowing filters) →
  cosine (dot product on normalized vecs) in JS → top-k →
  return `[{ session_id, workspace_id, kind, ts, text, score }]`.
- **Security:** scoping is identical to the other typed tools —
  `ctx.allowedWorkspaces` filters every candidate row, so self-recall and
  grant-scoped cross-workspace search fall out of the same filter. Consistent
  with #146: a *typed, scoped* tool may return confined snippets, unlike the
  rejected raw-SQL / `raw_jsonl` hatch.
- Brute-force scan is acceptable at desktop scale (tens of thousands of vectors →
  single-digit-to-tens of ms).

## Error handling

- Embedding model fails to load → `search_transcripts` returns a clear
  "index unavailable" error; **ingest-time indexing degrades silently** (logged
  via `logError`) and never blocks transcript ingest.
- Malformed/empty messages are skipped (mirrors existing `ingestLine`).
- Summary generation/ingest failure is non-fatal; turns remain searchable.

## Testing

- **Unit (vitest):** Float32 vector encode/decode round-trip; cosine ranking
  correctness; `extractText` over string vs block content; dedup behavior;
  `model_id`-change reindex trigger; `session-summary` routing in `ingestLine`.
- **MCP contract:** extend `mcpServer.test.ts` cross-workspace isolation — a
  search MUST NOT return a row outside `allowedWorkspaces` — **and** the CI-only
  e2e `tests/mcp-*.spec.ts`, per the pinned-contract rule (both must be updated
  when the tool surface changes).

## Scope / non-goals (v1)

- No renderer UI / human-facing search surface (chosen consumer is agents via
  MCP). Possible later.
- No `sqlite-vec`; brute force until scale demands.
- No re-ranking model; cosine top-k only.

## Spec maintenance

Implementation touches a data model (new tables), the MCP tool surface
(`search_transcripts`), and the runner contract (the `session-summary` hook +
event type). Per `.claude/rules/spec-maintenance.md`, **`docs/SPEC.md` must be
updated in the same commit as the implementing change** — specifically the
observability data-model section (schema), §11 Fleet-state MCP (new tool), and
the runner env/JSONL contract (new event type).
