#!/usr/bin/env bash
# Linux release build of fleet-embedder, run in Debian 12 (GCC 12, glibc 2.36):
# libstdc++.a is linked statically, and a newer distro's libstdc++.a references
# glibc symbols that 2.28 lacks. Needs docker. Run from the repo root.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
# The same image digest is the host image's embedder-build stage (docker/host/Dockerfile); bump both together.
docker run --rm -v "$root":/w -w /w \
  -e UID_GID="$(id -u):$(id -g)" -e GITHUB_ACTIONS \
  rust:1.91-bookworm@sha256:c1e5f19e773b7878c3f7a805dd00a495e747acbdc76fb2337a4ebf0418896b33 bash -euo pipefail -c '
    trap "chown -R \$UID_GID embedder/target embedder/bin 2>/dev/null || true" EXIT
    embedder/scripts/install-zigbuild.sh /tmp/zb
    PATH=/tmp/zb/bin:$PATH embedder/scripts/ci-build.sh'
