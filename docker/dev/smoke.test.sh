#!/usr/bin/env bash
# Smoke the dev runner image AS THE NON-ROOT fleet USER — the real regression
# guard is a tool installed root-only that `fleet` can't reach on PATH.
# Usage: docker/dev/smoke.test.sh [image-tag]
set -euo pipefail
IMG="${1:-claude-fleet/runner-dev:test}"

run() { docker run --rm --user fleet --entrypoint bash "$IMG" -lc "$1"; }

echo "== dev runner smoke ($IMG, user=fleet) =="
run 'gh --version         | sed -n "1p"'
run 'gcc --version        | sed -n "1p"'
run 'g++ --version        | sed -n "1p"'
run 'make --version       | sed -n "1p"'
run 'pkg-config --version | sed -n "1p"'
run 'pkg-config --exists libsecret-1 && echo "libsecret-1: ok"'
run 'python3 --version    | sed -n "1p"'
run 'pip3 --version       | sed -n "1p"'
run 'uv --version         | sed -n "1p"'
run 'go version           | sed -n "1p"'
run 'cargo --version      | sed -n "1p"'
run 'rustc --version      | sed -n "1p"'
echo "== all toolchains reachable as fleet =="
