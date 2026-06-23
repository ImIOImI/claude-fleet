#!/usr/bin/env bash
# AWS CLI v2 (multi-account). Inert without per-workspace creds (wired via the
# vault) — installed so credentialed workspaces can use it.
set -euo pipefail
source "$(dirname "$0")/_arch.sh"
V="${AWS_CLI_VERSION:-2.33.27}"
tmp="$(mktemp -d)"
curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${ARCH_GNU}-${V}.zip" -o "$tmp/aws.zip"
unzip -q "$tmp/aws.zip" -d "$tmp"
"$tmp/aws/install"
rm -rf "$tmp"
aws --version
