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
llm_input="$work/llm-input"
# Note: heredoc uses double-quote delimiter so $llm_input expands at write time.
cat > "$fake_llm" <<FAKE
#!/usr/bin/env bash
cat > "$llm_input"
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

# 4b. Second chapter window contains turns from new window only (turn 25 is in
#     window; turn 5 was in the first chapter and must NOT appear).
assert "$(grep -c 'prompt number 25' "$work/llm-input" 2>/dev/null || echo 0)" "1" "second chapter contains turn 25"
assert "$(grep 'prompt number 5 ' "$work/llm-input" >/dev/null 2>&1 && echo found || echo absent)" "absent" "second chapter excludes turn 5"

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
