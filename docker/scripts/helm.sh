#!/usr/bin/env bash
# Helm — review/template the charts in infra/charts/. Official get-helm-3
# installer drops `helm` into /usr/local/bin.
set -euo pipefail
curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
helm version --short
