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

make --version | head -1
dig -v 2>&1 | head -1 || true
pre-commit --version
