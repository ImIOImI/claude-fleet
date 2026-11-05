#!/usr/bin/env bash
# Local Postgres 16 + pgvector for the store suite where Docker is unavailable
# (Linux x64/arm64). Real server binaries from @embedded-postgres, pgvector from
# the PGDG bookworm .deb; Unix socket only. CI uses the pgvector/pgvector:pg16
# service container instead.
#
#   scripts/pg-test-server.sh start   # prints the PG_TEST_URL to export
#   scripts/pg-test-server.sh stop
set -euo pipefail
ROOT=${PG_TEST_ROOT:-/tmp/fleet-pg-test}
PG_PKG_VERSION=16.15.0-beta.19
PGVECTOR_DEB_VERSION=0.8.7-1.pgdg12+1
case "$(uname -m)" in
  x86_64) NPM_ARCH=x64; DEB_ARCH=amd64 ;;
  aarch64|arm64) NPM_ARCH=arm64; DEB_ARCH=arm64 ;;
  *) echo "unsupported arch $(uname -m)" >&2; exit 1 ;;
esac
NATIVE="$ROOT/node_modules/@embedded-postgres/linux-$NPM_ARCH/native"
URL="postgres://postgres@localhost/postgres?host=$ROOT/sock"

install() {
  [ -x "$NATIVE/bin/postgres" ] && [ -f "$NATIVE/lib/postgresql/vector.so" ] && return
  mkdir -p "$ROOT"
  (cd "$ROOT" && [ -f package.json ] || npm init -y >/dev/null)
  (cd "$ROOT" && npm i --no-audit --no-fund "@embedded-postgres/linux-$NPM_ARCH@$PG_PKG_VERSION" >/dev/null)
  chmod +x "$NATIVE"/bin/*
  local deb="postgresql-16-pgvector_${PGVECTOR_DEB_VERSION}_${DEB_ARCH}.deb"
  curl -sfL -o "$ROOT/$deb" "https://apt.postgresql.org/pub/repos/apt/pool/main/p/pgvector/${deb//+/%2B}"
  rm -rf "$ROOT/deb" && dpkg-deb -x "$ROOT/$deb" "$ROOT/deb"
  cp "$ROOT/deb/usr/lib/postgresql/16/lib/vector.so" "$NATIVE/lib/postgresql/"
  cp "$ROOT"/deb/usr/share/postgresql/16/extension/vector* "$NATIVE/share/postgresql/extension/"
}

case "${1:-}" in
  start)
    install
    if [ ! -f "$ROOT/data/PG_VERSION" ]; then
      "$NATIVE/bin/initdb" -D "$ROOT/data" -U postgres --auth=trust --locale=C.UTF-8 -E UTF8 >/dev/null
    fi
    mkdir -p "$ROOT/sock"
    "$NATIVE/bin/pg_ctl" -D "$ROOT/data" -o "-k $ROOT/sock -c listen_addresses=''" -l "$ROOT/pg.log" -w status >/dev/null 2>&1 \
      || "$NATIVE/bin/pg_ctl" -D "$ROOT/data" -o "-k $ROOT/sock -c listen_addresses=''" -l "$ROOT/pg.log" -w start >/dev/null
    echo "export PG_TEST_URL='$URL'"
    ;;
  stop)
    "$NATIVE/bin/pg_ctl" -D "$ROOT/data" -m fast stop >/dev/null 2>&1 || true
    ;;
  *) echo "usage: $0 start|stop" >&2; exit 2 ;;
esac
