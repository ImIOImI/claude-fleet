#!/usr/bin/env bash
# Open Policy Agent — policy review (Rego), part of the org's CI toolchain.
set -euo pipefail
source "$(dirname "$0")/_arch.sh"
V="${OPA_VERSION:-1.13.2}"
curl -fsSL "https://github.com/open-policy-agent/opa/releases/download/v${V}/opa_linux_${ARCH_DEB}_static" \
  -o /usr/local/bin/opa
chmod 0755 /usr/local/bin/opa
opa version
