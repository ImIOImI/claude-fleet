#!/usr/bin/env bash
# The gh shim: passes a scoped token as GH_TOKEN, keeps arguments intact, and
# runs gh without a token when fleet-host-cred has none.
set -euo pipefail
unset GH_TOKEN GITHUB_TOKEN GH_HOST GH_REPO
here=$(cd "$(dirname "$0")" && pwd)
t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
cat > "$t/fleet-host-cred" <<'EOF'
#!/bin/sh
[ "$1" = gh-token ] || exit 2
shift; [ "$1" = -- ] && shift
case "$*" in
  *acme/a*) echo ghs_scoped ;;
  *acme/err*) printf 'fleet-host-cred: 403: not in github.repositories: err\nsecond line\n' >&2; exit 0 ;;
  *acme/long*) printf '%0300d\n' 0 >&2 ;;
esac
EOF
cat > "$t/gh-real" <<'EOF'
#!/bin/sh
printf 'token=%s args=%s\n' "${GH_TOKEN:-none}" "$*"
EOF
chmod +x "$t/fleet-host-cred" "$t/gh-real"
run() { PATH="$t:$PATH" FLEET_GH_REAL="$t/gh-real" sh "$here/gh" "$@"; }
test "$(run pr view 1 -R acme/a)" = 'token=ghs_scoped args=pr view 1 -R acme/a'
test "$(run search prs 'a b')" = 'token=none args=search prs a b'
test "$(GH_TOKEN=mine run pr view -R acme/a)" = 'token=mine args=pr view -R acme/a'
test "$(run pr view -R acme/err 2>&1 >/dev/null)" = 'fleet-host-cred: 403: not in github.repositories: err'
test "$(run pr view -R acme/err 2>/dev/null)" = 'token=none args=pr view -R acme/err'
test "$(run pr view -R acme/long 2>&1 >/dev/null | wc -c)" -le 201
test -z "$(run pr view 1 -R acme/a 2>&1 >/dev/null)"
echo "gh shim: OK"
