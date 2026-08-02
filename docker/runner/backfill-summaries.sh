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
