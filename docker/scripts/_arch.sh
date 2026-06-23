#!/usr/bin/env bash
# Sourced by the binary installers to resolve the running architecture into the
# two naming conventions release assets use. Sets:
#   ARCH_DEB  → amd64 | arm64   (gh, yq, opa, kubectl, terramate, tenv, helm…)
#   ARCH_GNU  → x86_64 | aarch64 (aws cli, some tarballs)
set -euo pipefail
case "$(uname -m)" in
  x86_64 | amd64) ARCH_DEB=amd64; ARCH_GNU=x86_64 ;;
  aarch64 | arm64) ARCH_DEB=arm64; ARCH_GNU=aarch64 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
export ARCH_DEB ARCH_GNU
