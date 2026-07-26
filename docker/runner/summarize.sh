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

# Diagnostic breadcrumb (#230). The summarizer used to fail into /dev/null, so a
# dead #207 pipeline was invisible. Report each decision point to the fleet-state
# MCP server (same socket/token path as session-report.sh); the host lands it in
# the errors table (reachable via list_errors). Fire-and-forget — a reporting
# failure never blocks or fails the hook. $1 = phase, $2 = compact JSON detail.
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

# Completed turns = typed human prompts (string content). Tool results are
# content ARRAYS and don't count; Stop firing means the reply completed.
turns="$(jq -rs '[.[] | select(.type=="user" and (.message.content|type)=="string")] | length' "$tpath" 2>/dev/null || echo 0)"

last_turns=0; last_run=0
[ -f "$state" ] && read -r last_turns last_run < "$state"
now="$(date +%s)"
new_turns=$((turns - last_turns))
if [ "$new_turns" -lt "$min_turns" ]; then
  # Below threshold — the common, healthy case. Opt-in only (CF_SUMMARY_DIAG),
  # since it fires on most Stops: this is what reveals a turn-count that never
  # climbs (e.g. jq under-counting a real transcript in-container, #230).
  [ -n "${CF_SUMMARY_DIAG:-}" ] && report_status gate \
    "$(jq -nc --argjson t "$turns" --argjson nt "$new_turns" --argjson mt "$min_turns" \
      '{turns:$t,newTurns:$nt,minTurns:$mt}' 2>/dev/null || printf '{}')"
  exit 0
fi
[ $((now - last_run)) -ge "$min_interval" ] || exit 0

# Claim the window immediately (before the slow LLM call) so a Stop firing
# mid-generation doesn't double-summarize the same turns.
printf '%s %s\n' "$turns" "$now" > "$state"

generate() {
  # Window: text of entries whose user-turn number > last_turns.
  # Rule: a user prompt increments the counter then carries that new value;
  # an assistant reply carries the same value as the user prompt it follows
  # (i.e. it belongs to that turn). Entries with turn number > $skip are in
  # the new window. This ensures the slice boundary is expressed in user-turn
  # positions, not mixed-entry positions, so no content from previous chapters
  # leaks into the current window.
  window="$(jq -rs --argjson skip "$last_turns" '
    reduce .[] as $e ([[], 0];
      if ($e.type=="user" and ($e.message.content|type)=="string")
      then [ .[0] + [{n: (.[1]+1), e: $e}], .[1]+1 ]
      elif $e.type=="assistant"
      then [ .[0] + [{n: .[1], e: $e}], .[1] ]
      else . end)
    | .[0]
    | map(select(.n > $skip))
    | map(.e
        | if .type=="user" then "USER: " + .message.content
          else "ASSISTANT: " + ([.message.content[]? | select(.type=="text") | .text] | join("\n"))
          end)
    | map(select(length > 10))
    | join("\n---\n")' "$tpath" 2>/dev/null | tail -c "$window_chars")"
  [ -n "$window" ] || { report_status empty-window "$(jq -nc --argjson nt "$new_turns" '{newTurns:$nt}' 2>/dev/null || printf '{}')"; return 0; }

  # Gate passed and we have a window — about to call the summarizer model. If
  # this signal appears but neither `generated` nor `rejected` follows, the
  # model call itself hung/crashed (the top #230 suspect).
  report_status attempt "$(jq -nc --argjson nt "$new_turns" --arg model "$model" '{newTurns:$nt,model:$model}' 2>/dev/null || printf '{}')"

  prev="$(tail -n 1 "$sidecar" 2>/dev/null | jq -r '.summary // empty' 2>/dev/null)"
  prompt="You summarize a window of an ongoing coding session.
Previously: ${prev:-"(session start)"}
Reply with ONLY strict JSON: {\"summary\":\"<=3 sentences about THIS window\",\"tags\":[\"3-6 lowercase concept tags\"]}
Window:
$window"

  raw="$(printf '%s' "$prompt" | ${CF_SUMMARIZE_CMD:-claude -p --model "$model"} 2>/dev/null)"
  # Models (esp. haiku) wrap the object in a ```json code fence and may add
  # prose around it. Pull out the object between the first '{' and last '}'
  # before validating — the summary JSON has no nested objects, so this is
  # unambiguous. No braces at all → empty → rejected below.
  json="${raw#"${raw%%\{*}"}"; json="${json%"${json##*\}}"}"
  # Strict validation: must parse, must have non-empty summary + tags array.
  out="$(printf '%s' "$json" | jq -c 'select((.summary|type)=="string" and (.summary|length)>0 and (.tags|type)=="array") | {summary, tags}' 2>/dev/null)"
  [ -n "$out" ] || {
    echo "summarize: model output rejected" >&2
    # Distinguish "model returned nothing" from "returned unparseable text".
    report_status rejected "$(jq -nc --argjson len "${#raw}" '{rawLen:$len}' 2>/dev/null || printf '{}')"
    return 0
  }

  from_ts="$(jq -rs '[.[] | .timestamp // empty] | first // empty' "$tpath" 2>/dev/null)"
  to_ts="$(jq -rs '[.[] | .timestamp // empty] | last // empty' "$tpath" 2>/dev/null)"
  printf '%s' "$out" | jq -c --arg sid "$sid" --arg model "$model" --arg f "$from_ts" --arg t "$to_ts" \
    '{type:"session-summary", summary:.summary, tags:.tags, sessionId:$sid, model:$model, fromEventTs:$f, toEventTs:$t}' \
    >> "$sidecar"
  # Chapter written to the sidecar. If this appears but no chapter lands in the
  # DB, the failure is in sidecar ingestion, not generation (#230).
  report_status generated "$(printf '%s' "$out" | jq -c '{tags:(.tags|length),summaryLen:(.summary|length)}' 2>/dev/null || printf '{}')"
}

if [ -n "${CF_SUMMARIZE_FG:-}" ]; then generate; else
  # cd /tmp: the claude -p run must not write its throwaway transcript into
  # the watched workspace project dir (spec §C known risk).
  ( cd /tmp && generate ) >/dev/null 2>&1 &
fi
exit 0
