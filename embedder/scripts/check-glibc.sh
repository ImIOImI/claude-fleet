#!/usr/bin/env bash
# Fail if an ELF binary needs a glibc symbol version above the floor, or links
# libstdc++/libgcc_s dynamically. Usage: check-glibc.sh <binary> [floor=2.28]
set -euo pipefail
bin=$1 floor=${2:-2.28}
max=$(objdump -T "$bin" | grep -oE 'GLIBC_[0-9]+\.[0-9]+' | sed 's/GLIBC_//' | sort -V | tail -1)
echo "max GLIBC symbol version: $max (floor $floor)"
if [ "$(printf '%s\n%s\n' "$max" "$floor" | sort -V | tail -1)" != "$floor" ]; then
  echo "::error::$bin needs GLIBC_$max > $floor:"
  objdump -T "$bin" | grep -E "GLIBC_[0-9.]+" | awk -v f="$floor" '{v=$0; sub(/.*GLIBC_/,"",v); sub(/[^0-9.].*/,"",v); print v, $NF}' \
    | sort -V | awk -v f="$floor" '{ split($1,a,"."); split(f,b,"."); if (a[1]>b[1] || (a[1]==b[1] && a[2]>b[2])) print "  " $0 }'
  exit 1
fi
needed=$(objdump -p "$bin" | awk '/NEEDED/ {print $2}')
echo "NEEDED: $(echo $needed)"
if echo "$needed" | grep -qE 'libstdc\+\+|libgcc_s'; then
  echo "::error::$bin links the C++ runtime dynamically"; exit 1
fi
