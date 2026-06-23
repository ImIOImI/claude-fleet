#!/usr/bin/env bash
# kubectl + kustomize — inspect/validate EKS manifests + Kustomize overlays.
set -euo pipefail
source "$(dirname "$0")/_arch.sh"
V="${KUBECTL_VERSION:-latest}"
[ "$V" = "latest" ] && V="$(curl -fsSL https://dl.k8s.io/release/stable.txt)"
curl -fsSL "https://dl.k8s.io/release/${V}/bin/linux/${ARCH_DEB}/kubectl" -o /usr/local/bin/kubectl
chmod 0755 /usr/local/bin/kubectl
kubectl version --client | head -1

# kustomize — download the release tarball directly (the upstream install
# script's glob is flaky). Resolve the latest `kustomize/vX.Y.Z` tag unless
# pinned, then fetch the matching asset (tag slash is %2F-encoded in the URL).
KV="${KUSTOMIZE_VERSION:-latest}"
if [ "$KV" = "latest" ]; then
  KV="$(curl -fsSL 'https://api.github.com/repos/kubernetes-sigs/kustomize/releases?per_page=30' \
        | grep '"tag_name"' | grep 'kustomize/' | head -1 | sed -E 's#.*"kustomize/(v[0-9.]+)".*#\1#')"
fi
tmp="$(mktemp -d)"
curl -fsSL "https://github.com/kubernetes-sigs/kustomize/releases/download/kustomize%2F${KV}/kustomize_${KV}_linux_${ARCH_DEB}.tar.gz" \
  | tar -xz -C "$tmp"
install -m 0755 "$tmp/kustomize" /usr/local/bin/kustomize
rm -rf "$tmp"
kustomize version
