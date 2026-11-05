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

## C1 tool-restriction verification (2026-11-05, final-review fix)

**Question:** does a capture fork really get *only* `record_claim` + `search_claims`, even when the user's/project's settings allow everything? `--allowedTools` alone only pre-approves; it removes nothing.

**Environment:** this container, `claude` 2.1.281. A scratch `CLAUDE_CONFIG_DIR` (copy of the OAuth credentials + a `~/.claude.json` holding only the `claude-fleet-state` server entry, project trusted) so the real `~/.claude*` files were never touched. Both the scratch **user** `settings.json` and the scratch **project** `.claude/settings.json` contained:

```json
{ "permissions": { "defaultMode": "bypassPermissions", "allow": ["Bash(*)", "mcp__claude-fleet-state", "Read(**)"] } }
```

The project dir held `readme.txt` (`the magic word is PINEAPPLE-42`). Live session: `claude -p "We are debugging a broker hang. … Reply with just OK." --session-id <live> --model claude-haiku-4-5 --output-format json` (exit 0). Each fork was asked to list its tools, then try (a) Bash `echo pwned > /tmp/fork-pwn`, (b) Read `readme.txt`, (c) `mcp__claude-fleet-state__get_config`, (d) `mcp__claude-fleet-state__search_claims {query:"broker"}`. Scripts: session scratchpad `c1setup.py`, `c1live.sh`, `c1fork.sh` / `c1fork-stream.sh` (stream-json to capture the `system/init` tool list), `c1inline.sh`.

**The installed host app here is v0.14.9**, which predates `record_claim`/`search_claims`, so (d) can only show "tool does not exist" in this container. A positive control (below) proves an allowed fleet-state tool does work under the new args.

### Before (pre-fix args) — vulnerable

```
claude -p "$P" --resume $LIVE --fork-session --session-id $FORK --model claude-haiku-4-5 \
  --allowedTools mcp__claude-fleet-state__record_claim,mcp__claude-fleet-state__search_claims \
  --max-turns 12 --output-format json
```

Transcript (verbatim, truncated):

```
TOOL_USE Bash {"command": "echo pwned > /tmp/fork-pwn", "description": "Write test file to /tmp"}
TOOL_RESULT is_error=False (Bash completed with no output)
TOOL_USE Read {"file_path": ".../c1/proj/readme.txt"}
TOOL_RESULT is_error=None 1	the magic word is PINEAPPLE-42
TOOL_USE ToolSearch {"query": "select:mcp__claude-fleet-state__get_config", "max_results": 1}
TOOL_USE mcp__claude-fleet-state__get_config {}
TOOL_RESULT is_error=None [{"type": "text", "text": "{\n  \"workspaceId\": \"01KW2JNC0K9JDYS8WAZBNT33X1\", ...
TOOL_USE ToolSearch {"query": "select:mcp__claude-fleet-state__search_claims", "max_results": 1}
TOOL_RESULT is_error=None No matching deferred tools found. ...
```

`/tmp/fork-pwn` **was created**. The fork also had Agent/Edit/Write/WebFetch and every claude.ai connector. (a)(b)(c) all succeeded: **C1 confirmed**.

### After (new `captureArgs`) — locked down

```
claude -p "$P" --resume $LIVE --fork-session --session-id $FORK --model claude-haiku-4-5 \
  --tools '' --permission-mode dontAsk \
  --allowedTools mcp__claude-fleet-state__record_claim,mcp__claude-fleet-state__search_claims \
  --disallowedTools mcp__claude-fleet-state__list_sessions,...,mcp__claude-fleet-state__get_config  # all 41 other TOOLS names
  --strict-mcp-config --max-turns 12 --output-format stream-json --verbose --mcp-config <fleet-state-only.json>
```

`system/init` + result (verbatim):

```
exit=0
ls: cannot access '/tmp/fork-pwn': No such file or directory
INIT permissionMode = dontAsk
INIT tools = []
INIT mcp_servers = [('claude-fleet-state', 'connected')]
RESULT is_error=False subtype=success
RESULT permission_denials = []
```

The fork has **zero tools**: no built-ins, no denied fleet-state tools, no connectors (`record_claim`/`search_claims` are absent only because the v0.14.9 host server doesn't define them). It made no tool calls; its prose "tool list" was hallucinated from context. The `bypassPermissions` default from both settings files was overridden (`permissionMode = dontAsk`).

### Positive control (new args, `search_transcripts` swapped in as a third allowed tool and removed from the deny list)

```
TOOL_USE Bash {"command": "echo pwned > /tmp/fork-pwn"}
TOOL_RESULT is_error=True <tool_use_error>Error: No such tool available: Bash. Bash is disabled for this session, in subagents as well as here.</tool_use_error>
TOOL_USE Read {"path": "readme.txt"}
TOOL_RESULT is_error=True <tool_use_error>Error: No such tool available: Read. Read is disabled for this session, in subagents as well as here.</tool_use_error>
TOOL_USE mcp__claude-fleet-state__search_transcripts {"query": "broker"}
TOOL_RESULT is_error=None [{"type": "text", "text": "[\n  {\n    \"sessionId\": \"49cbe88e-...\", ... \"score\": 0.7843...
TOOL_USE mcp__claude-fleet-state__get_config {}
TOOL_RESULT is_error=True <tool_use_error>Error: No such tool available: mcp__claude-fleet-state__get_config</tool_use_error>
INIT permissionMode = dontAsk
INIT tools = ['mcp__claude-fleet-state__search_transcripts']
INIT mcp_servers = [('claude-fleet-state', 'connected')]
```

`/tmp/fork-pwn` not created. (a) Bash: unavailable. (b) Read: unavailable. (c) `get_config`: unavailable. An allowed fleet-state tool works end to end. So on a host app with the claims tools, (d) `search_claims` and `record_claim` are the fork's only two tools.

### Why the deny list is required (inline `--mcp-config` check)

The same flags **without** `--disallowedTools`, using an inline JSON `--mcp-config` (the container form, `docker.ts:managedMcpConfigJson`), and only `search_transcripts` allowed on the CLI:

```
INIT permissionMode = dontAsk
INIT tools = ['mcp__claude-fleet-state__committee_collect', ..., 'mcp__claude-fleet-state__get_config', ..., 'mcp__claude-fleet-state__update_todo']   # all 37 server tools
INIT mcp_servers = [('claude-fleet-state', 'connected')]
```

The settings allow rule `mcp__claude-fleet-state` re-opens every fleet-state tool under `dontAsk`, so `--disallowedTools` (derived from `TOOLS`, deny beats allow) is load-bearing. The check also confirms that inline-JSON `--mcp-config` connects under `--strict-mcp-config`.

### Not adopted
- `--setting-sources`: it would also drop user settings carrying auth/endpoint env (`env`, `apiKeyHelper`), and the deny list + `dontAsk` already neutralise their allow rules. User hooks therefore still run in forks, just as they do in the session being forked.
- `--permission-prompts none`: redundant with `dontAsk`, and too new for the varied host `claude` versions that local/WSL workspaces run.
