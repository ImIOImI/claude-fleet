#!/usr/bin/env bash
# Terraform/OpenTofu static analysis for the IaC reviewer experts:
#   tflint — HCL linter / provider rules
#   trivy  — security + misconfig scanner (IaC, secrets, deps)
set -euo pipefail
source "$(dirname "$0")/_arch.sh"

# tflint — download the release zip directly. Upstream removed their
# install_linux.sh convenience script (the old raw.githubusercontent.com/.../
# master/install_linux.sh URL now 404s), so follow their README and fetch the
# arch-specific asset from releases/latest/download (redirects to the current
# release — no API call, no rate limit).
tmp="$(mktemp -d)"
curl -fsSL "https://github.com/terraform-linters/tflint/releases/latest/download/tflint_linux_${ARCH_DEB}.zip" \
  -o "$tmp/tflint.zip"
unzip -q "$tmp/tflint.zip" -d /usr/local/bin
chmod 0755 /usr/local/bin/tflint
rm -rf "$tmp"

# trivy — its official installer still grabs the latest release for us.
curl -fsSL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh \
  | sh -s -- -b /usr/local/bin

tflint --version | sed -n '1p'  # sed, not head — head SIGPIPEs the producer under QEMU (see apt-tools.sh)
trivy --version | sed -n '1p'
