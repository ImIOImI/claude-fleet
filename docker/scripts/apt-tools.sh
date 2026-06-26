#!/usr/bin/env bash
# Tier-1 apt packages shared by every tooled image: review/build essentials +
# dnsutils (dig/nslookup) + pre-commit. Run as root during image build.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  make \
  shellcheck \
  dnsutils \
  unzip \
  python3 \
  python3-pip \
  python3-venv
# pre-commit, system-wide. Debian bookworm marks the system Python as
# externally-managed (PEP 668), so the override is required for a global install.
pip3 install --no-cache-dir --break-system-packages pre-commit
rm -rf /var/lib/apt/lists/*

# Smoke the tools. Use `sed -n '1p'` (NOT `| head -1`) to print the first line:
# head closes the pipe after line 1, and under QEMU emulation (the arm64 leg of
# the multi-arch build) the slow emulated producer is still writing → SIGPIPE →
# exit 141, which `set -o pipefail` turns into a build failure. sed drains to EOF.
make --version | sed -n '1p'
dig -v 2>&1 | sed -n '1p' || true
pre-commit --version
