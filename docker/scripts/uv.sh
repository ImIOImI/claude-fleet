#!/usr/bin/env bash
# uv — fast Python package/venv manager. Pinned release tarball into
# /usr/local/bin (world-executable).
set -euo pipefail
source "$(dirname "$0")/_arch.sh"
V="${UV_VERSION:-0.5.14}"
tmp="$(mktemp -d)"
curl -fsSL "https://github.com/astral-sh/uv/releases/download/${V}/uv-${ARCH_GNU}-unknown-linux-gnu.tar.gz" \
  | tar -xz -C "$tmp"
install -m 0755 "$tmp/uv-${ARCH_GNU}-unknown-linux-gnu/uv"  /usr/local/bin/uv
install -m 0755 "$tmp/uv-${ARCH_GNU}-unknown-linux-gnu/uvx" /usr/local/bin/uvx
rm -rf "$tmp"
uv --version | sed -n '1p'
