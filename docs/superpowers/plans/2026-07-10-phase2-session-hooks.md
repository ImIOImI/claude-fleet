# Phase 2 Session Hooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the approved Phase 2 spec (`docs/superpowers/specs/2026-07-10-phase2-session-hooks-design.md`): claude self-reports its session id per tab (SessionStart hook → verified mapping, fixing `/clear` drift), debounced chaptered LLM summaries with tags (Stop hook → sidecar JSONL → existing ingest), and value-signal collection (`usage_events`, `mark_useful`, `get_config`).

**Architecture:** Broker exports `CLAUDE_FLEET_BROKER_SESSION_ID` into every claude it spawns; two new bash hooks in the runner image report mapping over MCP and write chapter summaries to a `*.fleet.jsonl` sidecar the watcher ingests; migration v8 rebuilds `session_summaries` as chapters and adds `session_tags` + `usage_events`; three new MCP tools (`report_session_mapping`, `mark_useful`, `get_config`) write through handlers injected by ipc.ts so the server's DB handle stays readonly.

**Tech Stack:** Go (broker), bash+jq (hooks), TypeScript (Electron main), better-sqlite3, vitest, Playwright (contract e2e).

## Global Constraints

- Never append to claude's live transcript `<uuid>.jsonl` — sidecar `<uuid>.fleet.jsonl` only (resume corruption).
- MCP server DB handle stays **readonly**; all writes via injected handlers (`signal_input_wait` pattern).
- MCP tool surface changes require updating BOTH `src/main/mcpServer.test.ts` and `tests/mcp-server.spec.ts` in the same task.
- Hook scripts are fire-and-forget: `set -u`, always `exit 0`, 2s socat timeout, `CF_*_SINK` test seams.
- Tunable env defaults (exact values): `CF_SUMMARY_MIN_NEW_TURNS=20`, `CF_SUMMARY_MIN_INTERVAL_S=120`, `CF_SUMMARY_MODEL=haiku`, `CF_SUMMARY_WINDOW_CHARS=8000`.
- `docs/SPEC.md` must be updated in the same PR (Task 12).
- Run unit tests with `npx vitest run <file>`; full suite `npm run test:unit`; typecheck `npm run typecheck`.
- Go tests: `cd broker && go test -race ./...` (uses `/bin/cat` as claude stand-in; no creds needed).
- Bash hook tests run via `bash docker/runner/<name>.test.sh` (see `input-wait-report.test.sh` for the harness style).

---

### Task 1: Broker exports tab identity env

**Files:**
- Modify: `broker/internal/session/session.go:61-63`
- Test: `broker/internal/session/manager_test.go`

**Interfaces:**
- Produces: every broker-spawned claude has `CLAUDE_FLEET_BROKER_SESSION_ID=<broker session id>` in its environment. Hooks (Tasks 3–4) consume it.

- [ ] **Step 1: Write the failing test** — append to `broker/internal/session/manager_test.go`:

```go
// TestBrokerSessionIDExported proves the spawned child sees its own broker
// session id in env — the hooks' only way to know which tab they belong to.
func TestBrokerSessionIDExported(t *testing.T) {
	m := NewManager(ManagerConfig{ClaudeExec: "/bin/sh", RingBufBytes: 4096})
	s, err := m.Create("tab-42", 80, 24, []string{"-c", "printf '%s' \"$CLAUDE_FLEET_BROKER_SESSION_ID\""})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	defer m.Close("tab-42")
	got := readAllOutput(t, s) // reuse the existing output-collection helper in this file
	if !strings.Contains(got, "tab-42") {
		t.Fatalf("child env missing broker session id; output=%q", got)
	}
}
```

