# Chapter-Summary Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Old transcripts that never got chapter summaries get backfilled automatically on session start, at the same ~20-turn cadence organic summarization uses.

**Architecture:** Extract the generation guts of `docker/runner/summarize.sh` into a sourced library (`summary-core.sh`) whose central op is "summarize the next ≤20-turn chunk past the watermark, advance the watermark." The Stop hook becomes a thin chunk loop (fixes the resume mega-window). A new SessionStart hook (`backfill-summaries.sh`) sweeps all of the workspace's transcripts and drains their backlog under a budget. Host-side, only `get_config` grows a `backfill` block. Spec: `docs/superpowers/specs/2026-07-31-summary-backfill-design.md`; issue #246.

**Tech Stack:** bash + jq (runner hooks, tested by plain bash test scripts), TypeScript (host config), Docker (runner image).

## Global Constraints

- Chunk size = `CF_SUMMARY_MIN_NEW_TURNS` (default `20`); a "typed turn" is a `type=="user"` entry whose `.message.content` is a **string** (tool-result arrays never count).
- Watermark file format is UNCHANGED: `<turns> <epoch>` in `<sid>.fleet.state`, claimed **before** the model call.
- Sub-threshold tails (<20 turns past the watermark) are never summarized — parity with organic behavior. No re-summarization of covered turns, ever.
- All hook scripts are fire-and-forget: always `exit 0`, never block claude, background their slow work, `cd /tmp` around `claude -p` calls (throwaway transcripts must not land in the watched project dir).
- New env tunables (script defaults): `CF_BACKFILL` (default on; `0` disables), `CF_BACKFILL_MAX_PER_SWEEP=10`, `CF_BACKFILL_DELAY_S=3`, `CF_SUMMARY_MAX_CHAPTERS_PER_RUN=5`. Existing `CF_SUMMARY_*` unchanged.
- New `report_summary_status` phases: `backfill-start`, `backfill-done` (host prefixes `summary-`; no host change needed — `ipc.ts:1037` already does `` `summary-${phase}` `` for any phase string).
- `docs/SPEC.md` must be updated in this branch (squash-merge makes it the same commit as the behavior change, satisfying `.claude/rules/spec-maintenance.md`).
- Run shell tests with plain `bash`; they need no npm. Vitest tasks need the container test-env setup in Task 0.
- `fromEventTs`/`toEventTs` on every chapter = the summarized **window's** first/last `.timestamp`, not the whole transcript's.

---

### Task 0: Workspace setup (no commit)

**Files:** none created in-repo.

The implementation worktree is `/workspace/claude-fleet/.claude/worktrees/summary-backfill-spec` (branch `worktree-summary-backfill-spec`, already has the spec committed). All commands below run from that directory.

