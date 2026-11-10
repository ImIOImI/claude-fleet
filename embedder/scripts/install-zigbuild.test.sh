#!/usr/bin/env bash
# Arch selection in install-zigbuild.sh (no downloads).
set -euo pipefail
s="$(dirname "$0")/install-zigbuild.sh"
x=$(FLEET_ZB_ARCH=x86_64 "$s" --print)
grep -q 'zig-x86_64-linux-0.14.1.tar.xz 24aeeec8af16c381934a6cd7d95c807a8cb2cf7df9fa40d359aa884195c4716c' <<<"$x"
grep -q 'cargo-zigbuild-x86_64-unknown-linux-musl.tar.xz f09b180a517af0e4dd4bffc921bb88e5ab705452a9dd948c61e489b3020c68c2' <<<"$x"
if err=$(FLEET_ZB_ARCH=aarch64 "$s" --print 2>&1); then echo "aarch64 accepted"; exit 1; fi
grep -q 'unsupported arch aarch64' <<<"$err"
if FLEET_ZB_ARCH=riscv64 "$s" --print 2>/dev/null; then echo "riscv64 accepted"; exit 1; fi
echo "install-zigbuild: OK"
