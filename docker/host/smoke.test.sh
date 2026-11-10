#!/usr/bin/env bash
# Smoke-test a runner-host image: probes on 8080, auth required, uid 1000,
# `fleet-host init`, the bootstrap/migrate subcommands, the MCP bridge file and /run/fleet,
# the embedder files and embed-check, and a clean SIGTERM that reaches fleet-host.
set -euo pipefail
image=$1
cfg=$(mktemp -d)
printf 'workspace: { name: smoke }\ngrants:\n  - { team: acme/platform, tier: session }\n' > "$cfg/config.yaml"
chmod -R a+rX "$cfg"
cid=$(docker run -d -p 127.0.0.1::8080 -v "$cfg:/etc/fleet-host:ro" "$image")
trap 'docker logs "$cid" 2>&1 | tail -20 || true; docker rm -f "$cid" >/dev/null 2>&1 || true' EXIT
port=$(docker port "$cid" 8080/tcp | head -1 | sed 's/.*://')
for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:$port/healthz" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://127.0.0.1:$port/healthz" | grep -q '"lease":"holder"'
test "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/whoami")" = 401
test "$(docker exec "$cid" id -u)" = 1000
docker exec "$cid" sh -c 'test -s /etc/ssl/certs/rds-global-bundle.pem && grep -q "BEGIN CERTIFICATE" /etc/ssl/certs/rds-global-bundle.pem'
docker exec "$cid" sh -c 'test -s /usr/local/lib/fleet-host/mcp-bridge.cjs && grep -q CLAUDE_FLEET_MCP_UNIX /usr/local/lib/fleet-host/mcp-bridge.cjs'
test "$(docker exec "$cid" stat -c '%a %U' /run/fleet)" = '700 fleet'
# fleet-host's fresh-step argv shape parses on the image's pinned claude: `--mcp-config=` takes one value and
# `--` keeps a dash-led prompt from being read as an option. A missing config file fails before any API call.
docker exec "$cid" sh -c 'claude -p --allowedTools a,b --mcp-config=/nonexistent/mcp.json --session-id 0b7e6c1e-1f6a-4c55-9c39-6f1f8d6c2a11 -- -x </dev/null 2>&1; true' \
  | grep -q 'MCP config file not found: /nonexistent/mcp.json$'
docker exec "$cid" fleet-host init | grep -q '"workspaceId"'
test "$(docker exec "$cid" sh -c 'fleet-host bootstrap >/dev/null; echo rc=$?')" = rc=2
docker exec "$cid" sh -c 'fleet-host migrate; true' | grep -q 'has no db: block'
docker exec "$cid" git config --system --get-all credential.https://github.com.helper | grep -q 'fleet-host-cred git-credential'
test "$(docker exec "$cid" sh -c 'printf "protocol=https\nhost=github.com\npath=a/b\n\n" | fleet-host-cred git-credential get 2>/dev/null; echo rc=$?')" = rc=0
test "$(docker exec "$cid" sh -c 'command -v gh || true')" != /usr/local/bin/gh
test "$(docker exec "$cid" stat -c '%a %U' /usr/local/lib/fleet-host/embed/fleet-embedder)" = '755 root'
docker exec "$cid" sh -c 'cd /usr/local/lib/fleet-host/embed/model && sha256sum -c --quiet SHA256SUMS'
test "$(docker exec "$cid" sh -c 'find /usr/local/lib/fleet-host/embed/model /usr/local/lib/fleet-host/embed/reference.json -type f -exec stat -c "%a %U" {} + | sort -u')" = '644 root'
# No db: no holder, so no sidecar process. /proc, not pgrep: the slim base has no procps.
test -z "$(docker exec "$cid" sh -c 'for p in /proc/[0-9]*; do [ "$(cat "$p/comm" 2>/dev/null)" = fleet-embedder ] && echo "$p"; done; true')"
docker exec "$cid" fleet-host embed-check | grep -q '"ok":true'
docker stop -t 15 "$cid" >/dev/null
docker logs "$cid" 2>&1 | grep -q '"msg":"shutting down"'
echo "runner-host smoke: OK"
