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
#
# The selector must DRAIN the whole curl body: a `| head -1` mid-stream closes
# the pipe early and SIGPIPEs curl (exit 141), which `set -o pipefail` turns
# into a build failure (this is what broke the devops image publish). `sort -V
# | tail -n1` reads to EOF (no early close) and picks the highest version —
# more robust than API order, since the kustomize repo interleaves other
# modules' tags (api/, kyaml/, cmd/config/).
KV="${KUSTOMIZE_VERSION:-latest}"
if [ "$KV" = "latest" ]; then
  # Authenticate the API call when a token is present (CI exports GITHUB_TOKEN)
  # — api.github.com allows only 60 req/hr/IP unauthenticated, which CI hits.
  gh_auth=()
  [ -n "${GITHUB_TOKEN:-}" ] && gh_auth=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
  KV="$(curl -fsSL "${gh_auth[@]}" 'https://api.github.com/repos/kubernetes-sigs/kustomize/releases?per_page=100' \
        | grep -oE 'kustomize/v[0-9]+\.[0-9]+\.[0-9]+' \
        | sed 's#kustomize/##' \
        | sort -V | tail -n1)"
  [ -n "$KV" ] || { echo "kustomize: could not resolve latest release tag" >&2; exit 1; }
fi
tmp="$(mktemp -d)"
curl -fsSL "https://github.com/kubernetes-sigs/kustomize/releases/download/kustomize%2F${KV}/kustomize_${KV}_linux_${ARCH_DEB}.tar.gz" \
  | tar -xz -C "$tmp"
install -m 0755 "$tmp/kustomize" /usr/local/bin/kustomize
rm -rf "$tmp"
kustomize version
