#!/usr/bin/env bash
# tenv (tofuutils) — manages OpenTofu AND Terramate, matching the org's CI
# (tenv ships the `tofu` + `terramate` shims, so terramate MUST come through
# tenv, not a separate .deb). Installs tenv, then pre-installs the pinned tofu
# version(s) + terramate into a world-readable TENV_ROOT so any container UID
# (docker run --user) can use the shims. The Dockerfile sets ENV TENV_ROOT.
set -euo pipefail
source "$(dirname "$0")/_arch.sh"
V="${TENV_VERSION:-4.8.3}"
TOFU_VERSIONS="${TOFU_VERSIONS:-1.11.5 1.10.5}"
TERRAMATE_VERSION="${TERRAMATE_VERSION:-0.17.1}"
export TENV_ROOT="${TENV_ROOT:-/opt/tenv}"

tmp="$(mktemp -d)"
curl -fsSL "https://github.com/tofuutils/tenv/releases/download/v${V}/tenv_v${V}_${ARCH_DEB}.deb" \
  -o "$tmp/tenv.deb"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends "$tmp/tenv.deb"
rm -rf /var/lib/apt/lists/* "$tmp"

# OpenTofu: install each pinned version; the FIRST listed becomes the default.
default=""
for tv in $TOFU_VERSIONS; do
  tenv tofu install "$tv"
  [ -z "$default" ] && default="$tv"
done
tenv tofu use "$default"

# Terramate (the org's IaC orchestration tool), via tenv's `tm` subcommand.
tenv tm install "$TERRAMATE_VERSION"
tenv tm use "$TERRAMATE_VERSION"

# Smoke the shims (this also creates the per-version last-use.txt files as root)…
tofu version | head -1
terramate --version

# …THEN make everything world-RWX, so any container UID (docker run --user) can
# both read the binaries and rewrite tenv's last-use.txt timestamp — otherwise
# every `tofu`/`terramate` call logs a permission-denied WARN. Must come last,
# after the smoke run, or those root-owned files get re-created post-chmod. Safe:
# the image layer is per-container (overlay upper), never shared.
chmod -R a+rwX "$TENV_ROOT"
