# Knowledge claims: fork feasibility gate results (Task 1, #483)

**Date:** 2026-11-04 · **Claude Code:** 2.1.281 (the runner pin) · **Environment:** claude-fleet container workspace (the dogfooding container, fleet-state MCP configured via `~/.claude.json`).

## Method
- A "live" session (`claude -p … --session-id <live>`, 19 turns of Read + summary, Opus 5.5 [1m]) ran in the background.
- While its transcript was actively growing (74 lines → 93 during the fork), a fork was run:

  ```
  claude -p "<prompt>" --resume <live> --fork-session --session-id <uuid> \
    --allowedTools mcp__claude-fleet-state__get_config --max-turns 4 --output-format json
  ```

- Five more one-turn forks followed, back to back, while the live session was still writing.
- Scripts: `scratchpad/forkgate/run-live.sh`, `fork-check.sh` (session scratch; logic reproduced in the plan's Task 1).

## Results (container)

| Check | Result |
|---|---|
| Fork exit code | 0 (`subtype: success`, 3 turns) |
| Fork honoured pre-assigned `--session-id` | **PASS** (`session_id` = the uuid passed) |
| Fork wrote its own transcript `<fork>.jsonl` | **PASS** |
| Lines with the fork id in the live transcript | **0** |
| Live transcript still valid JSONL | **PASS** (after 1 + 5 forks) |
| Live transcript prefix byte-identical | **PASS** (only its own appends) |
| Live session finished normally | **PASS** (`live exit=0`, all 19 turns) |
| `--allowedTools` with an MCP tool name in `-p` mode | **PASS** (5 `get_config` calls, 0 tool errors, no permission prompt) |

## Cost (the real finding)
- **Prompt caching works but doesn't make forks cheap.** The fork reads the shared prefix from cache (113K cache-read tokens over 3 turns), but it re-writes about 37K tokens of cache for the tail plus its own prompt.
- At roughly 50K context on Opus 5.5 [1m]:
  - the 3-turn fork cost **$0.34**
  - one-turn forks cost **$0.08** (first) and then **~$0.53** each (the live session had advanced, so the tail cache was rewritten each time)
- **Extrapolation, not measured:** captures at 60% or 85% of a large window will cost more, likely **$0.5–$2 each** for 1M-context sessions. On OAuth workspaces this draws on plan usage rather than dollars.

## Not covered here
- WSL and native local workspaces: no host shell from this container. Their env, auth and `--mcp-config` wiring is unit-tested (Task 8 fix round), and the fork mechanics are the same `claude` binary.
- Forking an interactive TUI session, as opposed to `-p`. The transcript-writing path is the same, and Troy can eyeball it on the host after merge.

## Verdict
The mechanism is safe and works as designed, so Task 9 can proceed. The cost profile needs a decision on capture frequency and model before default-on ships broadly.
