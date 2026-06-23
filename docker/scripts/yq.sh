#!/usr/bin/env bash
# yq — YAML query/edit (Helm charts, ArgoCD apps, GH Actions, Terramate config).
set -euo pipefail
source "$(dirname "$0")/_arch.sh"
V="${YQ_VERSION:-latest}"
if [ "$V" = "latest" ]; then
  url="https://github.com/mikefarah/yq/releases/latest/download/yq_linux_${ARCH_DEB}"
else
  url="https://github.com/mikefarah/yq/releases/download/v${V}/yq_linux_${ARCH_DEB}"
fi
curl -fsSL "$url" -o /usr/local/bin/yq
chmod 0755 /usr/local/bin/yq
yq --version
