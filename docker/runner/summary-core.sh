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
