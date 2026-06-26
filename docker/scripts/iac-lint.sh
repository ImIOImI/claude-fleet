#!/usr/bin/env bash
# Terraform/OpenTofu static analysis for the IaC reviewer experts:
#   tflint — HCL linter / provider rules
#   trivy  — security + misconfig scanner (IaC, secrets, deps)
# Both ship official installers that grab the latest release and drop a binary
# into /usr/local/bin.
set -euo pipefail

curl -fsSL https://raw.githubusercontent.com/terraform-linters/tflint/master/install_linux.sh | bash
curl -fsSL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh \
  | sh -s -- -b /usr/local/bin

tflint --version
trivy --version | sed -n '1p'  # sed, not head — head SIGPIPEs the producer under QEMU (see apt-tools.sh)
