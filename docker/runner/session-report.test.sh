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
