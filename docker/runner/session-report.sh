#!/usr/bin/env bash
# Claude Code hook: report this claude session's id + owning broker session
# (tab) to the fleet-state MCP server. Registered for SessionStart — fires on
# startup, resume, AND clear, so the host's tab↔session mapping tracks /clear
# drift with claude's own testimony (#207). Fire-and-forget; always exit 0.
set -u
payload="$(cat)"
sid="$(printf '%s' "$payload" | jq -r '.session_id // empty' 2>/dev/null)"
bid="${CLAUDE_FLEET_BROKER_SESSION_ID:-}"
[ -n "$sid" ] || { echo "session-report: no session_id in hook payload" >&2; exit 0; }
[ -n "$bid" ] || { echo "session-report: no CLAUDE_FLEET_BROKER_SESSION_ID in env" >&2; exit 0; }

req=$(jq -nc --arg sid "$sid" --arg bid "$bid" \
  '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"report_session_mapping",arguments:{brokerSessionId:$bid,sessionId:$sid}}}')

# Test seam: capture the request instead of sending it.
if [ -n "${CF_SESSION_REPORT_SINK:-}" ]; then
  printf '%s\n' "$req" >> "$CF_SESSION_REPORT_SINK"
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
