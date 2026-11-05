#!/usr/bin/env bash
# Install the AWS RDS global CA bundle at <dest>, verified against the sha256
# pinned in docker/versions.yaml. Used by images that connect with verify-full.
#   docker/scripts/rds-ca-bundle.sh /etc/ssl/certs/rds-global-bundle.pem
set -euo pipefail
dest=${1:?usage: rds-ca-bundle.sh <dest.pem>}
versions="$(cd "$(dirname "$0")/.." && pwd)/versions.yaml"
url=$(awk '$1 == "rds_ca_bundle_url:" { print $2 }' "$versions")
sum=$(awk '$1 == "rds_ca_bundle_sha256:" { print $2 }' "$versions")
[ -n "$url" ] && [ -n "$sum" ] || { echo "rds_ca_bundle_* missing from $versions" >&2; exit 1; }
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
curl -fsSL -o "$tmp" "$url"
echo "$sum  $tmp" | sha256sum -c --quiet -
install -D -m 0644 "$tmp" "$dest"
