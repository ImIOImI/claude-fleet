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
          CF_SUMMARIZE_CMD="$fake_llm" CF_BACKFILL_LOCK_DIR="$work/lock" "$@" bash "$here/backfill-summaries.sh"
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
        CF_SUMMARIZE_CMD="$bad_llm" CF_BACKFILL_LOCK_DIR="$work/lock" bash "$here/backfill-summaries.sh"
assert "$([ -f "$proj/-workspace/$old1.fleet.jsonl" ] || [ -f "$proj/-workspace/$old2.fleet.jsonl" ] && echo yes || echo no)" "no" "broken model produces no chapters"

# 6. Lock: a held lock makes the sweep a no-op.
rm -f "$proj/-workspace/"*.fleet.state
mkdir "$work/lockdir"
: > "$calls"
run_sweep CF_BACKFILL_LOCK_DIR="$work/lockdir"   # pre-existing dir = lock held
assert "$(wc -l < "$calls" | tr -d ' ')" "0" "held lock skips the sweep"

[ "$fails" -eq 0 ] && echo "ALL PASS" || exit 1
