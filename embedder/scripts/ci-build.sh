#!/usr/bin/env bash
# Build fleet-embedder for the runner's OS into embedder/bin/ and check it
# (embedder/README.md "Packaging"). Run from the repo root.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p bin
case "$(uname -s)" in
  Linux)
    # glibc 2.28 floor via zig's versioned glibc stubs. libstdc++ is linked
    # statically by build.rs; the empty ORT_CXX_STDLIB stops ort-sys also
    # linking it dynamically.
    # onnxruntime is fetched here, not by ort-sys: with host == target, zig
    # would also compile ort-sys's build-time OpenSSL and fails to.
    cargo fetch --locked
    ver=$(awk '/^name = "ort-sys"/ {getline; gsub(/[" ]/, "", $0); sub(/version=/, ""); print}' Cargo.lock)
    dist=$(find "${CARGO_HOME:-$HOME/.cargo}/registry/src" -path "*/ort-sys-$ver/dist.txt" | head -1)
    read -r url sha < <(awk -F'\t' '$1 == "none" && $2 == "x86_64-unknown-linux-gnu" {print $3, $4}' "$dist")
    mkdir -p target/ort && curl -fsSL "$url" -o target/ort/ort.tgz
    echo "$(echo "$sha" | tr A-F a-f)  target/ort/ort.tgz" | sha256sum -c -
    tar -xzf target/ort/ort.tgz -C target/ort
    ORT_LIB_LOCATION=$PWD/target/ort/onnxruntime/lib ORT_CXX_STDLIB= \
      cargo zigbuild --release --locked --no-default-features --target x86_64-unknown-linux-gnu.2.28
    cp target/x86_64-unknown-linux-gnu/release/fleet-embedder bin/
    scripts/check-glibc.sh bin/fleet-embedder 2.28
    exe=bin/fleet-embedder ;;
  Darwin)
    cargo build --release --locked
    cp target/release/fleet-embedder bin/
    # arm64 kills unsigned code: the linker's ad-hoc signature must survive strip.
    codesign -v --strict bin/fleet-embedder
    exe=bin/fleet-embedder ;;
  MINGW*|MSYS*|CYGWIN*)
    cargo build --release --locked
    cp target/release/fleet-embedder.exe bin/
    # App-local VC++ runtime (the static onnxruntime is /MD); DirectML, D3D12,
    # DXGI and DXCore are Windows system DLLs.
    for dll in msvcp140.dll msvcp140_1.dll vcruntime140.dll vcruntime140_1.dll; do
      cp "/c/Windows/System32/$dll" bin/
    done
    exe=bin/fleet-embedder.exe ;;
  *) echo "unsupported OS $(uname -s)"; exit 1 ;;
esac
# Smoke: it must start and report a bad model dir as a fatal frame (exit 1).
set +e
"$exe" --model-dir does-not-exist </dev/null >smoke.out
code=$?
set -e
out=$(tail -c +5 smoke.out); rm -f smoke.out
echo "smoke: exit=$code $out"
if [ "$code" != 1 ] || [[ "$out" != *'"type":"fatal"'* ]]; then
  echo "::error::fleet-embedder did not start"; exit 1
fi
