# Dev runner image (`runner-dev`)

## Problem

The base runner image (`docker/Dockerfile`, `node:22-bookworm-slim`) is
deliberately lean: it has no C/C++ build toolchain, so `npm ci` inside a
workspace cannot compile the app's native modules (`better-sqlite3`,
`node-pty`, `keytar`), `npx electron-rebuild` cannot run, and the Playwright
e2e suite cannot execute (missing browser system libraries). Developing
claude-fleet *itself* inside a workspace — or doing any native/polyglot build
work — therefore requires tools the runner does not carry.

The `devops` variant adds a platform-engineering toolset (kubectl, Argo, AWS,
…) but nothing for compiling code, and it is scoped to committee/IaC work.

## Goal

A general **polyglot dev image** that also carries everything needed to build
and test claude-fleet: a C/C++ build toolchain, Python, Go, and Rust, plus the
Playwright browser **system libraries**. It intentionally does **not** include
the devops cloud/k8s tooling (kubectl, Argo, AWS, …).

## Architecture

A third sibling variant, `docker/dev/Dockerfile`, built `FROM ${BASE_IMAGE}`
(the base runner, pinned by digest) — exactly the pattern `docker/devops/`
uses. Building `FROM` the base (not `FROM` devops) is what keeps argo/kubectl/
aws out: they are only ever layered by the devops image, so a base-sibling
simply never has them. Published to GHCR as
`ghcr.io/<owner>/claude-fleet/runner-dev`.

All tools install at **build time as root** (`USER root` … `USER fleet`, like
devops) into **world-readable system locations**, so any host UID
(`docker run --user`) can use them at runtime. The container still runs as the
non-root `fleet` user with the base entrypoint (tini) + CMD (broker).

## Toolset

Installed via shared, arch-aware scripts under `docker/scripts/` (one per
toolset), following existing conventions: `source _arch.sh` for
`ARCH_DEB`/`ARCH_GNU`, and smoke each tool with `… | sed -n '1p'` (never
`head`, which SIGPIPEs the producer under QEMU on the arm64 leg).

**Native-build toolchain (apt, `dev-build.sh`)** — `build-essential` (gcc/g++/
make), `pkg-config`, `python3`/`python3-pip`/`python3-venv`, and
`libsecret-1-dev` (keytar's build dependency). This is what lets a workspace
`npm ci` compile `better-sqlite3`/`node-pty`/`keytar` and run
`npx electron-rebuild`.

**Playwright system libs (apt, in `dev-build.sh`)** — the OS libraries
Playwright's browsers need (`libnss3`, `libnspr4`, `libatk1.0-0`,
`libatk-bridge2.0-0`, `libcups2`, `libdrm2`, `libgbm1`, `libasound2`,
`libxkbcommon0`, `libxcomposite1`, `libxdamage1`, `libxfixes3`, `libxrandr2`,
`libpango-1.0-0`, `libcairo2`, `fonts-liberation`). These require root and so
must be baked. The **browsers themselves are not baked** — a workspace runs the
one-line, non-root `npx playwright install` at runtime, which downloads into
`~/.cache/ms-playwright` without root.

**Go (`go.sh`)** — official tarball → `/usr/local/go`, `PATH` += `/usr/local/go/
bin`, `GOTOOLCHAIN=local`. (The base builds the broker with Go in a *build
stage* only; the runtime image has no Go.)

**Rust (`rust.sh`)** — `rustup` with `CARGO_HOME=/opt/cargo` and
`RUSTUP_HOME=/opt/rustup` (world-readable), stable toolchain pinned; `PATH` +=
`/opt/cargo/bin`. Provides `cargo`/`rustc`/`clippy`/`rustfmt`.

**Python** — `python3`/`pip`/`venv` from apt (in `dev-build.sh`), plus **`uv`**
(`uv.sh`) installed to `/usr/local/bin` for a fast, self-contained workflow.

**Node** — already in the base (`node:22`); nothing to add.

### Capability metadata

Image labels the app surfaces as searchable chips in the workspace image
picker:

```
com.claude-fleet.variant="dev"
com.claude-fleet.capabilities="gcc g++ make pkg-config python3 pip uv go rust cargo playwright-deps electron-rebuild"
org.opencontainers.image.title="claude-fleet runner · dev"
org.opencontainers.image.description="Base claude-fleet runner + polyglot dev toolchain: C/C++ build-essential, Python + uv, Go, Rust (rustup), and Playwright browser system libs. Builds the app's native modules and runs its test suite."
```

## Versioning

`docker/versions.yaml` gains pinned `go`, `rust`, and `uv` entries (same "bump
deliberately" discipline). apt-sourced packages (build-essential, python3,
Playwright libs) track the Debian bookworm repo and need no pin. The dev
Dockerfile sets `ARG` defaults mirroring `versions.yaml`; CI passes them via
`--build-arg`.

## CI

`.github/workflows/publish-runner.yml` gains a third build step after devops,
identical in shape:

- `docker/metadata-action` for `runner-dev` tags (`latest` on default branch +
  `sha`).
- `docker/build-push-action` with `file: docker/dev/Dockerfile`, repo root as
  context, multi-arch `linux/amd64,linux/arm64`, GHA cache.
- `BASE_IMAGE` pinned to the just-built base **digest** (lockstep with base).
- The `github_token` BuildKit secret exported for the installers (rustup/Go/uv
  hit GitHub releases → same anonymous rate-limit risk devops guards against).

## Testing

`docker/dev/smoke.test.sh` asserts, **as the non-root `fleet` user** against a
built image, that each toolchain answers for its version: `gcc`, `g++`, `make`,
`pkg-config`, `python3`, `pip3`, `uv`, `go`, `cargo`, `rustc`, and that
`pkg-config --exists libsecret-1`. Running as `fleet` is the real regression
guard: a tool installed root-only that `fleet` cannot reach on `PATH` is the
failure mode this catches. CI runs it after the dev build.

## Docs

`docs/SPEC.md` §runner-images gains a `dev` variant paragraph alongside devops,
and notes it as the recommended "custom runner image" escape hatch referenced
in the loadout tool-dependencies section (system packages needing root are not
auto-installed; a dev image bakes them).

## Non-goals

- No browsers baked into the image (runtime `npx playwright install` covers it).
- No devops/cloud tooling (that is the devops image's job).
- No change to the base image — it stays lean and non-root.
