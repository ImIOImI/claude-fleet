#!/usr/bin/env bash
# Dev image tier: the C/C++ build toolchain that lets a workspace compile
# claude-fleet's native modules (better-sqlite3, node-pty, keytar) and run
# `npx electron-rebuild`, plus the OS libraries Playwright's browsers need.
# Browsers themselves are NOT baked — a workspace runs the non-root
# `npx playwright install` at runtime (downloads into ~/.cache/ms-playwright).
# Run as root during image build.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  build-essential \
  pkg-config \
  python3 \
  python3-pip \
  python3-venv \
  libsecret-1-dev \
  ca-certificates \
  curl \
  unzip
# Playwright browser runtime libraries (root-only; browsers install non-root
# at runtime). Mirrors `playwright install-deps` for chromium/firefox/webkit.
apt-get install -y --no-install-recommends \
  libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
  libgbm1 libasound2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
  libxrandr2 libpango-1.0-0 libcairo2 fonts-liberation
rm -rf /var/lib/apt/lists/*

# Smoke — sed -n '1p', NOT head (QEMU SIGPIPE on the arm64 leg).
gcc --version | sed -n '1p'
g++ --version | sed -n '1p'
make --version | sed -n '1p'
pkg-config --version | sed -n '1p'
python3 --version | sed -n '1p'
pkg-config --exists libsecret-1 && echo "libsecret-1: ok"
