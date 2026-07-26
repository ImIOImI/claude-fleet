# Dev Runner Image Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `runner-dev` image variant: the base runner plus a polyglot dev toolchain (C/C++, Python+uv, Go, Rust) and Playwright browser system libs, so a workspace can build claude-fleet's native modules and run its test suite.

**Architecture:** A sibling variant `docker/dev/Dockerfile` built `FROM ${BASE_IMAGE}` (base runner by digest), mirroring `docker/devops/`. Tools install at build time as root into world-readable locations via arch-aware scripts in `docker/scripts/`; the container still runs non-root as `fleet`. CI's `publish-runner.yml` builds it after base, pinned to the base digest.

**Tech Stack:** Docker (BuildKit, multi-arch amd64/arm64), bash installer scripts, GitHub Actions, apt (Debian bookworm), rustup, Go tarball, uv.

## Global Constraints

- Base image is `node:22-bookworm-slim`; dev variant is `FROM ${BASE_IMAGE}` (default `ghcr.io/imioimi/claude-fleet/runner:latest`), **never** `FROM` devops — this is what keeps argo/kubectl/aws out.
- Tools install as root at build time (`USER root` … end `USER fleet`); install into **world-readable** system locations (`/usr/local`, `/opt/*`) so any `docker run --user` UID can use them.
- Installer scripts: `set -euo pipefail`; `source "$(dirname "$0")/_arch.sh"` for `ARCH_DEB`/`ARCH_GNU`; smoke tools with `… | sed -n '1p'` — **never `head`** (SIGPIPEs the producer under QEMU on the arm64 leg → exit 141 → build failure).
- Version pins live in `docker/versions.yaml`; the Dockerfile sets `ARG` defaults mirroring them.
- Repo root is the build context (so `docker/scripts/` is reachable); `.dockerignore` already opts `docker/` in.
- Local env has no Docker: verification is `shellcheck` on scripts + YAML parse. The image build and `smoke.test.sh` run in CI.

---

### Task 1: Version pins

**Files:**
- Modify: `docker/versions.yaml`

**Interfaces:**
- Produces: `GO_VERSION`, `RUST_VERSION`, `UV_VERSION` build args sourced from these values.

- [ ] **Step 1: Add pins** to `docker/versions.yaml` under a new "Dev image" section:

```yaml

# Dev image toolchains (docker/dev/Dockerfile).
go: 1.23.5            # Go — official tarball into /usr/local/go
rust: 1.84.0          # Rust — rustup toolchain (cargo/rustc/clippy)
uv: 0.5.14            # uv — fast Python package/venv manager
```

- [ ] **Step 2: Validate YAML parses**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('docker/versions.yaml')); print('ok')"`
Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git add docker/versions.yaml
git commit -m "chore(docker): pin go/rust/uv for dev runner image"
```

---

### Task 2: Native-build toolchain + Playwright libs script

**Files:**
- Create: `docker/scripts/dev-build.sh`

**Interfaces:**
- Produces: on PATH after run — `gcc`, `g++`, `make`, `pkg-config`, `python3`, `pip3`; and `pkg-config --exists libsecret-1` succeeds; Playwright browser system libs present.

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
# Dev image tier: the C/C++ build toolchain that lets a workspace compile
# claude-fleet's native modules (better-sqlite3, node-pty, keytar) and run
# `npx electron-rebuild`, plus the OS libraries Playwright's browsers need.
# Browsers themselves are NOT baked — a workspace runs the non-root
# `npx playwright install` at runtime (downloads into ~/.cache/ms-playwright).
# Run as root during image build.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  build-essential \
  pkg-config \
  python3 \
  python3-pip \
  python3-venv \
  libsecret-1-dev \
  ca-certificates \
  curl \
  unzip
# Playwright browser runtime libraries (root-only; browsers install non-root
# at runtime). Mirrors `playwright install-deps` for chromium/firefox/webkit.
apt-get install -y --no-install-recommends \
  libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
  libgbm1 libasound2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
  libxrandr2 libpango-1.0-0 libcairo2 fonts-liberation
rm -rf /var/lib/apt/lists/*

# Smoke — sed -n '1p', NOT head (QEMU SIGPIPE on the arm64 leg).
gcc --version | sed -n '1p'
g++ --version | sed -n '1p'
make --version | sed -n '1p'
pkg-config --version | sed -n '1p'
python3 --version | sed -n '1p'
pkg-config --exists libsecret-1 && echo "libsecret-1: ok"
```

