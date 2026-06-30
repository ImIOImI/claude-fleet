set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/input-wait-report.sh"
sink="$(mktemp)"

# PreToolUse[AskUserQuestion] → waiting:true
printf '%s' '{"session_id":"sid-1","hook_event_name":"PreToolUse","tool_name":"AskUserQuestion"}' \
  | CF_INPUT_WAIT_SINK="$sink" bash "$SCRIPT"
grep -q '"name":"signal_input_wait"' "$sink" || { echo "FAIL: no tool call"; exit 1; }
grep -q '"sessionId":"sid-1"' "$sink" || { echo "FAIL: sessionId"; exit 1; }
grep -q '"waiting":true' "$sink" || { echo "FAIL: waiting not true"; exit 1; }

# PostToolUse → waiting:false
: > "$sink"
printf '%s' '{"session_id":"sid-1","hook_event_name":"PostToolUse","tool_name":"AskUserQuestion"}' \
  | CF_INPUT_WAIT_SINK="$sink" bash "$SCRIPT"
grep -q '"waiting":false' "$sink" || { echo "FAIL: post should be false"; exit 1; }

# Stop → waiting:false (safety clear)
: > "$sink"
printf '%s' '{"session_id":"sid-1","hook_event_name":"Stop"}' \
  | CF_INPUT_WAIT_SINK="$sink" bash "$SCRIPT"
grep -q '"waiting":false' "$sink" || { echo "FAIL: stop should be false"; exit 1; }

echo "PASS"
