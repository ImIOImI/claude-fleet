#!/usr/bin/env bash
# Linux release build of fleet-embedder, run in Debian 12 (GCC 12, glibc 2.36):
# libstdc++.a is linked statically, and a newer distro's libstdc++.a references
# glibc symbols that 2.28 lacks. Needs docker. Run from the repo root.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
docker run --rm -v "$root":/w -w /w \
  -e UID_GID="$(id -u):$(id -g)" -e GITHUB_ACTIONS \
  rust:1.91-bookworm bash -euo pipefail -c '
    trap "chown -R \$UID_GID embedder/target embedder/bin 2>/dev/null || true" EXIT
    cd /tmp
    curl -fsSL -o zig.tar.xz https://ziglang.org/download/0.14.1/zig-x86_64-linux-0.14.1.tar.xz
    echo "24aeeec8af16c381934a6cd7d95c807a8cb2cf7df9fa40d359aa884195c4716c  zig.tar.xz" | sha256sum -c -
    curl -fsSL -o czb.tar.xz https://github.com/rust-cross/cargo-zigbuild/releases/download/v0.24.1/cargo-zigbuild-x86_64-unknown-linux-musl.tar.xz
    echo "f09b180a517af0e4dd4bffc921bb88e5ab705452a9dd948c61e489b3020c68c2  czb.tar.xz" | sha256sum -c -
    tar -xJf zig.tar.xz && tar -xJf czb.tar.xz
    export PATH=/tmp/zig-x86_64-linux-0.14.1:/tmp/cargo-zigbuild-x86_64-unknown-linux-musl:$PATH
    cd /w && embedder/scripts/ci-build.sh'