- [ ] **Step 2: shellcheck**

Run: `shellcheck docker/scripts/dev-build.sh`
Expected: no output (clean).

- [ ] **Step 3: Commit**

```bash
git add docker/scripts/dev-build.sh
git commit -m "feat(docker): dev-build.sh — build toolchain + Playwright libs"
```

---

### Task 3: Go installer

**Files:**
- Create: `docker/scripts/go.sh`

**Interfaces:**
- Consumes: `GO_VERSION` (default `1.23.5`), `ARCH_DEB` from `_arch.sh`.
- Produces: `/usr/local/go`; `go` on PATH via `/usr/local/go/bin`.

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
# Go — official tarball into /usr/local/go (world-readable). The base builds
# the broker with Go in a build stage only; the runtime image has no Go until
# this runs. PATH/GOTOOLCHAIN are set by the Dockerfile ENV.
set -euo pipefail
source "$(dirname "$0")/_arch.sh"
V="${GO_VERSION:-1.23.5}"
tmp="$(mktemp -d)"
curl -fsSL "https://go.dev/dl/go${V}.linux-${ARCH_DEB}.tar.gz" | tar -xz -C "$tmp"
rm -rf /usr/local/go
mv "$tmp/go" /usr/local/go
rm -rf "$tmp"
/usr/local/go/bin/go version | sed -n '1p'
```

- [ ] **Step 2: shellcheck**

Run: `shellcheck docker/scripts/go.sh`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add docker/scripts/go.sh
git commit -m "feat(docker): go.sh — official Go tarball installer"
```

---

### Task 4: Rust installer

**Files:**
- Create: `docker/scripts/rust.sh`

**Interfaces:**
- Consumes: `RUST_VERSION` (default `1.84.0`).
- Produces: `/opt/cargo` (`CARGO_HOME`), `/opt/rustup` (`RUSTUP_HOME`), world-readable; `cargo`/`rustc` on PATH via `/opt/cargo/bin`.

- [ ] **Step 1: Write the script**

```bash
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
```

- [ ] **Step 2: shellcheck**

Run: `shellcheck docker/scripts/rust.sh`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add docker/scripts/rust.sh
git commit -m "feat(docker): rust.sh — rustup into world-readable /opt"
```

---

### Task 5: uv installer

**Files:**
- Create: `docker/scripts/uv.sh`

**Interfaces:**
- Consumes: `UV_VERSION` (default `0.5.14`), `ARCH_GNU` from `_arch.sh`.
- Produces: `uv` + `uvx` in `/usr/local/bin`.

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
# uv — fast Python package/venv manager. Pinned release tarball into
# /usr/local/bin (world-executable).
set -euo pipefail
source "$(dirname "$0")/_arch.sh"
V="${UV_VERSION:-0.5.14}"
tmp="$(mktemp -d)"
curl -fsSL "https://github.com/astral-sh/uv/releases/download/${V}/uv-${ARCH_GNU}-unknown-linux-gnu.tar.gz" \
  | tar -xz -C "$tmp"
install -m 0755 "$tmp/uv-${ARCH_GNU}-unknown-linux-gnu/uv"  /usr/local/bin/uv
install -m 0755 "$tmp/uv-${ARCH_GNU}-unknown-linux-gnu/uvx" /usr/local/bin/uvx
rm -rf "$tmp"
uv --version | sed -n '1p'
```

- [ ] **Step 2: shellcheck**

Run: `shellcheck docker/scripts/uv.sh`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add docker/scripts/uv.sh
git commit -m "feat(docker): uv.sh — pinned uv installer"
```

---

### Task 6: Dev Dockerfile

**Files:**
- Create: `docker/dev/Dockerfile`

**Interfaces:**
- Consumes: `docker/scripts/{dev-build,go,rust,uv}.sh`, `docker/versions.yaml` values via ARGs.
- Produces: image with all toolchains on PATH for the non-root `fleet` user; base entrypoint/CMD inherited.

- [ ] **Step 1: Write the Dockerfile**

```dockerfile
# syntax=docker/dockerfile:1
# Dev runner image — the base claude-fleet runner + a polyglot dev toolchain:
# C/C++ build-essential, Python + uv, Go, Rust (rustup), and the Playwright
# browser system libraries. Builds the app's native modules (better-sqlite3,
# node-pty, keytar), runs `npx electron-rebuild`, and runs the e2e suite
# (browsers install non-root at runtime via `npx playwright install`).
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

