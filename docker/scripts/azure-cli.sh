#!/usr/bin/env bash
# Azure CLI, pinned. Installed via pip (not the apt repo) so it resolves on both
# amd64 and arm64 — the Microsoft apt repo lacks arm64 azure-cli for Debian.
# Heavy (~hundreds of MB of Python deps); gate it off for a lean image. Inert
# without per-workspace creds (vault), like the AWS CLI.
set -euo pipefail
V="${AZURE_CLI_VERSION:-2.83.0}"
pip3 install --no-cache-dir --break-system-packages "azure-cli==${V}"
az version --output table | head -3