(If the file's existing helper for reading session output has a different name, use that one — check how `TestCreateArgsReachExec` collects output and mirror it.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd broker && go test -race ./internal/session/ -run TestBrokerSessionIDExported -v`
Expected: FAIL (output does not contain `tab-42`)

- [ ] **Step 3: Implement** — in `session.go` `newSession`, replace the env line:

```go
	cmd := exec.Command(command, args...)
	// TERM for the TUI; CLAUDE_FLEET_BROKER_SESSION_ID so in-container hooks
	// can pair their claude session with the tab that owns this PTY (#207).
	cmd.Env = append(cmd.Environ(),
		"TERM=xterm-256color",
		"CLAUDE_FLEET_BROKER_SESSION_ID="+id,
	)
```

- [ ] **Step 4: Run to verify pass**: `cd broker && go test -race ./...` → all PASS
- [ ] **Step 5: Commit** — `git add broker && git commit -m "feat(broker): export CLAUDE_FLEET_BROKER_SESSION_ID to spawned claude (#207)"`

---

### Task 2: Local backend exports the same env

**Files:**
- Modify: `src/main/localSessions.ts` (the `args` block in `attachLocalSession`, ~line 93)
- Test: `src/main/localSessions.test.ts`

**Interfaces:**
- Consumes: `AttachOpts.sessionId` (already present — the broker-session key).
- Produces: local claude spawns carry `CLAUDE_FLEET_BROKER_SESSION_ID` (parity for when local gains hooks; spec §A).

- [ ] **Step 1: Failing test** — append to `localSessions.test.ts` (the `tracker()` calls record `env`? If not, extend `tracker()`'s `calls` entries to also capture `env` from the spawn opts — it receives the full spawn options object):

```ts
it('exports CLAUDE_FLEET_BROKER_SESSION_ID to the spawned claude (#207)', () => {
  const t = tracker();
  attachLocalSession({ ...base, workspaceId: 'ws1', sessionId: 's1', spawn: t.spawn });
  expect(t.calls[0].env.CLAUDE_FLEET_BROKER_SESSION_ID).toBe('s1');
});
```

- [ ] **Step 2: Run** `npx vitest run src/main/localSessions.test.ts` → FAIL
- [ ] **Step 3: Implement** — in `attachLocalSession`'s spawn branch:

```ts
    const proc = opts.spawn({
      file: opts.file,
      args,
      cwd: opts.cwd,
      cols: opts.cols,
      rows: opts.rows,
      env: { ...opts.env, CLAUDE_FLEET_BROKER_SESSION_ID: opts.sessionId }
    });
```

- [ ] **Step 4: Run** → PASS; then `npm run typecheck` → clean
- [ ] **Step 5: Commit** — `git commit -am "feat(local): export CLAUDE_FLEET_BROKER_SESSION_ID to local claude spawns (#207)"`

---

### Task 3: `session-report.sh` hook (SessionStart → report_session_mapping)

**Files:**
- Create: `docker/runner/session-report.sh` (mode 0755)
- Create: `docker/runner/session-report.test.sh`

**Interfaces:**
- Consumes: hook payload JSON on stdin (`.session_id`, `.hook_event_name`); env `CLAUDE_FLEET_BROKER_SESSION_ID`.
- Produces: a `tools/call` for `report_session_mapping { brokerSessionId, sessionId }` over the MCP socket (Task 9 implements the tool). Test seam: `CF_SESSION_REPORT_SINK`.

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
# Claude Code hook: report this claude session's id + owning broker session
# (tab) to the fleet-state MCP server. Registered for SessionStart — fires on
# startup, resume, AND clear, so the host's tab↔session mapping tracks /clear
# drift with claude's own testimony (#207). Fire-and-forget; always exit 0.
set -u
payload="$(cat)"
sid="$(printf '%s' "$payload" | jq -r '.session_id // empty' 2>/dev/null)"
bid="${CLAUDE_FLEET_BROKER_SESSION_ID:-}"
[ -n "$sid" ] || { echo "session-report: no session_id in hook payload" >&2; exit 0; }
[ -n "$bid" ] || { echo "session-report: no CLAUDE_FLEET_BROKER_SESSION_ID in env" >&2; exit 0; }

req=$(jq -nc --arg sid "$sid" --arg bid "$bid" \
  '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"report_session_mapping",arguments:{brokerSessionId:$bid,sessionId:$sid}}}')

# Test seam: capture the request instead of sending it.
if [ -n "${CF_SESSION_REPORT_SINK:-}" ]; then
  printf '%s\n' "$req" >> "$CF_SESSION_REPORT_SINK"
  exit 0
fi

sock="/fleet/mcp/mcp.sock"
tok="/fleet/mcp/token"
port="${CLAUDE_FLEET_MCP_TCP_PORT:-7071}"
if [ -S "$sock" ]; then
  printf '%s\n' "$req" | timeout 2 socat - "UNIX-CONNECT:$sock" >/dev/null 2>&1 || true
elif [ -f "$tok" ]; then
  { printf '%s\n' "$(cat "$tok")"; printf '%s\n' "$req"; } \
    | timeout 2 socat - "TCP:host.docker.internal:$port" >/dev/null 2>&1 || true
fi
exit 0
```

- [ ] **Step 2: Write the test** (`session-report.test.sh`, mirroring `input-wait-report.test.sh`'s assert style):

```bash
#!/usr/bin/env bash
# Tests for session-report.sh. Run: bash docker/runner/session-report.test.sh
set -u
here="$(cd "$(dirname "$0")" && pwd)"
fails=0
assert() { if [ "$1" = "$2" ]; then echo "ok: $3"; else echo "FAIL: $3 (got '$1' want '$2')"; fails=$((fails+1)); fi; }

sink="$(mktemp)"; trap 'rm -f "$sink"' EXIT

# 1. Happy path: payload sid + env bid → one tools/call with both args.
: > "$sink"
printf '{"session_id":"uuid-1","hook_event_name":"SessionStart"}' \
  | CF_SESSION_REPORT_SINK="$sink" CLAUDE_FLEET_BROKER_SESSION_ID="tab-9" bash "$here/session-report.sh"
assert "$(jq -r '.params.arguments.brokerSessionId' "$sink")" "tab-9" "broker id forwarded"
assert "$(jq -r '.params.arguments.sessionId' "$sink")" "uuid-1" "session id forwarded"
assert "$(jq -r '.params.name' "$sink")" "report_session_mapping" "tool name"

# 2. Missing env → no request, exit 0.
: > "$sink"
printf '{"session_id":"uuid-1"}' | CF_SESSION_REPORT_SINK="$sink" bash "$here/session-report.sh"
assert "$(wc -c < "$sink" | tr -d ' ')" "0" "no request without broker id"

# 3. Missing session_id → no request, exit 0.
: > "$sink"
printf '{}' | CF_SESSION_REPORT_SINK="$sink" CLAUDE_FLEET_BROKER_SESSION_ID="tab-9" bash "$here/session-report.sh"
assert "$(wc -c < "$sink" | tr -d ' ')" "0" "no request without session id"

[ "$fails" -eq 0 ] && echo "ALL PASS" || exit 1
```

- [ ] **Step 3: Run** `chmod +x docker/runner/session-report.sh && bash docker/runner/session-report.test.sh` → `ALL PASS`
- [ ] **Step 4: Commit** — `git add docker/runner && git commit -m "feat(hooks): session-report.sh — SessionStart reports tab↔session mapping (#207)"`

---

### Task 4: `summarize.sh` hook (Stop → debounced chapter summary)

**Files:**
- Create: `docker/runner/summarize.sh` (mode 0755)
- Create: `docker/runner/summarize.test.sh`

**Interfaces:**
- Consumes: hook payload (`.session_id`, `.transcript_path`); env tunables (Global Constraints); env `CF_SUMMARIZE_CMD` (test seam replacing `claude -p`), `CF_SUMMARIZE_FG=1` (test seam: run generation in foreground).
- Produces: appends `{"type":"session-summary","summary","tags","sessionId","model","fromEventTs","toEventTs"}` lines to `<transcript dir>/<uuid>.fleet.jsonl`; state file `<uuid>.fleet.state` holding `<turns> <epoch-seconds>`.

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
# Claude Code hook: debounced chapter summaries (#207). On Stop, count
# completed turns (typed human prompts — string content, not tool-result
# arrays; each has an assistant reply by the time Stop fires). When ≥
# CF_SUMMARY_MIN_NEW_TURNS new turns landed since the last summary AND ≥
# CF_SUMMARY_MIN_INTERVAL_S seconds passed, summarize ONLY the new window via
# `claude -p` and append a session-summary event to the SIDECAR
# <uuid>.fleet.jsonl (never the live transcript — corrupts --resume).
# Fire-and-forget; always exit 0.
set -u
payload="$(cat)"
sid="$(printf '%s' "$payload" | jq -r '.session_id // empty' 2>/dev/null)"
tpath="$(printf '%s' "$payload" | jq -r '.transcript_path // empty' 2>/dev/null)"
[ -n "$sid" ] && [ -n "$tpath" ] && [ -f "$tpath" ] || exit 0

min_turns="${CF_SUMMARY_MIN_NEW_TURNS:-20}"
min_interval="${CF_SUMMARY_MIN_INTERVAL_S:-120}"
model="${CF_SUMMARY_MODEL:-haiku}"
window_chars="${CF_SUMMARY_WINDOW_CHARS:-8000}"

dir="$(dirname "$tpath")"
state="$dir/$sid.fleet.state"
sidecar="$dir/$sid.fleet.jsonl"

# Completed turns = typed human prompts (string content). Tool results are
# content ARRAYS and don't count; Stop firing means the reply completed.
turns="$(jq -rs '[.[] | select(.type=="user" and (.message.content|type)=="string")] | length' "$tpath" 2>/dev/null || echo 0)"

last_turns=0; last_run=0
[ -f "$state" ] && read -r last_turns last_run < "$state"
now="$(date +%s)"
new_turns=$((turns - last_turns))
[ "$new_turns" -ge "$min_turns" ] || exit 0
[ $((now - last_run)) -ge "$min_interval" ] || exit 0

# Claim the window immediately (before the slow LLM call) so a Stop firing
# mid-generation doesn't double-summarize the same turns.
printf '%s %s\n' "$turns" "$now" > "$state"

generate() {
  # Window: text of turns AFTER the last summarized turn. Take user strings +
  # assistant text blocks in file order, keep the tail for the new window,
  # cap total chars.
  window="$(jq -rs --argjson skip "$last_turns" '
    [ .[]
      | select((.type=="user" and (.message.content|type)=="string")
               or (.type=="assistant"))
      | if .type=="user" then "USER: " + .message.content
        else "ASSISTANT: " + ([.message.content[]? | select(.type=="text") | .text] | join("\n"))
        end
      | select(length > 10)
    ] | .[$skip:] | join("\n---\n")' "$tpath" 2>/dev/null | tail -c "$window_chars")"
  [ -n "$window" ] || return 0

  prev="$(tail -n 1 "$sidecar" 2>/dev/null | jq -r '.summary // empty' 2>/dev/null)"
  prompt="You summarize a window of an ongoing coding session.
Previously: ${prev:-"(session start)"}
Reply with ONLY strict JSON: {\"summary\":\"<=3 sentences about THIS window\",\"tags\":[\"3-6 lowercase concept tags\"]}
Window:
$window"

  raw="$(printf '%s' "$prompt" | ${CF_SUMMARIZE_CMD:-claude -p --model "$model"} 2>/dev/null)"
  # Strict validation: must parse, must have non-empty summary + tags array.
  out="$(printf '%s' "$raw" | jq -c 'select((.summary|type)=="string" and (.summary|length)>0 and (.tags|type)=="array") | {summary, tags}' 2>/dev/null)"
  [ -n "$out" ] || { echo "summarize: model output rejected" >&2; return 0; }

  from_ts="$(jq -rs '[.[] | .timestamp // empty] | first // empty' "$tpath" 2>/dev/null)"
  to_ts="$(jq -rs '[.[] | .timestamp // empty] | last // empty' "$tpath" 2>/dev/null)"
  printf '%s' "$out" | jq -c --arg sid "$sid" --arg model "$model" --arg f "$from_ts" --arg t "$to_ts" \
    '{type:"session-summary", summary:.summary, tags:.tags, sessionId:$sid, model:$model, fromEventTs:$f, toEventTs:$t}' \
    >> "$sidecar"
}

if [ -n "${CF_SUMMARIZE_FG:-}" ]; then generate; else
  # cd /tmp: the claude -p run must not write its throwaway transcript into
  # the watched workspace project dir (spec §C known risk).
  ( cd /tmp && generate ) >/dev/null 2>&1 &
fi
exit 0
```

- [ ] **Step 2: Write the test** (`summarize.test.sh`):

```bash
#!/usr/bin/env bash
# Tests for summarize.sh. Run: bash docker/runner/summarize.test.sh
set -u
here="$(cd "$(dirname "$0")" && pwd)"
fails=0
assert() { if [ "$1" = "$2" ]; then echo "ok: $3"; else echo "FAIL: $3 (got '$1' want '$2')"; fails=$((fails+1)); fi; }

work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
t="$work/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl"
sid="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
mkpayload() { printf '{"session_id":"%s","transcript_path":"%s"}' "$sid" "$t"; }
mkturns() { # $1 = number of user turns to write
  : > "$t"
  for i in $(seq 1 "$1"); do
    printf '{"type":"user","timestamp":"2026-07-10T0%s:00:00Z","message":{"content":"this is typed human prompt number %s with enough length"}}\n' "$((i % 10))" "$i" >> "$t"
    printf '{"type":"assistant","message":{"content":[{"type":"text","text":"assistant reply number %s with plenty of text in it"}]}}\n' "$i" >> "$t"
  done
  # tool result (content array on a user line) — must NOT count as a turn
  printf '{"type":"user","message":{"content":[{"type":"tool_result","content":"x"}]}}\n' >> "$t"
}
fake_llm="$work/fake-llm.sh"
cat > "$fake_llm" <<'FAKE'
#!/usr/bin/env bash
cat >/dev/null
printf '{"summary":"Fixed the widget and refactored the frobnicator.","tags":["widget","frobnicator","refactor"]}'
FAKE
chmod +x "$fake_llm"
run() { mkpayload | CF_SUMMARIZE_FG=1 CF_SUMMARIZE_CMD="$fake_llm" CF_SUMMARY_MIN_INTERVAL_S=0 bash "$here/summarize.sh"; }

# 1. Below threshold (19 turns < 20): no sidecar, no state advance to summary.
mkturns 19; run
assert "$([ -f "$work/$sid.fleet.jsonl" ] && echo yes || echo no)" "no" "no summary below turn threshold"

# 2. At threshold: one sidecar chapter with tags.
mkturns 20; rm -f "$work/$sid.fleet.state"; run
assert "$(jq -r '.type' "$work/$sid.fleet.jsonl")" "session-summary" "sidecar event type"
assert "$(jq -r '.tags | length' "$work/$sid.fleet.jsonl")" "3" "tags present"
assert "$(jq -r '.sessionId' "$work/$sid.fleet.jsonl")" "$sid" "session id stamped"

# 3. Re-fire with no new turns: debounced (still exactly 1 line).
run
assert "$(wc -l < "$work/$sid.fleet.jsonl" | tr -d ' ')" "1" "no re-summary without new turns"

# 4. 20 MORE turns: second chapter appended.
mkturns 40; run
assert "$(wc -l < "$work/$sid.fleet.jsonl" | tr -d ' ')" "2" "second chapter appended"

# 5. Malformed model output: rejected, nothing appended.
cat > "$fake_llm" <<'FAKE'
#!/usr/bin/env bash
cat >/dev/null; printf 'Sure! Here is your summary: it went well.'
FAKE
mkturns 60; run
assert "$(wc -l < "$work/$sid.fleet.jsonl" | tr -d ' ')" "2" "garbage output rejected"

# 6. Interval floor: immediate re-fire with default interval blocked.
cat > "$fake_llm" <<'FAKE'
#!/usr/bin/env bash
cat >/dev/null; printf '{"summary":"ok.","tags":["a","b","c"]}'
FAKE
mkturns 80
mkpayload | CF_SUMMARIZE_FG=1 CF_SUMMARIZE_CMD="$fake_llm" bash "$here/summarize.sh"   # honors 120s default vs state just written
assert "$(wc -l < "$work/$sid.fleet.jsonl" | tr -d ' ')" "2" "interval floor blocks immediate re-run"

[ "$fails" -eq 0 ] && echo "ALL PASS" || exit 1
```

- [ ] **Step 3: Run** `chmod +x docker/runner/summarize.sh && bash docker/runner/summarize.test.sh` → `ALL PASS` (iterate on jq details until green; the transcript fixtures above define the contract)
- [ ] **Step 4: Commit** — `git add docker/runner && git commit -m "feat(hooks): summarize.sh — turn-debounced chapter summaries with tags to sidecar (#207)"`

---

### Task 5: Register hooks in `hooks.settings.json`

**Files:**
- Modify: `docker/runner/hooks.settings.json`
- Modify: `docker/Dockerfile` ONLY IF it copies files individually (verify: `grep -n 'input-wait-report\|hooks.settings\|runner/' docker/Dockerfile`); if it copies the `docker/runner/` dir wholesale, no change needed beyond ensuring +x.

**Interfaces:**
- Produces: SessionStart → `session-report.sh`; Stop additionally runs `summarize.sh` (keep the existing input-wait Stop entry).

- [ ] **Step 1: Edit `hooks.settings.json`**:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "AskUserQuestion", "hooks": [ { "type": "command", "command": "/usr/local/lib/claude-fleet/input-wait-report.sh" } ] }
    ],
    "PostToolUse": [
      { "matcher": "AskUserQuestion", "hooks": [ { "type": "command", "command": "/usr/local/lib/claude-fleet/input-wait-report.sh" } ] }
    ],
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "/usr/local/lib/claude-fleet/session-report.sh" } ] }
    ],
    "Stop": [
      { "hooks": [
        { "type": "command", "command": "/usr/local/lib/claude-fleet/input-wait-report.sh" },
        { "type": "command", "command": "/usr/local/lib/claude-fleet/summarize.sh" }
      ] }
    ],
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "/usr/local/lib/claude-fleet/input-wait-report.sh" } ] }
    ]
  }
}
```

- [ ] **Step 2: Verify Dockerfile coverage**: `grep -n 'runner' docker/Dockerfile` — confirm the COPY brings the whole `docker/runner/` dir to `/usr/local/lib/claude-fleet/` with exec bits (add `COPY docker/runner/session-report.sh docker/runner/summarize.sh /usr/local/lib/claude-fleet/` + `RUN chmod +x ...` only if copies are per-file).
- [ ] **Step 3: Validate JSON**: `jq . docker/runner/hooks.settings.json` → parses.
- [ ] **Step 4: Commit** — `git add docker && git commit -m "feat(runner): register SessionStart + summarize hooks (#207)"`

---

### Task 6: Migration v8 — chaptered summaries, tags, usage events

**Files:**
- Modify: `src/main/db.ts` (migrate(), the `upsertSessionSummary` statement + Cache, new helpers)
- Test: `src/main/dbSummaries.test.ts` (existing file — extend), `src/main/db.test.ts` (usage events)

**Interfaces:**
- Produces (exact signatures, later tasks consume):
  - `addSessionTags(workspaceId: string, sessionId: string, tags: string[]): void` (INSERT OR IGNORE)
  - `recordUsageEvent(e: { workspaceId: string; sessionId?: string | null; kind: 'search-impression' | 'clickthrough' | 'marked-useful' | 'resumed'; detail?: Record<string, unknown> }): void`
  - `ingestLine` keeps its signature; `session-summary` events now APPEND chapter rows (dedup on `(session_id, source_max_event_id)`), never replace.
  - `unembeddedSummaries(modelId, limit)` keeps returning pending chapters (its existing join on `dedup_key = CAST(source_max_event_id AS TEXT)` already generalizes to multiple rows — verify in tests).

- [ ] **Step 1: Failing tests** — extend `dbSummaries.test.ts`:

```ts
it('appends chapter rows per source_max_event_id, never replaces (#207)', () => {
  ingestLine(WS, SES, userLine('u1', 'first prompt'));
  ingestLine(WS, SES, JSON.stringify({ type: 'session-summary', summary: 'chapter one', tags: ['a', 'b'], model: 'haiku' }));
  ingestLine(WS, SES, userLine('u2', 'second prompt'));
  ingestLine(WS, SES, JSON.stringify({ type: 'session-summary', summary: 'chapter two', tags: ['b', 'c'], model: 'haiku' }));
  const db = openDb(dir);
  const rows = db.prepare('SELECT summary FROM session_summaries WHERE session_id = ? ORDER BY id').all(SES) as Array<{ summary: string }>;
  expect(rows.map((r) => r.summary)).toEqual(['chapter one', 'chapter two']);
});