# Capability metadata — claude-fleet surfaces image labels as searchable chips
# in the workspace image picker.
LABEL org.opencontainers.image.title="claude-fleet runner · dev" \
      org.opencontainers.image.description="Base claude-fleet runner + polyglot dev toolchain: C/C++ build-essential, Python + uv, Go, Rust (rustup), and Playwright browser system libs. Builds the app's native modules and runs its test suite." \
      com.claude-fleet.variant="dev" \
      com.claude-fleet.capabilities="gcc g++ make pkg-config python3 pip uv go rust cargo playwright-deps electron-rebuild"

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
    rm -rf /opt/install-scripts

# Back to the unprivileged fleet user. ENTRYPOINT (tini) + CMD (broker) are
# inherited from the base — still a fleet runner, just with a dev toolchain.
USER fleet
WORKDIR /workspace
```

- [ ] **Step 2: Sanity-check ARG defaults match versions.yaml**

Run: `grep -E 'GO_VERSION|RUST_VERSION|UV_VERSION' docker/dev/Dockerfile && grep -E '^(go|rust|uv):' docker/versions.yaml`
Expected: versions align (1.23.5 / 1.84.0 / 0.5.14).

- [ ] **Step 3: Commit**

```bash
git add docker/dev/Dockerfile
git commit -m "feat(docker): dev runner Dockerfile (runner-dev variant)"
```

---

### Task 7: Smoke test

**Files:**
- Create: `docker/dev/smoke.test.sh`

**Interfaces:**
- Consumes: a built dev image tag as `$1` (default `claude-fleet/runner-dev:test`).
- Produces: exit 0 iff every toolchain answers **as the non-root `fleet` user**.

- [ ] **Step 1: Write the test**

```bash
#!/usr/bin/env bash
# Smoke the dev runner image AS THE NON-ROOT fleet USER — the real regression
# guard is a tool installed root-only that `fleet` can't reach on PATH.
# Usage: docker/dev/smoke.test.sh [image-tag]
set -euo pipefail
IMG="${1:-claude-fleet/runner-dev:test}"

run() { docker run --rm --user fleet --entrypoint bash "$IMG" -lc "$1"; }

echo "== dev runner smoke ($IMG, user=fleet) =="
run 'gcc --version        | sed -n "1p"'
run 'g++ --version        | sed -n "1p"'
run 'make --version       | sed -n "1p"'
run 'pkg-config --version | sed -n "1p"'
run 'pkg-config --exists libsecret-1 && echo "libsecret-1: ok"'
run 'python3 --version    | sed -n "1p"'
run 'pip3 --version       | sed -n "1p"'
run 'uv --version         | sed -n "1p"'
run 'go version           | sed -n "1p"'
run 'cargo --version      | sed -n "1p"'
run 'rustc --version      | sed -n "1p"'
echo "== all toolchains reachable as fleet =="
```

- [ ] **Step 2: shellcheck + chmod**

Run: `shellcheck docker/dev/smoke.test.sh && chmod +x docker/dev/smoke.test.sh`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add docker/dev/smoke.test.sh
git commit -m "test(docker): non-root smoke test for dev runner image"
```

---

### Task 8: CI publish step

**Files:**
- Modify: `.github/workflows/publish-runner.yml` (append after the devops build step, ~line 95)

**Interfaces:**
- Consumes: `steps.base.outputs.digest`, `steps.owner.outputs.value`.
- Produces: `ghcr.io/<owner>/claude-fleet/runner-dev` pushed multi-arch, then smoke-tested.

- [ ] **Step 1: Append the dev build + smoke steps**

