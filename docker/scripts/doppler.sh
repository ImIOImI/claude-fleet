#!/usr/bin/env bash
# Doppler CLI — secrets manager; experts read/run app config via `doppler run`.
set -euo pipefail
source "$(dirname "$0")/_arch.sh"
V="${DOPPLER_VERSION:-3.76.0}"
tmp="$(mktemp -d)"
curl -fsSL "https://github.com/DopplerHQ/cli/releases/download/${V}/doppler_${V}_linux_${ARCH_DEB}.tar.gz" \
  | tar -xz -C "$tmp"
install -m 0755 "$tmp/doppler" /usr/local/bin/doppler
rm -rf "$tmp"
doppler --version
