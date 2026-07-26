# syntax=docker/dockerfile:1
# Dev runner image — the base claude-fleet runner + a polyglot dev toolchain:
# C/C++ build-essential, Python + uv, Go, Rust (rustup), the GitHub CLI (gh),
# and the Playwright browser system libraries. Builds the app's native modules
# (better-sqlite3, node-pty, keytar), runs `npx electron-rebuild`, drives PRs
# with `gh`, and runs the e2e suite (browsers install non-root at runtime via
# `npx playwright install`).
#
# Built FROM the published base (NOT devops — so it carries none of the
# cloud/k8s tooling). Build with the REPO ROOT as context so docker/scripts/
# are reachable.
ARG BASE_IMAGE=ghcr.io/imioimi/claude-fleet/runner:latest
FROM ${BASE_IMAGE}

# Tool versions — defaults mirror docker/versions.yaml; CI passes them via
# --build-arg from that file so there's one source of truth.
ARG GO_VERSION=1.23.5
ARG RUST_VERSION=1.84.0
ARG UV_VERSION=0.5.14
ARG GH_VERSION=2.87.3

# Capability metadata — claude-fleet surfaces image labels as searchable chips
# in the workspace image picker.
LABEL org.opencontainers.image.title="claude-fleet runner · dev" \
      org.opencontainers.image.description="Base claude-fleet runner + polyglot dev toolchain: C/C++ build-essential, Python + uv, Go, Rust (rustup), GitHub CLI (gh), and Playwright browser system libs. Builds the app's native modules and runs its test suite." \
      com.claude-fleet.variant="dev" \
      com.claude-fleet.capabilities="gcc g++ make pkg-config python3 pip uv go rust cargo gh playwright-deps electron-rebuild"

# World-readable toolchain roots so any container UID (docker run --user) can
# use them; PATH picks up each toolchain's bin.
ENV GOTOOLCHAIN=local \
    CARGO_HOME=/opt/cargo \
    RUSTUP_HOME=/opt/rustup \
    PATH=/usr/local/go/bin:/opt/cargo/bin:/usr/local/bin:$PATH

USER root
COPY docker/scripts/ /opt/install-scripts/
# Installers hit GitHub releases (rust/go/uv) → anonymous builds risk the
# 60 req/hr/IP limit. Mount CI's token as a BuildKit secret (optional; keeps
# it out of image layers).
RUN --mount=type=secret,id=github_token set -eux; \
    if [ -f /run/secrets/github_token ]; then \
      GITHUB_TOKEN="$(cat /run/secrets/github_token)"; export GITHUB_TOKEN; \
    fi; \
    cd /opt/install-scripts; \
    bash dev-build.sh; \
    bash go.sh; \
    bash rust.sh; \
    bash uv.sh; \
    bash gh.sh; \
    rm -rf /opt/install-scripts

# Back to the unprivileged fleet user. ENTRYPOINT (tini) + CMD (broker) are
# inherited from the base — still a fleet runner, just with a dev toolchain.
USER fleet
WORKDIR /workspace
