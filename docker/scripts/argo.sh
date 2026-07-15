#!/usr/bin/env bash
# Argo CLIs — argocd (GitOps sync/diff), argo (Workflows), and the Rollouts
# kubectl plugin. All three are single static binaries from argoproj releases.
set -euo pipefail
source "$(dirname "$0")/_arch.sh"
CD_V="${ARGOCD_VERSION:-3.4.5}"
WF_V="${ARGO_WORKFLOWS_VERSION:-4.0.7}"
RO_V="${ARGO_ROLLOUTS_VERSION:-1.9.0}"
tmp="$(mktemp -d)"
curl -fsSL -o "$tmp/argocd" \
  "https://github.com/argoproj/argo-cd/releases/download/v${CD_V}/argocd-linux-${ARCH_DEB}"
curl -fsSL "https://github.com/argoproj/argo-workflows/releases/download/v${WF_V}/argo-linux-${ARCH_DEB}.gz" \
  | gunzip > "$tmp/argo"
curl -fsSL -o "$tmp/kubectl-argo-rollouts" \
  "https://github.com/argoproj/argo-rollouts/releases/download/v${RO_V}/kubectl-argo-rollouts-linux-${ARCH_DEB}"
install -m 0755 -t /usr/local/bin "$tmp/argocd" "$tmp/argo" "$tmp/kubectl-argo-rollouts"
rm -rf "$tmp"
argocd version --client --short
argo version --short
kubectl-argo-rollouts version --short
