#!/usr/bin/env bash
# Rust via rustup into world-readable /opt (not $HOME) so every container UID
# (docker run --user) shares one toolchain. PATH is set by the Dockerfile ENV.
set -euo pipefail
V="${RUST_VERSION:-1.84.0}"
export CARGO_HOME=/opt/cargo RUSTUP_HOME=/opt/rustup
curl -fsSL https://sh.rustup.rs \
  | sh -s -- -y --no-modify-path --profile minimal --default-toolchain "$V" \
      --component clippy rustfmt
# World-readable/executable so a non-root `fleet` (or any --user UID) can use it.
chmod -R a+rX /opt/cargo /opt/rustup
/opt/cargo/bin/rustc --version | sed -n '1p'
/opt/cargo/bin/cargo --version | sed -n '1p'
