#!/usr/bin/env bash
# Smoke-test a runner-host image: probes on 8080, auth required, uid 1000 under `single`, the no-mode refusal, the `fleet-host` user,
# `broker ready`/`broker drain` with no broker and the drain-settings refusal,
# `fleet-host init`, the bootstrap/migrate subcommands, the MCP bridge file and /run/fleet,
# the embedder files and embed-check, and a clean SIGTERM that reaches fleet-host.
set -Eeuo pipefail
# Under -e a check without `|| fail` would exit silently; name the line instead.
trap 'echo "FAIL: line $LINENO: $BASH_COMMAND"' ERR
fail() { echo "FAIL: $*"; exit 1; }
image=$1
cfg=$(mktemp -d)
printf 'workspace: { name: smoke }\ngrants:\n  - { team: acme/platform, tier: session }\n' > "$cfg/config.yaml"
chmod -R a+rX "$cfg"
cid=$(docker run -d -p 127.0.0.1::8080 -v "$cfg:/etc/fleet-host:ro" "$image" fleet-host-entry single) || fail "start the single container"
trap 'docker logs "$cid" 2>&1 | tail -20 || true; docker rm -f "$cid" >/dev/null 2>&1 || true' EXIT
rc=0; docker run --rm "$image" >/dev/null 2>&1 || rc=$?
test "$rc" = 2 || fail "no mode exited $rc, want 2"
test "$(docker run --rm --entrypoint id "$image" -u fleet-host)" = 1001 || fail "fleet-host uid"
test "$(docker run --rm --entrypoint stat "$image" -c '%a %u' /var/lib/fleet-host/state)" = '700 1001' || fail "state dir mode/owner"
# No broker running: the readiness probe fails and the preStop drain reports it can't connect.
docker run --rm --entrypoint /usr/local/bin/broker "$image" ready && fail "broker ready passed with no broker"
rc=0; out=$(docker run --rm --entrypoint /usr/local/bin/broker "$image" drain 2>&1) || rc=$?
test "$rc" = 1 || fail "broker drain without a broker exited $rc"
grep -q 'broker drain:' <<<"$out" || fail "broker drain without a broker: $out"
# An out-of-range drain setting refuses to start.
rc=0; docker run --rm --entrypoint /usr/local/bin/broker -e CLAUDE_FLEET_BROKER_DRAIN_SOFT=40m "$image" >/dev/null 2>&1 || rc=$?
test "$rc" = 1 || fail "broker started with CLAUDE_FLEET_BROKER_DRAIN_SOFT=40m (rc $rc)"
port=$(docker port "$cid" 8080/tcp | head -1 | sed 's/.*://') || fail "no published port"
[ -n "$port" ] || fail "no published port"
for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:$port/healthz" >/dev/null 2>&1 && break
  sleep 1
done
grep -q '"lease":"holder"' <<<"$(curl -fsS "http://127.0.0.1:$port/healthz" || true)" || fail "/healthz is not holder"
test "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/whoami")" = 401 || fail "/whoami without auth is not 401"
test "$(docker exec "$cid" id -u)" = 1000 || fail "single runs as uid 1000"
docker exec "$cid" sh -c 'test -s /etc/ssl/certs/rds-global-bundle.pem && grep -q "BEGIN CERTIFICATE" /etc/ssl/certs/rds-global-bundle.pem' || fail "RDS CA bundle"
# Vite's empty optional-peer stub makes ws call an undefined unmask on any client frame >= 32 bytes.
docker exec "$cid" sh -c '! grep -rlq viteOptionalPeerDep_bufferutil /usr/local/lib/fleet-host' || fail "bundled ws still loads the bufferutil stub"
docker exec "$cid" sh -c 'test -s /usr/local/lib/fleet-host/mcp-bridge.cjs && grep -q CLAUDE_FLEET_MCP_UNIX /usr/local/lib/fleet-host/mcp-bridge.cjs' || fail "MCP bridge file"
test "$(docker exec "$cid" stat -c '%a %U' /run/fleet)" = '700 fleet' || fail "/run/fleet mode/owner"
# fleet-host's fresh-step argv shape parses on the image's pinned claude: `--mcp-config=` takes one value and
# `--` keeps a dash-led prompt from being read as an option. A missing config file fails before any API call.
grep -q 'MCP config file not found: /nonexistent/mcp.json$' \
  <<<"$(docker exec "$cid" sh -c 'claude -p --allowedTools a,b --mcp-config=/nonexistent/mcp.json --session-id 0b7e6c1e-1f6a-4c55-9c39-6f1f8d6c2a11 -- -x </dev/null 2>&1; true')" \
  || fail "fresh-step argv shape on the pinned claude"
grep -q '"workspaceId"' <<<"$(docker exec "$cid" fleet-host init)" || fail "fleet-host init"
test "$(docker exec "$cid" sh -c 'fleet-host bootstrap >/dev/null; echo rc=$?')" = rc=2 || fail "fleet-host bootstrap without args is not rc 2"
grep -q 'has no db: block' <<<"$(docker exec "$cid" sh -c 'fleet-host migrate; true')" || fail "fleet-host migrate without db"
grep -q 'fleet-host-cred git-credential' <<<"$(docker exec "$cid" git config --system --get-all credential.https://github.com.helper)" || fail "git credential helper"
test "$(docker exec "$cid" sh -c 'printf "protocol=https\nhost=github.com\npath=a/b\n\n" | fleet-host-cred git-credential get 2>/dev/null; echo rc=$?')" = rc=0 || fail "git-credential get rc"
test "$(docker exec "$cid" sh -c 'command -v gh || true')" != /usr/local/bin/gh || fail "gh shim resolves to /usr/local/bin/gh"
test "$(docker exec "$cid" stat -c '%a %U' /usr/local/lib/fleet-host/embed/fleet-embedder)" = '755 root' || fail "embedder binary mode/owner"
docker exec "$cid" sh -c 'cd /usr/local/lib/fleet-host/embed/model && sha256sum -c --quiet SHA256SUMS' || fail "embedder model checksums"
test "$(docker exec "$cid" sh -c 'find /usr/local/lib/fleet-host/embed/model /usr/local/lib/fleet-host/embed/reference.json -type f -exec stat -c "%a %U" {} + | sort -u')" = '644 root' || fail "embedder model files mode/owner"
# No db: no holder, so no sidecar process. /proc, not pgrep: the slim base has no procps.
test -z "$(docker exec "$cid" sh -c 'for p in /proc/[0-9]*; do [ "$(cat "$p/comm" 2>/dev/null)" = fleet-embedder ] && echo "$p"; done; true')" || fail "embedder running without a holder"
grep -q '"ok":true' <<<"$(docker exec "$cid" fleet-host embed-check)" || fail "fleet-host embed-check"
docker stop -t 15 "$cid" >/dev/null || fail "docker stop"
grep -q '"msg":"shutting down"' <<<"$(docker logs "$cid" 2>&1)" || fail "SIGTERM did not reach fleet-host"
echo "runner-host smoke: OK"
