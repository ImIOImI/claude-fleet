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

# 7. Fenced JSON output: models (esp. haiku) wrap the object in a ```json code
#    fence and may add prose. It must still be accepted. Isolated sid/transcript
#    so it doesn't inherit the accumulated state above.
t2="$work/ffffffff-1111-2222-3333-444444444444.jsonl"
sid2="ffffffff-1111-2222-3333-444444444444"
: > "$t2"
for i in $(seq 1 20); do
  printf '{"type":"user","timestamp":"2026-07-10T00:00:00Z","message":{"content":"typed human prompt number %s with enough length"}}\n' "$i" >> "$t2"
  printf '{"type":"assistant","message":{"content":[{"type":"text","text":"assistant reply number %s here"}]}}\n' "$i" >> "$t2"
done
cat > "$fake_llm" <<'FAKE'
#!/usr/bin/env bash
cat >/dev/null
printf 'Here is the summary:\n```json\n{"summary":"Wrapped in a code fence.","tags":["fence","json","markdown"]}\n```\n'
FAKE
printf '{"session_id":"%s","transcript_path":"%s"}' "$sid2" "$t2" \
  | CF_SUMMARIZE_FG=1 CF_SUMMARIZE_CMD="$fake_llm" CF_SUMMARY_MIN_INTERVAL_S=0 bash "$here/summarize.sh"
assert "$(jq -r '.type' "$work/$sid2.fleet.jsonl" 2>/dev/null)" "session-summary" "fenced JSON output accepted"
assert "$(jq -r '.tags | length' "$work/$sid2.fleet.jsonl" 2>/dev/null)" "3" "fenced JSON tags parsed"

# ── #230 diagnostics: report_status emits to the MCP sink at each decision point ──
phases() { jq -r '.params.arguments.phase' "$1" 2>/dev/null | tr '\n' ',' ; }
mkturns_iso() { # $1 sid, $2 transcript, $3 count — isolated fixture
  : > "$2"
  for i in $(seq 1 "$3"); do
    printf '{"type":"user","timestamp":"2026-07-10T00:00:00Z","message":{"content":"typed human prompt number %s with enough length"}}\n' "$i" >> "$2"
    printf '{"type":"assistant","message":{"content":[{"type":"text","text":"assistant reply %s"}]}}\n' "$i" >> "$2"
  done
}

# 8. Success path emits attempt → generated (and NOT rejected).
ok_llm="$work/ok-llm.sh"
printf '#!/usr/bin/env bash\ncat >/dev/null; printf %s '\''{"summary":"did stuff.","tags":["a","b","c"]}'\''\n' > "$ok_llm"; chmod +x "$ok_llm"
sid8="88888888-0000-0000-0000-000000000008"; t8="$work/$sid8.jsonl"; sink8="$work/sink8"
mkturns_iso "$sid8" "$t8" 20
printf '{"session_id":"%s","transcript_path":"%s"}' "$sid8" "$t8" \
  | CF_SUMMARIZE_FG=1 CF_SUMMARIZE_CMD="$ok_llm" CF_SUMMARY_MIN_INTERVAL_S=0 CF_SUMMARY_STATUS_SINK="$sink8" bash "$here/summarize.sh"
assert "$(phases "$sink8")" "attempt,generated," "success path reports attempt then generated"

# 9. Rejected model output emits attempt → rejected (the top #230 suspect signal).
bad_llm="$work/bad-llm.sh"
printf '#!/usr/bin/env bash\ncat >/dev/null; printf %s '\''sorry, no json here'\''\n' > "$bad_llm"; chmod +x "$bad_llm"
sid9="99999999-0000-0000-0000-000000000009"; t9="$work/$sid9.jsonl"; sink9="$work/sink9"
mkturns_iso "$sid9" "$t9" 20
printf '{"session_id":"%s","transcript_path":"%s"}' "$sid9" "$t9" \
  | CF_SUMMARIZE_FG=1 CF_SUMMARIZE_CMD="$bad_llm" CF_SUMMARY_MIN_INTERVAL_S=0 CF_SUMMARY_STATUS_SINK="$sink9" bash "$here/summarize.sh"
assert "$(phases "$sink9")" "attempt,rejected," "rejected path reports attempt then rejected"

# 10. Below threshold with CF_SUMMARY_DIAG=1 emits a gate tick carrying the count.
sidA="aaaaaaaa-0000-0000-0000-00000000000a"; tA="$work/$sidA.jsonl"; sinkA="$work/sinkA"
mkturns_iso "$sidA" "$tA" 5
printf '{"session_id":"%s","transcript_path":"%s"}' "$sidA" "$tA" \
  | CF_SUMMARIZE_FG=1 CF_SUMMARY_DIAG=1 CF_SUMMARY_STATUS_SINK="$sinkA" bash "$here/summarize.sh"
