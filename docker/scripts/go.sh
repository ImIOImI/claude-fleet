#!/usr/bin/env bash
# Go — official tarball into /usr/local/go (world-readable). The base builds
# the broker with Go in a build stage only; the runtime image has no Go until
# this runs. PATH/GOTOOLCHAIN are set by the Dockerfile ENV.
set -euo pipefail
source "$(dirname "$0")/_arch.sh"
V="${GO_VERSION:-1.23.5}"
tmp="$(mktemp -d)"
curl -fsSL "https://go.dev/dl/go${V}.linux-${ARCH_DEB}.tar.gz" | tar -xz -C "$tmp"
rm -rf /usr/local/go
mv "$tmp/go" /usr/local/go
rm -rf "$tmp"
/usr/local/go/bin/go version | sed -n '1p'
