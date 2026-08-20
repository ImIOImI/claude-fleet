# Design: "waiting on AskUserQuestion" chip state

**Status:** approved, ready for implementation plan
**Date:** 2026-06-30

## Problem

claude-fleet chips show **busy** (claude working) vs not, via the PTY title glyph
(`activityDetector.ts`: quadrant-circle spinner `◐◑◒◓` = busy — legacy braille
accepted, #343 — `✳` = idle). They cannot show the
state that most wants a human: a session **blocked on an `AskUserQuestion` prompt,
waiting for the user to answer**. Add a distinct chip state for it, on the workspace
chip and both session indicators (terminal session-tab dot + left-rail Sessions row).

## Why the obvious approaches don't work

- **PTY glyph** — an `AskUserQuestion` prompt renders with the *idle* glyph; the
  title can't distinguish "done" from "waiting on a question."
- **Observability / JSONL** — verified live (2026-06-30): the `AskUserQuestion`
  `tool_use` line is flushed to the transcript only at **answer-time**, not when the
  question is posed. So there is no pending window in the DB to observe. The chip
  would never light while the user is actually being asked. This matches the
  (now-superseded) "shelved" conclusion in SPEC §11.

## The signal that does work: a `PreToolUse` hook (spike-verified)

Claude Code fires tool-lifecycle **hooks** independently of the JSONL. Verified on
Claude Code 2.1.177, in both a headless run and a real interactive PTY session:

```
PreToolUse[AskUserQuestion]   ← fires when the question is POSED (before the answer)
   … real multi-second/minute pending window …
PostToolUse[AskUserQuestion]  ← fires when ANSWERED (payload carries the selection)
Stop                          ← end of turn
```

Each hook receives JSON on stdin including `session_id` (the Claude session UUID),
`cwd`, `transcript_path`, `tool_name`, `tool_input`, `tool_use_id`. The `PreToolUse`
edge is exactly the pose-time signal the JSONL lacks.

**Edges:**
- **enter waiting** ← `PreToolUse` matched to `AskUserQuestion`
- **leave waiting** ← `PostToolUse[AskUserQuestion]` **and** `Stop` **and**
  `UserPromptSubmit`. The extra clears are a safety net: a question dismissed with
  Esc emits **no** `PostToolUse` (confirmed in the headless probe), but it does end
  the turn (`Stop`) or get followed by a typed prompt (`UserPromptSubmit`).

## Transport: hook → MCP (spike-verified)

The hook (running inside the runner container) reports state by calling a new tool
on the existing per-workspace `claude-fleet-state` MCP server. Verified: a one-shot
line-delimited JSON-RPC `tools/call` over the socket works with **no `initialize`
handshake** (the server dispatches per line), and `socat` is present in the runner.

Two transport variants exist and the hook must handle both (same shape as
`docker.ts` `managedMcpServerEntry()`):
- **unix** (`/fleet/mcp/mcp.sock` present): `printf '%s\n' "$REQ" | socat - UNIX-CONNECT:/fleet/mcp/mcp.sock`
- **tcp+token** (`/fleet/mcp/token` present, Windows/Docker-Desktop hosts): send the
  token as the first line, then the request, to `host.docker.internal:$CLAUDE_FLEET_MCP_TCP_PORT` (default 7071).

**New MCP tool — `signal_input_wait`** (in `src/main/mcpServer.ts`, registered in the
`TOOLS` array like `committee_*`):
- args: `{ sessionId: string, waiting: boolean }`
- workspace identity is **ambient** (`ctx.callerId`, derived from the accepting
  listener — unforgeable); `sessionId` is the Claude UUID from the hook payload.
- backed by an injected handler (a `setInputWaitHandler(...)` setter mirroring
  `setCommitteeHandlers`), so the read-only DB server stays read-only and the
  host-side effect lives in `ipc.ts`.

## Host state + push

`ipc.ts` keeps `inputWaitByWorkspace: Map<workspaceId, Set<claudeSessionId>>`. The
injected handler adds/removes `sessionId` for `ctx.callerId` and broadcasts on a new
IPC channel **`inputwait:update`** with `{ workspaceId, waitingSessionIds: string[] }`
(a small broadcaster mirroring `src/main/mcpStatusBroadcast.ts`). Preload exposes an
`onInputWait(cb)` subscription mirroring `observability.onSummary`.

**Cleanup (so it can't get stuck on):** clear a workspace's set on session end,
workspace stop/pause, and MCP connection drop for that workspace. (A stale "waiting"
is worse than a missed one.)

## UI — the violet chip

Renderer `App` subscribes to `inputwait:update` and holds
`waitingSessionIds: Set<claudeSessionId>` (per workspace). Keyed by Claude UUID — a
direct match for the Sessions list; the session **tab** reuses the existing
broker→Claude resolution already used for `busySessionIds`.

- **Workspace chip** (`WorkspaceTabStrip`): waiting iff any of its sessions is in the
  set. Dot → violet, **reusing the `chipBusyPulse` animation** (same pulse as busy,
  `blinkSync` lockstep) + a violet **"?"** glyph; secondary line → `needs input`.
  **Waiting wins over busy** (it's the actionable signal).
- **Session-tab dot** (`TerminalPane` `SessionTabDot`) and **Sessions row**
  (`SessionsPane` / `SessionBusyDot`): violet pulse + "?" when that session waits;
  waiting class takes precedence over busy.
- CSS: new token (`--wait`, ~`oklch(68% 0.17 300)` violet — distinct from green
  `--ok` busy and blue `--info` "reachable") + `.dot.waiting`,
  `.session-tab-dot.waiting`, and a waiting variant of the Sessions-row dot.

## Where the hook ships

Baked into the **runner base image**, so every workspace gets it by default: a
`PreToolUse`/`PostToolUse`/`Stop`/`UserPromptSubmit` hook entry in the image's
`~/.claude/settings.json` plus the reporter script (e.g. `/usr/local/lib/claude-fleet/input-wait.sh`).
This is a **runner-container contract change**. (Not a loadout — loadouts are
opt-in/per-workspace; this must be default and always-on.)

## Scope / non-goals

- **AskUserQuestion only.** Permission prompts and `ExitPlanMode` are out — not
  required here, and they have different/again-unverified hook behavior.
- No change to the busy/idle glyph detection; waiting is an independent overlay.

## SPEC.md updates (same change)

- **§5** (renderer layout): document the waiting chip state + `inputwait:update`.
- **§6** (IPC surface) + MCP tool list: add `signal_input_wait` and `inputwait:update`.
- **§7** (runner contract): the baked-in hook + reporter script.
- **§11**: supersede the "no needs-input signal / shelved" decision — a pose-time
  signal exists via an installed `PreToolUse[AskUserQuestion]` hook (note it's
  AskUserQuestion-specific; permission prompts remain unaddressed).

## Testing

- **Main unit**: `signal_input_wait` handler updates/clears the per-workspace set and
  triggers a broadcast; cleanup on session-end/stop/disconnect. The
  `inputwait:update` broadcaster (resilient fan-out, like `observabilityBroadcast.test.ts`).
- **Reporter script**: a bash test that, given a hook stdin payload, emits a correct
  JSON-RPC `tools/call` and picks the right transport (unix vs tcp+token).
- **Renderer unit**: waiting-set resolution (Claude UUID direct + broker→Claude for
  the tab); precedence (waiting over busy) in dot class selection.
- **E2E (Playwright)**: drive the MCP `signal_input_wait` tool (or a fake hook ping)
  and assert the workspace chip + Sessions row pick up the waiting class, then clear.

## Risks — resolved by spike

- MCP one-shot `tools/call` works without `initialize` ✅
- `socat` present in runner ✅
- Pose edge (`PreToolUse`) and clear edge (`PostToolUse`, with `Stop`/`UserPromptSubmit`
  fallback) confirmed in a real interactive session ✅

## Open implementation details (settle in the plan)

- Exact base-image change + how existing image hooks (if any) merge with this entry.
- Whether the hook reads `session_id` purely from stdin (yes) and how it shells the
  MCP call concisely without blocking the tool (fire-and-forget, short `socat` timeout).
- Cleanup wiring points in `ipc.ts` (session-end / stop / MCP disconnect hooks).