it('accumulates tags as a union across chapters', () => {
  ingestLine(WS, SES, userLine('u1', 'x'));
  ingestLine(WS, SES, JSON.stringify({ type: 'session-summary', summary: 's1', tags: ['a', 'b'] }));
  ingestLine(WS, SES, userLine('u2', 'y'));
  ingestLine(WS, SES, JSON.stringify({ type: 'session-summary', summary: 's2', tags: ['b', 'c'] }));
  const db = openDb(dir);
  const tags = db.prepare('SELECT tag FROM session_tags WHERE session_id = ? ORDER BY tag').all(SES) as Array<{ tag: string }>;
  expect(tags.map((t) => t.tag)).toEqual(['a', 'b', 'c']);
});
```

And in `db.test.ts`:

```ts
describe('usage_events (#207)', () => {
  it('recordUsageEvent appends rows with JSON detail', () => {
    const dir = freshDb();
    try {
      recordUsageEvent({ workspaceId: 'ws-a', sessionId: 's1', kind: 'search-impression', detail: { query: 'broker hang' } });
      recordUsageEvent({ workspaceId: 'ws-a', kind: 'resumed', sessionId: 's1' });
      const db = openDb(dir);
      const rows = db.prepare('SELECT kind, session_id, detail FROM usage_events ORDER BY id').all() as Array<Record<string, unknown>>;
      expect(rows.map((r) => r.kind)).toEqual(['search-impression', 'resumed']);
      expect(JSON.parse(rows[0].detail as string)).toEqual({ query: 'broker hang' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/main/dbSummaries.test.ts src/main/db.test.ts` → FAIL
- [ ] **Step 3: Implement migration v8** in `migrate()` after the v7 block:

```ts
  if ((d.pragma('user_version', { simple: true }) as number) < 8) {
    // Phase 2 (#207): chaptered summaries + tags + value-signal collection.
    // session_summaries becomes append-only chapters (one per summarized
    // window); a wandering multi-day session gets topical chapters instead
    // of one over-generalized replaced blurb. Old rows migrate as chapters.
    d.exec(`
      CREATE TABLE session_summaries_v8 (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id          TEXT NOT NULL,
        workspace_id        TEXT NOT NULL,
        summary             TEXT NOT NULL,
        tags                TEXT,
        source_max_event_id INTEGER NOT NULL,
        from_ts             INTEGER,
        to_ts               INTEGER,
        model               TEXT,
        generated_at        INTEGER NOT NULL,
        UNIQUE(session_id, source_max_event_id)
      );
      INSERT INTO session_summaries_v8
        (session_id, workspace_id, summary, source_max_event_id, model, generated_at)
        SELECT session_id, workspace_id, summary, source_max_event_id, model, generated_at
        FROM session_summaries;
      DROP TABLE session_summaries;
      ALTER TABLE session_summaries_v8 RENAME TO session_summaries;
      CREATE INDEX idx_session_summaries_session ON session_summaries(session_id, generated_at);

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
        kind         TEXT NOT NULL,
        detail       TEXT
      );
      CREATE INDEX idx_usage_events_session ON usage_events(session_id, kind);
      CREATE INDEX idx_usage_events_workspace_ts ON usage_events(workspace_id, ts);
    `);
    d.pragma('user_version = 8');
  }
```

Replace the `upsertSessionSummary` prepared statement with an append (keep the cache-slot name so `ingestLine` compiles; the semantic change to ingest itself is here too — see step 3b):

```ts
const insertSessionChapter = (d: Database.Database) =>
  d.prepare(`
    INSERT OR IGNORE INTO session_summaries
      (session_id, workspace_id, summary, tags, source_max_event_id, from_ts, to_ts, model, generated_at)
    VALUES (@session_id, @workspace_id, @summary, @tags, @source_max_event_id, @from_ts, @to_ts, @model, @generated_at)
  `);
const insertSessionTag = (d: Database.Database) =>
  d.prepare(`INSERT OR IGNORE INTO session_tags (workspace_id, session_id, tag) VALUES (?, ?, ?)`);
```

**Step 3b — `ingestLine`'s `session-summary` branch** becomes:

```ts
  } else if (type === 'session-summary' && typeof parsed.summary === 'string') {
    const toEpoch = (v: unknown): number | null => {
      const t = typeof v === 'string' ? Date.parse(v) : NaN;
      return Number.isFinite(t) ? t : null;
    };
    s.insertSessionChapter.run({
      session_id: sessionId,
      workspace_id: workspaceId,
      summary: parsed.summary,
      tags: Array.isArray(parsed.tags) ? JSON.stringify(parsed.tags) : null,
      source_max_event_id: maxEventId(sessionId),
      from_ts: toEpoch(parsed.fromEventTs),
      to_ts: toEpoch(parsed.toEventTs),
      model: typeof parsed.model === 'string' ? parsed.model : null,
      generated_at: ts ?? Date.now(),
    });
    if (Array.isArray(parsed.tags)) {
      for (const tag of parsed.tags) {
        if (typeof tag === 'string' && tag.trim()) s.insertSessionTag.run(workspaceId, sessionId, tag.trim().toLowerCase());
      }
    }
  }
```

**Step 3c — public helpers** (near `learnBrokerSessionMapping`):

```ts
/** Union-accumulate concept tags for a session (chapter tags, #207). */
export function addSessionTags(workspaceId: string, sessionId: string, tags: string[]): void {
  const d = openDbOrThrow();
  const ins = d.prepare(`INSERT OR IGNORE INTO session_tags (workspace_id, session_id, tag) VALUES (?, ?, ?)`);
  for (const t of tags) if (t.trim()) ins.run(workspaceId, sessionId, t.trim().toLowerCase());
}

/** Append-only value signal (#207). Scores are derived at read time (Phase 3). */
export function recordUsageEvent(e: {
  workspaceId: string;
  sessionId?: string | null;
  kind: 'search-impression' | 'clickthrough' | 'marked-useful' | 'resumed';
  detail?: Record<string, unknown>;
}): void {
  const d = openDbOrThrow();
  d.prepare(`INSERT INTO usage_events (ts, workspace_id, session_id, kind, detail) VALUES (?, ?, ?, ?, ?)`)
    .run(Date.now(), e.workspaceId, e.sessionId ?? null, e.kind, e.detail ? JSON.stringify(e.detail) : null);
}
```

- [ ] **Step 4: Run** the two test files → PASS; check `unembeddedSummaries`/`indexSessionSummaries` still compile against the chaptered table (`npx vitest run src/main/transcriptIndex.test.ts src/main/dbEmbeddings.test.ts`) — their join key (`dedup_key = CAST(source_max_event_id AS TEXT)`) is unchanged. Fix the `unembeddedSummaries` SELECT if it assumed one row per session (it must return each un-embedded chapter).
- [ ] **Step 5: Full gate** `npm run test:unit && npm run typecheck` → green. Commit: `git commit -am "feat(db): v8 — chaptered session summaries, session_tags, usage_events (#207)"`

---

### Task 7: Watcher sidecar support

**Files:**
- Modify: `src/main/jsonlWatcher.ts` (path→state resolution ~line 157/208)
- Test: `src/main/jsonlWatcher.test.ts` (check it exists: `ls src/main/jsonlWatcher.test.ts`; if absent, create with the watcher's existing testability seams — if the watcher is only e2e-tested, put the pure filename-parsing logic in an exported function and unit-test that)

**Interfaces:**
- Produces: exported pure helper `parseTranscriptFilename(path: string): { sessionId: string; sidecar: boolean } | null`; files named `<uuid>.fleet.jsonl` ingest under `<uuid>` and never fire `new-session`.

- [ ] **Step 1: Failing test** (unit-test the pure helper):

```ts
import { parseTranscriptFilename } from './jsonlWatcher.js';

describe('sidecar filename routing (#207)', () => {
  const U = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  it('routes <uuid>.jsonl as a primary transcript', () => {
    expect(parseTranscriptFilename(`/x/${U}.jsonl`)).toEqual({ sessionId: U, sidecar: false });
  });
  it('routes <uuid>.fleet.jsonl to the same session as a sidecar', () => {
    expect(parseTranscriptFilename(`/x/${U}.fleet.jsonl`)).toEqual({ sessionId: U, sidecar: true });
  });
  it('rejects non-uuid stems', () => {
    expect(parseTranscriptFilename('/x/notes.jsonl')).toBeNull();
    expect(parseTranscriptFilename('/x/junk.fleet.jsonl')).toBeNull();
  });
});
```

- [ ] **Step 2: Run** → FAIL (helper doesn't exist)
- [ ] **Step 3: Implement** — extract + export the helper in `jsonlWatcher.ts`:

```ts
/** Session id + sidecar flag from a watched file path, or null if neither a
 *  primary transcript (<uuid>.jsonl) nor a fleet sidecar (<uuid>.fleet.jsonl).
 *  Sidecars carry host-bound events (session-summary chapters, #207) and are
 *  ingested under their session id but NEVER fire 'new-session' — they must
 *  not touch the pending-attach fallback or look like fresh conversations. */
export function parseTranscriptFilename(path: string): { sessionId: string; sidecar: boolean } | null {
  if (extname(path) !== '.jsonl') return null;
  let stem = basename(path, '.jsonl');
  let sidecar = false;
  if (stem.endsWith('.fleet')) { stem = stem.slice(0, -'.fleet'.length); sidecar = true; }
  if (!UUID_RE.test(stem)) return null;
  return { sessionId: stem, sidecar };
}
```

Then in the watcher's file-state creation (the code around lines 157–210): use `parseTranscriptFilename`, store `sidecar` on `FileState`, and guard the `new-session` emit (line ~169) with `if (!state.sidecar)`. The ingest path (line ~249+) is unchanged — sidecar lines flow through `ingestLine` identically. The durable-mirror append (line ~270) should also be skipped for sidecars (`if (!state.sidecar)`) — summaries are DB data, not conversation history.

- [ ] **Step 4: Run** watcher tests + `npm run test:unit` → green
- [ ] **Step 5: Commit** — `git commit -am "feat(watcher): ingest <uuid>.fleet.jsonl sidecars without firing new-session (#207)"`

---

### Task 8: MCP tool `report_session_mapping` (+ injected writer)

**Files:**
- Modify: `src/main/mcpServer.ts` (TOOLS array + injection setter), `src/main/ipc.ts` (wiring)
- Test: `src/main/mcpServer.test.ts`

**Interfaces:**
- Consumes: `learnBrokerSessionMapping` (db.ts, returns previous id) — via injection, NOT imported by mcpServer.
- Produces: setter `setSessionMappingHandler(fn: (callerId: string, brokerSessionId: string, sessionId: string) => void)`; tool `report_session_mapping`.

- [ ] **Step 1: Failing test** (in `mcpServer.test.ts`, alongside the `signal_input_wait` describe):

```ts
import { setSessionMappingHandler } from './mcpServer.js';

describe('report_session_mapping (#207)', () => {
  afterEach(() => setSessionMappingHandler(() => {}));
  it('forwards (callerId, brokerSessionId, sessionId) to the injected handler', () => {
    const calls: Array<[string, string, string]> = [];
    setSessionMappingHandler((c, b, s) => calls.push([c, b, s]));
    tool('report_session_mapping').run({} as never, { brokerSessionId: 'tab-1', sessionId: 'uuid-9' }, ctxA);
    expect(calls).toEqual([[WS_A, 'tab-1', 'uuid-9']]);
  });
  it('rejects bad args', () => {
    setSessionMappingHandler(() => {});
    expect(() => tool('report_session_mapping').run({} as never, { brokerSessionId: 'x' }, ctxA)).toThrow(/required/);
  });
});
```

- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Implement** — in `mcpServer.ts`, next to `setInputWaitHandler`:

```ts
/** Injected by ipc.ts: persist claude's self-reported tab↔session mapping
 *  (SessionStart hook, #207). callerId is host-assigned; the handler may only
 *  ever write the caller's own workspace rows. */
export type SessionMappingHandler = (callerId: string, brokerSessionId: string, sessionId: string) => void;
let sessionMappingHandler: SessionMappingHandler | null = null;
export function setSessionMappingHandler(fn: SessionMappingHandler): void {
  sessionMappingHandler = fn;
}
```

And append to `TOOLS` (after `signal_input_wait`):

```ts
  {
    name: 'report_session_mapping',
    description:
      'Internal (called by the runner SessionStart hook, not by the model): record which claude ' +
      'session UUID is running in which tab of THIS workspace. ' +
      'Args: brokerSessionId (the tab id), sessionId (the claude session UUID).',
    inputSchema: {
      type: 'object',
      properties: { brokerSessionId: { type: 'string' }, sessionId: { type: 'string' } },
      required: ['brokerSessionId', 'sessionId']
    },
    run: (_db, a, ctx) => {
      if (!sessionMappingHandler) throw new Error('session-mapping reporting is unavailable');
      if (typeof a.brokerSessionId !== 'string' || typeof a.sessionId !== 'string') {
        throw new Error('brokerSessionId (string) and sessionId (string) are required');
      }
      sessionMappingHandler(ctx.callerId, a.brokerSessionId, a.sessionId);
      return { ok: true };
    }
  },
```

Wire in `ipc.ts` (next to the `setInputWaitHandler(...)` call at ~line 937; import `setSessionMappingHandler` from mcpServer and `logError` is already imported):

```ts
  setSessionMappingHandler((callerId, brokerSessionId, claudeSessionId) => {
    const previous = learnBrokerSessionMapping(callerId, brokerSessionId, claudeSessionId);
    if (previous && previous !== claudeSessionId) {
      logError({
        source: 'main', type: 'mapping-remapped', level: 'warn',
        message: `broker ${brokerSessionId} remapped ${previous} → ${claudeSessionId} via SessionStart hook (drift corrected)`,
        workspaceId: callerId,
        extra: { brokerSessionId, from: previous, to: claudeSessionId, how: 'session-start-hook' }
      });
    }
  });
```

- [ ] **Step 4: Run** `npx vitest run src/main/mcpServer.test.ts` → PASS. Check the tool-count/contract assertions in that file and `tests/mcp-server.spec.ts` — update the pinned tool list to include `report_session_mapping` (Task 11 pins the rest; do this tool now so the suite stays green).
- [ ] **Step 5: Commit** — `git commit -am "feat(mcp): report_session_mapping — claude self-reports tab mapping, fixes /clear drift (#207)"`

---### Task 9: MCP tools `mark_useful` + `get_config`

**Files:**
- Modify: `src/main/mcpServer.ts`, `src/main/ipc.ts`
- Test: `src/main/mcpServer.test.ts`

**Interfaces:**
- Produces: setters `setUsageRecorder(fn: (e: { workspaceId: string; sessionId?: string | null; kind: 'search-impression' | 'clickthrough' | 'marked-useful' | 'resumed'; detail?: Record<string, unknown> }) => void)` and `setConfigResolver(fn: (callerId: string) => Record<string, unknown>)`; tools `mark_useful`, `get_config`.

- [ ] **Step 1: Failing tests**:

```ts
import { setUsageRecorder, setConfigResolver } from './mcpServer.js';

describe('mark_useful + get_config (#207)', () => {
  afterEach(() => { setUsageRecorder(() => {}); setConfigResolver(() => ({})); });

  it('mark_useful records a marked-useful usage event for an allowed session', () => {
    const events: unknown[] = [];
    setUsageRecorder((e) => events.push(e));
    tool('mark_useful').run(db, { sessionId: 'sa', note: 'led me to the fix' }, ctxA);
    expect(events).toEqual([{ workspaceId: WS_A, sessionId: 'sa', kind: 'marked-useful', detail: { note: 'led me to the fix' } }]);
  });

  it("mark_useful refuses a session outside the caller's allowed set", () => {
    setUsageRecorder(() => { throw new Error('must not be called'); });
    expect(() => tool('mark_useful').run(db, { sessionId: 'sb' }, ctxA)).toThrow(/not found/);
  });

  it('get_config returns the resolver output for the caller', () => {
    setConfigResolver((callerId) => ({ summarizer: { model: 'haiku', minNewTurns: 20 }, workspaceId: callerId }));
    const out = tool('get_config').run(db, {}, ctxA) as Record<string, unknown>;
    expect(out.workspaceId).toBe(WS_A);
  });
});
```

- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Implement** — setters mirror Task 8's shape (`usageRecorder`, `configResolver`, both nullable module lets + exported setters). Tools:

```ts
  {
    name: 'mark_useful',
    description:
      'Mark a session as useful after its content answered your question — e.g. when a ' +
      'search_transcripts result led you to the information you needed. This feeds the value ' +
      'signals that decide what history stays richly indexed. Args: sessionId (required), note (optional, why it helped).',
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string' }, note: { type: 'string' } },
      required: ['sessionId']
    },
    run: (db, a, ctx) => {
      if (!usageRecorder) throw new Error('usage recording is unavailable');
      if (typeof a.sessionId !== 'string') throw new Error('sessionId (string) is required');
      // Scope: the session must belong to an allowed workspace (same check
      // shape as get_session — reuse its row lookup against `db`).
      const row = db.prepare('SELECT workspace_id FROM sessions WHERE id = ?').get(a.sessionId) as { workspace_id: string } | undefined;
      if (!row || !ctx.allowedWorkspaces.has(row.workspace_id)) throw new Error(`session not found: ${a.sessionId}`);
      usageRecorder({
        workspaceId: ctx.callerId,
        sessionId: a.sessionId,
        kind: 'marked-useful',
        detail: typeof a.note === 'string' && a.note ? { note: a.note.slice(0, 500) } : undefined
      });
      return { ok: true };
    }
  },
  {
    name: 'get_config',
    description:
      'Effective fleet tunables for this workspace (summarizer model/debounce/window, app defaults ' +
      '⊕ workspace env overrides). Note: reflects what the host set at container create; manual ' +
      'in-container env changes are not visible until recreate. No args.',
    inputSchema: { type: 'object', properties: {} },
    run: (_db, _a, ctx) => {
      if (!configResolver) throw new Error('config resolution is unavailable');
      return configResolver(ctx.callerId);
    }
  },
```

Wire in `ipc.ts`:

```ts
  setUsageRecorder((e) => recordUsageEvent(e));
  setConfigResolver((callerId) => {
    const m = manifestCacheOrRead(callerId); // use the existing manifest read used nearby (readWorkspaceManifest is async — so resolve from the same sync source ipc uses for env, or make the resolver async and await it in the tool; pick whichever matches existing code, and reflect the choice in the tool's run signature)
    const env = m?.env ?? {};
    const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
    return {
      workspaceId: callerId,
      summarizer: {
        model: typeof env.CF_SUMMARY_MODEL === 'string' ? env.CF_SUMMARY_MODEL : 'haiku',
        minNewTurns: num(env.CF_SUMMARY_MIN_NEW_TURNS, 20),
        minIntervalS: num(env.CF_SUMMARY_MIN_INTERVAL_S, 120),
        windowChars: num(env.CF_SUMMARY_WINDOW_CHARS, 8000)
      }
    };
  });
```

(`readWorkspaceManifest` is async — if no sync manifest source exists in ipc.ts, make `configResolver` return a Promise and `await` it in the tool's `run` — `callTool` already awaits `tool.run`.)

- [ ] **Step 4: Run** mcpServer tests → PASS
- [ ] **Step 5: Commit** — `git commit -am "feat(mcp): mark_useful + get_config tools (#207)"`

---

### Task 10: Implicit telemetry — impressions, click-throughs, resumes

**Files:**
- Modify: `src/main/mcpServer.ts` (search_transcripts run + a per-caller recent-results ring + read-tools clickthrough hook)
- Modify: `src/main/docker.ts` + `src/main/local.ts` (resumed events)
- Test: `src/main/mcpServer.test.ts`

**Interfaces:**
- Consumes: `setUsageRecorder` from Task 9 (all writes flow through it).
- Produces: module-internal `noteSearchResults(callerId, sessionIds)` + `noteRead(callerId, sessionId, db …)`; exported `_resetTelemetryForTests()`.

- [ ] **Step 1: Failing tests**:

```ts
import { _resetTelemetryForTests } from './mcpServer.js';

describe('implicit usage telemetry (#207)', () => {
  beforeEach(() => _resetTelemetryForTests());
  afterEach(() => setUsageRecorder(() => {}));

  it('search_transcripts records one impression per distinct result session, carrying the query', async () => {
    const events: Array<Record<string, unknown>> = [];
    setUsageRecorder((e) => events.push(e as Record<string, unknown>));
    setQueryEmbedder(async (texts) => texts.map(() => { const v = new Float32Array(EMBED_DIM); v[0] = 1; return v; }));
    // seed one embedding row for WS_A (reuse the insert helper pattern from the scoping describe)
    seedEmbedding(db, WS_A, 'sa');
    await tool('search_transcripts').run(db, { query: 'the broker hang' }, ctxA);
    const imp = events.filter((e) => e.kind === 'search-impression');
    expect(imp).toHaveLength(1);
    expect(imp[0].sessionId).toBe('sa');
    expect((imp[0].detail as Record<string, unknown>).query).toBe('the broker hang');
  });

  it('a read of a recently-searched session records a clickthrough', async () => {
    const events: Array<Record<string, unknown>> = [];
    setUsageRecorder((e) => events.push(e as Record<string, unknown>));
    setQueryEmbedder(async (texts) => texts.map(() => { const v = new Float32Array(EMBED_DIM); v[0] = 1; return v; }));
    seedEmbedding(db, WS_A, 'sa');
    await tool('search_transcripts').run(db, { query: 'x' }, ctxA);
    tool('get_session').run(db, { id: 'sa' }, ctxA);
    expect(events.some((e) => e.kind === 'clickthrough' && e.sessionId === 'sa')).toBe(true);
  });

  it('a read WITHOUT a recent search records no clickthrough', () => {
    const events: Array<Record<string, unknown>> = [];
    setUsageRecorder((e) => events.push(e as Record<string, unknown>));
    tool('get_session').run(db, { id: 'sa' }, ctxA);
    expect(events.filter((e) => e.kind === 'clickthrough')).toHaveLength(0);
  });
});
```

(Define a local `seedEmbedding(db, ws, ses)` helper in the test file reusing the INSERT from the existing search-scoping describe.)

- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Implement** in `mcpServer.ts`:

```ts
// ── Implicit value telemetry (#207) ─────────────────────────────────────────
// Per-caller ring of recently-returned search result session ids. A read of
// one of those sessions within CLICKTHROUGH_WINDOW_MS is engagement — the
// implicit signal Phase 3's value scoring is built on. In-memory only.
const CLICKTHROUGH_WINDOW_MS = 5 * 60_000;
const recentSearchHits = new Map<string, Map<string, number>>(); // callerId → sessionId → ts
export function _resetTelemetryForTests(): void { recentSearchHits.clear(); }

function noteSearchResults(callerId: string, query: string, sessionIds: string[]): void {
  const ring = recentSearchHits.get(callerId) ?? new Map<string, number>();
  const now = Date.now();
  for (const sid of new Set(sessionIds)) {
    ring.set(sid, now);
    usageRecorder?.({ workspaceId: callerId, sessionId: sid, kind: 'search-impression', detail: { query: query.slice(0, 300) } });
  }
  recentSearchHits.set(callerId, ring);
}

function noteRead(callerId: string, sessionId: string): void {
  const ring = recentSearchHits.get(callerId);
  const ts = ring?.get(sessionId);
  if (ts === undefined) return;
  if (Date.now() - ts > CLICKTHROUGH_WINDOW_MS) { ring!.delete(sessionId); return; }
  ring!.delete(sessionId); // one clickthrough per impression
  usageRecorder?.({ workspaceId: callerId, sessionId, kind: 'clickthrough' });
}
```

Call `noteSearchResults(ctx.callerId, query, hits.map(h => h.sessionId))` at the end of `search_transcripts.run`, and `noteRead(ctx.callerId, <session id>)` at the top of the `get_session`, `session_summary`, `list_events`, and `get_cost` runs (each already resolves/validates its session id — insert after validation so denied reads don't count).

**Resumed events** — in `docker.ts` `attachPty` CREATE branch, when `resumeOf` is set (right after the mapping learn):

```ts
    if (resumeOf) recordUsageEvent({ workspaceId, sessionId: resumeOf, kind: 'resumed' });
```

and the same line in `local.ts`'s `onFreshSpawn` when `resumeOf` is set (import `recordUsageEvent` from `./db.js` in both).

- [ ] **Step 4: Run** `npx vitest run src/main/mcpServer.test.ts` → PASS; `npm run typecheck`
- [ ] **Step 5: Commit** — `git commit -am "feat(telemetry): search impressions, click-throughs, resume events (#207)"`

---

### Task 11: Query snapshot + contract pins (unit + e2e)

**Files:**
- Modify: `src/main/mcpServer.ts` (snapshot table list ~line 703 + `query` tool description ~line 967 + `search_transcripts` description)
- Test: `src/main/mcpServer.test.ts`, `tests/mcp-server.spec.ts`

**Interfaces:**
- Produces: `query` snapshot exposes `session_summaries`, `session_tags`, `usage_events` (workspace-scoped like the existing three).

- [ ] **Step 1: Failing test**:

```ts
describe('query snapshot exposes phase-2 tables, workspace-scoped (#207)', () => {
  it('session_tags are readable and scoped', () => {
    db.prepare(`CREATE TABLE IF NOT EXISTS session_tags (workspace_id TEXT, session_id TEXT, tag TEXT, PRIMARY KEY(session_id, tag))`).run();
    db.prepare(`INSERT INTO session_tags VALUES (?, 'sa', 'broker')`).run(WS_A);
    db.prepare(`INSERT INTO session_tags VALUES (?, 'sb', 'secret-tag')`).run(WS_B);
    const rows = tool('query').run(db, { sql: 'SELECT tag FROM session_tags ORDER BY tag' }, ctxA) as { rows: Array<{ tag: string }> };
    expect(rows.rows.map((r) => r.tag)).toEqual(['broker']);
  });
});
```

(Also add the `usage_events` + `session_summaries` equivalents with one WS_A and one WS_B row each, asserting only WS_A rows come back. The test `makeDb`/`makeFileDb` helpers need the three new tables added to their CREATE block — add them there with the v8 shapes.)

- [ ] **Step 2: Run** → FAIL (snapshot builder doesn't copy the new tables)
- [ ] **Step 3: Implement** — at the snapshot builder (~line 703), the per-table copy loop/statements gain the three tables (same `WHERE workspace_id IN (…allowed)` scope predicate as `sessions`):

```ts
        `CREATE TABLE session_summaries AS SELECT * FROM ${alias}.session_summaries WHERE ${scope}`,
        `CREATE TABLE session_tags     AS SELECT * FROM ${alias}.session_tags     WHERE ${scope}`,
        `CREATE TABLE usage_events     AS SELECT * FROM ${alias}.usage_events     WHERE ${scope}`,
```

Update the `query` tool description: `Tables: events, sessions, broker_sessions, session_summaries, session_tags, usage_events`. Update `search_transcripts` description to add: `If a result leads you to the information you needed, call mark_useful with its sessionId.` Update the e2e contract spec `tests/mcp-server.spec.ts` tool list to include `report_session_mapping`, `mark_useful`, `get_config` and the new query-table description text (open the file, find the pinned tool-name array / description assertions, extend).

- [ ] **Step 4: Run** `npx vitest run src/main/mcpServer.test.ts` → PASS; `npm run test:unit` → green (e2e runs in CI)
- [ ] **Step 5: Commit** — `git commit -am "feat(mcp): expose phase-2 tables via query snapshot; pin new tool contract (#207)"`

---

### Task 12: SPEC.md + memory-of-record updates

**Files:**
- Modify: `docs/SPEC.md`

**Interfaces:** none (documentation gate — the repo rule requires it in the same PR).

- [ ] **Step 1:** Update `docs/SPEC.md`:
  - §6/§11 (fleet-state MCP tool list): add `report_session_mapping`, `mark_useful`, `get_config`; `query` snapshot table list gains the three tables.
  - §7 data model: v8 schema (chaptered `session_summaries`, `session_tags`, `usage_events`) with the append-only/derived-score rationale (copy the spec's §E/§F language, edited in place per the spec-maintenance rule — current state, not history).
  - §7 "Phase 2 — session-summary hook (not yet implemented)" paragraphs (two locations, lines ~66 and ~516): rewrite as implemented — Stop hook `summarize.sh`, turn debounce (20 turns / 120s), chapters, sidecar `<uuid>.fleet.jsonl`, tunables via workspace env.
  - §4/§9 env contract: `CLAUDE_FLEET_BROKER_SESSION_ID` exported by broker + local backend; `CF_SUMMARY_*` tunables.
  - Watcher section: sidecar convention (`*.fleet.jsonl` — ingest, no `new-session`, no mirror).
- [ ] **Step 2:** `grep -n 'not yet implemented' docs/SPEC.md` → no stale Phase-2 stubs remain.
- [ ] **Step 3: Commit** — `git commit -am "docs(SPEC): phase 2 session hooks — hooks, chapters, tags, usage events (#207)"`

---

### Task 13: Runner image build + hook smoke gate

**Files:** none (verification gate; established rule: never ship hook/settings changes untested against a built image)

- [ ] **Step 1:** Build the base runner image from repo root: `docker build -t claude-fleet-runner:phase2-test -f docker/Dockerfile .`
- [ ] **Step 2:** Smoke the hooks inside it without creds:

```bash
docker run --rm -e CLAUDE_FLEET_BROKER_SESSION_ID=tab-1 claude-fleet-runner:phase2-test \
  bash -c 'printf "{\"session_id\":\"u-1\"}" | CF_SESSION_REPORT_SINK=/tmp/s bash /usr/local/lib/claude-fleet/session-report.sh && cat /tmp/s'
```

Expected: one `report_session_mapping` JSON line. Repeat for `summarize.sh` with the Task-4 fixture technique (`CF_SUMMARIZE_FG=1 CF_SUMMARIZE_CMD=/bin/cat`-style fake).
- [ ] **Step 3:** `jq . docker/runner/hooks.settings.json` inside the image parses; `claude --settings /usr/local/lib/claude-fleet/hooks.settings.json --version` exits 0 (proves settings load doesn't kill claude).
- [ ] **Step 4:** Full local gate: `npm run test:unit && npm run typecheck && npm run build && cd broker && go test -race ./...` → all green.
- [ ] **Step 5:** Push branch, open the PR (`Fixes #207`, refs #206), CI green, then merge per repo flow. Runner image publishes via `publish-runner.yml` on merge; note in the PR that existing workspaces adopt on image pull + container recreate.
