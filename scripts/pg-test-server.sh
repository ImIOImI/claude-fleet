#!/usr/bin/env bash
# Local Postgres 16 + pgvector for the store suite where Docker is unavailable
# (Linux x64/arm64). Real server binaries from @embedded-postgres, pgvector from
# the PGDG bookworm .deb (sha256-pinned); owner-only Unix socket. CI uses the
# pgvector/pgvector:0.8.7-pg16 service container instead.
#
#   scripts/pg-test-server.sh start   # prints the PG_TEST_URL to export
#   scripts/pg-test-server.sh stop
set -euo pipefail
umask 077
ROOT=${PG_TEST_ROOT:-/tmp/fleet-pg-test}
PG_PKG_VERSION=16.15.0-beta.19
PGVECTOR_DEB_VERSION=0.8.7-1.pgdg12+1
case "$(uname -m)" in
  x86_64) NPM_ARCH=x64; DEB_ARCH=amd64; DEB_SHA256=c1f350f3ed881535b242725510fb8f4d7a6031e3cb8f4c1d8019b2e67930be75 ;;
  aarch64|arm64) NPM_ARCH=arm64; DEB_ARCH=arm64; DEB_SHA256=a50ea0d64ba3ab05f98910aa75f0dd238a466cfe5dbb1e1899896dd2a514e810 ;;
  *) echo "unsupported arch $(uname -m)" >&2; exit 1 ;;
esac
NATIVE="$ROOT/node_modules/@embedded-postgres/linux-$NPM_ARCH/native"
URL="postgres://postgres@localhost/postgres?host=$ROOT/sock"

# trust auth: the root and socket must be ours alone.
own_root() {
  mkdir -p "$ROOT"
  if [ "$(stat -c %u "$ROOT")" != "$(id -u)" ]; then
    echo "$ROOT is not owned by uid $(id -u); refusing to use it" >&2
    exit 1
  fi
  chmod 700 "$ROOT"
}

install() {
  [ -x "$NATIVE/bin/postgres" ] && [ -f "$NATIVE/lib/postgresql/vector.so" ] && return
  (cd "$ROOT" || exit 1; [ -f package.json ] || npm init -y >/dev/null)
  (cd "$ROOT" || exit 1; npm i --ignore-scripts --no-audit --no-fund "@embedded-postgres/linux-$NPM_ARCH@$PG_PKG_VERSION" >/dev/null)
  # --ignore-scripts skips the package's libpq.so.5 etc. symlinks.
  (cd "$ROOT/node_modules/@embedded-postgres/linux-$NPM_ARCH" || exit 1; node scripts/hydrate-symlinks.js)
  chmod +x "$NATIVE"/bin/*
  local deb="postgresql-16-pgvector_${PGVECTOR_DEB_VERSION}_${DEB_ARCH}.deb"
  curl -sfL -o "$ROOT/$deb" "https://apt.postgresql.org/pub/repos/apt/pool/main/p/pgvector/${deb//+/%2B}"
  echo "$DEB_SHA256  $ROOT/$deb" | sha256sum -c --quiet - || { rm -f "$ROOT/$deb"; echo "pgvector .deb sha256 mismatch" >&2; exit 1; }
  rm -rf "$ROOT/deb" && dpkg-deb -x "$ROOT/$deb" "$ROOT/deb"
  cp "$ROOT/deb/usr/lib/postgresql/16/lib/vector.so" "$NATIVE/lib/postgresql/"
  cp "$ROOT"/deb/usr/share/postgresql/16/extension/vector* "$NATIVE/share/postgresql/extension/"
}

case "${1:-}" in
  start)
    own_root
    install
    if [ ! -f "$ROOT/data/PG_VERSION" ]; then
      "$NATIVE/bin/initdb" -D "$ROOT/data" -U postgres --auth=trust --locale=C.UTF-8 -E UTF8 >/dev/null
    fi
    mkdir -p "$ROOT/sock"
    "$NATIVE/bin/pg_ctl" -D "$ROOT/data" status >/dev/null 2>&1 \
      || "$NATIVE/bin/pg_ctl" -D "$ROOT/data" -o "-k $ROOT/sock -c listen_addresses='' -c unix_socket_permissions=0700" -l "$ROOT/pg.log" -w start >/dev/null
    echo "export PG_TEST_URL='$URL'"
    ;;
  stop)
    "$NATIVE/bin/pg_ctl" -D "$ROOT/data" -m fast stop >/dev/null 2>&1 || true
    ;;
  *) echo "usage: $0 start|stop" >&2; exit 2 ;;
esac
