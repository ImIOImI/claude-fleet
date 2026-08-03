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
