#!/usr/bin/env bash
# zig and cargo-zigbuild for the release Linux build (ci-build.sh), sha256-pinned.
# x86_64 only: the host images are amd64 (D82).
# Usage: install-zigbuild.sh <dest> | --print
set -euo pipefail
arch=${FLEET_ZB_ARCH:-$(uname -m)}
case "$arch" in
  x86_64)
    zig_sha=24aeeec8af16c381934a6cd7d95c807a8cb2cf7df9fa40d359aa884195c4716c
    czb=cargo-zigbuild-x86_64-unknown-linux-musl
    czb_sha=f09b180a517af0e4dd4bffc921bb88e5ab705452a9dd948c61e489b3020c68c2 ;;
  *) echo "install-zigbuild: unsupported arch $arch" >&2; exit 1 ;;
esac
zig=zig-$arch-linux-0.14.1
zig_url=https://ziglang.org/download/0.14.1/$zig.tar.xz
czb_url=https://github.com/rust-cross/cargo-zigbuild/releases/download/v0.24.1/$czb.tar.xz
if [ "${1:-}" = --print ]; then
  printf '%s %s\n%s %s\n' "$zig_url" "$zig_sha" "$czb_url" "$czb_sha"
  exit 0
fi
dest=${1:?usage: install-zigbuild.sh <dest> | --print}
mkdir -p "$dest/bin"
dest=$(cd "$dest" && pwd)
cd "$dest"
curl -fsSL --retry 3 -o zig.tar.xz "$zig_url"
echo "$zig_sha  zig.tar.xz" | sha256sum -c -
curl -fsSL --retry 3 -o czb.tar.xz "$czb_url"
echo "$czb_sha  czb.tar.xz" | sha256sum -c -
tar -xJf zig.tar.xz && tar -xJf czb.tar.xz && rm zig.tar.xz czb.tar.xz
ln -sf "$dest/$zig/zig" bin/zig
ln -sf "$dest/$czb/cargo-zigbuild" bin/cargo-zigbuild