- [ ] **Step 1: Symlink node_modules** (worktrees don't have their own; tsc/vitest resolve from the base checkout):

```bash
cd /workspace/claude-fleet/.claude/worktrees/summary-backfill-spec
ln -sfn /workspace/claude-fleet/node_modules node_modules
```

- [ ] **Step 2: Verify the vitest env works** (this container has no compiler; the base checkout's `node_modules` was previously patched with a prebuilt `better_sqlite3.node` and an electron `path.txt` stub — see memory `run-unit-tests-env` if the run below fails):

```bash
npx vitest run src/main/config.test.ts 2>&1 | tail -3
```

Expected: all tests pass. If `better_sqlite3.node` or electron errors appear: `cd /tmp && mkdir -p bs3probe && cd bs3probe && npm init -y && npm install better-sqlite3@12.10.0 && cp node_modules/better-sqlite3/build/Release/better_sqlite3.node /workspace/claude-fleet/node_modules/better-sqlite3/build/Release/` and `printf 'electron-stub' > /workspace/claude-fleet/node_modules/electron/path.txt`.

- [ ] **Step 3: Verify the existing shell suite is green before touching anything:**

```bash
bash docker/runner/summarize.test.sh
```

Expected: `ALL PASS`.

---

### Task 1: Extract `summary-core.sh` (pure refactor, behavior identical)

**Files:**
- Create: `docker/runner/summary-core.sh`
- Modify: `docker/runner/summarize.sh` (becomes a thin caller; net behavior unchanged in this task)
- Test: `docker/runner/summarize.test.sh` (existing — must pass UNMODIFIED; that is the whole gate)

**Interfaces:**
- Produces (used by Tasks 2–3): a sourceable library. Callers set globals `sid` and `tpath`, then call:
  - `summary_init` — derives globals `min_turns`, `model`, `window_chars`, `state` (`<dir>/<sid>.fleet.state`), `sidecar` (`<dir>/<sid>.fleet.jsonl`) from env + `tpath`.
  - `count_turns` — echoes the typed-turn count of `$tpath` (echoes `0` on jq failure).
  - `read_watermark` — sets globals `last_turns`, `last_run` (0 0 when no state file).
  - `report_status <phase> [<compact-json-detail>]` — #230 breadcrumb (unchanged semantics, honors `CF_SUMMARY_STATUS_SINK`).
  - `generate_window <skip>` — Task 1 keeps today's *unbounded* window generation (everything past `<skip>`); Task 2 replaces it with `summarize_next_chunk`. In Task 1 it contains today's `generate()` body verbatim, parameterized by `$1` instead of the closed-over `last_turns`.

- [ ] **Step 1: Create `docker/runner/summary-core.sh`** with the shared pieces moved verbatim from `summarize.sh` (report_status, turn counting, init). Content:

```bash
#!/usr/bin/env bash
# Shared core for chapter summaries (#207, #246). Sourced by summarize.sh
# (Stop hook) and backfill-summaries.sh (SessionStart sweep) — one windowing
# implementation so the live and backfill paths can't drift. Callers set the
# globals sid + tpath, then call summary_init. Helpers are fire-and-forget:
# they return instead of exiting, and a reporting failure never propagates.

# Diagnostic breadcrumb (#230): report each decision point to the fleet-state
# MCP server; the host lands it in the errors table (list_errors). $1 = phase,
# $2 = compact JSON detail. Uses the caller's $sid.
report_status() {
  phase="$1"; detail="${2:-}"; [ -n "$detail" ] || detail='{}'
  req="$(jq -nc --arg sid "$sid" --arg phase "$phase" --argjson detail "$detail" \
    '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"report_summary_status",arguments:{sessionId:$sid,phase:$phase,detail:$detail}}}' 2>/dev/null)" || return 0
  # Test seam: capture the request instead of sending it.
  if [ -n "${CF_SUMMARY_STATUS_SINK:-}" ]; then printf '%s\n' "$req" >> "$CF_SUMMARY_STATUS_SINK"; return 0; fi
  sock="/fleet/mcp/mcp.sock"; tok="/fleet/mcp/token"; port="${CLAUDE_FLEET_MCP_TCP_PORT:-7071}"
  if [ -S "$sock" ]; then
    printf '%s\n' "$req" | timeout 2 socat - "UNIX-CONNECT:$sock" >/dev/null 2>&1 || true
  elif [ -f "$tok" ]; then
    { printf '%s\n' "$(cat "$tok")"; printf '%s\n' "$req"; } \
      | timeout 2 socat - "TCP:host.docker.internal:$port" >/dev/null 2>&1 || true
  fi
}

# Derive per-session paths + tunables from $sid/$tpath and env.
summary_init() {
  min_turns="${CF_SUMMARY_MIN_NEW_TURNS:-20}"
  model="${CF_SUMMARY_MODEL:-haiku}"
  window_chars="${CF_SUMMARY_WINDOW_CHARS:-8000}"
  dir="$(dirname "$tpath")"
  state="$dir/$sid.fleet.state"
  sidecar="$dir/$sid.fleet.jsonl"
}

# Completed turns = typed human prompts (string content). Tool results are
# content ARRAYS and don't count.
count_turns() {
  jq -rs '[.[] | select(.type=="user" and (.message.content|type)=="string")] | length' "$tpath" 2>/dev/null || echo 0
}

read_watermark() {
  last_turns=0; last_run=0
  [ -f "$state" ] && read -r last_turns last_run < "$state"
}
```

Then move today's `generate()` body (summarize.sh lines between `generate() {` and its closing `}` on current main — window jq, `Previously:` chain, model call, fence-tolerant JSON extraction, validation, `session-summary` append, `ai-title` append, `generated` breadcrumb) into `summary-core.sh` as:

```bash
# Task-1 shape: today's unbounded window generation, parameterized by $1=skip.
# Task 2 replaces this with the chunk-bounded summarize_next_chunk.
generate_window() {
  skip="$1"
  # ... the verbatim body of today's generate(), with every occurrence of
  #     $last_turns replaced by $skip, and new_turns computed by the caller
  #     passed in as $2 for the attempt/empty-window breadcrumb details ...
}
```

Concretely, inside the moved body the only edits are: `--argjson skip "$last_turns"` → `--argjson skip "$skip"`, and the two `--argjson nt "$new_turns"` become `--argjson nt "${2:-0}"`.

- [ ] **Step 2: Rewrite `docker/runner/summarize.sh`** to source the core. Full new content:

```bash
#!/usr/bin/env bash
# Claude Code hook: debounced chapter summaries (#207). On Stop, count
# completed turns; when ≥ CF_SUMMARY_MIN_NEW_TURNS new turns landed since the
# last summary AND ≥ CF_SUMMARY_MIN_INTERVAL_S seconds passed, summarize the
# new window via `claude -p` and append a session-summary event to the SIDECAR
# <uuid>.fleet.jsonl (never the live transcript — corrupts --resume).
# Fire-and-forget; always exit 0. Generation lives in summary-core.sh (#246).
set -u
payload="$(cat)"
sid="$(printf '%s' "$payload" | jq -r '.session_id // empty' 2>/dev/null)"
tpath="$(printf '%s' "$payload" | jq -r '.transcript_path // empty' 2>/dev/null)"
[ -n "$sid" ] && [ -n "$tpath" ] && [ -f "$tpath" ] || exit 0

. "$(dirname "$0")/summary-core.sh"
summary_init
min_interval="${CF_SUMMARY_MIN_INTERVAL_S:-120}"

turns="$(count_turns)"
read_watermark
now="$(date +%s)"
new_turns=$((turns - last_turns))
if [ "$new_turns" -lt "$min_turns" ]; then
  # Below threshold — the common, healthy case. Opt-in only (CF_SUMMARY_DIAG).
  [ -n "${CF_SUMMARY_DIAG:-}" ] && report_status gate \
    "$(jq -nc --argjson t "$turns" --argjson nt "$new_turns" --argjson mt "$min_turns" \
      '{turns:$t,newTurns:$nt,minTurns:$mt}' 2>/dev/null || printf '{}')"
  exit 0
fi
[ $((now - last_run)) -ge "$min_interval" ] || exit 0

# Claim the window immediately (before the slow LLM call) so a Stop firing
# mid-generation doesn't double-summarize the same turns.
printf '%s %s\n' "$turns" "$now" > "$state"

if [ -n "${CF_SUMMARIZE_FG:-}" ]; then generate_window "$last_turns" "$new_turns"; else
  # cd /tmp: the claude -p run must not write its throwaway transcript into
  # the watched workspace project dir (spec §C known risk).
  ( cd /tmp && generate_window "$last_turns" "$new_turns" ) >/dev/null 2>&1 &
fi
exit 0
```

- [ ] **Step 3: Run the UNMODIFIED existing suite** — this is the refactor gate:

```bash
bash docker/runner/summarize.test.sh
```

Expected: `ALL PASS` (all 13 numbered cases). Any failure means the extraction changed behavior — fix the extraction, not the test.

- [ ] **Step 4: Commit**

```bash
git add docker/runner/summary-core.sh docker/runner/summarize.sh
git commit -m "refactor(#246): extract summarize.sh generation into sourced summary-core.sh"
```

---

### Task 2: Chunk-bounded windows, windowed timestamps, chunk loop in the Stop hook

**Files:**
- Modify: `docker/runner/summary-core.sh` (replace `generate_window` with `summarize_next_chunk`)
- Modify: `docker/runner/summarize.sh` (gate → chunk loop)
- Test: `docker/runner/summarize.test.sh` (append new cases 14–16; existing cases must keep passing)

**Interfaces:**
- Produces (used by Task 3): `summarize_next_chunk` — no args (uses globals from `summary_init`). Summarizes turns `(last_turns, last_turns+min_turns]` **only when a full chunk exists**. Return codes: `0` = chapter generated (caller may continue), `1` = no full chunk remaining (stop, nothing claimed), `2` = chunk claimed but not generated (empty-window or model-rejected — stop; watermark HAS advanced past the failed chunk, matching today's claim-first semantics).
- The Stop hook honors `CF_SUMMARY_MAX_CHAPTERS_PER_RUN` (default 5).

- [ ] **Step 1: Append failing tests to `docker/runner/summarize.test.sh`** (before the final `[ "$fails" -eq 0 ]` line). They need a fixture with ordered, distinguishable timestamps:

```bash
# ── #246 chunked backfill core: bounded windows, windowed timestamps, loop cap ──
mkturns_seq() { # $1 sid, $2 transcript, $3 count — ordered unique timestamps
  : > "$2"
  for i in $(seq 1 "$3"); do
    printf '{"type":"user","timestamp":"2026-07-10T%02d:%02d:00Z","message":{"content":"typed human prompt number %s with enough length"}}\n' \
      "$((i / 60))" "$((i % 60))" "$i" >> "$2"
    printf '{"type":"assistant","message":{"content":[{"type":"text","text":"assistant reply number %s here"}]}}\n' "$i" >> "$2"
  done
}
count_llm="$work/count-llm.sh"   # counts invocations, returns valid JSON
calls="$work/llm-calls"
cat > "$count_llm" <<COUNT
#!/usr/bin/env bash
cat > "$work/last-llm-input"
echo x >> "$calls"
printf '{"summary":"chunk summary.","tags":["a","b","c"]}'
COUNT
chmod +x "$count_llm"

# 14. 80-turn dead transcript, one Stop-hook run → 4 chapters (organic cadence
#     replayed), watermark 80, model called exactly 4 times.
sidE="eeeeeeee-0000-0000-0000-00000000000e"; tE="$work/$sidE.jsonl"
mkturns_seq "$sidE" "$tE" 80; : > "$calls"
printf '{"session_id":"%s","transcript_path":"%s"}' "$sidE" "$tE" \
  | CF_SUMMARIZE_FG=1 CF_SUMMARIZE_CMD="$count_llm" CF_SUMMARY_MIN_INTERVAL_S=0 bash "$here/summarize.sh"
assert "$(jq -rs 'map(select(.type=="session-summary")) | length' "$work/$sidE.fleet.jsonl" 2>/dev/null)" "4" "80 turns → 4 chapters in one run"
assert "$(wc -l < "$calls" | tr -d ' ')" "4" "model called once per chunk"
assert "$(cut -d' ' -f1 "$work/$sidE.fleet.state")" "80" "watermark advanced to 80"
# Last chunk's window is turns 61-80 only.
assert "$(grep -c 'prompt number 61 ' "$work/last-llm-input" 2>/dev/null || echo 0)" "1" "final chunk contains turn 61"
assert "$(grep 'prompt number 41 ' "$work/last-llm-input" >/dev/null 2>&1 && echo found || echo absent)" "absent" "final chunk excludes turn 41"

# 15. Windowed timestamps: chapter 2 carries the 2nd chunk's first/last ts,
#     not the whole transcript's.
assert "$(jq -rs 'map(select(.type=="session-summary")) | .[1].fromEventTs' "$work/$sidE.fleet.jsonl")" "2026-07-10T00:21:00Z" "chapter 2 fromEventTs = turn 21"
assert "$(jq -rs 'map(select(.type=="session-summary")) | .[1].toEventTs' "$work/$sidE.fleet.jsonl")" "2026-07-10T00:40:00Z" "chapter 2 toEventTs = turn 40"

# 16. CF_SUMMARY_MAX_CHAPTERS_PER_RUN caps the loop; a second run resumes.
sidF="ffffffff-0000-0000-0000-00000000000f"; tF="$work/$sidF.jsonl"
mkturns_seq "$sidF" "$tF" 80; : > "$calls"
printf '{"session_id":"%s","transcript_path":"%s"}' "$sidF" "$tF" \
  | CF_SUMMARIZE_FG=1 CF_SUMMARIZE_CMD="$count_llm" CF_SUMMARY_MIN_INTERVAL_S=0 CF_SUMMARY_MAX_CHAPTERS_PER_RUN=2 bash "$here/summarize.sh"
assert "$(jq -rs 'map(select(.type=="session-summary")) | length' "$work/$sidF.fleet.jsonl" 2>/dev/null)" "2" "cap stops after 2 chapters"
assert "$(cut -d' ' -f1 "$work/$sidF.fleet.state")" "40" "capped run watermarks at 40"
printf '{"session_id":"%s","transcript_path":"%s"}' "$sidF" "$tF" \
  | CF_SUMMARIZE_FG=1 CF_SUMMARIZE_CMD="$count_llm" CF_SUMMARY_MIN_INTERVAL_S=0 CF_SUMMARY_MAX_CHAPTERS_PER_RUN=2 bash "$here/summarize.sh"
assert "$(jq -rs 'map(select(.type=="session-summary")) | length' "$work/$sidF.fleet.jsonl" 2>/dev/null)" "4" "second run resumes to 4 chapters"
```

- [ ] **Step 2: Run to verify the new cases fail** (existing 1–13 still pass):

```bash
bash docker/runner/summarize.test.sh
```

Expected: cases 14–16 FAIL (e.g. "80 turns → 4 chapters" got '1'), 1–13 ok.

- [ ] **Step 3: Replace `generate_window` with `summarize_next_chunk` in `summary-core.sh`.** Full function (this replaces the Task-1 `generate_window` entirely — nothing else in the file changes):

```bash
# One chapter for the next chunk: turns (last_turns, last_turns+min_turns].
# Only fires when a FULL chunk exists (sub-threshold tails stay unsummarized —
# parity with organic behavior). Claims the watermark BEFORE the model call.
# Returns: 0 chapter generated; 1 no full chunk (nothing claimed);
#          2 chunk claimed but not generated (empty window / model rejected).
summarize_next_chunk() {
  turns="$(count_turns)"
  read_watermark
  new_turns=$((turns - last_turns))
  [ "$new_turns" -ge "$min_turns" ] || return 1
  skip="$last_turns"
  chunk_end=$((skip + min_turns))
  printf '%s %s\n' "$chunk_end" "$(date +%s)" > "$state"

  # Window: entries whose user-turn number n satisfies skip < n <= chunk_end.
  # A user prompt increments the counter then carries the new value; an
  # assistant reply carries the same value as the prompt it follows — so the
  # slice boundary is expressed in user-turn positions and no content from
  # other chapters leaks in. Emits {text, from, to} so the chapter can carry
  # the WINDOW's timestamps (#246 — whole-transcript stamps poisoned Phase 3).
  slice="$(jq -cs --argjson skip "$skip" --argjson upto "$chunk_end" '
    reduce .[] as $e ([[], 0];
      if ($e.type=="user" and ($e.message.content|type)=="string")
      then [ .[0] + [{n: (.[1]+1), e: $e}], .[1]+1 ]
      elif $e.type=="assistant"
      then [ .[0] + [{n: .[1], e: $e}], .[1] ]
      else . end)
    | .[0] | map(select(.n > $skip and .n <= $upto)) | . as $win
    | { text: ($win
        | map(.e
            | if .type=="user" then "USER: " + .message.content
              else "ASSISTANT: " + ([.message.content[]? | select(.type=="text") | .text] | join("\n"))
              end)
        | map(select(length > 10)) | join("\n---\n")),
        from: ([$win[].e.timestamp // empty] | first // ""),
        to:   ([$win[].e.timestamp // empty] | last // "") }' "$tpath" 2>/dev/null)"
  window="$(printf '%s' "$slice" | jq -r '.text // empty' 2>/dev/null | tail -c "$window_chars")"
  from_ts="$(printf '%s' "$slice" | jq -r '.from // empty' 2>/dev/null)"
  to_ts="$(printf '%s' "$slice" | jq -r '.to // empty' 2>/dev/null)"
  [ -n "$window" ] || { report_status empty-window "$(jq -nc --argjson nt "$new_turns" '{newTurns:$nt}' 2>/dev/null || printf '{}')"; return 2; }

  # Gate passed and we have a window — about to call the summarizer model. If
  # this appears with no `generated`/`rejected` after it, the model call itself
  # hung/crashed (the top #230 suspect).
  report_status attempt "$(jq -nc --argjson nt "$min_turns" --arg model "$model" '{newTurns:$nt,model:$model}' 2>/dev/null || printf '{}')"

  prev="$(tail -n 1 "$sidecar" 2>/dev/null | jq -r '.summary // empty' 2>/dev/null)"
  prompt="You summarize a window of an ongoing coding session.
Previously: ${prev:-"(session start)"}
Reply with ONLY strict JSON: {\"summary\":\"<=3 sentences about THIS window\",\"tags\":[\"3-6 lowercase concept tags\"],\"title\":\"<=6 word label for the whole session so far\"}
Window:
$window"

  raw="$(printf '%s' "$prompt" | ${CF_SUMMARIZE_CMD:-claude -p --model "$model"} 2>/dev/null)"
  # Models (esp. haiku) wrap the object in a ```json code fence and may add
  # prose around it. Pull out the object between the first '{' and last '}'.
  json="${raw#"${raw%%\{*}"}"; json="${json%"${json##*\}}"}"
  out="$(printf '%s' "$json" | jq -c 'select((.summary|type)=="string" and (.summary|length)>0 and (.tags|type)=="array") | {summary, tags}' 2>/dev/null)"
  [ -n "$out" ] || {
    echo "summarize: model output rejected" >&2
    report_status rejected "$(jq -nc --argjson len "${#raw}" '{rawLen:$len}' 2>/dev/null || printf '{}')"
    return 2
  }

  printf '%s' "$out" | jq -c --arg sid "$sid" --arg model "$model" --arg f "$from_ts" --arg t "$to_ts" \
    '{type:"session-summary", summary:.summary, tags:.tags, sessionId:$sid, model:$model, fromEventTs:$f, toEventTs:$t}' \
    >> "$sidecar"

  # #170: emit the rolling ai-title so ingestLine's last-write-wins re-titles
  # the tab/left-rail. Optional — absent/blank title just skips the line.
  title="$(printf '%s' "$json" | jq -r 'if (.title|type)=="string" and ((.title|gsub("^\\s+|\\s+$";""))|length)>0 then (.title|gsub("^\\s+|\\s+$";"")) else empty end' 2>/dev/null)"
  if [ -n "$title" ]; then
    jq -nc --arg sid "$sid" --arg title "$title" '{type:"ai-title", aiTitle:$title, sessionId:$sid}' >> "$sidecar"
  fi

  report_status generated "$(printf '%s' "$out" | jq -c --argjson retitled "$([ -n "$title" ] && echo true || echo false)" '{tags:(.tags|length),summaryLen:(.summary|length),retitled:$retitled}' 2>/dev/null || printf '{}')"
  return 0
}
```

- [ ] **Step 4: Update `summarize.sh`'s tail** — replace everything from the `printf '%s %s\n' "$turns" "$now" > "$state"` line to the end with a loop (the gate above it stays; the claim now happens per-chunk inside the core):

```bash
max_chapters="${CF_SUMMARY_MAX_CHAPTERS_PER_RUN:-5}"

# Catch up in real ≤min_turns chapters instead of one tail-capped mega-window
# (#246): a resumed session with an 80-turn backlog gets 4 chapters, not 1.
# Stops on: backlog drained (rc 1), cap reached, or a chunk that attempted but
# didn't generate (rc 2 — likely a broken model; don't burn the rest of the cap).
run_chunks() {
  n=0
  while [ "$n" -lt "$max_chapters" ]; do
    summarize_next_chunk || return 0
    n=$((n+1))
  done
}

if [ -n "${CF_SUMMARIZE_FG:-}" ]; then run_chunks; else
  # cd /tmp: the claude -p run must not write its throwaway transcript into
  # the watched workspace project dir (spec §C known risk).
  ( cd /tmp && run_chunks ) >/dev/null 2>&1 &
fi
exit 0
```

Also DELETE the now-dead `printf '%s %s\n' "$turns" "$now" > "$state"` claim line from `summarize.sh` (the chunk step claims), and delete `generate_window` remnants if any.

- [ ] **Step 5: Run the whole suite:**

```bash
bash docker/runner/summarize.test.sh
```

Expected: `ALL PASS` — all 16 cases. Watch case 5 specifically (garbage model output at 60 turns must leave the sidecar at 2 lines: the rejected chunk returns 2 and stops the loop) and case 6 (interval floor still blocks — the interval gate lives in the hook, unchanged).

- [ ] **Step 6: Commit**

```bash
git add docker/runner/summary-core.sh docker/runner/summarize.sh docker/runner/summarize.test.sh
git commit -m "feat(#246): chunk-bounded chapter windows + windowed timestamps + Stop-hook catch-up loop"
```

---

### Task 3: `backfill-summaries.sh` — the SessionStart sweep

**Files:**
- Create: `docker/runner/backfill-summaries.sh`
- Test: `docker/runner/backfill-summaries.test.sh` (new file, same style as summarize.test.sh)

**Interfaces:**
- Consumes: `summary-core.sh` (`summary_init`, `count_turns`, `read_watermark`, `summarize_next_chunk` rc 0/1/2, `report_status`), the SessionStart hook stdin payload (`{"session_id": "...", "transcript_path": "..."}`).
- Produces: sidecar lines for old sessions (ingested by the existing host watcher — no host changes); `backfill-start` / `backfill-done` breadcrumbs.
- Test seams: `CF_BACKFILL_PROJECTS_DIR` (defaults to `$HOME/.claude/projects`), `CF_BACKFILL_FG=1` (run the sweep in the foreground), plus the core's `CF_SUMMARIZE_CMD` / `CF_SUMMARY_STATUS_SINK`.

- [ ] **Step 1: Write the failing test file `docker/runner/backfill-summaries.test.sh`:**

```bash
#!/usr/bin/env bash
# Tests for backfill-summaries.sh. Run: bash docker/runner/backfill-summaries.test.sh
set -u
here="$(cd "$(dirname "$0")" && pwd)"
fails=0
assert() { if [ "$1" = "$2" ]; then echo "ok: $3"; else echo "FAIL: $3 (got '$1' want '$2')"; fails=$((fails+1)); fi; }

work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
proj="$work/projects"; mkdir -p "$proj/-workspace"
mkturns_seq() { # $1 transcript-path, $2 count
  : > "$1"
  for i in $(seq 1 "$2"); do
    printf '{"type":"user","timestamp":"2026-07-10T%02d:%02d:00Z","message":{"content":"typed human prompt number %s with enough length"}}\n' \
      "$((i / 60))" "$((i % 60))" "$i" >> "$1"
    printf '{"type":"assistant","message":{"content":[{"type":"text","text":"assistant reply number %s here"}]}}\n' "$i" >> "$1"
  done
}
calls="$work/llm-calls"
fake_llm="$work/fake-llm.sh"
cat > "$fake_llm" <<FAKE
#!/usr/bin/env bash
cat >/dev/null
echo x >> "$calls"
printf '{"summary":"backfilled chunk.","tags":["a","b","c"]}'
FAKE
chmod +x "$fake_llm"

cur="11111111-0000-0000-0000-000000000cur"   # the just-started session
old1="22222222-0000-0000-0000-0000000old1"   # 45 turns → 2 chunks + 5-turn tail
old2="33333333-0000-0000-0000-0000000old2"   # 20 turns → 1 chunk
tiny="44444444-0000-0000-0000-0000000tiny"   # 5 turns → never a candidate
mkturns_seq "$proj/-workspace/$cur.jsonl" 30
mkturns_seq "$proj/-workspace/$old1.jsonl" 45
mkturns_seq "$proj/-workspace/$old2.jsonl" 20
mkturns_seq "$proj/-workspace/$tiny.jsonl" 5

run_sweep() { # $* = extra env assignments
  printf '{"session_id":"%s","transcript_path":"%s"}' "$cur" "$proj/-workspace/$cur.jsonl" \
    | env CF_BACKFILL_FG=1 CF_BACKFILL_PROJECTS_DIR="$proj" CF_BACKFILL_DELAY_S=0 \
          CF_SUMMARIZE_CMD="$fake_llm" "$@" bash "$here/backfill-summaries.sh"
}

# 1. Full drain: old1 gets 2 chapters, old2 gets 1; current + tiny untouched.
sink1="$work/sink1"; : > "$calls"
run_sweep CF_SUMMARY_STATUS_SINK="$sink1"
assert "$(jq -rs 'map(select(.type=="session-summary")) | length' "$proj/-workspace/$old1.fleet.jsonl" 2>/dev/null)" "2" "old1 drained to 2 chapters"
assert "$(jq -rs 'map(select(.type=="session-summary")) | length' "$proj/-workspace/$old2.fleet.jsonl" 2>/dev/null)" "1" "old2 drained to 1 chapter"
assert "$([ -f "$proj/-workspace/$cur.fleet.jsonl" ] && echo yes || echo no)" "no" "just-started session skipped"
assert "$([ -f "$proj/-workspace/$tiny.fleet.jsonl" ] && echo yes || echo no)" "no" "sub-threshold transcript never a candidate"
assert "$(wc -l < "$calls" | tr -d ' ')" "3" "exactly 3 model calls"
# Breadcrumbs: backfill-start reports 2 candidates; backfill-done reports 3 generated, 0 remaining.
assert "$(jq -r 'select(.params.arguments.phase=="backfill-start") | .params.arguments.detail.candidates' "$sink1")" "2" "backfill-start counts candidates"
assert "$(jq -r 'select(.params.arguments.phase=="backfill-done") | .params.arguments.detail.generated' "$sink1")" "3" "backfill-done counts generated"
assert "$(jq -r 'select(.params.arguments.phase=="backfill-done") | .params.arguments.detail.remaining' "$sink1")" "0" "backfill-done remaining=0 after full drain"

# 2. Idempotent: a second sweep generates nothing new.
: > "$calls"; run_sweep
assert "$(wc -l < "$calls" | tr -d ' ')" "0" "second sweep is a no-op"

# 3. Budget: fresh fixture, budget 2 → stops mid-backlog; next sweep resumes.
rm -f "$proj/-workspace/"*.fleet.jsonl "$proj/-workspace/"*.fleet.state
sink3="$work/sink3"; : > "$calls"
run_sweep CF_BACKFILL_MAX_PER_SWEEP=2 CF_SUMMARY_STATUS_SINK="$sink3"
assert "$(wc -l < "$calls" | tr -d ' ')" "2" "budget caps the sweep at 2 chapters"
assert "$(jq -r 'select(.params.arguments.phase=="backfill-done") | .params.arguments.detail.remaining' "$sink3")" "1" "budget-exhausted sweep reports remaining>0"
: > "$calls"; run_sweep CF_BACKFILL_MAX_PER_SWEEP=10
assert "$(wc -l < "$calls" | tr -d ' ')" "1" "next sweep drains the remaining chunk"

# 4. Kill switch: CF_BACKFILL=0 does nothing, reports nothing.
rm -f "$proj/-workspace/"*.fleet.jsonl "$proj/-workspace/"*.fleet.state
sink4="$work/sink4"; : > "$calls"
run_sweep CF_BACKFILL=0 CF_SUMMARY_STATUS_SINK="$sink4"
assert "$(wc -l < "$calls" | tr -d ' ')" "0" "kill switch stops the sweep"
assert "$([ -s "$sink4" ] && echo nonempty || echo empty)" "empty" "kill switch emits no breadcrumbs"

# 5. Broken model: rc-2 chunk ends the sweep (no call-burning), watermark advanced.
rm -f "$proj/-workspace/"*.fleet.jsonl "$proj/-workspace/"*.fleet.state
bad_llm="$work/bad-llm.sh"
printf '#!/usr/bin/env bash\ncat >/dev/null; printf %s '\''no json'\''\n' > "$bad_llm"; chmod +x "$bad_llm"
: > "$calls"
printf '{"session_id":"%s","transcript_path":"%s"}' "$cur" "$proj/-workspace/$cur.jsonl" \
  | env CF_BACKFILL_FG=1 CF_BACKFILL_PROJECTS_DIR="$proj" CF_BACKFILL_DELAY_S=0 \
        CF_SUMMARIZE_CMD="$bad_llm" bash "$here/backfill-summaries.sh"
assert "$([ -f "$proj/-workspace/$old1.fleet.jsonl" ] || [ -f "$proj/-workspace/$old2.fleet.jsonl" ] && echo yes || echo no)" "no" "broken model produces no chapters"

# 6. Lock: a held lock makes the sweep a no-op.
rm -f "$proj/-workspace/"*.fleet.state
mkdir "$work/lockdir"
: > "$calls"
run_sweep CF_BACKFILL_LOCK_DIR="$work/lockdir"   # pre-existing dir = lock held
assert "$(wc -l < "$calls" | tr -d ' ')" "0" "held lock skips the sweep"

[ "$fails" -eq 0 ] && echo "ALL PASS" || exit 1
```

- [ ] **Step 2: Run to verify it fails:**

```bash
bash docker/runner/backfill-summaries.test.sh
```

Expected: FAIL — `backfill-summaries.sh: No such file or directory`.

- [ ] **Step 3: Write `docker/runner/backfill-summaries.sh`:**

```bash
#!/usr/bin/env bash
# Claude Code hook: chapter-summary backfill sweep (#246). On SessionStart,
# scan this workspace's transcripts for sessions with unsummarized backlog
# (ended before the pipeline worked — wrong image, pre-Phase-2, #230) and
# drain them in organic-cadence chunks via summary-core.sh, under a per-sweep
# budget. The just-started session is skipped: the Stop hook owns it. Sidecar
# output is ingested by the existing host watcher — this script only writes
# <uuid>.fleet.jsonl lines. Fire-and-forget; always exit 0.
set -u
payload="$(cat)"
current_sid="$(printf '%s' "$payload" | jq -r '.session_id // empty' 2>/dev/null)"
[ "${CF_BACKFILL:-1}" != "0" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

. "$(dirname "$0")/summary-core.sh"

budget="${CF_BACKFILL_MAX_PER_SWEEP:-10}"
delay="${CF_BACKFILL_DELAY_S:-3}"
proj="${CF_BACKFILL_PROJECTS_DIR:-$HOME/.claude/projects}"
lock="${CF_BACKFILL_LOCK_DIR:-/tmp/cf-backfill.lock}"

sweep() {
  # mkdir is the portable atomic lock (flock isn't guaranteed in slim images).
  # A sweep should never live long; a lock dir older than an hour is a crash
  # leftover — steal it.
  if ! mkdir "$lock" 2>/dev/null; then
    now="$(date +%s)"
    lock_ts="$(stat -c %Y "$lock" 2>/dev/null || echo "$now")"
    [ $((now - lock_ts)) -gt 3600 ] || return 0
    rm -rf "$lock" 2>/dev/null
    mkdir "$lock" 2>/dev/null || return 0
  fi
  trap 'rmdir "$lock" 2>/dev/null' RETURN

  # Pass 1: find candidates (backlog ≥ one full chunk), newest-active first.
  candidates=""
  n_candidates=0
  backlog_turns=0
  for tpath in $(ls -t "$proj"/*/*.jsonl 2>/dev/null); do
    case "$tpath" in *.fleet.jsonl) continue ;; esac
    sid="$(basename "$tpath" .jsonl)"
    [ "$sid" = "$current_sid" ] && continue
    summary_init
    turns="$(count_turns)"
    read_watermark
    backlog=$((turns - last_turns))
    [ "$backlog" -ge "$min_turns" ] || continue
    candidates="$candidates $tpath"
    n_candidates=$((n_candidates + 1))
    backlog_turns=$((backlog_turns + backlog))
  done
  [ "$n_candidates" -gt 0 ] || return 0

  sid="$current_sid" report_status backfill-start \
    "$(jq -nc --argjson c "$n_candidates" --argjson bt "$backlog_turns" '{candidates:$c,backlogTurns:$bt}' 2>/dev/null || printf '{}')"

  # Pass 2: drain under the global budget. rc 2 (attempted, not generated)
  # ends the whole sweep — a broken model must not burn the rest of the budget.
  generated=0
  aborted=0
  for tpath in $candidates; do
    sid="$(basename "$tpath" .jsonl)"
    summary_init
    while [ "$generated" -lt "$budget" ]; do
      summarize_next_chunk; rc=$?
      [ "$rc" -eq 1 ] && break
      [ "$rc" -eq 2 ] && { aborted=1; break; }
      generated=$((generated + 1))
      [ "$generated" -lt "$budget" ] && sleep "$delay"
    done
    [ "$generated" -ge "$budget" ] && break
    [ "$aborted" -eq 1 ] && break
  done

  # Remaining = candidates that still hold a full-chunk backlog.
  remaining=0
  for tpath in $candidates; do
    sid="$(basename "$tpath" .jsonl)"
    summary_init
    turns="$(count_turns)"
    read_watermark
    [ $((turns - last_turns)) -ge "$min_turns" ] && remaining=$((remaining + 1))
  done
  sid="$current_sid" report_status backfill-done \
    "$(jq -nc --argjson g "$generated" --argjson r "$remaining" --argjson b "$budget" '{generated:$g,remaining:$r,budget:$b}' 2>/dev/null || printf '{}')"
}

if [ -n "${CF_BACKFILL_FG:-}" ]; then sweep; else
  # cd /tmp: nested claude -p transcripts must not land in a watched dir.
  ( cd /tmp && sweep ) >/dev/null 2>&1 &
fi
exit 0
```

- [ ] **Step 4: Run both shell suites:**

```bash
bash docker/runner/backfill-summaries.test.sh && bash docker/runner/summarize.test.sh
```

Expected: `ALL PASS` twice. Note for test 1: `sid=... report_status` env-prefix works because `report_status` is a function — bash applies the assignment to the function's environment; if the sink assertions fail with the wrong sessionId, switch the two call sites to `save_sid="$sid"; sid="$current_sid"; report_status ...; sid="$save_sid"`.

- [ ] **Step 5: Commit**

```bash
git add docker/runner/backfill-summaries.sh docker/runner/backfill-summaries.test.sh
git commit -m "feat(#246): SessionStart backfill sweep — drain unsummarized transcripts under budget"
```

---

### Task 4: Wire the sweep into the image (hooks.settings.json + Dockerfile)

**Files:**
- Modify: `docker/runner/hooks.settings.json` (SessionStart gains the sweep)
- Modify: `docker/Dockerfile:73-80` (COPY + chmod the two new scripts)

**Interfaces:**
- Consumes: Task 3's `backfill-summaries.sh`, Task 1's `summary-core.sh`.
- Produces: a runner image where every claude launch (all launches pass `--settings /usr/local/lib/claude-fleet/hooks.settings.json`) runs the sweep on SessionStart. The devops image builds `FROM` the base and inherits automatically. `.dockerignore` already opts in `!docker/runner/**` — no change there.

- [ ] **Step 1: Edit `docker/runner/hooks.settings.json`** — replace the `SessionStart` entry:

```json
    "SessionStart": [
      { "hooks": [
        { "type": "command", "command": "/usr/local/lib/claude-fleet/session-report.sh" },
        { "type": "command", "command": "/usr/local/lib/claude-fleet/backfill-summaries.sh" }
      ] }
    ],
```

(session-report.sh stays first: mapping ground truth must land even if the sweep misbehaves.)

- [ ] **Step 2: Edit `docker/Dockerfile`** — in the runner-assets block (currently lines 73–80), add the two new COPYs and chmods alongside the existing ones:

```dockerfile
COPY docker/runner/summary-core.sh /usr/local/lib/claude-fleet/summary-core.sh
COPY docker/runner/backfill-summaries.sh /usr/local/lib/claude-fleet/backfill-summaries.sh
```

and extend the chmod chain:

```dockerfile
 && chmod 0755 /usr/local/lib/claude-fleet/summary-core.sh \
 && chmod 0755 /usr/local/lib/claude-fleet/backfill-summaries.sh \
```

- [ ] **Step 3: Validate the JSON and (if docker is available) the build:**

```bash
jq . docker/runner/hooks.settings.json >/dev/null && echo "hooks.settings.json valid"
docker build -f docker/Dockerfile -t cf-runner-test . 2>&1 | tail -3 || echo "no docker here — the pre-merge test-runner-images.yml workflow builds it in CI"
```

Expected: `hooks.settings.json valid`; the image build succeeds locally or is deferred to CI (the `test-runner-images.yml` pre-merge gate builds base+dev without pushing, which catches a missing COPY source — the exact failure mode SPEC §image build-context warns about).

- [ ] **Step 4: Commit**

```bash
git add docker/runner/hooks.settings.json docker/Dockerfile
git commit -m "feat(#246): register backfill sweep on SessionStart + ship core/sweep in the runner image"
```

---

### Task 5: Host `get_config` surfaces the backfill tunables

**Files:**
- Modify: `src/main/config.ts:258-271` (`resolveWorkspaceConfig` type + object)
- Modify: `src/main/mcpServer.ts:1328-1334` (get_config description mentions backfill)
- Test: `src/main/config.test.ts:208-230`

**Interfaces:**
- Consumes: workspace `env.plain` (the same map that already feeds `CF_SUMMARY_*`; env vars set in the app's env editor flow to the container at create — no new injection plumbing exists or is needed).
- Produces: `get_config` payload gains `summarizer.maxChaptersPerRun: number` and `backfill: { enabled: boolean; maxPerSweep: number; delayS: number }`.

- [ ] **Step 1: Extend the existing test expectations in `src/main/config.test.ts`.** In the test at line 208 (`reports the live app version alongside the summarizer defaults`), change the expected object to:

```typescript
      summarizer: { model: 'haiku', minNewTurns: 20, minIntervalS: 120, windowChars: 8000, maxChaptersPerRun: 5 },
      backfill: { enabled: true, maxPerSweep: 10, delayS: 3 }
```

In the env-override test at line 223, extend the input env with `CF_BACKFILL: '0', CF_BACKFILL_MAX_PER_SWEEP: '4', CF_SUMMARY_MAX_CHAPTERS_PER_RUN: 'garbage'` and assert:

```typescript
    expect(out.summarizer).toEqual({ model: 'sonnet', minNewTurns: 5, minIntervalS: 120, windowChars: 8000, maxChaptersPerRun: 5 });
    expect(out.backfill).toEqual({ enabled: false, maxPerSweep: 4, delayS: 3 });
```

- [ ] **Step 2: Run to verify it fails:**

```bash
npx vitest run src/main/config.test.ts
```

Expected: FAIL — received object lacks `maxChaptersPerRun` / `backfill`.

- [ ] **Step 3: Implement in `src/main/config.ts`.** Extend the return type and object of `resolveWorkspaceConfig`:

```typescript
  summarizer: { model: string; minNewTurns: number; minIntervalS: number; windowChars: number; maxChaptersPerRun: number };
  backfill: { enabled: boolean; maxPerSweep: number; delayS: number };
```

```typescript
    summarizer: {
      model: typeof env.CF_SUMMARY_MODEL === 'string' ? env.CF_SUMMARY_MODEL : 'haiku',
      minNewTurns: num(env.CF_SUMMARY_MIN_NEW_TURNS, 20),
      minIntervalS: num(env.CF_SUMMARY_MIN_INTERVAL_S, 120),
      windowChars: num(env.CF_SUMMARY_WINDOW_CHARS, 8000),
      maxChaptersPerRun: num(env.CF_SUMMARY_MAX_CHAPTERS_PER_RUN, 5)
    },
    backfill: {
      enabled: env.CF_BACKFILL !== '0',
      maxPerSweep: num(env.CF_BACKFILL_MAX_PER_SWEEP, 10),
      delayS: num(env.CF_BACKFILL_DELAY_S, 3)
    }
```

- [ ] **Step 4: Update the `get_config` tool description in `src/main/mcpServer.ts`** — in the description string starting at line 1328, change the opening clause to:

```
'Effective fleet tunables for this workspace (summarizer model/debounce/window/chapter-cap and backfill sweep budget, app defaults ' +
```

(rest of the description unchanged).

- [ ] **Step 5: Run the affected suites:**

```bash
npx vitest run src/main/config.test.ts src/main/mcpServer.test.ts && npm run typecheck
```

Expected: PASS + clean typecheck. (`mcpServer.test.ts`'s get_config test injects its own resolver, so it pins wiring, not shape — it must stay green untouched. The e2e `tests/mcp-server.spec.ts` asserts tool *names* and `app.version` only; no e2e change needed.)

- [ ] **Step 6: Commit**

```bash
git add src/main/config.ts src/main/config.test.ts src/main/mcpServer.ts
git commit -m "feat(#246): get_config surfaces backfill sweep + chapter-cap tunables"
```

---

### Task 6: SPEC.md updates

**Files:**
- Modify: `docs/SPEC.md` — the runner-hooks block (§4, lines ~66-78), the fleet-state tools list (§11, lines ~1141-1144).

Required by `.claude/rules/spec-maintenance.md`; the branch squash-merges, so these land in the same commit as the behavior change.

- [ ] **Step 1: §4 runner scripts list (line ~67-68):** add after the `summarize.sh` bullet:

```markdown
- **`summary-core.sh`** — sourced library holding the shared chapter-generation core (`summarize_next_chunk`): chunk-bounded window slicing, watermark claim, model call, strict-JSON validation, sidecar append, breadcrumbs. Sourced by `summarize.sh` and `backfill-summaries.sh` so the live and backfill paths share one windowing implementation (#246).
- **`backfill-summaries.sh`** — `SessionStart` hook; sweeps the workspace's transcripts for sessions with ≥ `CF_SUMMARY_MIN_NEW_TURNS` unsummarized turns past their watermark (sessions that ended before the pipeline worked) and drains them in organic-cadence chunks under a per-sweep budget. See *Backfill sweep* below.
```

and update the complete-registrations sentence (both occurrences, lines ~68 and ~78) so SessionStart reads `SessionStart` → `session-report.sh` + `backfill-summaries.sh`.

- [ ] **Step 2: §4 Session-summary hook paragraph (line ~72):** amend to describe chunking. Replace the sentence describing the window ("When both conditions hold, the hook extracts the *window since the last chapter* (capped to `CF_SUMMARY_WINDOW_CHARS` chars)…") with:

```markdown
When both conditions hold, the hook catches up in **chunks**: each iteration summarizes only the next `CF_SUMMARY_MIN_NEW_TURNS` turns past the watermark (window text capped to `CF_SUMMARY_WINDOW_CHARS` chars), claims the watermark at the chunk boundary *before* the model call, and repeats — up to `CF_SUMMARY_MAX_CHAPTERS_PER_RUN` chapters per run (default 5) — so a resumed session with a large backlog gets real chapters instead of one tail-truncated mega-window (#246). `fromEventTs`/`toEventTs` on each chapter are the **window's** first/last transcript timestamps (previously the whole transcript's — which gave every chapter identical stamps and would have poisoned Phase-3 decay scoring). A chunk that attempts but fails to generate (rejected output / empty window) ends the run; its turns are not retried (claim-first semantics, unchanged).
```

- [ ] **Step 3: §4 add a *Backfill sweep* paragraph after the Diagnostics paragraph (~line 74):**

```markdown
**Backfill sweep (`backfill-summaries.sh`, #246).** Chapter generation historically required a live `Stop` hook, so sessions that ended while the pipeline was broken (or predate it) stayed unsummarized forever. On `SessionStart` the sweep backgrounds itself immediately (never delays the session), takes a `mkdir` lock (`/tmp/cf-backfill.lock`, stolen if older than an hour) so multi-tab wakes don't double-scan, and scans every `~/.claude/projects/*/​*.jsonl` (skipping `*.fleet.jsonl` sidecars and the just-started session — the Stop hook owns that one), newest-mtime first. Transcripts with at least one full chunk of unsummarized turns are drained via the same `summarize_next_chunk` core, under a global per-sweep budget: `CF_BACKFILL_MAX_PER_SWEEP` chapters (default 10) with `CF_BACKFILL_DELAY_S` seconds between model calls (default 3); the backlog finishes draining across subsequent wakes. `CF_BACKFILL=0` disables the sweep. Backfilled chapters are indistinguishable from organic ones (same cadence, tags, rolling `ai-title` — old sessions get retro-titled) and reach the DB through the normal sidecar-watcher path, which ingests idempotently. Sub-threshold tails stay unsummarized (organic parity) and covered turns are never re-summarized. Two always-on breadcrumbs frame each sweep: `backfill-start` `{candidates, backlogTurns}` and `backfill-done` `{generated, remaining, budget}`, attributed to the triggering session.
```

- [ ] **Step 4: §4 Tunables paragraph (line ~76):** append to the list:

```markdown
`CF_SUMMARY_MAX_CHAPTERS_PER_RUN` (default `5`), `CF_BACKFILL` (default on; `0` disables), `CF_BACKFILL_MAX_PER_SWEEP` (default `10`), `CF_BACKFILL_DELAY_S` (default `3`).
```

- [ ] **Step 5: §11 tool list:** at line ~1142 (`report_summary_status`), extend the phase enumeration with `backfill-start` and `backfill-done` (both `info`). At line ~1144 (`get_config`), update the shape to `summarizer: { model, minNewTurns, minIntervalS, windowChars, maxChaptersPerRun }` and add `backfill: { enabled, maxPerSweep, delayS }` with the same env-override note (`CF_BACKFILL*`, `CF_SUMMARY_MAX_CHAPTERS_PER_RUN`).

- [ ] **Step 6: Commit**

```bash
git add docs/SPEC.md
git commit -m "docs(#246): SPEC — backfill sweep, chunked summarizer, new tunables + breadcrumbs"
```

---

### Task 7: Full gate, PR, live verification plan

**Files:** none (verification + PR).

- [ ] **Step 1: Run everything that runs in this container:**

```bash
bash docker/runner/summarize.test.sh
bash docker/runner/backfill-summaries.test.sh
npx vitest run src/main/config.test.ts src/main/mcpServer.test.ts
npm run typecheck
```

Expected: all pass. (Full `npm test` needs a build + display for Playwright; CI covers it, along with the runner-image build gate.)

- [ ] **Step 2: Push and open the PR:**

```bash
git push -u origin worktree-summary-backfill-spec
gh pr create --head worktree-summary-backfill-spec --base main \
  --title "feat: chapter-summary backfill — chunked summarization + session-start sweep (#246)" \
  --body "Implements #246 per docs/superpowers/specs/2026-07-31-summary-backfill-design.md. Closes #246.
- summary-core.sh: shared chunk-bounded generation (fixes resume mega-window + whole-transcript fromEventTs/toEventTs)
- summarize.sh: thin catch-up loop, CF_SUMMARY_MAX_CHAPTERS_PER_RUN cap
- backfill-summaries.sh: SessionStart sweep, budget + lock + kill switch, backfill-start/done breadcrumbs
- get_config: backfill + chapter-cap tunables; SPEC updated in-branch (squash-merge = same commit)

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

- [ ] **Step 3: Post-merge live verification (manual, after image republish + workspace recreate):** confirm in this manager workspace that (a) `list_errors type=summary-backfill-start` shows a sweep on next session start, (b) chapters appear for old sessions (`query`: `SELECT session_id, COUNT(*) FROM session_summaries GROUP BY session_id`), (c) `search_transcripts kind=summary` returns the new chapters, (d) the ~25-session backlog drains at ≤10 chapters per wake across a few wakes.

---

## Self-Review Notes

- **Spec coverage:** core/chunking (§A → Tasks 1-2), Stop-hook loop (§B → Task 2), sweep with budget/lock/kill switch/breadcrumbs (§C → Task 3), deliberate non-goals (§D → encoded as tests: sub-threshold, idempotency), host config + SPEC (§E → Tasks 5-6), env table (§F → Global Constraints + Tasks 3/5), testing incl. live verification (§G → Tasks 2/3/7). No gaps found.
- **Type consistency:** `summarize_next_chunk` rc contract (0/1/2) defined in Task 2, consumed identically in Task 3. `maxChaptersPerRun`/`backfill` field names match between config.ts and config.test.ts. Breadcrumb phase strings (`backfill-start`/`backfill-done`) match between script, tests, and SPEC text.
- **Known judgment calls encoded above:** rc-2 ends a whole run/sweep (don't burn budget on a broken model); `mkdir` lock instead of `flock` (not guaranteed in slim images); two-pass sweep for accurate candidate counts.
