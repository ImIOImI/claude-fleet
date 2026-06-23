#!/usr/bin/env bash
# GitHub CLI — the committee experts/manager reach for `gh pr view/diff/review`.
set -euo pipefail
source "$(dirname "$0")/_arch.sh"
V="${GH_VERSION:-2.87.3}"
tmp="$(mktemp -d)"
curl -fsSL "https://github.com/cli/cli/releases/download/v${V}/gh_${V}_linux_${ARCH_DEB}.tar.gz" \
  | tar -xz -C "$tmp"
install -m 0755 "$tmp/gh_${V}_linux_${ARCH_DEB}/bin/gh" /usr/local/bin/gh
rm -rf "$tmp"
gh --version | head -1