assert "$(phases "$sinkA")" "gate," "below-threshold + diag reports a gate tick"
assert "$(jq -r '.params.arguments.detail.turns' "$sinkA" 2>/dev/null)" "5" "gate tick carries the turn count"

# 11. Below threshold WITHOUT diag stays silent (no spam on the common path).
sidB="bbbbbbbb-0000-0000-0000-00000000000b"; tB="$work/$sidB.jsonl"; sinkB="$work/sinkB"
mkturns_iso "$sidB" "$tB" 5
printf '{"session_id":"%s","transcript_path":"%s"}' "$sidB" "$tB" \
  | CF_SUMMARIZE_FG=1 CF_SUMMARY_STATUS_SINK="$sinkB" bash "$here/summarize.sh"
assert "$([ -s "$sinkB" ] && echo nonempty || echo empty)" "empty" "below-threshold without diag emits nothing"

# ── #170 ai-title refresh: the same haiku call also returns a short "title";
#    summarize.sh appends an ai-title sidecar line so ingestLine's last-write-wins
#    overwrites Claude Code's stale one-shot title → tab + left-rail re-title. ──

# 12. Model returns a title → ai-title line appended alongside session-summary.
title_llm="$work/title-llm.sh"
printf '#!/usr/bin/env bash\ncat >/dev/null; printf %s '\''{"summary":"Refactored the widget.","tags":["widget","refactor","cleanup"],"title":"Refactor widget module"}'\''\n' > "$title_llm"; chmod +x "$title_llm"
sidC="cccccccc-0000-0000-0000-00000000000c"; tC="$work/$sidC.jsonl"; sinkC="$work/sinkC"
mkturns_iso "$sidC" "$tC" 20
printf '{"session_id":"%s","transcript_path":"%s"}' "$sidC" "$tC" \
  | CF_SUMMARIZE_FG=1 CF_SUMMARIZE_CMD="$title_llm" CF_SUMMARY_MIN_INTERVAL_S=0 CF_SUMMARY_STATUS_SINK="$sinkC" bash "$here/summarize.sh"
assert "$(jq -rs 'map(select(.type=="session-summary")) | length' "$work/$sidC.fleet.jsonl" 2>/dev/null)" "1" "session-summary still emitted with title"
assert "$(jq -rs 'map(select(.type=="ai-title")) | length' "$work/$sidC.fleet.jsonl" 2>/dev/null)" "1" "ai-title line emitted when title present"
assert "$(jq -rs 'map(select(.type=="ai-title")) | .[0].aiTitle' "$work/$sidC.fleet.jsonl" 2>/dev/null)" "Refactor widget module" "ai-title carries the model title"
assert "$(jq -rs 'map(select(.type=="ai-title")) | .[0].sessionId' "$work/$sidC.fleet.jsonl" 2>/dev/null)" "$sidC" "ai-title stamps session id"
# The generated breadcrumb notes the retitle so #230 observers see it happen.
assert "$(jq -r 'select(.params.arguments.phase=="generated") | .params.arguments.detail.retitled' "$sinkC" 2>/dev/null)" "true" "generated breadcrumb notes retitled:true"

# 13. Model omits title → no ai-title line (backward compatible); chapter unaffected.
sidD="dddddddd-0000-0000-0000-00000000000d"; tD="$work/$sidD.jsonl"; sinkD="$work/sinkD"
mkturns_iso "$sidD" "$tD" 20
printf '{"session_id":"%s","transcript_path":"%s"}' "$sidD" "$tD" \
  | CF_SUMMARIZE_FG=1 CF_SUMMARIZE_CMD="$ok_llm" CF_SUMMARY_MIN_INTERVAL_S=0 CF_SUMMARY_STATUS_SINK="$sinkD" bash "$here/summarize.sh"
assert "$(jq -rs 'map(select(.type=="ai-title")) | length' "$work/$sidD.fleet.jsonl" 2>/dev/null)" "0" "no ai-title line when model omits title"
assert "$(jq -rs 'map(select(.type=="session-summary")) | length' "$work/$sidD.fleet.jsonl" 2>/dev/null)" "1" "session-summary still emitted without title"
assert "$(jq -r 'select(.params.arguments.phase=="generated") | .params.arguments.detail.retitled' "$sinkD" 2>/dev/null)" "false" "generated breadcrumb notes retitled:false when omitted"

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

# ── #230 prompt hijack: haiku continues conversational transcript content
#    instead of summarizing. The window must be quoted as delimited DATA and the
#    operative instruction + JSON format must come AFTER it (recency wins with
#    weak models), and an invalid reply gets exactly one retry. ──

