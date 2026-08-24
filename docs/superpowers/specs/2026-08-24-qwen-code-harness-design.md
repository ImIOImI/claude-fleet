# Pluggable harness: qwen-code for open-model workspaces

## Problem

Model-endpoint workspaces (#250, shipped v0.9.0) point **claude-code** at a
non-Claude endpoint via env (`ANTHROPIC_BASE_URL/AUTH_TOKEN/MODEL`). It works,
but a small open-weight model (Qwen3-Coder, DeepSeek) is being driven by a
harness built for Claude: claude-code's per-request payload is ~25–33K tokens,
of which ~14–24K is tool schemas that no official knob can trim. On a 30B model
this produces the two symptoms observed in practice:

1. **Malformed / failed tool calls** — the agentic loop breaks.
2. **Poor quality / "lost in prompt"** — it runs, but results are weak.

Live probing of the target endpoint (Ollama `qwen3-coder:30b` at
`10.0.20.10:11434`, 2026-08-24) established that symptom (1) is **not** an
endpoint defect here: clean single-turn tool calls (1/5/15 tools, no XML leak,
no >5-tool format flip), multi-turn `tool_result` round-trips, and
no context truncation to ~178K input tokens all work. The residual latency cost
scales with context (~90s at 178K on this hardware). That isolates the real,
structural problem to symptom (2) plus latency: **claude-code's heavy scaffold
is the wrong driver for a 30B model, and this is unfixable inside claude-code.**

The fix is a harness tuned for these models. **qwen-code** (QwenLM/qwen-code,
Apache-2.0) exists precisely for this: model-conditional system prompts that
teach Qwen3-Coder's native tool-call token format, a defensive streaming
tool-call parser, dedicated DeepSeek reasoning paths, and — critically for
fleet — it writes **Claude-family transcript JSONL** natively, so observability
parity is a field-mapping adapter, not a reconstruction.

## Goal

Make **harness** a first-class, per-workspace choice so an endpoint workspace
can run qwen-code instead of claude-code, with **full observability parity**
(cost, tokens, tool calls, history, summaries, semantic search, committee,
busy/idle) and fleet-native recall tools, reusing the shipped #250
endpoint-config flow unchanged.

## Scope

**In:**
- A `harness` field on the workspace manifest + WorkspaceModal picker.
- Harness-aware spawn: which binary the broker launches, and which env dialect
  the endpoint compiles to.
- A **transcript adapter** that turns qwen-code's JSONL into fleet-ingestible
  claude-dialect JSONL at the watched path.
- Busy/idle title emission for the qwen harness.
- Runner image carrying the pinned `qwen` binary (variant image).
- `docs/SPEC.md` updates (data model, env contract, runner image, observability)
  in the same PR, per the spec-maintenance rule.

**Out (non-goals):**
- No new workspace **`kind`**. The parked "API workspace kind" (no-TUI,
  fleet-native chat pane) is explicitly not built here; `harness` is orthogonal
  to `kind`. Target compatibility is the **#250 endpoint-config flow only**.
- No serving-layer build work. The endpoint is healthy; serving stays a
  documented config note (see §7).
- No opencode adoption. Evaluated (#255) and deferred: its supported
  observability surface is HTTP/SSE (not files), its on-disk format is churning
  (JSON→SQLite→v2 DB), and `cost` is 0 for custom providers — a heavier
  integration than qwen-code's native JSONL.
- No custom-built harness. qwen-code already occupies that niche for these
  models; building our own would reinvent its Qwen-specific tuning.

## Design

### Data model — the `harness` field

Add to the workspace manifest (`<userData>/state/<id>/workspace.json`):

```
harness: 'claude-code' | 'qwen-code'   // default 'claude-code'
```

- **Default `'claude-code'`** — every existing workspace is unchanged; absent
  field reads as `'claude-code'`. Zero blast radius.
- **Validation:** `harness: 'qwen-code'` is only valid with `authMode:
  'endpoint'`. A qwen-code harness against an OAuth/Anthropic-key auth mode is
  rejected at manifest read and in the form (nonsensical — qwen-code drives an
  OpenAI-compatible endpoint, not Anthropic OAuth). Mirror the #250 lesson:
  every summary→form/submit builder must carry `harness`, or a saved-tab resume
  silently drops it. Grep `authMode:` / `endpointId:` in the renderer to find
  all builders and add `harness` alongside.

`harness` is orthogonal to `kind` (`container`/`local`) and `authMode`. A
container endpoint workspace is the primary target; local is not blocked but not
a launch target for v1.

### Spawn — harness forks binary + env dialect

The endpoint registry → env-compilation path from #250 is reused verbatim. The
`harness` field forks two things at create/spawn:

**Binary the broker launches in the PTY:**
- `claude-code` → `claude …` (today's behavior).
- `qwen-code` → `qwen …` (+ `--resume <uuid>` on resume, analogous to claude).

The broker already owns an arbitrary PTY command; this is a launch-arg change,
not a broker redesign.

**Env dialect compiled from the same endpoint entry:**

| | claude-code | qwen-code |
|---|---|---|
| Endpoint path hit | `/v1/messages` (Anthropic) | `/v1/chat/completions` (OpenAI) |
| Base URL var | `ANTHROPIC_BASE_URL` | `OPENAI_BASE_URL` |
| Key var | `ANTHROPIC_AUTH_TOKEN` | `OPENAI_API_KEY` |
| Model var | `ANTHROPIC_MODEL` | `OPENAI_MODEL` |

Both dialects compile from **one** endpoint registry entry (the target box
serves both API shapes on the same port). The qwen dialect points at the OpenAI
path so qwen-code's Qwen-tuned prompt and harness-side tool-call parser apply
(this is the mechanism that fixes symptom 2). Endpoint-under / workspace-env-over
precedence is unchanged from #250. Local-endpoint credential-stripping
invariants (strip inherited host `ANTHROPIC_API_KEY`; never bind OAuth creds for
an endpoint workspace) apply identically and must extend to `OPENAI_API_KEY`.

qwen-code also accepts a `~/.qwen/settings.json` `modelProviders` block; env
vars are sufficient for v1, but the compiler may write a settings.json instead
if per-provider sampling/`extra_body` tuning proves necessary (see §7).

### Transcript adapter — the core new component

qwen-code writes Claude-family JSONL to
`~/.qwen/projects/<sanitized-cwd>/chats/<sessionId>.jsonl`: append-only,
tree-structured (`uuid`, `parentUuid`, `sessionId`, ISO `timestamp`,
`type: user|assistant|tool_result|system`, `cwd`, per-response `model` +
`usageMetadata`, enriched `toolCallResult`). Fleet's watcher expects claude's
dialect at `<userData>/state/<ws-id>/.claude/projects/-workspace/<uuid>.jsonl`
(`jsonlWatcher.ts`), reading the fields catalogued in the ingest contract
(`db.ts:ingestLine`): `type`, `timestamp`, `uuid`, `message.model`,
`message.usage.{input,output,cache_read,cache_creation}_*`, `service_tier`,
`message.content[]` `tool_use`/`tool_result` blocks
(`name`/`id`/`input`/`tool_use_id`/`is_error`), and a user-message body for the
title.

The adapter is a **field-mapping transform** (same family, different names), not
a reconstruction:

- `usageMetadata.{promptTokenCount,candidatesTokenCount,cachedContentTokenCount}`
  → `message.usage.{input_tokens,output_tokens,cache_read_input_tokens,…}`.
- qwen `model` string → `message.model`. (Unknown model prices to $0 with a
  one-time warning — non-fatal — but we register qwen model ids in
  `pricing.ts` so cost renders; unpriced endpoints render `—` as in #250.)
- qwen tool records → `message.content[]` `tool_use`/`tool_result` blocks.
- Emit at the fleet-watched path with **filename = the session UUID**, so the
  existing chokidar watcher, dedup (`UNIQUE(session_id, dedup_key)`), compaction
  handling, and mirror all work untouched.

**Placement — in-container sidecar (chosen):** a tiny process in the runner
tails qwen-code's `chats/<sessionId>.jsonl` and writes the mapped claude-dialect
JSONL into the bind-mounted state path. Rationale: keeps the host watcher and
its dedup/mirror invariants **ignorant of harness** (it only ever sees claude
dialect), and matches #250's "the container talks the contract" principle.
Rejected alternative — teaching the host watcher a second dialect — spreads
harness-awareness into the ingest core and its dedup/mirror/summary/embedding
consumers.

The adapter is the one schema-coupling risk: qwen-code's JSONL is pinned by
their own contract test but is not a stability-guaranteed public API. Mitigation:
pin the `qwen` version in the image (as claude is pinned, SPEC §4), and cover the
adapter with fixture tests (§8) that fail loudly on a version bump.

### Observability glue

- **Busy/idle:** fleet infers busy from a braille-glyph OSC title on the PTY
  (`activityDetector.ts`, U+2800–U+28FF = busy). qwen-code's Ink TUI won't emit
  that convention, so the **sidecar emits the OSC title** from qwen's session
  status (busy on turn-start, idle on turn-end/awaiting-input). This is
  glyph-independent, sidestepping the historical braille-detector fragility.
- **Session mapping:** fleet's pending-attach → `new-session` pairing assumes
  filename = session UUID and `--resume <uuid>` appends to the same file
  (`broker_sessions`). The adapter preserves the UUID filename and qwen-code's
  `--resume`/`--continue` append semantics, so mapping resolves unchanged.
- **Recall tools (free):** qwen-code is an MCP client (stdio/HTTP). Point it at
  the bind-mounted `/fleet/mcp/mcp.sock` via `socat` (identical to how
  claude-code reaches fleet-state; identity is ambient from the socket). The
  compiled config adds the fleet-state MCP server so `search_transcripts`,
  `query`, `session_summary`, etc. become native tools in the qwen workspace.
- **Committee (PTY-first):** `committee_post` types into the PTY exactly as
  today; `committee_status`/`collect`/`pause`/`unpause` operate on the broker
  session unchanged. No committee rewiring in v1.

### Harness shape — PTY-first, daemon fallback

Run qwen-code's TUI in the existing broker PTY so tabs, pause/resume,
committee-typing, and title-busy all reuse current machinery. Risk: qwen-code's
Ink TUI (virtualized viewport, SGR mouse tracking on by default) may misbehave
in the raw broker PTY. Mitigations, in order:

1. Tune qwen-code UI settings for the broker: `ui.useTerminalBuffer`,
   `ui.mouseTracking` (disable if the broker injects raw mouse sequences).
2. If still fragile, **fall back to headless `qwen serve`**: the broker runs the
   daemon, a thin PTY client renders it, and observability reads the same JSONL.
   The daemon exposes `POST /session/:id/prompt` + SSE — committee would repoint
   there. This is a fallback only; not built unless the PTY path fails
   acceptance (§8).

The daemon boundary is noted but deliberately not designed out in v1 (keeps the
door open without scope creep).

## Runner image

Add the pinned `qwen` binary (Apache-2.0, ~95 MB npm package, needs Node 22 —
already the base) as a **variant image** layered on the base runner, mirroring
`docker/devops/Dockerfile`. Avoids bloating the default runner for workspaces
that never use qwen. Version pinned in `docker/versions.yaml`; bumped
deliberately (adapter fixture tests gate the bump). The sidecar + `socat` ship in
the same image. Image build uses the repo root as context (broker + scripts
reachable), as today.

## Non-obvious constraints / invariants

- **Absent `harness` = `claude-code`.** Pre-this-change builds reading a
  `harness: 'qwen-code'` manifest must degrade safely to claude-code (or refuse
  to launch qwen), never silently mis-drive. Release-notes hazard, as with the
  #250 authMode downgrade.
- **`harness` must ride every form/submit builder** (the #250 `endpointId`
  drop-on-save bug class). Present-but-undefined keys overwrite on manifest
  merge.
- **Credential stripping extends to OpenAI vars** — an endpoint workspace never
  inherits host `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`.
- **The host watcher only ever sees claude dialect.** All harness-specific
  translation lives container-side.

## Testing

- **Unit:** the transcript adapter (qwen JSONL fixtures → asserted fleet event
  rows, incl. token/model/tool mapping and UUID-filename); env-compilation for
  the qwen dialect (base/key/model vars, credential stripping); manifest
  validation (`qwen-code` requires `authMode: endpoint`; `harness` survives
  summary→form→submit round-trip).
- **Contract:** extend the ingest/MCP contract tests
  (`mcpServer.test.ts` + `tests/mcp-*.spec.ts`) so a qwen-harness workspace
  yields cost/token/tool rows identical in **shape** to claude's.
- **e2e:** a qwen-harness workspace boots, runs one agentic turn against a stub
  OpenAI-compatible endpoint, and fleet shows tokens + a tool call — the bar
  #250's e2e used. Busy/idle chip flips on turn start/end.
- **Acceptance for PTY-first:** qwen-code's TUI renders, accepts input, resizes,
  and exits cleanly in the broker PTY. Failure here triggers the daemon
  fallback, not a redesign.

## Rollout

- Ship behind the harness picker; default `claude-code` = no behavior change for
  anyone.
- **Immediate parallel win (no code):** wire `10.0.20.10:11434` as a plain
  claude-code endpoint workspace via shipped #250 now, to A/B against qwen-code
  once the harness lands.
- Runner-image republish + workspace **RECREATE** required to pick up the qwen
  variant image (standard for image changes).
- `docs/SPEC.md` §4 (runner image), §data-model (manifest `harness`, env
  contract), §6 (observability: sidecar-emitted JSONL + title) updated in the
  same PR.

## Open decisions

- **Env vars vs `~/.qwen/settings.json`** for the qwen endpoint config. Start
  with env (sufficient, rides #250); switch to a compiled settings.json only if
  per-provider sampling/`extra_body`/`contextWindowSize` tuning is needed.
- **Sidecar process host:** a dedicated tiny Node process vs folding the tail-and-
  map loop into the broker. Leaning dedicated (single responsibility, testable in
  isolation), decided at implementation.
- **qwen model pricing:** whether to price qwen endpoints at all or render `—`
  (unpriced, as #250 does for unknown models). Default `—` unless a rate is
  configured on the endpoint entry.
- **Serving contingency:** if real coding tasks expose tool-reliability or
  latency limits Ollama can't meet, document a vLLM + `--tool-call-parser
  qwen3_xml` migration (correct sampling: temp 0.7 / top_p 0.8 /
  repetition_penalty 1.05; ≥Q5/FP8; INT8 KV). Not a v1 workstream.
