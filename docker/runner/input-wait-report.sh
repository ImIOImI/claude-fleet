#!/usr/bin/env bash
# Claude Code hook: report whether this session is blocked on an AskUserQuestion.
# Registered for PreToolUse[AskUserQuestion] (waiting=true) and
# PostToolUse[AskUserQuestion]/Stop/UserPromptSubmit (waiting=false).
# Fire-and-forget; always exit 0 so it never blocks the tool call.
set -u
payload="$(cat)"
sid="$(printf '%s' "$payload" | jq -r '.session_id // empty' 2>/dev/null)"
evt="$(printf '%s' "$payload" | jq -r '.hook_event_name // empty' 2>/dev/null)"
[ -n "$sid" ] || { echo "input-wait-report: no session_id in hook payload" >&2; exit 0; }
if [ "$evt" = "PreToolUse" ]; then waiting=true; else waiting=false; fi

req=$(jq -nc --arg sid "$sid" --argjson waiting "$waiting" \
  '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"signal_input_wait",arguments:{sessionId:$sid,waiting:$waiting}}}')


# Test seam: capture the request instead of sending it.
if [ -n "${CF_INPUT_WAIT_SINK:-}" ]; then
  printf '%s\n' "$req" >> "$CF_INPUT_WAIT_SINK"
  exit 0
fi

sock="/fleet/mcp/mcp.sock"
tok="/fleet/mcp/token"
port="${CLAUDE_FLEET_MCP_TCP_PORT:-7071}"
if [ -S "$sock" ]; then
  printf '%s\n' "$req" | timeout 2 socat - "UNIX-CONNECT:$sock" >/dev/null 2>&1 || true
elif [ -f "$tok" ]; then
  { printf '%s\n' "$(cat "$tok")"; printf '%s\n' "$req"; } \
    | timeout 2 socat - "TCP:host.docker.internal:$port" >/dev/null 2>&1 || true
fi
exit 0