```yaml

      # ── Dev runner (FROM the base digest; polyglot toolchain, no cloud/k8s) ─
      - name: Dev metadata
        id: meta_dev
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/${{ steps.owner.outputs.value }}/claude-fleet/runner-dev
          tags: |
            type=raw,value=latest,enable={{is_default_branch}}
            type=sha,format=short

      - name: Build and push dev
        uses: docker/build-push-action@v5
        with:
          context: .
          file: docker/dev/Dockerfile
          platforms: linux/amd64,linux/arm64
          push: true
          build-args: |
            BASE_IMAGE=ghcr.io/${{ steps.owner.outputs.value }}/claude-fleet/runner@${{ steps.base.outputs.digest }}
          secrets: |
            github_token=${{ secrets.GITHUB_TOKEN }}
          tags: ${{ steps.meta_dev.outputs.tags }}
          labels: ${{ steps.meta_dev.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

      # Smoke the native-arch image as the non-root fleet user (load one-arch
      # locally so `docker run` can execute it on the runner).
      - name: Build dev (amd64, load) for smoke
        uses: docker/build-push-action@v5
        with:
          context: .
          file: docker/dev/Dockerfile
          platforms: linux/amd64
          load: true
          build-args: |
            BASE_IMAGE=ghcr.io/${{ steps.owner.outputs.value }}/claude-fleet/runner@${{ steps.base.outputs.digest }}
          secrets: |
            github_token=${{ secrets.GITHUB_TOKEN }}
          tags: claude-fleet/runner-dev:test
          cache-from: type=gha

      - name: Smoke dev image
        run: bash docker/dev/smoke.test.sh claude-fleet/runner-dev:test
```

- [ ] **Step 2: Validate workflow YAML parses**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/publish-runner.yml')); print('ok')"`
Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/publish-runner.yml
git commit -m "ci: build, push, and smoke-test the dev runner image"
```

---

### Task 9: SPEC docs

**Files:**
- Modify: `docs/SPEC.md` (the runner-images section, ~line 78 after the DevOps paragraph)

**Interfaces:**
- Produces: a `dev` variant paragraph; cross-reference from the loadout tool-dependencies note (~line 649) that a dev image is the root-package escape hatch.

- [ ] **Step 1: Add the dev-image paragraph** after the DevOps paragraph:

```markdown
**Dev image** (`…/claude-fleet/runner-dev`, `docker/dev/Dockerfile`) is built **`FROM` the base** (not devops — it carries none of the cloud/k8s tooling) and layers a **polyglot dev toolchain**: C/C++ `build-essential` (gcc/g++/make/pkg-config) + `libsecret-1-dev`, Python (`python3`/`pip`/`venv` + `uv`), Go (`/usr/local/go`), Rust (rustup into world-readable `/opt/cargo`+`/opt/rustup`), and the **Playwright browser system libraries** (browsers themselves install non-root at runtime via `npx playwright install`). This is the image for developing/building **claude-fleet itself** inside a workspace — it compiles the app's native modules (`better-sqlite3`, `node-pty`, `keytar`), runs `npx electron-rebuild`, and runs the e2e suite. Toolchains install as root at build time into **world-readable** locations (so any `docker run --user` UID reaches them on `PATH`); the container still runs non-root as `fleet`. Capability label `com.claude-fleet.variant=dev`. Version pins for go/rust/uv live in `docker/versions.yaml`; the publish workflow builds it after the base with `--build-arg BASE_IMAGE=<base digest>` and runs `docker/dev/smoke.test.sh` (asserts every toolchain is reachable as `fleet`).
```

- [ ] **Step 2: Cross-reference the escape hatch** — at the loadout tool-dependencies note (search `custom runner image`), ensure it points at the dev image as a concrete example. Change the phrase `the recommended escape hatch is a custom runner image` to `the recommended escape hatch is a custom runner image (e.g. the **dev** variant, which bakes build-essential/Python/Go/Rust)`.

- [ ] **Step 3: Commit**

```bash
git add docs/SPEC.md
git commit -m "docs(spec): document the dev runner image variant"
```

---

## Self-Review

- **Spec coverage:** architecture (Task 6), toolset — native/Playwright (Task 2), Go (3), Rust (4), Python/uv (2+5), capability labels (Task 6), versioning (Task 1), CI (Task 8), smoke test (Task 7), docs (Task 9). All spec sections mapped.
- **Type/name consistency:** `BASE_IMAGE`, `GO_VERSION`/`RUST_VERSION`/`UV_VERSION`, `CARGO_HOME=/opt/cargo`, `RUSTUP_HOME=/opt/rustup`, `/usr/local/go` used identically across the Dockerfile, scripts, ENV, and smoke test.
- **Placeholders:** none — every script and edit shows full content.
