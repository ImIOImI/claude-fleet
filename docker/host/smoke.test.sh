#!/usr/bin/env bash
# Smoke-test a runner-host image: probes on 8080, auth required, uid 1000,
# `fleet-host init`, the bootstrap/migrate subcommands, the MCP bridge file and /run/fleet,
# and a clean SIGTERM that reaches fleet-host.
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
docker exec "$cid" fleet-host init | grep -q '"workspaceId"'
test "$(docker exec "$cid" sh -c 'fleet-host bootstrap >/dev/null; echo rc=$?')" = rc=2
docker exec "$cid" sh -c 'fleet-host migrate; true' | grep -q 'has no db: block'
docker exec "$cid" git config --system --get-all credential.https://github.com.helper | grep -q 'fleet-host-cred git-credential'
test "$(docker exec "$cid" sh -c 'printf "protocol=https\nhost=github.com\npath=a/b\n\n" | fleet-host-cred git-credential get 2>/dev/null; echo rc=$?')" = rc=0
test "$(docker exec "$cid" sh -c 'command -v gh || true')" != /usr/local/bin/gh
docker stop -t 15 "$cid" >/dev/null
docker logs "$cid" 2>&1 | grep -q '"msg":"shutting down"'
echo "runner-host smoke: OK"
