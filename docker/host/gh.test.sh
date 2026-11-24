#!/usr/bin/env bash
# The gh shim end to end against the fleet-host-cred bundle and a fake credential
# socket: gh gets a scoped GH_TOKEN, arguments and exit status pass through, an
# explicit GH_TOKEN wins, and no output ever carries the token.
# FLEET_HOST_CRED_MJS points at a built bundle; otherwise one is built with esbuild.
set -euo pipefail
unset GH_TOKEN GITHUB_TOKEN GH_HOST GH_REPO FLEET_HOST_CRED_ADDR
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
t=$(mktemp -d)
trap 'kill "${srv:-}" 2>/dev/null || true; rm -rf "$t"' EXIT
fake=ghs_FAKEshimtest0000
mjs=${FLEET_HOST_CRED_MJS:-}
if [ -z "$mjs" ]; then
  mjs=$t/fleet-host-cred.mjs
  "$root/node_modules/.bin/esbuild" "$root/src/host/credMain.ts" --bundle --platform=node --format=esm --log-level=warning --outfile="$mjs"
fi
mkdir "$t/bin"
printf '#!/bin/sh\nexec node %s "$@"\n' "$mjs" > "$t/bin/fleet-host-cred"
cat > "$t/gh-real" <<'G'
#!/bin/sh
printf '%s' "${GH_TOKEN:-none}" > "$REC"
printf 'args=%s\n' "$*"
exit "${FAKE_RC:-0}"
G
chmod +x "$t/bin/fleet-host-cred" "$t/gh-real"
cat > "$t/srv.mjs" <<'S'
import { createServer } from 'node:http';
const [sock, tok] = process.argv.slice(2);
createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    const { repositories } = JSON.parse(b);
    if (repositories[0] === 'err') res.writeHead(403).end(JSON.stringify({ error: 'not in github.repositories: err\nsecond line' }));
    else res.writeHead(200).end(JSON.stringify({ token: tok }));
  });
}).listen(sock, () => process.stdout.write('up\n'));
S
node "$t/srv.mjs" "$t/cred.sock" "$fake" > "$t/srv.out" & srv=$!
for _ in $(seq 50); do [ -s "$t/srv.out" ] && break; sleep 0.1; done
cd "$t" # no git remotes to resolve a repo from
export REC=$t/rec FLEET_HOST_CRED_SOCKET=$t/cred.sock FLEET_GH_REAL=$t/gh-real
run() { PATH="$t/bin:$PATH" sh "$here/gh" "$@" 2>&1; }
check() { # expected-output expected-token args...
  local want=$1 tok=$2 out; shift 2
  out=$(run "$@") || true
  case "$out" in *"$fake"*) echo "token leaked in output of: $*" >&2; exit 1 ;; esac
  test "$out" = "$want" || { echo "output of $*: $out" >&2; exit 1; }
  test "$(cat "$REC")" = "$tok" || { echo "gh token for $*: wrong" >&2; exit 1; }
}
check 'args=pr view 1 -R acme/a' "$fake" pr view 1 -R acme/a
check 'args=pr create -R acme/a --body a  b' "$fake" pr create -R acme/a --body 'a  b'
check 'args=search prs a b' none search prs 'a b'
GH_TOKEN=mine check 'args=pr view -R acme/a' mine pr view -R acme/a
check $'fleet-host-cred: 403: not in github.repositories: err\nargs=pr view -R acme/err' none pr view -R acme/err
rc=0; FAKE_RC=5 run pr view -R acme/a >/dev/null || rc=$?
test "$rc" = 5
for argv in "gh-token -- pr view -R acme/a" "gh -- pr view -R acme/a"; do
  # shellcheck disable=SC2086
  out=$(PATH="$t/bin:$PATH" fleet-host-cred $argv 2>&1) || true
  case "$out" in *"$fake"*) echo "token leaked by fleet-host-cred $argv" >&2; exit 1 ;; esac
done
echo "gh shim: OK"