# 17. Prompt structure: window delimited, instruction after the window content.
sidG="12121212-0000-0000-0000-000000000012"; tG="$work/$sidG.jsonl"
mkturns_iso "$sidG" "$tG" 20
cap_llm="$work/cap-llm.sh"; cap_in="$work/cap-in"
cat > "$cap_llm" <<CAP
#!/usr/bin/env bash
cat > "$cap_in"
printf '{"summary":"structural capture.","tags":["a","b","c"]}'
CAP
chmod +x "$cap_llm"
printf '{"session_id":"%s","transcript_path":"%s"}' "$sidG" "$tG" \
  | CF_SUMMARIZE_FG=1 CF_SUMMARIZE_CMD="$cap_llm" CF_SUMMARY_MIN_INTERVAL_S=0 bash "$here/summarize.sh"
assert "$(grep -c '^<<<TRANSCRIPT-WINDOW$' "$cap_in" 2>/dev/null)" "1" "window opened by begin marker"
assert "$(grep -c '^TRANSCRIPT-WINDOW>>>$' "$cap_in" 2>/dev/null)" "1" "window closed by end marker"
last_window_line="$(grep -n 'prompt number 20' "$cap_in" | tail -1 | cut -d: -f1)"
instruction_line="$(grep -n 'Reply with ONLY strict JSON' "$cap_in" | tail -1 | cut -d: -f1)"
assert "$([ -n "$instruction_line" ] && [ -n "$last_window_line" ] && [ "$instruction_line" -gt "$last_window_line" ] && echo after || echo before)" \
  "after" "JSON instruction comes after the window content"

# 18. Retry: first reply is a hijacked continuation (no JSON), second is valid →
#     chapter lands, model called exactly twice, no rejected breadcrumb.
retry_llm="$work/retry-llm.sh"; retry_calls="$work/retry-calls"
cat > "$retry_llm" <<RETRY
#!/usr/bin/env bash
cat >/dev/null
echo x >> "$retry_calls"
if [ "\$(wc -l < "$retry_calls")" -ge 2 ]; then
  printf '{"summary":"second try worked.","tags":["a","b","c"]}'
else
  printf 'PR #191 is in CI now. I will monitor it and report back.'
fi
RETRY
chmod +x "$retry_llm"
sidH="13131313-0000-0000-0000-000000000013"; tH="$work/$sidH.jsonl"; sinkH="$work/sinkH"
mkturns_iso "$sidH" "$tH" 20; : > "$retry_calls"
printf '{"session_id":"%s","transcript_path":"%s"}' "$sidH" "$tH" \
  | CF_SUMMARIZE_FG=1 CF_SUMMARIZE_CMD="$retry_llm" CF_SUMMARY_MIN_INTERVAL_S=0 CF_SUMMARY_STATUS_SINK="$sinkH" bash "$here/summarize.sh"
assert "$(jq -rs 'map(select(.type=="session-summary")) | length' "$work/$sidH.fleet.jsonl" 2>/dev/null)" "1" "retry recovers the chapter"
assert "$(wc -l < "$retry_calls" | tr -d ' ')" "2" "model called exactly twice on retry"
assert "$(phases "$sinkH")" "attempt,generated," "recovered retry reports attempt then generated"

# 19. Both attempts invalid → rejected once, model called exactly twice.
sidI="14141414-0000-0000-0000-000000000014"; tI="$work/$sidI.jsonl"; sinkI="$work/sinkI"
fail_llm="$work/fail-llm.sh"; fail_calls="$work/fail-calls"
cat > "$fail_llm" <<FAILLLM
#!/usr/bin/env bash
cat >/dev/null
echo x >> "$fail_calls"
printf 'Sounds good, I will keep going with the release.'
FAILLLM
chmod +x "$fail_llm"
mkturns_iso "$sidI" "$tI" 20; : > "$fail_calls"
printf '{"session_id":"%s","transcript_path":"%s"}' "$sidI" "$tI" \
  | CF_SUMMARIZE_FG=1 CF_SUMMARIZE_CMD="$fail_llm" CF_SUMMARY_MIN_INTERVAL_S=0 CF_SUMMARY_STATUS_SINK="$sinkI" bash "$here/summarize.sh"
assert "$(phases "$sinkI")" "attempt,rejected," "double failure reports attempt then rejected"
assert "$(wc -l < "$fail_calls" | tr -d ' ')" "2" "double failure stops after the single retry"
assert "$([ -f "$work/$sidI.fleet.jsonl" ] && echo yes || echo no)" "no" "no chapter on double failure"

[ "$fails" -eq 0 ] && echo "ALL PASS" || exit 1
