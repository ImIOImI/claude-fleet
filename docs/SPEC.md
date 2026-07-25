# claude-fleet — product spec

This document is the single source of truth for what claude-fleet is and how it's built. The bar is rebuild-from-spec: a competent engineer (or Claude) reading only this file should be able to rebuild a functionally equivalent application.

See [`.claude/rules/spec-maintenance.md`](../.claude/rules/spec-maintenance.md) for the rule that keeps this doc honest.

---

## 1. Overview

**claude-fleet** is a desktop application for driving a small fleet (3–6) of Claude Code **workspaces** from a single window. The user picks an auth mode (OAuth via Claude.ai, or API key supplied as a per-workspace env-var secret); the app spins up a workspace (today: a Docker container backed by `dockerode`) — each gets a private host folder plus a fleet-wide shared folder under an app-level "fleet root" — running `claude` in a PTY, renders the live terminal with xterm.js, and surfaces structured observability (cost, tokens, tool calls, transcript history) sourced from the workspace's bind-mounted Claude transcript JSONL.

It is a local-only operator console — not a remote orchestrator, not a multi-user service, not a cloud product. Everything runs on the user's machine, against the user's local Docker daemon.

**Terminology.** "Workspace" is the user-level concept the UI talks about: a named place where a Claude session runs against a directory. It's persisted on disk as a manifest at `<userData>/state/<id>/workspace.json` independent of any backend's lifecycle, so workspaces survive container deletion and can be restarted. "Container" in this doc refers specifically to a Docker-container backend; a **local** (non-container) backend that runs `claude` directly on the host is also implemented (#16, Linux/macOS). A workspace's `kind` selects which.

## 2. Goals

- Run multiple Claude Code sessions in parallel, each fully isolated in its own workspace with its own host-directory bind-mount.
- One window, one keyboard, one set of credentials — no juggling terminals or shells.
- Workspaces persist across backend lifecycle. Each workspace has an immutable ULID `id` and a mutable display `name`; the host-side manifest at `<userData>/state/<id>/workspace.json` survives container deletion and rename. The workspace modal's Saved tab lists every stopped / deleted workspace (the "cold" fleet — running/paused live in the top strip); each row expands inline into an edit form so the user can adjust the spec before the Resume button starts the container (looked up by `com.claude-fleet.id` label) — or recreates from the saved spec, reusing the same ULID so state-dir + vault history stay attached.
- Persistent **expert workspaces**: pause an entire workspace plus its session set, then resume later and re-attach to every session right where it was — same conversation, same in-memory context. Lets the user build domain-specific agents that load their architecture / documentation / codebase knowledge once, sleep when idle, and wake up ready to act (analyze a PR, answer a question, run a check) without re-priming the context every time.
- Live terminal fidelity: cursor, colors, resize, paste, scrollback — all the things xterm.js gives you.
- Structured observability layered on top of the raw terminal: per-session cost, token counts, tool calls, transcript history — read from the Claude transcript JSONL that the CLI already writes, not by scraping the terminal stream.
- A global, workspace-filterable table of past Claude Code sessions with auto-generated short descriptions — selectable to resume any session in any workspace, regardless of which workspace originally ran it. Sessions persist across workspace deletion; the table is the durable record of past work.
- Drop OS files, pasted images, web content, or text fragments onto the window and have them saved into the selected workspace's directory where the agent can read them. The window is the inbox; the path lands on the clipboard for the user to reference in their next prompt.
- A durable, append-only mirror of every event Claude Code emits, written to `<workspace>/_history/<session-id>.jsonl` so the agent or user can refer back to pre-compaction turns. Whether the mirror is written, and whether it survives an explicit "Close terminal", are per-profile defaults (factory: write the mirror, delete on close). Both defaults can be overridden — the write decision at open time, the cleanup decision in the modal at close time. The mirror, when written, persists across pane switches, workspace restarts, and app exits; only the explicit Close action prompts the cleanup question.
- An always-on, structured log of every prompt Claude makes to the user — permission requests, `AskUserQuestion` calls, and plan-mode approvals — captured to a SQLite table the UI can review. The point is to give the user a substrate for tuning `.claude/settings.json` permissions and CLAUDE.md guidance over time: read what Claude is repeatedly asking about, then decide what to allow, deny, or document.
- Claude inside each workspace can query the application's state DB (sessions, cost, prompts, events) through a read-only MCP server exposed by claude-fleet. The agent gets typed tools for common queries — enough to consult its own past sessions, summarize cost patterns, or audit what it's been asking the user about — plus a scoped `query` tool for ad-hoc SQL. Reads are confined to the caller's own workspace (plus any it holds a `read` grant over); the `query` tool enforces this structurally via a per-call in-memory snapshot, not via SQL parsing.
- Credentials never touch the renderer process or the host filesystem in plaintext. They live in the OS keychain and are injected into workspaces as environment variables by the main process.

## 3. Non-goals

- **Not a remote orchestrator.** No SSH, no Kubernetes, no remote daemons. Local Docker only.
- **Not multi-user.** One user, one machine, one keychain.
- **Not a generic terminal multiplexer.** Every session targets `claude` in a managed container. No arbitrary shells, no `docker exec` on unmanaged containers.
- **Not a session recorder.** Terminal output is rendered but not persisted; durable history comes from Claude's own transcript JSONL, not from the PTY stream.
- **Not a Claude Code replacement.** The CLI inside the container is the source of truth for what runs. This app is a viewport and lifecycle manager around it.
- **No auto-updater, no telemetry.** The runner image sets `DISABLE_AUTOUPDATER=1` and `DISABLE_TELEMETRY=1`.
- **Not a general port manager (v1).** Port-forward preview auto-detects dev servers and opens them in the system browser — no manual port pinning, no persistent port list, no arbitrary `host:port` dialing, no LAN exposure, no in-app preview tab.

## 4. Stack

| Layer | Choice | Why |
|---|---|---|
| Shell | Electron | Native window with full Node.js access in the main process — needed for Docker socket, OS keychain, and SQLite. |
| Bundler | `electron-vite` + Vite | One config covers main/preload/renderer with sensible defaults; HMR for the renderer; no hand-rolled Webpack. |
| UI | React 18 + TypeScript | Standard, well-understood. TypeScript is non-negotiable given the IPC surface area. |
| Terminal | `@xterm/xterm` + `@xterm/addon-fit` | The de facto web terminal. Handles ANSI, resize, scrollback, paste, copy-on-select. |
| Docker client | `dockerode` | Promise-based wrapper over the Docker Engine API with first-class streaming `exec` attach (needed for live PTY). Avoids shelling out to the `docker` CLI. |
| Credentials | Electron `safeStorage` | Backs the per-workspace secret vault (`<userData>/secrets.enc`). Real OS encryption on macOS/Windows (and Linux with a desktop keyring). On Linux with no keyring (e.g. WSL) it opts into safeStorage's **plaintext backend** (`setUsePlainTextEncryption(true)` → base64, *not* OS-encrypted) so the vault is at least functional — which `keytar` was not (it failed outright). (`keytar` is retained only for the one-time purge of legacy entries in `migration.ts`.) |
| Local DB | `better-sqlite3` | Synchronous SQLite for the history/cost layer. Single-file, embedded, no daemon. JSONL→SQLite cache + cost rollup ship under #2; surrounding observability work (live push, slot consumers) follows. |
| File watcher | `chokidar` | Tails JSONL transcripts as Claude Code appends to them. Battle-tested cross-platform layer above `fs.watch` (atomic-rename handling, polling fallback on WSL). Imported via dynamic `await import('chokidar')` because v5 is ESM-only and the main bundle is CommonJS. |
| Unit tests | `vitest` | Fast, Vite-native runner for pure-TS modules (e.g., `pricing.ts`). Picks up `*.test.ts` next to source. E2E lives in `tests/` under Playwright. |

**Native modules.** `better-sqlite3`, `keytar` (retained for the legacy-purge migration), `node-pty`, and `onnxruntime-node` (local embedding backend — see §7 *Local embeddings*) ship as native bindings — they must match Electron's bundled Node ABI, not the system Node. The repo's `postinstall` script runs `electron-builder install-app-deps` to pull prebuilt binaries (or rebuild) for the current Electron version. Without this hook, `npm install` builds the bindings against the system Node and Electron fails to load them at runtime with a `NODE_MODULE_VERSION` mismatch. (The vault itself no longer needs a native module — `safeStorage` is built into Electron.) **`electron-builder.yml` must `asarUnpack` these native modules** (`**/*.node` plus the `better-sqlite3`/`keytar`/`node-pty`/`onnxruntime-node` trees): a `.node` binary cannot be `dlopen`'d from inside `app.asar`, so without this the packaged app crashes the moment it touches SQLite, the keychain, a PTY, or the embedding pipeline. electron-builder's automatic smart-unpack does **not** reliably catch all four, so the unpack list is declared explicitly. Runtime deps in the packaged main process must also be loaded through the **CJS loader**: `@huggingface/transformers` is required lazily via `createRequire` (its `dist/transformers.node.cjs` entry), never dynamic `import()` — Electron's ESM loader cannot resolve packages from inside `app.asar`, and a dynamic import that works in dev fails in every packaged build with a mangled `ERR_MODULE_NOT_FOUND` (#194); a regression test in `embeddings.test.ts` pins this. The transitive `sharp` dep **must ship and be asarUnpacked** (full `sharp` + `@img/*` trees — sharp's `.node` binding dlopens the libvips shared libraries relative to its own real path): transformers' CJS node build imports sharp at module load (`pipelines.js` → `utils/image.js`), so excluding it breaks every embedder load in the packaged app with `Cannot find module 'sharp'` even though text feature-extraction never uses it. An earlier revision excluded sharp to save size; that was the root failure behind the packaged `search_transcripts` breakage (#194 fallout). Size stays bounded because npm installs only the build platform's `@img/*` optional packages.

**Cross-building the Windows installer from Linux/WSL.** A `Makefile` builds the unsigned Windows NSIS installer without a Windows machine (`make wine` once, then `make dist`). The packaging works because the three native modules all resolve to Windows binaries without a host compiler: `better-sqlite3` + `keytar` have Electron-ABI Windows prebuilds that `install-app-deps --platform win32` fetches, and `node-pty` already bundles its `win32-x64`/`win32-arm64` prebuilds in the npm package. Two Linux-specific snags are handled in the `natives-win` target: (1) `cpu-features` (an *optional* transitive dep of `ssh2` via `dockerode`) has no Windows prebuild and only compiles from source — it is removed (`ssh2` runs fine without it); (2) `node-pty`'s install script keys off the *host* platform and would try to compile on Linux, so a stub `prebuilds/linux-<arch>` dir makes `npm rebuild` a no-op and preserves its bundled win32 binaries. **Wine is required only for the NSIS target** — electron-builder generates the uninstaller by executing the freshly built installer (a Windows binary). The `make portable` target produces the unpacked app dir without NSIS and therefore needs no Wine. Code signing is out of scope for this path (the installer is unsigned; users see a SmartScreen warning).

**CI build matrix.** `.github/workflows/build-app.yml` builds the app on **native runners** (`macos-latest` → `.dmg`, `windows-latest` → `.exe`, `ubuntu-latest` → `.AppImage`). macOS/Linux use a plain `npm ci` — their toolchains compile/fetch native modules directly. **Windows must not compile from source**: `node-gyp` can't detect the runner's newest Visual Studio, so the Windows job uses `npm ci --ignore-scripts`, drops the optional `cpu-features` dep, and runs `install-app-deps --platform win32` to pull the Electron-ABI prebuilts (better-sqlite3/keytar) and use node-pty's bundled win prebuild — the same prebuilt-only strategy as the Makefile, minus Wine (NSIS runs natively on the Windows runner). It runs on PRs (build + upload artifacts) and on `v*` tags (build, then publish a **draft** GitHub Release with the unsigned installers attached). The Makefile remains the path for a local Windows build from a Linux/WSL dev box without CI. Note: `npm ci` is strict about lockfile/`package.json` consistency, so `package-lock.json` must stay in sync (regenerate with `npm install --package-lock-only` if `npm ci` reports missing entries).

The **base** runner image is `ghcr.io/<owner>/claude-fleet/runner:latest`, built from `docker/Dockerfile`. Base: `node:22-bookworm-slim`. Installs `git`, `ca-certificates`, `curl`, `ripgrep`, `jq`, `less`, `socat`, `tini`, globally installs `@anthropic-ai/claude-code` **pinned to a specific version**, and ships the Go **broker** (built in an earlier stage). Runs as non-root user `fleet` (UID/GID 1000 by default). Entrypoint is `tini`; `CMD` is the broker (the long-running PID 1). The base is deliberately **lean and standalone**.

The image bakes four hook artifacts into `/usr/local/lib/claude-fleet/`:
- **`input-wait-report.sh`** — calls `signal_input_wait` on `PreToolUse[AskUserQuestion]` (`waiting=true`), and on `PostToolUse[AskUserQuestion]` / `Stop` / `UserPromptSubmit` (`waiting=false`).
- **`session-report.sh`** — `SessionStart` hook; reads `session_id` from the hook payload and `CLAUDE_FLEET_BROKER_SESSION_ID` from env, then calls `report_session_mapping` over the MCP socket. See §7 *Broker env-var contract* for the verified-mapping and drift-correction rationale.
- **`summarize.sh`** — `Stop` hook; debounced LLM chapter-summary generator. See §4 *Session-summary hook* for the full description.
- **`hooks.settings.json`** — a claude settings file that registers all three scripts for their respective hook events. The complete hook registrations: `PreToolUse[AskUserQuestion]` → `input-wait-report.sh`; `PostToolUse[AskUserQuestion]` → `input-wait-report.sh`; `Stop` → `input-wait-report.sh` + `summarize.sh`; `UserPromptSubmit` → `input-wait-report.sh`; `SessionStart` → `session-report.sh`.

Every in-container `claude` launch passes `--settings /usr/local/lib/claude-fleet/hooks.settings.json` — a **trusted load** that bypasses the `/hooks` approval gate — so all hooks fire without user confirmation. They do not affect the user's own `.claude/settings.json`.

**Session-summary hook (`summarize.sh`).** A `Stop` hook runs `docker/runner/summarize.sh`, which appends chapter-summary events to a sidecar file `<uuid>.fleet.jsonl` (never the live transcript — appending to it corrupts `--resume`). The hook counts *completed turns* — typed human prompts with string content (tool-result arrays don't count) — against a persisted state file `<uuid>.fleet.state`. It re-summarizes only when **≥ `CF_SUMMARY_MIN_NEW_TURNS` new turns** have landed since the last chapter **and ≥ `CF_SUMMARY_MIN_INTERVAL_S` seconds** have elapsed; on both default values this means the haiku call fires at most once per ~20 prompts and once per ~2 minutes. When both conditions hold, the hook extracts the *window since the last chapter* (capped to `CF_SUMMARY_WINDOW_CHARS` chars), prepends the previous chapter's summary as a one-line continuity hint ("Previously: …"), calls `claude -p --model $CF_SUMMARY_MODEL` (run from `/tmp` so the throwaway transcript does not land in the watched directory), extracts the JSON object from the reply — the substring from the first `{` to the last `}`, which tolerates the markdown ```` ```json ```` code fence and any prose models (notably haiku) wrap around it — then demands strict JSON `{"summary":"…","tags":["…"]}`, validates with jq, and on success appends `{"type":"session-summary","summary","tags","sessionId","model","fromEventTs","toEventTs"}` to the sidecar. The background invocation (`& disown`) is fire-and-forget; the hook always exits 0 and the parent claude is never blocked.

**Tunables** (workspace env, settable via the app's env-var editor — no new UI required): `CF_SUMMARY_MODEL` (default `haiku`), `CF_SUMMARY_MIN_NEW_TURNS` (default `20`), `CF_SUMMARY_MIN_INTERVAL_S` (default `120`), `CF_SUMMARY_WINDOW_CHARS` (default `8000`). The `get_config` MCP tool returns the effective values (app defaults overridden by the workspace's env) so agents can inspect the knobs; it notes that manually changing env inside the container is not reflected until recreate.

**`summarize.sh` is registered in `hooks.settings.json`** alongside `input-wait-report.sh` and baked into the runner image. The registered hooks in `hooks.settings.json` are now: `PreToolUse[AskUserQuestion]` → `input-wait-report.sh`; `PostToolUse[AskUserQuestion]` → `input-wait-report.sh`; `Stop` → `input-wait-report.sh` + `summarize.sh`; `UserPromptSubmit` → `input-wait-report.sh`; and `SessionStart` → `session-report.sh` (see env-var contract below).

**DevOps image** (`…/claude-fleet/runner-devops`, `docker/devops/Dockerfile`) is built **`FROM` the base** and layers the SumerSports platform-engineering toolset: GitHub CLI, `yq`, tenv + OpenTofu, Terramate, OPA, tflint + trivy, kubectl + kustomize, helm, `dnsutils` (`dig`), and the AWS CLI; the **Azure CLI is opt-in** (`--build-arg INSTALL_AZURE_CLI=true` — its pip tree ~doubles image size, so it's off by default). The image carries **capability labels** (`com.claude-fleet.capabilities`, `com.claude-fleet.cloud=aws=…/azure=…`, `com.claude-fleet.variant=devops`) that the app surfaces as searchable chips in the workspace image picker, so you can find "the one with kubectl/aws/tofu". **Committee experts/managers run on this image** — their loadouts reach for `gh`/IaC tools. Install logic lives in **shared, standalone, arch-aware scripts under `docker/scripts/`** (one per toolset) that any image composes; pinned versions live in `docker/versions.yaml` (org-canon pins mirror `ci-images`). Both images build with the **repo root as context** (so `docker/scripts/` + the broker module are reachable; `.dockerignore` opts those paths in). The publish workflow builds the base, pushes it, then builds devops with `--build-arg BASE_IMAGE=<base digest>` so they stay in lockstep. Future images stack the same way (e.g. a `platform` image `FROM` devops adding Java/.NET).

**Why claude is pinned, not `:latest`.** claude 2.1.150 added a "Managed settings require approval" startup gate that fires when an org pushes a privileged setting (e.g., `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`) into the user's `remote-settings.json`. In 2.1.150 specifically, the prompt was unnavigable over our broker PTY — input bytes reached claude (verified via `/proc/<pid>/io` rchar growing and tty-echo coming back), but the prompt's parser didn't act on Enter, digits, or arrow-Enter combos, leaving every new OAuth workspace stuck before the main TUI. 2.1.169 fixed navigation and the pin currently sits at 2.1.177 (verified the gate still navigates over a PTY). Pinning the version protects against a silent re-regression in the same code path. Bumping the pin is deliberate — verify navigation works against a built image before raising the floor (see issue #65 for the test recipe and the broker probe script used to verify).

## 5. Architecture

Three processes, per Electron convention:

```
┌────────────────────┐   IPC (contextBridge)   ┌────────────────────┐
│  Main (Node)       │ ◄─────────────────────► │  Renderer (React)  │
│  - dockerode       │                         │  Layout:           │
│  - safeStorage     │   exposes window.api    │   ┌─ top strip ─┐  │
│  - clipboard       │   via preload script    │   ├──┬───────┬──┤  │
│  - native Menu     │                         │   │S │ term  │ O│  │
│  - broker client   │                         │   ├──┴───────┴──┤  │
│  - better-sqlite3  │                         │   └─ bottom bar ┘  │
│  - JSONL watcher   │                         └────────────────────┘
└─────────┬──────────┘
          │
          │  Docker socket + Unix sockets to each container's broker
          ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Docker daemon                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ runner ct 1                                                  │   │
│  │   tini (PID 1)                                               │   │
│  │     └─ broker  ◄────── unix socket ◄── host BrokerClient     │   │
│  │         ├─ claude PTY (session A)                            │   │
│  │         ├─ claude PTY (session B)                            │   │
│  │         └─ claude PTY (session C)                            │   │
│  └──────────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ runner ct 2  …                                               │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘

binds (per container):
  <fleetRoot>/<id>       → /workspace   (private; only this container)
  <fleetRoot>/shared     → /shared      (shared; every container, rw)
  state/<id>/.claude     → /home/fleet/.claude
  state/<id>/claude.json → /home/fleet/.claude.json   (onboarding/trust seed)
  state/<id>/broker      → /run/broker   (broker socket directory)
```


The **broker** is a small Go daemon (//broker) shipped inside the runner image. It owns every claude PTY in the container and exposes them via a Unix-socket protocol. The host's Electron main process attaches via the bind-mounted socket directory rather than running `docker exec claude` directly. This is the foundation of "expert workspaces" (issue #18): PTYs outlive any individual host disconnect (app quit, app crash), so when the user pauses + closes the app + reopens + unpauses, every session reattaches to the same live `claude` process with its in-memory context (analyses, file watches, MCP server state) intact.

**Broker frame protocol.** The frame envelope is `[u32 totalLen BE][u8 type][payload]`, defined in `broker/internal/proto/proto.go` and mirrored as `FrameType` in `src/main/broker.ts`. PTY-session frames (host↔broker): `CREATE`/`CREATED`, `ATTACH`/`ATTACHED`, `DETACH`/`DETACHED`, `INPUT`, `OUTPUT`, `CLOSE`/`CLOSED`, `ENDED`, `RESIZE`, `LIST`/`SESSIONS`, `HISTORY`. Port-forward frames (added for dev-server preview):

| Frame | Hex | Dir | Payload | Meaning |
|---|---|---|---|---|
| `DIAL` | 0x14 | host→broker | JSON `{channel, port}` | dial `127.0.0.1:<port>` inside the container; bind to `channel` |
| `DIALED` | 0x15 | broker→host | JSON `{channel, ok, error?}` | dial result |
| `LISTPORTS` | 0x16 | host→broker | empty | request current LISTEN ports |
| `PORTS` | 0x17 | broker→host | JSON `{ports:[{port}]}` | listening-port snapshot |

A broker channel is either a PTY session or a dialed TCP connection — disjoint kinds, host-allocated from the same monotonic counter so they never collide. Once `DIALED{ok:true}`, the channel reuses the existing `INPUT`/`OUTPUT`/`CLOSE`/`ENDED` frames as a raw byte relay — HTTP keep-alive and WebSocket/HMR pass through untouched. Port detection: `LISTPORTS` parses `/proc/net/tcp` and `/proc/net/tcp6`, keeps rows in state `0A` (LISTEN), extracts the local port, dedupes across both files, and excludes the broker's own TCP port (Windows) and the MCP port.

Each broker session has **at most one live writer**. An `ATTACH` to a session that already holds a writer is rejected (`ATTACHED` with `OK:false`, error `session: already attached`) rather than silently replacing it — otherwise the displaced connection keeps believing it's attached while claude's OUTPUT flows to the newcomer, blinding the original. The host's normal re-attach `DETACH`es first, so it never trips this; the guard exists for a second connection on the socket (an external probe, or a future second window). Reconnect-after-disconnect still works: a dropped connection's deferred cleanup `DETACH`es its sessions, clearing the writer for the next attach. **One race remains** on the pause→quit→reopen→resume path: the pre-quit connection died while the container was paused, so the broker (frozen) hasn't run that connection's deferred cleanup yet. On `unpause` it reaps the dead connection and accepts the new ATTACH — but the host may reconnect in the millisecond before the reap completes and get rejected `already attached`. So the host **retries** an `already attached` ATTACH (`REATTACH_RETRIES`=12 × `REATTACH_RETRY_MS`=250ms ≈ 3s) in `attachPty`; a genuinely-live second writer keeps failing and the retry gives up.

The app uses Electron's default **native menu** (`Menu.setApplicationMenu`). The **Help** submenu is built in `src/main/appMenu.ts`: a disabled `claude-fleet v<version>` item (the at-a-glance answer to "what version am I running?"), then **Open Data Folder** (`app.getPath('userData')`) and **Open Log** (`getLogPath()` → `<userData>/error.log`), both opened WSL-aware via `openHostPath`. These are the primary escape hatches for users who need the running version, crash logs, or the state DB without knowing the path. The version string (`appVersionString()` in `src/main/appVersion.ts` — also served to workspaces via the `get_config` MCP tool) is `package.json`'s version verbatim in packaged builds; dev builds append the git HEAD sha (`0.6.0-dev.abc1234`, looked up once and cached) because between releases the bare version can't distinguish a release build from main-N-commits-later.

**Main process** owns everything privileged:
- Docker daemon access via `dockerode` (default socket).
- Secret-vault encryption via Electron `safeStorage`.
- PTY session lifecycle: holds the duplex stream handle for each active `docker exec`, forwards data to the renderer over per-session IPC channels, forwards renderer input back to the stream, forwards resize events to Docker.
- JSONL transcript watching (`chokidar`) + SQLite persistence (`better-sqlite3`). The watcher tails every workspace's `<state>/<id>/.claude/projects/-workspace/*.jsonl` non-recursively and ingests new lines into the SQLite cache (see §7 *JSONL→SQLite cache*). Cost rollup (`src/main/pricing.ts`) groups events by `(model, service_tier)` and applies hardcoded Claude 4.x rates to derive USD; the rest of #2 (live push, slot consumers for chip/tab/context-bar) lands later.

**Preload** is a tightly scoped bridge. It uses `contextBridge.exposeInMainWorld('api', …)` to expose a typed `window.api` to the renderer. Window options: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: false` (sandbox is off because the preload needs `ipcRenderer`).

**Renderer** is pure React. It has zero Node access. It can only do what `window.api` lets it do. Everything privileged flows through IPC.

The renderer layout is a 3-row × 3-col shell:
- **Top row** (`WorkspaceTabStrip`): app name, workspace chips (each with a per-workspace hue + status dot), a `+` button (adds a workspace — opens the modal to create a new one *or* resume a saved one; a bare glyph rather than "New workspace" copy because it isn't strictly new, #21), a Settings gear, the daemon status indicator (no pill chrome — a constant "Docker" label plus a dot that does the signaling: solid green when reachable, pulsing red with a hover tooltip when not, #23), `MOCK MODE` chip when active. The chip hue comes from the manifest's `color.hue` field when set, falling back to a name-hash of the same 14-hue preset palette so unset workspaces still get a stable distinct color. **The strip is the "warm" fleet: only `running` + `paused` workspaces appear here** (instant switch). `stopped` + `deleted` are the "cold" fleet — they live in the workspace modal's Saved list and need a restart (#21), so a workspace is in exactly one place. If the selected workspace leaves the warm set (e.g. stopped via its ⋮ menu), App re-selects the first warm workspace so the main pane never strands on a chip that's gone. Each chip carries a small secondary line below the workspace name driven by observability — `active 2m ago` when the session is fresh, `idle 1h ago` when it's been quiet > 5 min, or empty when no events have been ingested yet. The activity text reads off `summary.lastActiveAt` from the shared summary map described below. A running chip also shows a **busy indicator** — its status dot pulses and the secondary line reads `working…` while claude is actively working. Busy/idle is detected in the renderer (`activityDetector.ts`) by watching each session's PTY stream for claude's terminal-title (OSC) glyph: a braille spinner (U+2800–U+28FF) means busy, `✳` means idle. `TerminalSession` reports per-session flips up to `TerminalPane`, which both aggregates to a per-workspace busy flag App distributes to the chip via `busyByWorkspace` *and* emits the per-session busy *broker* id set via `onBusyIdsChange`. `TerminalPane` also emits the current **live** (non-ended) broker session id set via `onLiveIdsChange` whenever the set changes (mount, tab open/close, PTY end); App.tsx collects these per-workspace and resolves them to claude UUIDs via `observability.summaryForBrokerSession(…)` to build the `openSessions` map for the Sessions pane (see §8 *Browse & resume a past session*). Jump-to-open-tab is handled via `activateRequest` / `onActivateConsumed` (a `{ brokerSessionId, token }` pair passed down to `TerminalPane`; mirrors `resumeRequest`/`onResumeConsumed`): when the Sessions pane clicks an open row, App sets `activateRequest`; `TerminalPane` consumes it (token-guarded) and calls `setActiveId(brokerSessionId)`. The **same busy pulse appears on every "session chip"**: the active terminal **session tab's** dot (driven directly by `TerminalPane`'s local `busyIds`), and each matching row in the left-rail **Sessions list**. For the Sessions list — keyed by claude session UUID, not broker id — App resolves the busy broker ids to claude UUIDs via `observability.summaryForBrokerSession(...).sessionId` (re-resolving on observability pushes, since the broker→claude mapping is learned as transcripts ingest) and passes the resulting `busySessionIds` set down, so only the genuinely-running session's row pulses. **All busy indicators blink in lockstep**: each pulse element aligns its CSS `animation-delay` to a shared wall-clock phase (`blinkSync.ts` — `useBlinkSync`/`blinkDelayMs`), so an indicator that mounts mid-cycle (e.g. a Sessions row that remounts on a list refresh) snaps to the same phase as one that has been pulsing for a while, rather than drifting. (Busy/idle only — a true "needs your input" signal isn't available: claude renders AskUserQuestion/permission prompts with no distinct title glyph and doesn't write them to the JSONL while pending; see §11.)

A running chip also surfaces a **waiting indicator** — a violet (`--wait`) status dot that **reuses the busy pulse** plus a `?` glyph and a `needs input` secondary line — when a session is blocked on an `AskUserQuestion` prompt. **Waiting wins over busy**: if a session is in the waiting set, its chip/tab dot shows violet rather than the busy pulse. The same violet state appears on the session-tab dot and the Sessions-list row. Unlike busy/idle (PTY title glyph), waiting is sourced from a runner hook: a `PreToolUse[AskUserQuestion]` hook reports `waiting=true`; `PostToolUse[AskUserQuestion]`, `Stop`, and `UserPromptSubmit` report `waiting=false`, all via the `signal_input_wait` MCP tool (§6). Main keeps a per-workspace `Set<string>` of waiting claude session UUIDs and pushes `inputwait:update` `{ workspaceId, waitingSessionIds }` to renderers on every change; the set is cleared when the workspace stops, pauses, or is removed. App keys the Sessions list directly by claude UUID and resolves the session tab via `summaryForBrokerSession`. **Container backend only** — the local backend does not get the hook.
- **Centralized observability distribution.** `App.tsx` owns a single `summaries: Record<workspaceId, WorkspaceSummary | null>` map (keyed by ULID) and distributes it to the chip strip, observability pane, and terminal-pane context bar via props. The map is filled two ways:
  1. **Live push.** The main-process `JsonlWatcher` emits `'ingest'` after every batch that genuinely inserts ≥1 new event (compaction re-reads that hit dedup_key are suppressed). `ipc.ts` subscribes, computes the workspace summary, and sends `observability:summary` to every BrowserWindow with `{ workspaceId, summary }`. The renderer's `window.api.observability.onSummary(cb)` (registered in App.tsx) updates the map immediately — chip relative-time, USD total, and context-bar fill refresh in <100ms of the JSONL flush.
  2. **30s safety poll.** App.tsx also re-fetches every workspace's summary every 30s. This backs up the push for any lost event and forces a re-render so the chip's `Date.now() - lastActiveAt` text rolls forward ("active 2m ago" → "active 12m ago") even when no new ingests are happening. It's 15× less frequent than the previous unconditional 2s poll because push handles the hot path.
- **Body row** (3 columns):
  - **Sessions pane** (left, ~280px): placeholder until #3 lands the JSONL-backed sessions table.
  - **Main pane** (center, fluid): header with selected workspace's name/status and `Close…` button, plus the xterm `TerminalPane` (or empty/first-run/disconnected states). The **first-run state** (shown whenever the live fleet is empty, `App.FirstRun`) doubles as the product's pitch rather than a bare "no workspaces" message: a centered hero (headline + lede + the primary *Launch your first workspace* CTA), a responsive grid of feature cards naming the distinctive capabilities and the value each buys (parallel fleet, per-workspace Docker isolation, pause/resume expert workspaces, live cost/token/tool observability, the cross-workspace Committee, drag-and-drop ingestion), and a footer strip name-dropping secondary features (loadouts, session history/resume, keychain secrets, fleet-state MCP). It scrolls within `.main-body`; styling lives under `.landing*` / `.feature-card` in `styles.css` and leans on the `--ok` accent. At the top of the terminal area, a **context bar** carries the workspace's hue track + a width-driven fill — `--pct` set inline by `TerminalPane` from `summary.lastTurnContextTokens / summary.contextWindowTokens × 100`. The effective context window comes from `src/main/contextWindow.ts`: 200K per Claude 4.x family by default, 1M when the model id carries the `[1m]` marker (e.g. `claude-opus-4-7[1m]`), and a heuristic 1M auto-upgrade when any observed turn in the session has already crossed 200K (catches the 1M beta header case, since that flag doesn't show up in the model string Claude Code writes to JSONL). Falls back to a full identity band (100%) when no observability data is available, so a fresh workspace still reads visually correct. Tooltip on the band shows `tokens / limit (pct%)`. A subtle vertical tick at 80% (`.terminal-accent-band::after`) marks the compaction threshold — claude auto-compacts around there, so the tick is the heads-up that the next turn might trigger one.
  - **Observability pane** (right, ~320px): just under the rail header sits the **plan-usage bar** (`UsageBudgetBar`) — a fleet-wide "tokens left" gauge for the current rolling window (default 5h), shown regardless of scope or selection because the plan limit is account-wide, not per-workspace. Numerator = `usage:rollingSpend` (all four token types summed across the fleet where `ts ≥ now − window`, polled every 15s); denominator = the configured `usageBudget.allowanceTokens` (§*Settings*). Framed as **percent remaining** ("NN% left" — the user's framing), with a depleting fill tinted warn ≤25% / danger ≤10% left and a `spent / allowance` subline; degrades to a spend-only readout when the allowance is 0. Below it, a **scope toggle** switches between *This workspace* and *Fleet · N*. **Fleet scope** is a pure-renderer aggregate built from the shared per-workspace `summaries` map (no extra IPC): total USD across all live workspaces, a stacked-share bar (one hue segment per workspace, `flex` = its `usd`), and per-workspace rows (hue dot + name + state + cost). **Workspace scope** is the default — a live view of the **active terminal tab**'s Claude session in the selected workspace. Shows session title (from `ai-title` event or first-user-message head), latest model, last-activity relative time, event count, and a **session graph** with a **cost ⇄ tokens metric toggle** (`$`/`tok` segmented control; preference persisted to `localStorage` under `obsGraphMetric`, default cost): in **cost** mode the headline is the USD total and the per-turn **sparkline** plots `costSeries`; in **tokens** mode the headline is total session tokens (input+output+cache) and the sparkline plots `tokenSeries` (per-turn total tokens — same per-turn definition as `costSeries`, so the two graphs line up bar-for-bar). Accent bars with recent turns brighter; hidden until ≥2 non-zero turns. Then token totals (input / cache-create / cache-read / output), recent tool calls (name + input summary + duration + ok/error status, from `recentToolCalls`), and a **Context · N terminals** section — one fill bar per session tab in the workspace (App reads `sessions.json` and fetches `summaryForBrokerSession` per tab), tinted warn ≥75% / danger ≥90% with an 80% compaction tick and the active tab dotted/bold. Empty state when the focused tab has no per-tab data yet. Below the session data, a **Workspace** block (rendered whenever a workspace is selected, even before any events) shows two clickable folder rows plus the runner image and resource limits in a bordered card: **private** (`<fleetRoot>/<id>` mounted at /workspace, visible only to that container) and **shared** (`<fleetRoot>/shared` mounted into every container). Each row is a button that reveals the host folder in the OS file manager via `fs:openPath`. The shared path comes from `config:get` (fetched once in App.tsx). Per-tab resolution comes from the `broker_sessions` mapping table (§11 *Per-tab mapping*). `TerminalPane` bubbles its active tab id up via `onActiveTabChange`; App.tsx fetches `summaryForBrokerSession(workspaceId, activeTabId)` for the selected workspace and re-fetches on every push for that workspace. **No workspace fallback** — when the per-tab fetch returns null the pane shows its empty state directly, regardless of how the tab was added. The fallback was tried (loaded-from-inventory tabs → workspace summary, fresh tabs → empty) but produced two user-visible bugs: clicking `+` showed the previous tab's data via the fallback, and switching between two unmapped tabs showed the same workspace-summary content on both ("doesn't update"). Per-tab semantics are now honest: each tab shows its own data or empty, never inherits from a sibling tab. The pane header carries a **collapse toggle** (`›`) that minimizes the rail to a thin 28px reopen strip (the `.app-body` grid's third column shrinks `320px`→`28px`); the strip is one tall click target whose `‹` button restores it. State is held in `App.tsx` (`obsCollapsed`) and persisted to `localStorage` under `obsRailCollapsed` — a pure UI preference, so it deliberately uses `localStorage` rather than the main-side `config.json`. The rail stays mounted while collapsed only in the sense that React re-renders it as the strip; the heavy summary subtree is not rendered, but the shared `summaries` map in App keeps polling so reopening is instant.
- **Bottom row** (`BottomBar`): static hint bar with key bindings and degraded-vault notice when applicable.

Modals owned by `App`:
- `WorkspaceModal` — tabbed shell with Saved + New tabs (underlined-tab style). Body of each tab uses `WorkspaceForm` — the field-level form component owns state, validation, and footer; New tab renders it in `mode='create'`, expanded Saved-tab rows render it in `mode='edit'`. Saved-row expanded footer is `Delete · Cancel · Clone · Resume`; New-tab footer is `Cancel · Create & start`.
- `EditWorkspaceModal` — single-purpose modal for editing a *live* workspace. Opened from the chip ⋮ menu Edit entry. Wraps `WorkspaceForm` in `mode='edit'`. On Save, calls `workspace:writeManifest` + diffs pre/post specs; container-level changes flip the restart-to-apply banner in the workspace's TerminalPane.
- `CloseWorkspaceModal` — Stop / Pause / Stop & remove (keeps state dir).
- `DeleteWorkspaceModal` — Permanent purge confirmation: stop + `workspace:remove(containerId, { deleteState: true })` + `vault:deleteAllForWorkspace(id)`.
- The legacy `ProfilesDialog` is gone — per-workspace env-var management lives inside `WorkspaceForm`.

## 6. IPC surface

All channels are `ipcMain.handle`/`ipcRenderer.invoke` (promise-based) except the PTY data stream, which uses one-way `webContents.send` from main to renderer.

### Workspace
Identity is the **ULID** `id` (immutable, 26 char Crockford base32). The user-facing `name` is a mutable label. Channels that operate on workspace identity (`list`, `create`, `start`, `getManifest`) take `id`; channels that operate on the live container itself (`stop`, `pause`, `remove`) take the Docker `containerId` because their target is the container instance, not the workspace identity.

- `workspace:ping` → `boolean` — is the backend reachable (for the Docker backend, is the daemon up).
- `workspace:list` → `Workspace[]` — merged list of live (running/stopped) workspaces plus deleted workspaces (those with a manifest on disk but no live container).
- `workspace:create(input: WorkspaceCreatePayload)` → `Workspace` — create + start a runner workspace AND write its manifest to `<userData>/state/<id>/workspace.json`. The renderer mints the ULID and ships the payload (id, name, description, labels, color, workspaceSubdir, kind, image, authMode, env: {plain, secretKeys}, resources). **No `workspaceRoot`** — the backend derives the workspace's private folder (`<fleetRoot>/<id>`) and shared folder (`<fleetRoot>/shared`) from the app-level fleet root and creates both. Secret env values land in the vault under `<id>:<key>` *before* this call so the main process can resolve them at container-start time.
- `workspace:start(id)` → `Workspace | null` — start an existing (live, possibly stopped or paused) workspace by ULID (looked up via the `com.claude-fleet.id` label). Paused containers are `unpause`d; stopped containers are `start`ed. Returns null if no container is labelled with that id (caller should recreate from the saved manifest using the same id via the create flow).
- `workspace:getManifest(id)` → `WorkspaceSpec | null` — read the persisted manifest.
- `workspace:writeManifest(spec)` → `void` — update a workspace's manifest in place without touching the container. Validates name-uniqueness across the fleet (excluding the row's own id). Used by the Saved-tab Resume flow to apply edited fields before calling `workspace:start`. Container-level fields (env, image, authMode, resources) won't take effect until the container is recreated — Phase 2's restart-to-apply banner surfaces this.
- `workspace:stop(containerId)` → `void` — stop with 5s grace; ignores 304/404.
- `workspace:pause(containerId)` → `void` — `docker pause` (cgroups freezer). Idempotent: 409 (already paused) and 404 (container gone) are treated as no-ops.
- `workspace:remove(containerId, opts?: { deleteState? })` → `void` — force-remove; if `deleteState`, also `rm -rf <userData>/state/<id>` (manifest, transcripts, broker socket). The renderer additionally calls `vault:deleteAllForWorkspace(id)` so secrets don't leak past the state dir.
- `workspace:ensureImage(channelId, image?)` → progress over `workspace:ensureImage:progress:${channelId}`. Pulls `image` — the **user-selected ref** the create/resume flow passes (blank/omitted falls back to the base `RUNNER_IMAGE`). This is what lets a brand-new image (e.g. the devops runner, or any registry ref typed in the picker) get pulled here, with live progress in the modal, instead of 404'ing later at `docker create`. Always asks the registry, so improvements to `:latest` (broker landing, claude version bumps) reach existing users on subsequent creates. Docker's pull semantics no-op when local layers match the remote digest. If the registry is unreachable and a local copy exists, falls back to the cached image with a warning; if neither, the error propagates so the caller can surface it. (`createWorkspace` resolves the image as `spec.image?.trim() || RUNNER_IMAGE`, so a blank ref can't slip through to `docker create`.)

### Images
- `images:list` → `ImageEntry[]` — every image known to the library, including labels.
- `images:remove(ref)` → `void` — remove an image entry. The image itself is not deleted from the Docker daemon; only the library entry goes away.

### Sessions
Two distinct things share this namespace: the per-workspace **terminal-tab inventory** (`read`/`write`) and the global **Sessions table** (`list`/`rename`/`delete`/`resume`).

The tab inventory is the tab list shown above the terminal body. Renderer-owned read/write of the whole file; main has no notion of tab lifecycle.
- `sessions:read(workspaceId)` → `SessionInventory` — read `<userData>/state/<id>/sessions.json`. Returns an empty inventory (`{ version: 1, sessions: [], nextNum: 2 }`) if the file is missing or malformed.
- `sessions:write(workspaceId, inventory)` → `void` — atomic write of the whole inventory.

The Sessions table (#3) is a global, workspace-filterable list of every Claude session the watcher has indexed, each resumable via `claude --resume`. Backed by the sqlite `sessions` table (see §7 *JSONL→SQLite cache*).
- `sessions:list(workspaceId?)` → `SessionListItem[]` — newest-active first. Omit `workspaceId` for the global list; pass it to scope to one workspace. Each item is the `sessions` row (`id`, `workspaceId`, `aiTitle`, `firstUserMessage`, `userSetName`, `startedAt`, `lastActiveAt`) plus derived `eventCount` + `usd` (one grouped pass over `events`, no N+1), overlaid with `workspaceName`, `workspaceColorHue`, `workspaceState`, and `tags: string[]` (tags from the session's latest tagged summary chapter, relevance-ordered; `[]` when no summary chapter exists yet — fetched via one grouped query over `session_tags`, no N+1). **Eligibility:** a session appears iff its workspace's manifest still exists — a truly-deleted workspace (manifest removed) drops out of `listAllWorkspaces` and its sessions are filtered; a closed-but-kept workspace (manifest present, no live container → state `'deleted'`) still appears. Enforced in the IPC layer, the only place that knows about on-disk manifests. The renderer's display title is `userSetName ?? aiTitle ?? firstUserMessage ?? '(untitled)'`.
- `sessions:rename(sessionId, name)` → `void` — set the manual name override (`user_set_name`); an empty/whitespace name clears it back to NULL so the auto title resurfaces.
- `sessions:delete(workspaceId, sessionId)` → `void` — drop the session's `events`, `broker_sessions`, and `sessions` rows, then unlink the on-disk transcript (`<state>/<id>/.claude/projects/-workspace/<sessionId>.jsonl`). The watcher's `unlink` handler only clears its in-memory offset state, so the DB rows are removed explicitly. Best-effort unlink (a missing file is fine).
- `sessions:resume(workspaceId)` → `{ containerId } | null` — bring the workspace's container up (`startWorkspace` unpauses a paused one, starts a stopped one, no-ops a running one) and return its `containerId` so the renderer can open a resume tab. **Null** when the container is gone and can't be brought up here (e.g. closed-but-kept workspace with no recreatable container) — the renderer surfaces a non-fatal "couldn't resume" notice. The actual `claude --resume <id>` happens through the normal attach flow (see §6 *PTY*).

### Vault
Per-workspace secret storage backed by Electron `safeStorage` (see §4 *Stack* for the WSL rationale). Profiles are gone; the whole vault is a single JSON object `{ "<workspaceId>": { "<envVarName>": "<value>" } }`, encrypted via `safeStorage.encryptString` and written base64 to `<userData>/secrets.enc`. The decrypted store is cached in memory; mutations are serialized through a write-lock so concurrent `setSecret`/`deleteSecret` calls (the env editor writing several rows) can't clobber each other. The renderer never sees a secret value it didn't just write — values come back over `vault:getSecret`, and the main process consumes them directly when constructing the container env via `resolveEnv` (`src/main/vault.ts`). Migration: secrets previously in keytar are NOT carried over (re-enter once; OAuth workspaces store none).
- `vault:available` → `boolean` — `safeStorage.isEncryptionAvailable()`, cached. False only when even the AES fallback is unavailable; the API-key auth mode degrades to disabled in that case.
- `vault:listKeys(workspaceId)` → `string[]` — the secret-env-var keys stored for the workspace (object keys of its bag).
- `vault:getSecret(workspaceId, key)` → `string | null` — fetch a single value. Null when missing.
- `vault:setSecret(workspaceId, key, value)` → `void` — upsert into the workspace's bag. Throws when encryption isn't available.
- `vault:deleteSecret(workspaceId, key)` → `void` — delete a single value; drops the workspace's bag when its last key is removed.
- `vault:deleteAllForWorkspace(workspaceId)` → `void` — purge the workspace's whole bag. Called at workspace-delete time so credentials don't outlive the manifest.

### PTY
- `pty:attach(containerId, brokerSessionId, cols, rows, resumeOf?)` → `ptyHandleId: string` — opens a connection to the workspace's in-container broker (Unix socket at `<state>/<id>/broker/broker.sock`) and either re-attaches to an existing broker session or creates one. `brokerSessionId` is the stable id from `sessions.json` (so re-attach across an app restart finds the same live PTY). Main retains a `BrokerClient` plus the resulting Duplex, returns an opaque `ptyHandleId` the renderer uses for subsequent input/resize/detach calls. **`resumeOf`** (a Claude session UUID) makes this a *resume* attach: the broker `CREATE` spawns `claude --resume <resumeOf>` instead of a bare `claude`. **Session identity is host-assigned (#195):** when CREATE runs without `resumeOf`, the host generates a UUID and passes `--session-id <uuid>`, so the broker→claude mapping is learned **deterministically at CREATE time** for both paths — never guessed from JSONL appearance order (the legacy pending-attach FIFO could pair a new JSONL with the wrong tab; a wrong `broker_sessions` row makes a later tab Refresh silently resume a different conversation). Learning happens only when CREATE actually runs — a plain ATTACH to a live session never relearns, since the running claude keeps whatever id it already has. The pending-attach queue remains as a fallback pairing for sessions the host did not name (e.g. seeded in e2e); an ambiguous consume is logged as `mapping-ambiguous-consume`. `resumeOf` only takes effect at CREATE time; on a re-attach where the broker session is already alive, ATTACH succeeds first and the resume args are correctly ignored (no second claude spawned). **On failure** the handler captures the last ~100 lines of broker stdout/stderr via `docker logs` and writes them to `error.log` under a `pty-attach-failed` entry alongside the thrown message — the broker is otherwise invisible to the host, and the worst-case "ATTACHED timed out" + "unsolicited frame type 4" pattern after a pause/resume is impossible to diagnose without seeing what the broker was actually doing.

Broker RPC timeout is 30s (`RPC_TIMEOUT_MS` in `src/main/broker.ts`). 10s was the original budget but routinely fired during the first ATTACH after a workspace pause/resume — the broker's `CREATE` path spawns the `claude` binary via `pty.StartWithSize`, and that first spawn (auth checks, MCP server warm-up, occasional network call) regularly takes 15–25s. The host's late-arriving response then lands with no waiter, producing the "unsolicited frame type 4" warning. 30s covers the observed worst case with margin without making honestly-stuck sessions hang the UI indefinitely.
- `pty:input(ptyHandleId, data: string)` → `void` — write user input to the broker as an INPUT frame on the channel.
- `pty:resize(ptyHandleId, cols, rows)` → `void` — send a RESIZE frame.
- `pty:detach(ptyHandleId)` → `void` — send a DETACH frame (session lives on inside the broker) and close the socket.
- `pty:closeSession(ptyHandleId)` → `boolean` — send a **CLOSE** frame, which terminates the broker session entirely (kills the PTY / claude and drops it from the broker's session map), then closes the socket. Returns whether a live handle was found. CLOSE is only honored on a channel the calling connection actually holds, so this must go through the attached `PtyHandle` (the renderer addresses it by `ptyHandleId`). Used by the **loadout reload** (§7): close the session, then `pty:attach` the *same* broker session id with `resumeOf` ⇒ the broker has no such session ⇒ it `CREATE`s it with `claude --resume <uuid>`, so the same tab resumes the conversation under the freshly-installed config.

Per-session events from main to renderer:
- `pty:data:${sessionId}` — `Buffer` chunks from the container's stdout/stderr.
- `pty:end:${sessionId}` — stream ended.
- `pty:error:${sessionId}` — stream error (stringified).

The renderer's `window.api.pty.onData/onEnd` register listeners and return unsubscribe functions.

### Ports
Dev-server preview: auto-detects listening ports inside a running container and relays browser traffic over the broker socket (see §5 *Broker frame protocol* for `DIAL`/`DIALED`/`LISTPORTS`/`PORTS` frames; see §8 *Dev-server preview* for the user flow; implementation in `src/main/portforward.ts`).

- `ports:detected` (main → renderer event) — `{ workspaceId, port }`. Fired when a new port appears in the `LISTPORTS` scan for a running workspace. The renderer shows a transient toast ("Dev server detected on port N") with an **Open preview** button. Main dedupes: a port toasts once per appearance; if it disappears and reappears it toasts again.
- `ports:open(workspaceId, containerPort)` → `{ hostPort }` — creates (or reuses) a `PortForward` for `containerPort`: a loopback `net.Server` bound to `127.0.0.1:0` (ephemeral host port). Each inbound browser connection gets a fresh broker channel via `DIAL`, then traffic flows through the existing `INPUT`/`OUTPUT` relay. Calls `shell.openExternal('http://127.0.0.1:<hostPort>')` and returns `hostPort`. In `MOCK_MODE` (no broker) the handler returns a stub host port without dialing.

**`PortMonitor`** — one per running workspace. Opens a dedicated lightweight `BrokerClient` (one-per-monitor — deliberate: concurrent `DIAL`s on a shared client would collide on the `DIALED` waiter), calls `listPorts()` every 3s, diffs against the last-seen set, and emits `ports:detected` on newly-appeared ports. Started when the workspace reaches `running`; stopped on pause/stop/remove. **`PortForward`** — one per forwarded container port. The `net.Server` is torn down automatically when the workspace pauses/stops/is removed. In `MOCK_MODE` the `ports:detected` event is driven by a test-only handler and `ports:open` returns a stub, matching the existing mock-for-UI / real-for-pipeline split.

### Observability
- `observability:eventsForSession(sessionId, sinceEventId?, limit?)` → `EventRow[]` — rows from the `events` table for the given session, ordered by `id` ascending, restricted to `id > sinceEventId`. Caller polls with the highest `id` it has seen to get incremental updates. Returns up to `limit` rows (default 500).
- `observability:summaryForWorkspace(workspaceId)` → `WorkspaceSummary | null` — picks the most-recently-active Claude session in the workspace and returns `{ sessionId, title, model, startedAt, lastActiveAt, eventCount, inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, usd, lastTurnContextTokens, contextWindowTokens, topTools[], recentToolCalls[], costSeries[] }`. `recentToolCalls[]` is the latest tool calls newest-first (`{ name, input, durationMs, status: 'ok'|'error'|'pending', ts }` — duration/status from the tool_use→tool_result match). `costSeries[]` is per-turn USD over recent assistant turns, oldest→newest (the sparkline series; each assistant event with usage is one turn, priced per-row so mixed models/tiers are correct). Returns null when no events have been ingested for the workspace yet. `lastTurnContextTokens` is `input + cache_read + cache_creation` from the most recent assistant event — a context-window-fullness proxy that drives the terminal-pane context bar; null when no assistant event has been seen yet. `contextWindowTokens` is the session's effective context window (200K / 1M, see §5 *Main pane* for derivation rules). App.tsx fires this once per workspace at mount/resubscribe and then every 30s as a safety net; the hot path is the live `observability:summary` push (see §5 *Centralized observability distribution*).
- `sessions:resolveResumeTarget(workspaceId, brokerSessionId)` → `string | null` — resume-grade tab→conversation resolution: the claude session UUID this tab may `claude --resume`, or null unless the `broker_sessions` row is **verified** (learned deterministically at spawn — v7 column). Legacy FIFO-guessed rows never resolve here: resuming a guess silently swaps the tab onto a different conversation (#195). Display lookups stay on the summary endpoint below, which serves unverified rows fine.
- `observability:summaryForBrokerSession(workspaceId, brokerSessionId)` → `WorkspaceSummary | null` — per-tab variant. Resolves the broker→claude mapping in the `broker_sessions` table and returns that claude session's summary, or **null** when no mapping is known. **No workspace fallback at this layer** — a freshly-added tab carries an unmapped broker session id but legitimately has no data, and returning the workspace's most-recently-active session there surfaces the previous tab's numbers (the user-visible "new session shows the last session's info" bug). The renderer applies a workspace-summary fallback only for tabs loaded from `sessions.json` (where the mapping just hasn't caught up — pre-PR tabs, concurrent-attach skip cases); freshly-added tabs (the `+` button, close-last-auto-recreate) leave the pane on its empty state until the watcher learns a mapping and real per-tab data flows in.
- `inputwait:update` (main → renderer push) — `{ workspaceId, waitingSessionIds: string[] }`. The set of claude session UUIDs in that workspace currently blocked on `AskUserQuestion`. Sent whenever the set changes (a session enters or leaves the waiting state) and cleared on workspace stop, pause, or remove. Exposed as `window.api.observability.onInputWait(cb)`.
- `observability:summary` (main → renderer) — broadcast every time the watcher ingests new lines for a workspace. Payload: `{ workspaceId, summary: WorkspaceSummary | null }`, where `summary` is the same shape `summaryForWorkspace` returns. Exposed to the renderer as `window.api.observability.onSummary(cb)`, which returns an unsubscribe. One push per ingest batch (one JSONL flush ≈ one push); duplicate-only re-reads after compaction are suppressed at the watcher. The fan-out runs through `broadcastObservabilitySummary` (`src/main/observabilityBroadcast.ts`), which guards each target with `win.isDestroyed()`, `webContents.isDestroyed()`, AND a try/catch around `send` — during BrowserWindow teardown the render frame can be disposed while both destroyed-flags still read false, and `webContents.send` then throws "Render frame was disposed before WebFrameMain could be accessed". The watcher's emit path isn't an awaited handler, so an unswallowed throw unwinds into Node's EventEmitter internals; the per-target catch keeps one stale window from breaking the whole broadcast.
- `observability:getCost(sessionId)` → `{ inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, usd }` — token totals + USD for one session. USD is derived from the `events` rows grouped by `(model, service_tier)`; pricing comes from `src/main/pricing.ts` (hardcoded Claude 4.x rates, standard tier full price, batch tier 50%, unknown model/tier degrades to $0 + one-time `console.warn`). The pane reads the equivalent `usd` field from `summaryForWorkspace`; this endpoint exists for the sessions table (#3) and per-session detail views.
- `observability:getCostForWorkspace(workspaceId)` → same shape, aggregated across every session in the workspace.

### Error log
Both main and renderer hook the standard "uncaught" channels and forward each crash through a single sink to `<userData>/error.log`. Main installs `process.on('uncaughtException')` + `process.on('unhandledRejection')` directly. The renderer wires `window.addEventListener('error', …)` + `window.addEventListener('unhandledrejection', …)` in `src/renderer/src/main.tsx` *before* mounting React, so a crash during App's initial render still lands. Each row is one JSON object: `{ ts, source: 'main' | 'renderer', type, message, stack?, extra? }`. No rotation; users can delete the file at will.
- `app:logError({ type, message, stack?, extra? })` → `void` — renderer → main bridge. The renderer never writes the log directly (sandbox / cross-process consistency).
- `app:errorLogPath()` → `string` — absolute path of the log.
- `app:openErrorLog()` → `string` — open `error.log` in the OS default app (WSL-aware, same `explorer.exe` fallback as `fs:openPath`). Backs the "Open log" action on the MCP-unreachable toast.
- `mcp:status:get()` → `{ ok, detail? }` — current host MCP listener health, for a window mounting mid-outage. Live changes arrive on the **`mcp:status`** broadcast (`main → renderer`, change-only), fanned to every window by `mcpStatusBroadcast.ts` (mirrors `observabilityBroadcast.ts`). Drives the sticky "MCP unreachable" toast (§11). The win32 TCP listener flips it on bind success/failure; non-win32 stays healthy (per-workspace unix failures still log via `reportListenerError` but aren't a global "MCP down").

### Filesystem
Host-filesystem helpers used by the workspace-create flow and the observability rail. The renderer is contextIsolated/sandboxed, so all disk access goes through main:
- `fs:isDirectory(path)` → `boolean` — whether `path` is an existing directory (workspace-root validation).
- `fs:mkdirp(path)` → `void` — create a directory and parents.
- `fs:openPath(path)` → `string` — reveal a host path in the OS file manager. On native macOS/Windows/Linux this is `shell.openPath`. **Under WSL** (detected once at load via `src/main/wsl.ts` — Linux platform + `WSL_DISTRO_NAME` or "microsoft" in `/proc/version`) `shell.openPath` can't reach a GUI file manager (no `xdg-open`/no Linux file manager), so the path is translated with `wslpath -w` and opened with `explorer.exe` (whose exit code is ignored — it returns 1 even on success). Resolves `''` on success or an error string; never rejects. Empty/non-string input returns `'No path provided'`. Drives the observability rail's Workspace **private/shared** folder rows; the renderer routes any error string to `app:logError`.
- `dialog:pickDirectory(defaultPath?)` → `string | null` — native open-directory dialog; null on cancel.

### Settings (app config)
App-level settings persist to `<userData>/config.json`: `{ fleetRoot?: string, disableHardwareAcceleration?: boolean, autoReloadLoadouts?: boolean, usageBudget?: { preset: 'pro'|'max5'|'max20'|'custom', customTokens: number } }`. All are surfaced via the top-strip gear → `SettingsModal`.
- **Fleet root** — the single host dir holding every workspace's private folder (`<fleetRoot>/<id>`) and the shared folder (`<fleetRoot>/shared`).
- **disableHardwareAcceleration** — when true, the app calls `app.disableHardwareAcceleration()` at startup. Silences Chromium's noisy GPU-init failure on WSLg (rendering falls back to CPU). Must be read **synchronously** at module load, before the `ready` event — `config.ts:hardwareAccelDisabledAtStartup()` does a `readFileSync` of `config.json` rather than going through the async cache. Changing it requires an app restart to take effect.
- **autoReloadLoadouts** — **defaults on** (absent ⇒ on; only an explicit `false` disables it, so `config.ts:read()` preserves the key verbatim rather than coercing). When on, installing/updating a loadout into a **running container** workspace auto-reloads its active Claude session in place (`--resume`) so the loadout takes effect immediately — gated on the session being **idle** (deferred until claude stops working; never interrupts a live turn). When off, the user reloads manually and the loadout loads on their next `claude` start. See §7 *Run layer — reload*.
- **usageBudget** — the denominator for the observability rail's **plan-usage bar** (§5). `preset` is `pro` | `max5` | `max20` | `custom` (default `pro`). The non-custom presets resolve to `USAGE_BUDGET_PRESETS` (`config.ts`): estimated total tokens — input + output + cache create + cache read — available in one rolling window per Claude plan. Anthropic does **not** publish exact per-window token limits, so these are order-of-magnitude estimates anchored to the official Pro→Max multipliers (Pro 19M / Max 5× 95M / Max 20× 380M per `USAGE_BUDGET_WINDOW_HOURS` = 5h); `custom` uses `customTokens`. The user calibrates against their real ceiling (Settings → Usage, or the spend the bar shows when Claude Code reports a limit), so the absolute numbers being estimates is acceptable — the rolling-spend readout makes the bar self-correcting.
- `config:get()` → `{ fleetRoot, sharedDir, disableHardwareAcceleration, autoReloadLoadouts, usageBudget }` — current fleet root + its derived `<fleetRoot>/shared` + the persisted HWA flag (the persisted value, not the effective one — the env override below isn't reflected) + the auto-reload flag (default true) + the resolved usage budget (`{ preset, customTokens, allowanceTokens, windowHours, presets }`, where `allowanceTokens` is the effective denominator after resolving preset→tokens). Fleet-root precedence: `CLAUDE_FLEET_ROOT` env override (the e2e suite sets this in `tests/_helpers.ts` so test runs don't pollute the real `~/fleet`) → the persisted config value → the `~/fleet` default.
- `config:setFleetRoot(path)` → `{ fleetRoot, sharedDir }` — persist a new fleet root (the dir is created). Takes effect for new containers and for existing ones on next restart (running containers keep their current mounts until recreated).
- `config:setHardwareAccelDisabled(disabled)` → `{ disableHardwareAcceleration }` — persist the HWA flag. `CLAUDE_FLEET_DISABLE_HWA=1` is an env override (dev shortcut) that forces it on regardless of the persisted value, matching the `CLAUDE_FLEET_MOCK` / `ANTHROPIC_API_KEY` pattern.
- `config:setAutoReloadLoadouts(enabled)` → `{ autoReloadLoadouts }` — persist the auto-reload flag.
- `config:setUsageBudget(preset, customTokens)` → `{ usageBudget }` — persist the plan-usage preset and the custom token amount it falls back to (`customTokens` is rounded, clamped ≥0).
- `usage:rollingSpend()` → `{ spentTokens, windowHours }` — the plan-usage bar's **numerator**: total tokens (all four types) spent across the **whole fleet** in the trailing `windowHours` window, via `db.ts:tokensSpentSince(Date.now() - windowMs)`. App.tsx polls this every 15s (separate, slower cadence than the per-workspace summary push — it's one cheap aggregate and the rolling window moves on the order of minutes).

### Clipboard + context menu
The renderer cannot use `navigator.clipboard` reliably (focus/permission gotchas in Electron, and the renderer is contextIsolated). All clipboard access goes through main:
- `clipboard:write(text)` → `void` — `electron.clipboard.writeText` (no-op on empty).
- `clipboard:read()` → `string` — `electron.clipboard.readText`.
- `menu:showTerminalContextMenu({ hasSelection })` → `'copy' | 'paste' | 'selectAll' | null` — builds a native `Menu`, popups it on the focused window, resolves with the chosen action or `null` on dismiss. Copy item is disabled when `hasSelection` is false.

## 7. Data model

### Workspace manifest (on disk)
For each workspace, `<userData>/state/<id>/workspace.json` records the persistent spec. The directory is keyed by the immutable ULID `id`; the user-facing `name` is a mutable label stored inside the manifest. Renaming a workspace is a manifest edit only — no host paths, container labels, or vault accounts move.

**Fleet root + folders.** A single app-level **fleet root** (persisted in `<userData>/config.json`, default `~/fleet`, editable via the Settings dialog) anchors two kinds of host folder: each workspace's **private** folder at `<fleetRoot>/<id>` (mounted only into that container at `/workspace`) and one **shared** folder at `<fleetRoot>/shared` (mounted into every container at `/shared`, rw). The user no longer picks a per-workspace host directory; `workspaceRoot` in the manifest is the derived private folder. A startup migration (`migration.ts`) creates these folders for existing workspaces and rewrites stale `workspaceRoot` values, and `listAllWorkspaces` always re-derives `workspaceRoot` from `<fleetRoot>/<id>` so a pre-migration container's stale label is ignored.

```ts
type WorkspaceKind = 'container' | 'local';
type AuthMode = 'oauth' | 'apikey';

interface WorkspaceSpec {
  id: string;              // ULID — identity, never changes
  name: string;            // mutable label, unique across the fleet (validated on save)
  description?: string;
  labels: string[];        // free-form, used for filtering in the Saved tab
  color?: { hue: number }; // one of 14 preset hues; random/hashed if unset
  workspaceRoot: string;   // container: derived `<fleetRoot>/<id>` (bind-mounted at /workspace). local: the user-chosen host dir claude runs in
  workspaceSubdir: string; // optional working subdir inside /workspace
  kind: WorkspaceKind;     // 'container' (Docker) or 'local' (host process, #16)
  image?: string;          // image ref for kind='container'; undefined for 'local'
  authMode: AuthMode;      // 'oauth' (default) or 'apikey' (requires ANTHROPIC_API_KEY in env)
  env: {
    plain: Record<string, string>; // values live in the manifest
    secretKeys: string[];          // values live in the safeStorage vault (<userData>/secrets.enc)
  };
  resources?: { cpus?: number; memoryMb?: number };
  mirror: {                        // durable transcript mirror (§11), factory on/delete
    default: 'on' | 'off';         // new sessions mirror unless overridden per-session
    cleanup: 'delete' | 'preserve';// pre-selected option in the close-time modal
  };
  createdAt: number;
  lastUsedAt: number;
}
```

The manifest is written on `workspace:create` and updated on successful `workspace:start`. Secret env values are NOT persisted here — only the *list* of keys (`secretKeys`). Values land in the safeStorage-encrypted vault (`<userData>/secrets.enc`) and are resolved at container-start time via `vault.resolveEnv(id, plain, secretKeys)`.

`workspace:remove(_, { deleteState: true })` removes the state dir (and thus the manifest) and the renderer additionally calls `vault:deleteAllForWorkspace(id)` so the workspace disappears from the past list and leaves no orphan keychain entries.

Manifests written before `kind`/`image` existed default to `kind: 'container'` and an undefined `image` (the runner image was used implicitly). The renderer treats undefined-kind as container, so older manifests Just Work.

### Image library (on disk)
`<userData>/imageLibrary.json` records every image a container workspace has been created against. Updated automatically on each `workspace:create` (container kind): if the ref is new the entry is inserted with labels pulled via `docker.getImage(ref).inspect()`; if it already exists, `lastUsedAt` and `useCount` are bumped and the labels are refreshed. The new-workspace modal's image picker filters this library by free-text substring across the ref and every label key/value.

```ts
interface ImageEntry {
  ref: string;                       // 'ghcr.io/org/img:tag'
  digest?: string;                   // resolved image digest (sha256:…)
  labels: Record<string, string>;    // from image inspect; LABEL directives from the Dockerfile
  firstUsedAt: number;
  lastUsedAt: number;
  useCount: number;
}
```

Writes are atomic (write-to-temp + rename). Reads tolerate a missing or malformed file by returning an empty library. Manual deletion of entries is exposed via `images:remove`; manual *addition* is not exposed today (the library is purely use-driven).

### Session inventory (on disk)
For each workspace, `<userData>/state/<id>/sessions.json` records the renderer's per-workspace tab list. Loaded by `TerminalPane` on mount, persisted on every change (add tab, close tab, switch active). PTYs themselves are not persisted — only the display ids, names, and which tab was active. On relaunch the renderer recreates the tabs and each `TerminalSession` opens a fresh `docker exec claude` per its tab. In-memory context (anything Claude held in process memory) is not yet preserved across app restarts; the in-container broker that fixes this is a deferred follow-up (see §11 Open decisions).

```ts
interface SessionEntry {
  id: string;        // stable display id = the broker session key; NOT the PTY handle (per-attach)
  name: string;      // 'main', 'session 2', 'session 3', … or an auto-derived title
  createdAt: number;
  resumeOf?: string; // set on a resume tab — first attach runs `claude --resume <resumeOf>`
  mirror?: 'on'|'off'; // per-session durable-mirror override; absent = workspace default
  autoName?: boolean;  // when true, `name` tracks Claude's session summary (auto-rename)
}

interface SessionInventory {
  version: 1;
  sessions: SessionEntry[];
  nextNum: number;   // auto-increment for 'session N' naming; doesn't decrement on close
  activeId?: string; // tab to focus on attach
}
```

Writes are atomic (write-to-temp + rename). Reads tolerate missing/malformed files by returning `{ version: 1, sessions: [], nextNum: 2 }`. The first attach to a fresh workspace inserts a single `main` tab and persists it immediately. A **resume tab** (created from the Sessions list) carries `resumeOf` so that even after the broker dies (host reboot) the re-attach re-resumes the same Claude session rather than starting a fresh one.

**Session-tab actions (⋮ menu).** Each tab has a `⋮` trigger (a portaled dropdown, like the workspace chips; replaces the old bare `×`) with **Rename**, **Refresh**, **Auto rename**, and **Close**. *Rename* is an inline edit in the tab; committing sets `name` and clears `autoName` (a manual name takes ownership). *Refresh* exits and resumes **that tab's** session in place (`claude --resume`) as soon as it's idle — the same close+resume the loadout reload uses, but user-initiated and per-tab (see §7 *Run layer — reload*). It enqueues the session id; `TerminalPane` fires it once the session goes idle (deferred while claude works) and App shows the shared toast immediately on click (`Refreshing <name>…`, or `… when idle` while busy). Disabled on an ended tab (nothing to resume in place). *Auto rename* toggles `autoName` — when on, `TerminalPane` subscribes to `observability:summary` and mirrors the tab's resolved Claude session title (`summaryForBrokerSession(...).title`, capped 40 chars) into `name`, refreshed on each push; an auto-named tab shows a `✦` marker. The toggle is **opt-in (default off)** so the conventional `main`/`session N` naming is unchanged unless the user asks for it. *Close* routes through the same `requestClose` path as before (mirror-delete confirm when a transcript mirror exists). Drag-reorder is disabled while a tab's name is being edited.

### Workspace shape (returned over IPC)
The `Workspace` type joins the manifest with live backend state:

```ts
type WorkspaceState = 'running' | 'paused' | 'stopped' | 'deleted';

interface Workspace extends WorkspaceSpec {
  state: WorkspaceState;
  containerId?: string;  // present iff state !== 'deleted'
  status?: string;       // backend status string when available
}
```

**State semantics:**
- **running** — the backend container is alive and its processes are executing.
- **paused** — the container is alive but all its processes are frozen via cgroups freezer (`docker pause`). Recoverable with `docker unpause`; preserves in-memory state.
- **stopped** — the container exists but its main process has exited (or it's in any other non-live state like `created` / `dead`).
- **deleted** — there is no live container, but a manifest is on disk. Recoverable by recreating via the create flow.

### Backend dispatch (per-workspace, by `kind`)
Workspace operations are routed to a backend **per workspace**, not chosen globally. Both backends implement a single `Backend` contract (`src/main/backend.ts`: `ping`, `ensureImage`, `listLiveWorkspaces`, `createWorkspace`, `inspectImage`, `start/pause/stop/removeWorkspace`, `attachPty`, `getBrokerLogs`) — the Docker backend (`docker.ts`), the local host-process backend (`local.ts`, #16), and the mock backend (`mock.ts`, behind `CLAUDE_FLEET_MOCK=1`). `ipc.ts` dispatches each call: `workspace:create` routes on the payload's `kind`; every other channel resolves the workspace's `kind` from its manifest via `backendRouter.ts:resolveKind(idOrContainerId)` (a Docker container id never matches a manifest path → defaults to `'container'`; a local workspace's containerId surrogate equals its id → resolves to `'local'`). `workspace:list` merges live results from both backends (deduped by id, since in mock mode both point at the same module). Docker-daemon-specific channels (`ping`, `ensureImage`, `inspectImage`) always target the Docker backend. In mock mode every workspace routes to the mock backend.

### Local (non-container) backend (#16)
The local backend (`local.ts`) runs `claude` as a **host child process** via `node-pty`, against a **user-chosen host directory** — no Docker, no broker, no bind mounts. It's for hosts where Docker is unavailable/overkill or `claude` is already installed. Binary resolution is platform-aware (POSIX + Windows); node-pty automatically uses ConPTY on Windows. Pause/resume is not supported — there is no container to freeze and SIGSTOP/SIGCONT don't map cleanly onto a host process with in-flight network connections; the Pause button is hidden in the UI for local workspaces.

- **Session manager (`localSessions.ts`)** — the in-process analog of the in-container broker. It owns each local PTY in a `Map` keyed by `<workspaceId> <sessionId>`, keeps it alive across renderer **detach/reattach** (workspace switches), and replays a capped ring buffer (256 KiB) on reattach so scrollback is restored — exactly the broker's HISTORY behavior, in the main process. `detach()` leaves the process running; only `stop`/`remove` kill it. Pure module (no node-pty import — the caller injects a `spawn` factory), so it's unit-testable; `local.ts` supplies the node-pty-backed factory (lazy `require` so the native addon loads only when a session actually spawns).
- **No cross-restart continuity.** Unlike a container (whose broker is a separate process tree that survives an app quit), a local `claude` is a child of the Electron main process and dies with the app. Liveness is in-memory only (the `started` set), so after an app restart all local workspaces report `stopped`; the user resumes them and the conversation is restored from the on-disk JSONL via `claude --resume <uuid>` — a fresh process, not the old in-memory state.
- **Working directory** — the user picks an existing host dir in the form (`dialog:pickDirectory` + a typed-path fallback); `claude` runs there. Safe to allow an arbitrary path because there's no bind mount. Stored as the manifest's `workspaceRoot` (the create + writeManifest handlers preserve it for local instead of deriving `<fleetRoot>/<id>`). Validated (exists + is a directory) in the `workspace:create` handler.
- **Uses the host's real claude config (no HOME isolation).** A local workspace *is* the user's host claude, so it inherits the real environment — crucially `HOME` — and uses the host's existing login, already-approved managed settings (the OTEL "managed settings require approval" gate), and its real install under `~/.local/bin`. An earlier isolated-`HOME` design re-triggered that approval gate on every workspace and made claude warn `$HOME/.local/bin/claude` was missing, so it was dropped: local provisions nothing under `<state>/<id>` except the manifest. Per-workspace differentiation is the working directory plus any injected env: `resolveEnv` layers the workspace's resolved env (e.g. a per-workspace `ANTHROPIC_API_KEY`) on top of the inherited host env. The `claude` binary is resolved (`claudeResolve.ts`, a pure electron-free module) by trying, in order: a `CLAUDE_FLEET_LOCAL_CLAUDE_BIN` override → `command -v claude` on the **inherited** PATH → well-known install dirs (`~/.local/bin`, `/usr/local/bin`, `/opt/homebrew/bin`, `/usr/bin`) → the user's **login shell** (`$SHELL -lic 'command -v claude'`, which sources their profile). The extra fallbacks matter because a GUI-launched Electron app (desktop icon, WSLg) inherits a minimal PATH that omits shell-profile additions — so a native-installer claude under `~/.local/bin` is invisible to `command -v` alone. On Windows the ladder is `where.exe claude` (preferring a spawnable `.exe` over an extension-less shim) → `%USERPROFILE%\.local\bin\claude.exe`; the POSIX shell steps are skipped (a GUI process already gets the registry-backed user PATH). If none resolve, attach throws a friendly "install Claude Code" error surfaced by the attach-error overlay. (Trade: local workspaces share the host `~/.claude` — login/history/config — rather than each having a private one; that's the intended meaning of "local".)
- **Lifecycle** — `createWorkspace`/`startWorkspace` mark the workspace running (processes spawn lazily on first attach); `pauseWorkspace` throws (pause is unsupported — the Pause button is hidden in the UI for local workspaces); `stop`/`remove` kill all live sessions (`remove` with `deleteState` also wipes the state dir). `listLiveWorkspaces` returns every `kind:'local'` manifest annotated `running`/`stopped` from the in-memory `started` set, so a stopped local workspace shows in the Saved modal (never the `deleted` bucket unless its manifest is gone).
- **MCP wiring (#12 for local)** — the read-only fleet MCP server is exposed to a local `claude` **without touching the user's real `~/.claude.json`**: `attachPty` spawns `claude --mcp-config <state>/<id>/mcp-config.json`. A `--mcp-config` server is **auto-trusted (no approval gate) and merges** with the user's own servers (verified against the CLI docs). The config points `claude-fleet-state` at a tiny stdio↔socket **bridge** (`mcpLocalBridge.ts`, written to `<userData>/mcp/local-bridge.cjs`) run via **Electron-as-node** (`command = process.execPath`, `env.ELECTRON_RUN_AS_NODE = '1'`, `env.CLAUDE_FLEET_MCP_SOCKET = <userData>/mcp/<id>/mcp.sock` — this local workspace's **own** per-id socket, §11/#117) — so it needs neither host `socat` (which the container uses but isn't on every host) nor host `node`. Local claude shares the app's lifetime with the MCP server, so the bridge is a plain connect with a short startup retry (no reconnect loop, unlike the container's). Skipped when the MCP socket is absent. Verify with the in-session `/mcp` command (transient `--mcp-config` servers don't show in `claude mcp list`).

### Docker container labels (backend implementation)
Today the primary workspace backend is a Docker container. The container name is `cf-<id>` (must be unique on the host); lookup is always by the `com.claude-fleet.id` label, which means renaming a workspace does not require touching the container at all. Each managed container carries:
- `com.claude-fleet.managed` = `"true"` — discovery filter. `dockerode listContainers` filters on this label exclusively, so unmanaged containers never appear in the UI.
- `com.claude-fleet.id` — the workspace's ULID. **Stable identity lookup key**; survives renames.
- `com.claude-fleet.name` — the workspace's user-facing label at create time. Snapshot only; the source of truth for current name is the manifest.
- `com.claude-fleet.workspace-root` — the workspace's private folder (`<fleetRoot>/<id>`), stamped so `listLiveWorkspaces` can return it without a manifest read.
- `com.claude-fleet.subdir` — the optional working subdir inside `/workspace`.

### Docker container shape
- `Tty: true`, `OpenStdin: true`, `StdinOnce: false` — required for interactive `docker exec` later.
- `WorkingDir: /workspace/${subdir}` (or `/workspace` if subdir is empty).
- Binds: `<fleetRoot>/<id>:/workspace:rw` (this workspace's private folder), `<fleetRoot>/shared:/shared:rw` (the fleet-wide shared folder, mounted into every container), `<userData>/state/<id>/.claude:/home/fleet/.claude:rw` (per-workspace persistent Claude state), `<userData>/state/<id>/broker:/run/broker:rw` (the directory the in-container broker creates its Unix socket in), and `<userData>/mcp/<id>:/fleet/mcp:rw` (this workspace's **own per-id** read-only MCP socket dir, §11/#117 — the per-id *leaf*, never the shared parent `<userData>/mcp/`, so a container sees only its own `mcp.sock` and the host can derive an unspoofable caller id from which listener accepted the connection). The private + shared host dirs are created (`mkdir -p`) before the container starts. When `authMode === 'oauth'`, one additional **file-bind** is layered on top of the `.claude` dir bind: `<userData>/claude-shared/.credentials.json:/home/fleet/.claude/.credentials.json:rw` — so the first workspace's Claude.ai login covers every subsequent one and token refresh in any workspace propagates to all of them. The shared host file is created (touched empty) by `docker.ts:ensureSharedCredentialsFile()` before the container starts, because Docker refuses to file-bind a missing host path. `apikey` workspaces don't get the file-bind — auth comes via `ANTHROPIC_API_KEY` in the env. A parallel OAuth-only file-bind maps `<userData>/claude-shared/remote-settings.json:/home/fleet/.claude/remote-settings.json:rw` (touched empty by `docker.ts:ensureSharedRemoteSettingsFile()`): claude fetches the org's managed settings (e.g. OTEL telemetry endpoints) into this file and shows a one-time "Managed settings require approval" gate whenever it finds managed settings not already on disk — so without sharing, every new workspace re-prompts. Approving the gate once writes the fetched settings into the shared file in place; every subsequent OAuth workspace then finds them already present and skips the gate. Security is preserved: claude re-fetches on each start, so a genuine change to the org's settings still re-triggers the gate.
- A second **file-bind** (all auth modes) maps `<userData>/state/<id>/claude.json:/home/fleet/.claude.json:rw`. This file lives in `$HOME`, *beside* `~/.claude` rather than inside it, so the `.claude` dir bind does not cover it — yet it is where claude stores onboarding/account state (`hasCompletedOnboarding`, per-project `hasTrustDialogAccepted`). Without persisting it, every freshly-created container starts blank and re-runs the onboarding wizard (theme / "trust this folder" / setup) even when the credential is already valid — which reads to the user as "having to log in again." `docker.ts:ensureWorkspaceClaudeJson()` seeds the host file (only if absent) with `{ hasCompletedOnboarding: true, projects: { "<workingDir>": { hasTrustDialogAccepted: true } } }`, where `<workingDir>` is the container's cwd, so the wizard is pre-completed. Seeding only when absent lets claude own the file once it runs (startup counts, MCP/project state accumulate and persist across restarts/recreation). Safe with no credentials yet: the seed skips the wizard but claude still performs the real OAuth login when the token is genuinely missing. Trusting `/workspace` is implied by the act of creating the workspace against that host directory.
- Env: `manifest.env.plain` merged with secret values resolved at create time via `vault.resolveEnv(id, plain, secretKeys)` (missing secret keys resolve to the empty string so the container still starts; claude itself surfaces the auth failure). `HOME=/home/fleet` is also set so tooling finds the bind-mounted `.claude/`.
- `User: <hostUid>:<hostGid>` so bind-mounted files are owned by the host user.
- Optional resource limits: `cpus` (→ `NanoCpus`), `memoryMb` (→ `Memory`).
- `AutoRemove: false` — containers persist across restarts unless explicitly removed.
- `RestartPolicy: { Name: 'unless-stopped' }` — survive a host reboot / docker daemon restart. On daemon start the container comes back, its broker re-launches, and the user can resume sessions from disk (transcripts + the `broker_sessions` mapping persist). `unless-stopped` (not `always`) respects an explicit `workspace:stop` — a deliberately stopped workspace stays down across reboots; only ones running when the daemon went away come back.

### JSONL→SQLite cache
Each workspace's Claude transcripts (`<userData>/state/<id>/.claude/projects/-workspace/<session-uuid>.jsonl`) are tailed by a single SQLite cache at `<userData>/state.db` (WAL mode). JSONL stays authoritative — the DB can be dropped at any time and the watcher rebuilds it from the JSONLs on next start.

**Schema (v8, current):**

```sql
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  ts INTEGER,                          -- ms since epoch; null for light events
  type TEXT NOT NULL,                  -- assistant / user / system / etc.
  subtype TEXT,                        -- system subtype (turn_duration, compact_boundary, …)
  uuid TEXT,                           -- event UUID (heavy events only)
  parent_uuid TEXT,
  -- fast-access extracts (NULL when n/a):
  model TEXT,                          -- assistant.message.model
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_input_tokens INTEGER,
  cache_creation_input_tokens INTEGER,
  service_tier TEXT,
  tool_name TEXT,                      -- first tool_use.name in the event's content[]
  tool_use_id TEXT,                    -- tool_use.id (assistant) / tool_result.tool_use_id (user) — links a call to its result
  tool_input TEXT,                     -- short summary of tool_use.input (command/path/pattern/…)
  tool_result_is_error INTEGER,        -- 1/0 on the tool_result event; NULL otherwise
  raw_jsonl TEXT NOT NULL,             -- original line, preserves fidelity
  dedup_key TEXT NOT NULL,             -- uuid when present, else sha256(raw_jsonl)
  UNIQUE(session_id, dedup_key)
);
CREATE INDEX idx_events_session_ts ON events(session_id, ts);
CREATE INDEX idx_events_workspace ON events(workspace_id);
CREATE INDEX idx_events_tool_use ON events(session_id, tool_use_id);

-- The tool_* columns (schema v4) feed recentToolCallsForSession: a tool_use
-- row LEFT JOINed to its tool_result row on (session_id, tool_use_id) yields
-- the call's name, input summary, wall-clock duration (result.ts − use.ts),
-- and ok/error/pending status. Added via additive ALTER so existing token/
-- cost history survives; tool detail populates as new calls land.
CREATE INDEX idx_events_type ON events(type);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                 -- session UUID (= JSONL filename stem)
  workspace_id TEXT NOT NULL,
  cwd TEXT,                            -- from first `system` event carrying it
  started_at INTEGER,                  -- first event ts
  last_active_at INTEGER,              -- max(event ts)
  ai_title TEXT,                       -- latest `ai-title.aiTitle`; Claude Code emits these lines natively (see below)
  first_user_message TEXT,             -- last-prompt or first user.content; synthetic command-wrapper messages skipped
  user_set_name TEXT                   -- manual override set via sessions:rename
);
CREATE INDEX idx_sessions_workspace ON sessions(workspace_id);

CREATE TABLE errors (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,
  workspace_id TEXT,                          -- NULL for global app-level crashes
  session_id   TEXT,                          -- claude session UUID; NULL when unknown
  source       TEXT NOT NULL,                 -- 'main' | 'renderer'
  level        TEXT NOT NULL,                 -- 'error' | 'warn' | 'info'; default 'error'
  type         TEXT NOT NULL,                 -- e.g. 'uncaughtException', 'mapping-unresolved'
  message      TEXT NOT NULL,
  stack        TEXT,
  extra        TEXT                           -- JSON blob of caller-supplied fields
);
CREATE INDEX idx_errors_workspace_ts ON errors(workspace_id, ts);
CREATE INDEX idx_errors_session ON errors(session_id);

-- v6: semantic transcript search (rebuildable from JSONL — additive).
-- vec is a Float32 BLOB (384 floats, L2-normalized) produced by bge-small-en-v1.5
-- via the local onnxruntime-node backend (bge-small-en-v1.5 at dtype q8; the DB
-- model key carries the dtype -- 'Xenova/bge-small-en-v1.5@q8' -- because q8 and
-- fp32 vectors are not comparable: a dtype change re-keys and re-embeds, and the
-- backfill purges rows under retired keys via deleteEmbeddingsForOtherModels).
-- Indexing batch (8) and per-text truncation (1000 chars) are MEMORY controls:
-- onnxruntime's arena holds its peak allocation for the process lifetime, and
-- fp32 at batch 64 x 2000 chars grew the main process past 3 GB; q8 at 8 x 1000
-- holds ~300 MB steady. Brute-force cosine search; no sqlite-vec.
-- dedup_key = 't<ref_event_id>' for turns, String(source_max_event_id) for summaries.
CREATE TABLE embeddings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  kind         TEXT NOT NULL,          -- 'turn' | 'summary'
  ref_event_id INTEGER,                -- events.id for turns; NULL for summaries
  ts           INTEGER,
  text         TEXT NOT NULL,          -- the text that was embedded
  model_id     TEXT NOT NULL,          -- e.g. 'Xenova/bge-small-en-v1.5'
  dim          INTEGER NOT NULL,       -- 384
  vec          BLOB NOT NULL,          -- Float32Array serialized as raw bytes
  dedup_key    TEXT NOT NULL,
  UNIQUE(session_id, kind, dedup_key)
);
CREATE INDEX idx_emb_workspace ON embeddings(workspace_id);
CREATE INDEX idx_emb_session   ON embeddings(session_id);
CREATE INDEX idx_emb_ref_event ON embeddings(ref_event_id);

-- v8: chaptered session summaries — one row per summarized window, not one
-- per session. A long wandering session produces an append-only sequence of
-- focused chapters (each covering ~20 completed turns) rather than one
-- over-generalized blurb. The dedup key (session_id, source_max_event_id) is
-- unchanged so replay is idempotent. Old v6 rows migrated as-is (one chapter).
CREATE TABLE session_summaries (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id          TEXT NOT NULL,
  workspace_id        TEXT NOT NULL,
  summary             TEXT NOT NULL,
  tags                TEXT,             -- JSON array for this chapter; NULL on migrated rows
  source_max_event_id INTEGER NOT NULL, -- max events.id at summary-generation time; dedup key
  from_ts             INTEGER,          -- wall-clock start of summarized window
  to_ts               INTEGER,          -- wall-clock end of summarized window
  model               TEXT,
  generated_at        INTEGER NOT NULL, -- ms since epoch
  UNIQUE(session_id, source_max_event_id)
);
CREATE INDEX idx_session_summaries_session ON session_summaries(session_id, generated_at);

-- v8: union of concept tags across all chapters for a session. Built by
-- INSERT OR IGNORE as each chapter lands — a session accumulates tags from
-- multiple chapters without duplicates and without rewriting existing rows.
-- Queried for workspace-level tag facets and semantic filtering.
CREATE TABLE session_tags (
  workspace_id TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  tag          TEXT NOT NULL,
  PRIMARY KEY (session_id, tag)
);
CREATE INDEX idx_session_tags_workspace ON session_tags(workspace_id, tag);

-- v8: append-only value-signal log. Scores are always derived at read time
-- (Phase 3 compaction); never stored destructively. Four event kinds:
--   'search-impression' — a session id appeared in a search_transcripts result
--                         (one row per distinct session per call; detail.query)
--   'clickthrough'      — a session was fetched via get_session/session_summary/
--                         list_events/get_cost within 5 min of a search that
--                         returned it (in-memory ring keyed per caller in mcpServer)
--   'marked-useful'     — mark_useful called explicitly (detail.note optional)
--   'resumed'           — host recorded a claude --resume at CREATE time
--                         (docker + local backends; strongest implicit vote)
CREATE TABLE usage_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,
  workspace_id TEXT NOT NULL,
  session_id   TEXT,     -- NULL for workspace-level events
  kind         TEXT NOT NULL,
  detail       TEXT      -- JSON blob (query text, note, etc.)
);
CREATE INDEX idx_usage_events_session ON usage_events(session_id, kind);
CREATE INDEX idx_usage_events_workspace_ts ON usage_events(workspace_id, ts);
```

`ERRORS_RETENTION = 2000`: every `recordError` call prunes to the most recent 2000 rows (DELETE by id rank). The table is an append-only ring buffer — no explicit expiry, no separate job.

`logError` is the single write path. File append to `<userData>/error.log` (one JSON line per call) remains the primary, crash-safe output; `recordError` is a best-effort DB sink registered via `setErrorSink` — a wedged DB never breaks crash logging. `LogPayload` carries optional `workspaceId`, `sessionId`, and `level` fields (absent ⇒ `null` / `'error'`), enabling operational diagnostics to be attributed to a workspace or session alongside crash rows. Beyond crash rows, the main process emits **operational diagnostics** through the same path (all queryable from a workspace via the `list_errors` MCP tool): `mcp-tool-error` (every MCP tool-call exception, with stack + tool + truncated args — #194), `mcp-call-stalled` (watchdog: a tools/call still running after 10s, tagged with the stage stuck in, `resolve-allowed` vs `run-tool`), `mcp-slow-call` (completed call over 10s total or 2s scope-resolve), `grant-check-slow` (a single `assertControl` over 1s during scope resolution), and the broker→claude mapping lifecycle (#195): `mapping-learned` (info, unambiguous pairing), `mapping-ambiguous-consume` (warn, FIFO consume with >1 tab pending — pairing is a guess; includes the queue snapshot), `mapping-remapped` (warn, a broker session's claude id overwritten with a different one — the cross-wired-tab event). MCP connection lifecycle rows make request loss attributable end-to-end: `mcp-conn` / `mcp-conn-closed` (info; transport, lifetime, rpc-line count per connection) and `mcp-auth-failed` (warn; a TCP connection presented an unknown token).

This `sessions` table is the index behind the Sessions table feature (§6 *Sessions*, §8 *Browse & resume a past session*): `listSessions` reads it (joined to a grouped `events` pass for cost + event count), `renameSession` sets `user_set_name`, and `deleteSession` removes the session's rows here + in `events`/`broker_sessions` before the IPC layer unlinks the JSONL.

**Title derivation.** The display title is `user_set_name ?? ai_title ?? first_user_message`. `ai_title` is **populated, not dormant** — Claude Code (≥2.1.x) writes `{"type":"ai-title","aiTitle":…,"sessionId":…}` lines into its own transcript natively (no hook, no statusline), and `ingestLine` folds the latest into `sessions.ai_title`. This rides on an **undocumented native transcript line type**, so it is the kind of thing a `claude` pin bump can silently break (§4 — bumping the pin is deliberate; re-verify the `ai-title` line still appears). `first_user_message` is the COALESCE'd first value, but **synthetic command-wrapper messages are skipped** when deriving it (`src/main/userPromptText.ts`): a session started with a slash command (e.g. `/clear`) emits a wrapper-only first `user` message (`<local-command-caveat>`/`<command-name>`/…) that would otherwise lock in as a junk fallback title; the first *real* prompt wins instead. `tests/ai-title.spec.ts` pins both behaviors against the real watcher + DB.

**`session-summary` JSONL event type.** The runner's `Stop` hook (`summarize.sh`) writes `{"type":"session-summary","summary":"…","tags":[…],"sessionId":"…","model":"…","fromEventTs":"…","toEventTs":"…"}` into the **sidecar** `<uuid>.fleet.jsonl` (never the live transcript). The watcher picks up sidecars via the `*.fleet.jsonl` naming convention and routes each `session-summary` event to `ingestLine` → `insertSessionChapter` (append-only, dedup by `source_max_event_id`) + `insertSessionTag` (union across chapters, INSERT OR IGNORE). The chapter is then scheduled for embedding the same as a turn. Vectors are rebuilt from stored JSONL on DB drop + replay — the same idempotency guarantee as `events`.

**Local embeddings.** Turn text and session summaries are embedded by `bge-small-en-v1.5` (384-d, L2-normalized) running locally via the `@huggingface/transformers` library on the **native `onnxruntime-node`** backend (ONNX Runtime, not the WASM fallback). `onnxruntime-node` is a cross-build native module: prebuilts are fetched by `install-app-deps` for the target Electron ABI; it is declared in `asarUnpack` alongside `better-sqlite3`/`keytar`/`node-pty`. The transitive `sharp` dep must ship and be asarUnpacked (see §4 *Native modules* for the rationale). Indexing failures degrade silently (per-turn errors logged, search never blocks ingest).

**Why these design choices:**
- **Unique `(session_id, dedup_key)`** makes ingestion idempotent. Re-tailing a JSONL from byte 0 (after crash, after losing in-memory offsets) produces no duplicates: heavy events use their `uuid` as the key; light events without a `uuid` use a SHA-256 hash of the raw line. Insert uses `INSERT OR IGNORE`.
- **`raw_jsonl` stored verbatim** so the DB is rebuildable and so new extract columns can be backfilled from existing rows without re-tailing.
- **Subagent JSONLs** (`<session-id>/subagents/agent-*.jsonl`) are deliberately *not* ingested today — the watcher uses `depth: 0` to skip them. Surface them later if needed.

**Watcher behavior:**
- One `JsonlWatcher` instance per main process. Started on `app.whenReady` (after `listWorkspaceManifests`), stopped on `before-quit`.
- Each workspace is registered with `registerWorkspace(id)`, which `mkdir -p`s `<state>/<id>/.claude/projects/-workspace` and adds it to the chokidar watch set. The mkdir is non-obvious but load-bearing: chokidar v5 silently drops paths that don't exist at `add()` time (its docs imply it queues missing paths and watches them when they appear, but in practice the create-detection misses files claude later writes there). Symptom when omitted: any workspace whose claude first-run happens AFTER `registerWorkspace` never gets its JSONLs ingested — the observability pane stays empty for that workspace forever.
- Per-file byte offsets are kept in memory only. On add/change: read from offset to EOF, find the last `\n`, ingest complete lines, advance offset past the newline. Trailing partial line waits for the next event.
- Compaction (file shrinks below the stored offset) resets the offset to 0; `dedup_key` ensures already-ingested rows aren't duplicated.
- **Sidecar convention (`*.fleet.jsonl`).** Files matching `<uuid>.fleet.jsonl` in a watched directory are host-written data sidecars (Stop-hook chapter summaries) rather than live claude transcripts. `parseTranscriptFilename` recognizes them by the `.fleet.jsonl` suffix and returns `{ sessionId: <uuid>, sidecar: true }`. Sidecar ingestion: (a) never fires the `'new-session'` event (cannot touch the pending-attach fallback path — a sidecar is not a new claude session); (b) skips the new-primary-file guard (sidecars are created out-of-band and may appear after the session is indexed); (c) ingests events normally — `session-summary` lines route to `insertSessionChapter` + `insertSessionTag` and are scheduled for embedding. Sidecar files are never mirrored by the durable transcript mirror; they are DB data, not user transcript history.
- Mock mode (`CLAUDE_FLEET_MOCK=1`) skips watcher + DB entirely — no real JSONLs to read.

### Vault layout
Secret env-var values live in `<userData>/secrets.enc`: a single JSON object `{ "<workspaceId>": { "<envVarName>": "<value>" } }`, serialized, encrypted with `safeStorage.encryptString`, and stored base64. One file holds the whole fleet's secrets (no per-account keychain entries, no separate index — listing a workspace's keys is just the object keys of its bag). `vault.ts` keeps the decrypted store cached in memory and serializes writes through a lock.

Why a file rather than `keytar`: keytar requires a Secret Service daemon on Linux that's absent on bare WSL, so secrets silently failed there. `safeStorage` encrypts with the OS keyring when available; on Linux with no keyring, `vault.ts` calls `setUsePlainTextEncryption(true)` once so encrypt/decrypt still work (base64 plaintext — see §9 for the trade), making the file usable everywhere (see §4 *Stack*). Secrets written under the old keytar scheme are not migrated — users re-enter API keys once.

The old `__profiles__:*` keytar shape (global per-profile API keys) is gone. The startup migration in `src/main/migration.ts` still runs a best-effort purge of legacy keytar entries (lazy `import('keytar')`, no-op if libsecret is absent), so pre-existing installs don't leave stale credentials in the OS keychain.

Values are read from the renderer only on explicit `vault:getSecret`; during normal operation, the main process consumes them directly via `resolveEnv` when constructing the container env (not round-tripped through the UI).

### Loadout library (#16-followup)
A **loadout** is a reusable, machine-parseable bundle of Claude config the user installs into a workspace on demand. Authored loadouts live at `<userData>/loadouts/<id>/`, each a folder with a `loadout.md` (**YAML frontmatter + markdown body** — the Claude-Code idiom, so a Claude instance parses it natively):
- **Frontmatter** = `title`, `version` (semver), `description` (the relevance signal), `tags`, `dependencies { loadouts: [{id, version?}], tools: [{cmd, version?}] }`, `scripts[] {label, run|file, unless?}`, `prompts[] {label, send|file}`. **Body** = install-instructions prose.
- **Convention-mapped files**: anything under `skills/ commands/ agents/ rules/ output-styles/` plus a root `CLAUDE.md` is part of the bundle — no need to list files.

**Apply model** (drives install + uninstall): **① drop** — convention files copied into the workspace's project root `.claude/` (for a container that's `<fleetRoot>/<id>/.claude/`, claude's cwd); **② merge** — `CLAUDE.md` appended as a marked `<!-- loadout:<id> start/end -->` block; `settings.json` blended into `.claude/settings.json` at **top-level-key** granularity (a key is added only if absent — collisions skipped + reported, no deep merge into an existing key in v1); named servers from `.mcp.json` merged into the workspace's root `.mcp.json`; hooks (from a dedicated `hooks.json` and/or `settings.json`'s `hooks`) appended **per-event** into `settings.hooks`; **③ run** — `scripts` run in the container at install via `docker exec` (`runInWorkspace`), each with an optional `unless` skip-guard (exit 0 ⇒ skip) and an inline `run` or a `file`; per-script results (`ran`/`skipped`/`failed`) return in the install result and surface in the review on failure. Scripts have side effects and are **not** reverted on uninstall. (`prompts` sent to the reloaded session are next.) Install is **collision-safe** (existing files/keys/servers are skipped + reported, never clobbered) and **container-only** in v1 (a local workspace runs in the user's real repo). `WorkspaceSpec.installedLoadouts[]` records the exact dropped files **and** merges (CLAUDE.md flag, settings keys, mcp server names, hook entries by value) so **uninstall reverts precisely** — removing only what the loadout added and keeping anything edited after install.

The pure engine is `src/main/loadoutCore.ts` (parse + apply/revert; fs+yaml only, unit-tested); `src/main/loadouts.ts` is the electron-aware wrapper (resolve `loadoutsRoot`/`fleetPrivateDir`, manifest read/write, `ensureBuiltinLoadouts` seeds 2 starters on first run).

**Run layer — reload (the "in-place `--resume`").** A loadout's files/merges land in the workspace's `.claude/`, but claude only reads its config **at session start** — so a freshly-installed loadout has no effect on a *running* session until claude restarts. Rather than make the user restart (the old destructive `stop`/`start` path loses the conversation and isn't reused here), the reload **closes and re-resumes the active session in place**: ① resolve the active tab's Claude session UUID (`sessions:resolveResumeTarget` — verified mappings only; unverified ⇒ the reload is skipped with an explicit toast rather than resuming a guess), ② `pty:closeSession` the live handle (broker CLOSE ⇒ claude exits, transcript flushed to `<uuid>.jsonl`, session dropped), ③ re-attach the **same** broker session id with `resumeOf=<uuid>` ⇒ the broker `CREATE`s `claude --resume <uuid>`, so the **same tab** picks the conversation back up — now with the loadout loaded. This close+resume is driven by a **per-session token map** in `TerminalPane`: `reloadTargets: Record<sessionId, token>`. Each `TerminalSession` is handed its own `reloadToken={reloadTargets[id] ?? null}`; when that number advances, the session runs the close+resume against itself. **Two producers feed the map**, both deferred until the target session is idle (busy/idle from the title-glyph `activityDetector`):

- **Loadout reload.** `LibraryPane`→`onInstalled(workspaceId)`→`App` (only if **autoReloadLoadouts** is on **and** the workspace is a running container) sets a per-workspace `reloadRequest`; the matching `TerminalPane` holds it pending and, once the **active session** is idle, bumps `reloadTargets[activeId]` (and fires `onReloadStarted` → the "Applying loadout…" toast).
- **Manual Refresh** (chip ⋮ menu, §6). `requestRefresh(s)` enqueues `s.id` into a `pendingRefresh: Set<sessionId>`; a drain effect bumps `reloadTargets[id]` for every queued id that is idle, not ended, and still present (the pure `readyToRefresh` helper, unit-tested). App shows the shared toast at click time. This targets **the specific tab** (even a background one), unlike the loadout path's active-only target — which is why the single target became a map.

If no resumable UUID exists (claude never started in that tab), it's a no-op — the files are already in place for the next start. The close+resume touches the broker session lifecycle and can't be exercised in mock/CI (needs a real `claude --resume`); the loadout path is verified by live container test, and the manual Refresh's queue/idle-gate logic is unit-tested (`readyToRefresh`) with an e2e covering the menu→toast wiring in mock mode.

**Shipped so far:** the format/parse, the **drop** + **CLAUDE.md marked-block** install/uninstall, manifest tracking, collision-safety, container-only, the IPC surface, and the **left-rail Library UI** — an accordion (Sessions + Library) with search + tag-filter, detail cards with per-workspace install/uninstall, and a review-before-install modal (files manifest + 🗀 Open folder). Plus the **merge layer** — `settings.json` (top-level keys), `.mcp.json` (named servers), and hooks blended in with precise tracked revert, surfaced in the review modal (a "Merges into config" list + a "Hooks · run on events" group). Plus **scripts** in the run layer — a loadout's setup commands run in the container at install (`docker exec`, `unless`-guarded), with results surfaced. Plus the **in-place `--resume` reload** — installing a loadout into a running workspace closes + re-resumes its active session so the loadout takes effect without losing the conversation, gated on an **auto-reload setting** (default on) firing only while claude is idle (see *Run layer — reload* above). Still **planned** (below): `prompts` sent to the reloaded session, versioning/dependency resolution + the Requirements preflight, the authoring modal, and the MCP discovery tools.

**Host-private boundary (invariant, §9).** The library at `<userData>/loadouts/` is in the host-private zone — **never bind-mounted into any container**, like the DB / vault / transcript mirrors. A workspace only ever sees the **installed snapshot** copied into its own `.claude/` + `CLAUDE.md`, never the library folder. A workspace's Claude discovers loadouts (to judge relevance and recommend) **only through the read-only MCP `list_loadouts`/`get_loadout` tools** — *mediated* metadata the main process chooses to expose, exactly the §9 rule (mediated, never a raw bind mount). Discovery ≠ filesystem visibility.

**Versioning, dependencies & sync (design; PR2+).**
- **semver.** `loadout.md` carries a `version`; `installedLoadouts[].version` records what each workspace has. The install marker is version-stamped (`<!-- loadout:<id>@<version> start -->`) so the snapshot is self-describing. (Adds the `semver` dep.)
- **Editing the source.** A loadout folder is filesystem-first and the app re-parses it on demand, so editing the source needs no "push" — the library reflects it immediately. Edit it via the **authoring modal** or **Open folder → your editor** (both first-class). A workspace's **Claude** authors a loadout by writing the folder **into its own workspace** (where it has write access); the host then **imports** it into the library — Claude never writes the host-private library directly (the host mediates).
- **Pushing an edit into installed workspaces is host-side**, reusing the install/uninstall engine: **Update** (when the source's semver > the workspace's installed version → revert old snapshot, install new — surfaced as "update available") and **Reinstall/Sync** (force re-apply the *current* source, for the author iteration loop where the version isn't bumped each save). Both run in the **main process** (it owns each workspace's private dir), keep collision-safety, **keep + flag** any file the user edited after install (never silent overwrite), and re-stamp the version marker. The container picks it up on its next session (same as install). Updates are **explicit/reviewed** (scripts re-run, files change), never automatic.
- **Both versions live on the host** — the library's `loadout.md` and the workspace's host-private manifest — so the container **never participates in version sync** and never sees the library.
- **Writes never go through the MCP server.** Edit/import/install/update/uninstall are mutations and run in the privileged **main process via IPC + the loadouts engine**. The MCP server stays **read-only** — its loadout role is **discovery only** (`list_loadouts`/`get_loadout`). A future *autonomous* install/update triggered by a workspace's Claude would be a deliberate, opt-in **write RPC** whose effect still executes in the main process, not the MCP server touching the filesystem.
- **Loadout dependencies** resolve **install-first** (topo-ordered, cycle-guarded). The library holds exactly **one** version of each loadout on disk, so a dependency `version` range is a *satisfies-check* against that single version (no multi-version solver) — an unsatisfiable range blocks with the exact mismatch.
- **Tool dependencies** are *declared expectations*, **preflight-checked** in the workspace (`command -v` + optional `--version` range) and surfaced in the review's **Requirements** section (✓ present / ✗ missing or wrong version). Since the runner image is **non-root** (no `apt`), runtimes are provided by the loadout's own **user-space bootstrap scripts** (`rustup`, `uv`, `nvm` into `$HOME`), guarded by `scripts[].unless` (e.g. `unless: command -v cargo`) so they run only when missing. System packages needing root are **not** auto-installed — the recommended escape hatch is a custom runner image. A missing **`required: true`** tool hard-blocks; otherwise install warns + proceeds (the review showed the risk).

Renderer: `LeftRail.tsx` (the accordion shell — Sessions section reuses `SessionsPane` in `embedded` mode + the new Library section), `LibraryPane.tsx` (search/tag-filter + cards + install/uninstall), `LoadoutReviewModal.tsx` (the review). **Card collapse (long-list ergonomics):** each loadout card is independently collapsible via a disclosure **chevron** in its title row (collapsed = title + action only; the body — description + tags — hides). The chevron toggles that one card (stops propagation, so the card-body click still opens the review modal); a header **Collapse all / Expand all** toggle (shown when >1 card is visible) acts on the currently-filtered set, its label following whether most visible cards are open. Cards default **expanded**; the set of collapsed ids persists to `localStorage` under `loadoutLibraryCollapsed` (a pure UI preference, like the rail-collapse state) — a loadout not in the set is expanded, so new loadouts appear open. Still forthcoming: the **Requirements** section in the review (tool preflight, with the merge/run layer), the authoring modal, and the read-only MCP discovery tools.

### Loadout library v2 — Phase 1: local catalog, favorites, browser modal

**Phase 1 is implemented.** Design doc + hi-fi mocks: [`docs/superpowers/specs/2026-06-28-loadout-library-v2-design.md`](superpowers/specs/2026-06-28-loadout-library-v2-design.md). The pure OCI logic core (`src/main/ociCore.ts` — ref parsing, artifact-layer path sanitizer, index parsing, version compare) was implemented and unit-tested in an earlier step; Phase 1 wires the user-facing layer on top of the local-only catalog.

**IPC (Phase 1, all privileged main process):**
- `loadouts:catalog(workspaceId?)` → `CatalogEntry[]` — assembles the local library with per-workspace install state (`installed`, `installedVersion`, `updateAvailable`), `present` (folder exists on disk), and `favorited` (from `config.json`). Returns all entries when `workspaceId` is omitted (used by the browser modal, which shows the full catalog regardless of workspace selection).
- `loadouts:setFavorite(id, on)` → `string[]` — toggles one loadout's membership in `config.json`'s `favorites` set and returns the updated set. Favorites are global (user-level, not workspace-scoped).

**Favorites (global).** `config.json` gains a `favorites: string[]` field. The field is absent-tolerant (defaults to `[]`) and is written by `loadouts:setFavorite`. The catalog builder reads it and sets `favorited: boolean` per entry. There is one favorites set for the whole app; per-entry `installed`/`updateAvailable` state is relative to the selected workspace.

**Left-rail additions (Phase 1).** The library pane gains two affordances beside the existing Tags dropdown: a **`.fav-filter`** toggle button (☆/★) that, when active (`.on`), filters the card list to `favorited === true` only; and a **`.lib-browse`** "Browse all" button that opens the browser modal. Each expanded card gains a **`.lc-fav`** button (☆ Favorite / ★ Favorited) that calls `loadouts:setFavorite` and triggers a catalog reload.

**Browser modal (`LoadoutBrowserModal`).** Renders as `.modal.loadout-browser` (720 px wide, flex column). Layout: `.lb-head` (title + close); `.lb-body` grid (200 px `.lb-facets` sidebar + `.lb-results` list). The facets sidebar has a `.lb-search` input and a `.lb-tagcloud` of `.lb-tag` pills (each togglable, `.on` when active — tag filter requires *all* active tags), plus a `.lb-sources` section added in Phase 2 (see below). Each result row is `.lb-row` with `.lb-row-main` (title, tags, description) and `.lb-row-actions` (`.lc-fav` toggle + Install / Installed button).

**Styles (new classes, `styles.css`).** `.fav-filter`, `.fav-filter.on`, `.lc-fav`, `.lc-fav.on`, `.lib-browse`, `.modal.loadout-browser`, `.lb-head`, `.lb-body`, `.lb-facets`, `.lb-search`, `.lb-tagcloud`, `.lb-tag`, `.lb-tag.on`, `.lb-results`, `.lb-row`, `.lb-row-main`, `.lb-row-title`, `.lb-row-desc`, `.lb-row-actions`, `.lb-empty`. All use the existing token set (`--ok`, `--rule`, `--bg-3`, `--ink`, `--ink-2`, `--r-sm`, `--r-md`). Phase 2 adds: `.lb-sources`, `.lb-sources-head`, `.lb-source-row`, `.lb-source-name`, `.lb-source-remove`, `.lb-add-source`, `.lb-source-error`, `.btn.update`.

### Loadout library v2 — Phase 2: remote OCI sources + update detection

**Phase 2 is implemented.** The paired index publisher shipped in `claude-fleet-loadouts` (the `publish-loadouts.yml` workflow emits `<source>/index:latest` with artifactType `application/vnd.claude-fleet.loadout-index.v1`). Per the workspace CLAUDE.md cross-repo contract, both sides landed in the same change.

**`src/main/ociClient.ts` — anonymous GHCR pull.** A native, zero-dependency OCI pull module (`fetch` only, no `oras` binary). The **anonymous token flow**: probe the manifest URL; if the registry returns HTTP 401 with `WWW-Authenticate: Bearer realm=…`, exchange the parsed realm/service/scope for an anonymous bearer token via the GHCR token endpoint. The token is then attached as `Authorization: Bearer` for all subsequent requests (manifest + blobs). If the probe returns anything other than 401, no token is requested (the manifest is already publicly accessible or the registry allows unauthenticated pull). Key exports: `pullArtifact(ref, destDir)` — fetches the manifest and streams each layer's blob into `destDir`, writing each file at its `org.opencontainers.image.title` annotation path via `safeLayerPath` (from `ociCore.ts`) to prevent directory traversal; `fetchAnnotations(ref)` — returns the manifest's top-level `annotations` object without pulling any blobs (used for provenance/version checks). **Security invariants**: every layer title goes through `safeLayerPath` (throws on `../` or absolute paths — aborts the whole pull); each blob is checked against a 5 MiB `MAX_BLOB_BYTES` cap before writing (manifest `size` field + `Content-Length` + final buffer all checked); all requests carry a 30s `AbortSignal` timeout. Non-GHCR registries are rejected by `parseImageRef` before any network call.

**`src/main/loadoutSources.ts` — sources, provenance, download.** Manages `<userData>/loadouts/sources.json` (shape: `{ sources: string[], provenance: Record<string, { source, version, downloadedAt }> }`). Exports: `listSources()` → `string[]`; `addSource(base)` — validates the source is reachable by pulling and parsing its index, then appends to `sources[]`; `removeSource(base)` — removes from `sources[]` and clears the in-memory cache; `browseSource(base, { refresh? })` — returns the cached index or pulls a fresh one; `allRemote()` — maps every configured source to its index (failed sources are skipped + logged, not fatal, so a temporarily unreachable source doesn't block the catalog); `download(source, id, version?)` — pulls the loadout artifact into `loadoutDir(id)` (i.e. `<userData>/loadouts/<id>/`) and writes provenance. The base URL is normalized (trailing slashes stripped) everywhere, and the index ref is constructed as `<base>/index:latest`.

**Catalog remote merge (`src/main/loadoutCatalog.ts`).** `buildLoadoutCatalog(workspaceId?)` now calls `allRemote()` and passes the result to `assembleCatalog` (in `ociCore.ts`). The catalog merges local library entries with remote index entries: a remote loadout whose `id` is already present locally gets `present:true`, `sources:[…]`, and `updateAvailable` set when the remote version is higher than the installed version; a remote-only loadout gets `present:false`, `installed:false`. The `CatalogEntry` type carries `remoteVersion?: string` from `ociCore.ts`.

**Pull-if-needed install + collision-confirm.** `loadoutInstall.ensureAndInstall(workspaceId, id, opts?)` is the install entry point. When `opts.source` is supplied: if the loadout is absent locally (`present:false`), `download(source, id, version)` is called first to pull it into the library before `installLoadout` runs (pull-if-needed). If the loadout already exists locally and `opts.force` is not set, the handler returns `{ status: 'needs-confirm', reason: 'collision' }` — the renderer's `onInstall` prompts the user ("already exists locally — overwrite?") and, on confirm, re-calls with `force: true`. `force: true` overwrites the local copy. Returns `{ status: 'installed' }` on success.

**New IPC channels (Phase 2, all privileged main process):**
- `loadouts:listSources()` → `string[]` — current source base URLs from `sources.json`.
- `loadouts:addSource(base)` → `RemoteLoadout[]` — validates + adds a source, returns its index.
- `loadouts:removeSource(base)` → `void` — removes from `sources[]` + clears cache.
- `loadouts:refreshSource(base)` → `RemoteLoadout[]` — force-refreshes one source's index.
- `loadouts:install` (extended) — now accepts `opts?: { source?, version?, force? }` to trigger pull-if-needed and collision-confirm; without opts, plain local install as before.

**Browser modal additions (Phase 2).** The `.lb-facets` sidebar gains a `.lb-sources` section below the tag cloud. It renders one `.lb-source-row` per configured source (checkbox + `.lb-source-name` + `.lb-source-remove` ×-button); checking a source filters the results list to entries that come from that source (or are already present locally). A `.lb-add-source` row has a text input (placeholder `ghcr.io/owner/repo`) + `+ Add` button that calls `loadouts:addSource`; errors surface in `.lb-source-error`. The ×-button on each row calls `loadouts:removeSource`; it stops propagation and prevents default so it doesn't toggle the surrounding label's checkbox.

**Rail `Update ↑` affordance (Phase 2).** When a catalog entry has `installed:true` and `updateAvailable:true`, `LibraryPane.tsx` renders a `.btn.update` button beside the ✓ Installed badge. Clicking it calls `loadouts:install(workspaceId, id, { source, version: remoteVersion, force: true })` to pull the latest version and reinstall. The button is disabled when the workspace is not in a runnable state.

**Host-private invariant (§9).** All downloaded artifacts land exclusively in `<userData>/loadouts/<id>/` via `loadoutDir(id)` — the host-private library, never bind-mounted into any container. A workspace only ever sees the installed snapshot in its own `.claude/`. The `safeLayerPath` + `MAX_BLOB_BYTES` cap (5 MiB/layer) enforces this at the pull layer: traversal attempts abort the pull before writing anything; oversized blobs are rejected.

## 8. User flows

### Startup
1. Main creates the window, registers IPC handlers.
2. Before any IPC traffic, main runs `runStartupMigration()` from `src/main/migration.ts`. Four idempotent passes:
   1. Legacy name-keyed state dirs get a fresh ULID and the dir is renamed in place (with the manifest rewritten to the new shape — `authMode='oauth'`, empty `env`, etc.).
   2. Any keytar entry under `service=claude-fleet` whose account doesn't fit the new `<id>:<key>` / `__secrets__:<id>` shape is deleted (`__profiles__:*` purge).
   3. **OAuth credentials consolidation** (Phase 3, #57): every workspace's per-workspace `.claude/.credentials.json` that's a *real non-empty file* (not a symlink, not empty) is folded into the shared file at `<userData>/claude-shared/.credentials.json`. If the shared file doesn't exist (or is empty) and at least one workspace has real credentials, the most-recently-modified one is promoted to the shared path; the others are backed up as `.credentials.json.old`. Every per-workspace path becomes a symlink to the shared file so the host-side filesystem reflects reality.
   4. **Fleet folders**: create `<fleetRoot>/shared` and each workspace's `<fleetRoot>/<id>` private folder, and rewrite any manifest whose `workspaceRoot` predates the fleet-root model to the derived private path.
3. Renderer mounts; on first render it calls `workspace:ping`. If false, the main pane shows "Docker daemon unreachable — start Docker Desktop (with WSL2 integration)."
4. If reachable, renderer calls `workspace:list` and polls every 5s thereafter to pick up state changes from outside the app. The list includes live workspaces (running/stopped) and deleted workspaces (manifest on disk, no container). The renderer keys selection by the ULID `id`; `containerId` is present only for live workspaces and is what stop/pause/remove/attach take.

### Create a workspace
1. User clicks the **`+`** button in the top strip (adds a workspace — new or resumed).
2. `<WorkspaceModal>` opens. Two tabs at top: **Saved** (count badge) + **New**, underlined-tab style. Default tab is Saved when at least one non-running workspace exists, else New.
3. The Saved tab lists every stopped / deleted workspace (the "cold" fleet; running/paused are in the strip, #21) — sorted with a Variant-B label-filter search at the top: text input matches name + description (substring, case-insensitive), and a **Labels** dropdown opens a checkbox list of fleet-wide labels with usage counts. Selected labels filter the list as OR (any-match); active filters surface as removable pills above the list with an `N of M` count on the right. Each row shows a color identity bar, name, description, state badge, and last-used relative time. Clicking a row's header animates it open (CSS `grid-template-rows: 0fr → 1fr`, 320ms cubic-bezier; chevron rotates 180°; form contents fade-and-slide in over 220ms with 80ms delay) and renders `WorkspaceForm` inline in `mode='edit'` with the persisted spec pre-filled. The expanded row's footer is **Delete (danger)** on the far left, then `Cancel · Clone · Resume` on the right.
4. **Resume** (primary in the expanded form) — `App.handleResume`:
   - Writes any newly-typed secret env values via `vault:setSecret(id, key, value)`. Pre-existing secrets the user didn't touch are left alone.
   - Calls `workspace:writeManifest(spec)` so renderer-visible edits (description, labels, color, name) take effect immediately even if the container needs a restart for env/image changes.
   - Calls `workspace:start(id)`. If a container exists (state was stopped/paused/running with no label match), it's started. If null (state was deleted, container gone), the renderer falls through to the create flow with the **same id reused** so state-dir + vault history stay attached.
5. **Clone** in the expanded form opens the modal in Clone mode — `App.openCloneFrom` strips the source's id, auto-suggests `<source>-N` (incrementing N from 2 until unused), clears the color so a fresh hue is picked, and the modal's New tab takes the foreground pre-filled with the source's spec. The user can edit before clicking **Create & start**. Source workspace is unchanged.
6. **Delete** in the expanded form (or chip ⋮ menu) opens `DeleteWorkspaceModal` — a confirm modal with explicit warning text. On confirm: `workspace:stop` (if live) → `workspace:remove(containerId, { deleteState: true })` (wipes state dir + manifest) → `vault:deleteAllForWorkspace(id)` (purges every secret).
7. **Cancel** in the expanded form collapses the row without applying changes.
6. The **New** tab is the Create form. The user fills:
   - **Type** radio: Container (default — isolated Docker runner) or Local ("coming soon" — submit throws).
   - For Container, an **Image** input appears with the inline image-library picker beneath it (default = most-recently-used library entry, or the bundled runner). A magnifying-glass button right of the input opens **`AdvancedImageSearchModal`** — a focused search surface mirroring the Saved-tab Variant-B shape (text input matches ref + digest, **Tags** dropdown filters by the `:tag` segment with OR semantics + pills). Each row in the list also surfaces which workspaces currently use the image (stopped consumers called out in warning color), so pinning a specific build is informed.
   - **Name** with pet-name placeholder and a **color swatch** to the left (popover with 14 OKLCH preset hues + Random). The swatch is dashed when no hue has been picked — `WorkspaceTabStrip` falls back to a name-hash of the same palette in that case so the chip still gets a stable distinct color.
   - **Description** textarea (optional).
   - **Labels** chip input with `<datalist>` autocomplete drawn from every other workspace's `labels[]`. Used for filtering in the Saved-tab list (PR 2 surface).
   - **Subfolder in /workspace** (optional) — a working subdir inside the container's private folder. (There is no host-path picker: the private + shared folders come from the app-level fleet root, configured in Settings.)
   - **Auth** radio: OAuth (default) / API key. API key is disabled until `ANTHROPIC_API_KEY` is added to the env list below — the radio's tooltip points there.
   - **Env vars** disclosure: KV editor with a per-row `secret` toggle. Plain rows land in `manifest.env.plain`; secret rows ship to `vault:setSecret(<newId>, key, value)` and only their *key names* are listed in `manifest.env.secretKeys`. The secret toggle is forced off when `vault:available` returns false. Edit mode shows pre-existing secret keys with a "•••••" placeholder; the user can replace by typing or leave untouched and the keychain entry stays as-is.
   - **Resource caps** disclosure (Container only): CPUs + Memory MB. Blank → no Docker limit.
7. **Create & start** submits. The renderer:
   1. Validates name (1–80 chars, no control characters, no name clash against the existing fleet) and env-var keys (`[A-Z_][A-Z0-9_]+`, no duplicates).
   2. Mints a fresh ULID via the `ulid` package (in `WorkspaceModal.handleCreate`, before the form's payload reaches App).
   3. For each secret env row, calls `vault:setSecret(id, key, value)`. Failures are warned but don't block the create (the container will start with the secret resolving to `""`).
   4. Calls `workspace:ensureImage(channelId, submit.image)` (pulls the selected image with progress in the modal), then `workspace:create` with the payload (id, name, description, labels, color, workspaceSubdir, kind, image, authMode, env: { plain, secretKeys }, resources) — no host path.
8. Main creates the workspace's private folder (`<fleetRoot>/<id>`) and the shared folder (`<fleetRoot>/shared`), creates the container (`docker create cf-<id>` with the `com.claude-fleet.id` label, the private folder bound at `/workspace` and shared at `/shared`, env resolved through `vault.resolveEnv`), writes the manifest, records the image in the library, and returns the `Workspace`.
9. The top strip refreshes; the new workspace appears and is auto-selected.

### Attach a terminal
1. User selects a workspace in the top strip (only live workspaces appear there).
2. `<TerminalPane>` mounts. It reads the workspace's persisted `sessions.json` via `sessions:read(workspaceId)`. If the inventory is non-empty the saved tabs are restored (including which one was active); otherwise a single auto-created `main` tab is inserted and persisted right away. The pane manages a tab strip above the terminal body and one `<TerminalSession>` per tab stacked in the body — only the active tab is `visibility: visible`, the rest stay mounted so their PTYs and scrollback are preserved across tab switches.
3. Each `<TerminalSession>` creates an `xterm` `Terminal` (DOM renderer — no canvas/webgl addon — so it does native per-glyph CSS font fallback), fits to its host div, calls `pty:attach(containerId, cols, rows)` → gets a `sessionId`. **Terminal fonts:** `TERMINAL_FONT_FAMILY` is a monospace-first chain with symbol/emoji fallbacks. Because the Linux/WSLg fontconfig set has no glyph for some characters Claude Code's TUI emits — the permission-mode media triangles (`⏵⏵ accept edits on`, U+23F5) and the tool-result tree connector (`⎿`, U+23BF) — two subsetted symbol fonts are **bundled** via `@font-face` (styles.css, Miscellaneous-Technical block only, ~3–4KB each): `Noto Sans Symbols 2` (crisp, preferred) and `Unifont` (last-resort catch-all for glyphs even Noto lacks, e.g. `⎿`). Both are **inlined as data: URIs** (`electron.vite.config.ts` forces `assetsInlineLimit` for `.woff2`) — the renderer is served over `file://`, where an emitted-as-a-file `@font-face` woff2 fails to load. After `term.open` the session forces `document.fonts.load(...)` for both families and refreshes so the glyphs don't flash as tofu on first paint. (Unifont's source `OS/2` carries an out-of-spec unicode-range bit that must be zeroed before subsetting, or Chrome's OTS sanitizer rejects the woff2.) It registers `onData` (writes chunks into xterm) and `onEnd` (shows the session-ended overlay). `term.onData` forwards to `pty:input(sessionId, data)`. A `ResizeObserver` re-fits and calls `pty:resize` on host div resize. The end-state overlay has two variants: a **natural** card ("claude session ended — Start new session") when `pty:end` fires after a successful attach, and an **attach-error** card surfacing the error message verbatim plus a `docker pull` hint when `pty:attach` itself throws (most often: stale runner image missing the broker, broker socket unreachable). The attach-error variant exists because the overlay is `position: absolute` over `.terminal-host` — without it, any error text written into xterm would be hidden behind the modal.
4. Clicking the **+** in the tab strip creates a new session. The first session is named `main`; subsequent sessions are `session 2`, `session 3`, … via a counter that doesn't decrement on close (so names stay stable). Each tab carries a small status dot showing two states today: **live** (PTY attached, normal-color dot) and **ended** (PTY exited, grey dot). Lifecycle is driven by the existing `pty:end` signal each `TerminalSession` already observes; `TerminalSession` reports state changes via an `onLifecycleChange(sessionId, 'live' | 'ended')` callback the parent `TerminalPane` aggregates into a `Set<string>` of ended tab ids. The dot flips back to live on the next "Start new session" click. Clicking a tab switches the active session. The **×** on a tab closes it; closing the last session auto-creates a fresh `main` so the strip is never empty. Every change is persisted to `sessions.json` immediately so a sudden quit doesn't lose tabs. Richer per-tab states (`idle`, `needs-input`) land when the observability watcher + permission-request log expose the relevant signals.
5. On unmount (workspace removed, or app close): each `<TerminalSession>` unsubscribes listeners, calls `pty:detach`, disposes the terminal.

**Always-mounted TerminalPanes.** App.tsx renders one `<TerminalPane>` per live workspace (state ≠ `deleted`), all permanently mounted; the one matching `selectedId` has `visible={true}` and the rest are CSS-hidden (`visibility: hidden` to preserve xterm layout dimensions; `pointer-events: none` so hidden panes don't intercept clicks on the visible one stacked at the same coords). Keying is by workspace name (not containerId) so the pane survives container stop+start — sessions.json is per-workspace, not per-container. **Workspace switches are a CSS toggle, not a remount**: xterm scrollback, broker connections, and PTY state persist across selection changes; only an actual workspace removal triggers teardown. This is the architectural fix for a long tail of timing-sensitive bugs (HISTORY frame dropped on re-attach, xterm `Viewport.syncScrollArea` crash on remount, broker `EventEmitter` race on attach) — all of those were second-order effects of the previous tear-down-on-switch model.

**Paused state.** When the selected workspace's state is `paused`, the terminal pane renders a modal card centered in the session-stack ("workspace paused" + Resume button) while the underlying `TerminalSession`s stay mounted but are dimmed (~40% opacity + greyscale + pointer-events disabled). The session tab strip and accent band stay live so the user can see which tabs exist and which workspace they're looking at. The chip in the workspace ribbon also shows a small ⏸ glyph and an amber status dot. The Resume button calls `workspace:start(name)`, which `docker unpause`s the container; the next `workspace:list` poll picks up the running state and the overlay disappears. **`TerminalSession` must not initiate an ATTACH while the workspace is paused**: `docker pause` freezes the broker (PID 1), but a Unix-socket *connect* still succeeds (the kernel parks it in the listen backlog), so an ATTACH sent to a frozen broker never gets its `ATTACHED` reply and the RPC hangs the full `RPC_TIMEOUT_MS` (30s) before failing `ATTACHED timed out`. The pane therefore passes `paused` into `TerminalSession`, which sets up xterm but **skips the network attach** while paused; the attach effect depends on `paused`, so when Resume flips it false the effect re-runs and attaches cleanly (the broker replays its ring buffer). This is what makes reopen-while-paused safe — without it, the always-mounted pane would auto-attach into the frozen broker on app start. Workspace-ribbon chips for other workspaces remain interactive so the user can switch to another workspace without resuming.

**Stopped state.** A `stopped` workspace is **not** in the top strip and has no main-pane (the always-mounted panes are running/paused only, #21) — it lives in the workspace modal's Saved list. Restart is the Saved-row **Resume** (writes the manifest, then `workspace:start(id)` → `docker start`; on the next `workspace:list` it flips to `running`, rejoins the strip, and gets auto-selected; sessions mount fresh from `sessions.json`). (An earlier iteration, #17, surfaced a "Start" overlay on a stopped chip *in the strip*; #21 superseded it by moving stopped out of the strip entirely.) The "+ new tab" button is disabled while paused. **In-memory continuity (#18):** because the broker owns every PTY inside the container (not the host), a paused workspace survives a full app quit — on reopen + Resume the host re-attaches to the same live `claude` processes with their in-memory context intact, not fresh re-spawns. The reattach is reliable across both broker failure modes: the frozen-broker ATTACH hang is avoided by the paused attach-gate above, and the unpause-reap race is covered by the host-side `already attached` retry (§6). A `stopped` (not paused) container is genuinely down — its PTYs are gone and Resume mounts fresh sessions from `sessions.json`.

Each `pty:attach` runs `claude` fresh inside the container via `docker exec` — it is *not* the container's main process. The container's main process is `sleep infinity`, kept alive by `tini`. Multiple sessions in the same workspace are independent `docker exec claude` processes side by side.

**Copy and paste**: the terminal pane has selection-aware key bindings. Ctrl+C copies when a selection exists and falls through as SIGINT when not; Ctrl+V pastes. Ctrl+Shift+C / Ctrl+Shift+V are unconditional copy / paste (terminal-convention alternates). Right-click opens a native context menu (Copy / Paste / Select All) via `menu:showTerminalContextMenu`. Clipboard reads and writes route through `clipboard:read` / `clipboard:write` in main, not `navigator.clipboard`. The terminal's `wordSeparator` is tuned to whitespace + brackets + quotes only, so double-clicking a URL selects the whole URL (URL-safe characters like `/`, `?`, `&`, `=`, `.`, `:` stay inside the word).

**Clickable links**: `term.registerLinkProvider` walks back to the first non-wrapped row, forward through `isWrapped` continuations, concatenates the rows, and matches URLs against the joined text — so a URL that soft-wraps across multiple rows is registered as a single link spanning all of them. Activation calls `window.open`, which `setWindowOpenHandler` routes through `shell.openExternal`.

### Manage per-workspace env vars
The global Profiles modal is gone. Per-workspace env vars (both plain and secret) live in the Env-vars disclosure inside `WorkspaceForm` — the same component renders for new workspaces in the New tab, for non-running workspaces in the Saved tab's inline expand-edit form, and for **running** workspaces in `EditWorkspaceModal` (opened via the chip ⋮ menu). Underneath, the renderer calls `vault:setSecret(workspaceId, key, value)` / `vault:deleteSecret(workspaceId, key)` to mutate keychain values, and the manifest's `env.secretKeys` array tracks which keys exist for that workspace so the editor can surface them without ever reading a value.

### Chip ⋮ menu (live workspaces)
Each chip in the workspace strip has a `⋮` trigger that opens a contextual menu. The menu's contents depend on the workspace's state:
- **Pause / Stop** (running), **Resume** (paused), or **Start** (stopped) — single-action lifecycle controls.
- **Edit…** — opens `EditWorkspaceModal`, a single-purpose modal wrapping `WorkspaceForm` in edit mode with the workspace's spec pre-filled. On Save, `App.handleEditSave` persists secrets + calls `workspace:writeManifest`, then compares pre-edit vs post-edit specs (`containerLevelChanged` in `EditWorkspaceModal.tsx`). Render-only changes (`name`, `description`, `labels`, `color`) take effect immediately. Container-level changes (`env`, `image`, `authMode`, `resources`) flip the **restart-to-apply banner** in the workspace's `TerminalPane` (see below).
- **Clone…** — opens the workspace modal in Clone mode pre-filled from this workspace (same `App.openCloneFrom` flow as the Saved-tab Clone footer button).
- **Close…** — opens `CloseWorkspaceModal` (preserves state dir).
- **Delete…** — opens `DeleteWorkspaceModal` (purges state dir + every keychain entry under the workspace's id). Distinct from Close — Close keeps the workspace in the Saved list; Delete makes it disappear.

### Restart-to-apply banner
`TerminalPane` renders a dismissable banner above the session tab strip when `EditWorkspaceModal` saves changes to any container-level field on a running or paused workspace:

> Changes apply on next start. **[Restart now]** ×

- **Restart now**: `workspace:stop(containerId)` → `workspace:start(id)`. Banner clears.
- **×** (dismiss): banner clears without restart.
- The banner is keyed by workspace id in App.tsx's `restartBannerIds` Set; the corresponding TerminalPane reads `restartBanner` as a prop and renders accordingly. The Set survives chip switches — selecting another workspace and coming back still shows the banner until dismissed.

### Close a workspace
1. User selects a workspace, then clicks **Close…** in the main-pane header.
2. `<CloseWorkspaceModal>` opens, showing the workspace name and current status. A single checkbox — "Also delete the state directory" — is unchecked by default (Keep is the spec default; recreating with the same name inherits prior Claude state and keeps the workspace in the past list).
3. Action buttons depend on current state:
   - **Running**: `Stop only` (calls `workspace:stop` → state goes to `stopped`), `Pause` (calls `workspace:pause` → state goes to `paused`, processes frozen via cgroups, recoverable), and `Stop & remove` (calls `workspace:stop` then `workspace:remove(id, { deleteState })`).
   - **Paused**: `Resume` (calls `workspace:start` → unpauses), and `Stop & remove` (forces SIGKILL via `remove --force`, so pause state doesn't block removal).
   - **Exited / stopped**: only `Remove` (calls `workspace:remove(id, { deleteState })`).
4. On success, the modal closes, the selection clears, and the top strip refreshes. With `deleteState=false` the workspace transitions to "deleted" state (still in the past list, recoverable via restart). With `deleteState=true` it's fully purged. Failures surface inline in the modal.

### Browse & resume a past session
The left rail (`SessionsPane`, the 280px column) is the Sessions table. It mirrors the ObservabilityPane's scope control: **This workspace** (the selected one) or **All** (every live workspace). A search box filters by title + workspace name (and tag text); the list refetches on scope/selection change, on every `observability:summary` push (throttled, so just-active sessions surface live), and after the pane's own rename/delete actions.

**Open / Recent grouping.** The list splits into two labeled groups — `Open · N` above, `Recent` below — rendered only when at least one session qualifies. A session is **open** when a mounted workspace's terminal tab has a live (non-ended) PTY and that tab's broker session maps to the claude session UUID via `broker_sessions`. Openness is derived entirely in the renderer: `TerminalPane` emits the current live (non-ended) broker-session-id set via `onLiveIdsChange`; App.tsx collects these per-workspace, resolves each broker id to a claude UUID via `observability.summaryForBrokerSession(…)` (the same trust model and re-resolution path used for the busy pulse), and builds the `openSessions` map passed down to `SessionsPane`. Open rows get a green left edge + tinted background; they FLIP-animate between groups as PTYs start and end. Openness is not persisted — it self-heals on every observability push that updates the broker→claude mapping. Non-goals: no persistent open state, no main-process open derivation, no `#` search grammar.

**Clicking an open session** selects its workspace and activates the already-open tab instead of opening a new resume tab: App calls `setActivateRequest({ workspaceId, brokerSessionId, token })` (token is a monotone counter so the same target can be re-activated); `TerminalPane` consumes via `activateRequest`/`onActivateConsumed` (token-guarded, mirrors `resumeRequest`/`onResumeConsumed`) and calls `setActiveId(brokerSessionId)`.

Each row shows the display title, and — in **All** scope — a workspace color dot + name, plus relative last-active time and USD cost. The meta line also shows up to 2 **tag chips** (Library `.tag` style) from the session's latest tagged summary chapter; clicking a chip toggles it as a filter. A **Tags ▾** checkbox-menu (one checkbox per distinct tag with occurrence counts, green `.pill` chips for active filters, `N of M` session count) sits below the search field; text search also matches tag text; multi-selected tags are OR-combined. Tags are `[]` when no summary chapter exists yet. Hover reveals row actions:
- **Resume (↻)**: for a session that is **not** currently open — App calls `sessions:resume(workspaceId)` to bring the container up, selects that workspace, and hands the matching `TerminalPane` a resume request. The pane opens a new tab whose `SessionEntry.resumeOf` is the Claude session UUID; that tab's first attach runs `claude --resume <uuid>` in the container (see §6 *PTY*). If the container can't be brought up, App logs a non-fatal warning and does nothing.
- **Rename (✎)**: inline edit → `sessions:rename`; empty clears the override.
- **Delete (🗑)**: a two-click inline confirm → `sessions:delete` (drops cache rows + unlinks the transcript). No modal — the action is row-local and the confirm is reversible up to the second click.

### Dev-server preview
A dev server (Vite, Next, a Python server, …) started inside a workspace container is auto-detected and openable in the host browser, with traffic relayed over the existing broker socket — no new published ports, no Docker bridge routing required. See §6 *Ports* for the IPC surface; §5 *Broker frame protocol* for the wire frames.

1. When a workspace reaches `running`, main starts a `PortMonitor` for it: a dedicated `BrokerClient` issues `LISTPORTS` every ~3s, diffs the result against the last-seen port set, and calls `ports:detected {workspaceId, port}` for each newly-appeared port.
2. The renderer receives `ports:detected`, shows a transient toast: *"Dev server detected on port N"* + an **Open preview** button.
3. User clicks **Open preview** → `ports:open(workspaceId, N)`. Main creates (or reuses) a `PortForward`: a `net.Server` bound to `127.0.0.1:0` (ephemeral host port). For every inbound browser connection, main sends `DIAL {channel, port=N}` to the broker over a fresh `BrokerClient`, awaits `DIALED{ok:true}`, then pipes the browser socket ↔ the broker channel using the existing `INPUT`/`OUTPUT` relay. Returns `{ hostPort }`.
4. Main calls `shell.openExternal('http://127.0.0.1:<hostPort>')` — the system browser opens the forwarded URL. WebSocket/HMR traffic (Vite, Next hot-reload) passes through the raw byte relay untouched.
5. The `PortForward` and `PortMonitor` are torn down automatically when the workspace pauses, stops, or is removed.

## 9. Security model

- **Secret env-var values stay out of the renderer except at write time.** Per-workspace secrets are persisted via `vault:setSecret(workspaceId, key, value)`. After that, the renderer holds only the *list* of secret key names (via `vault:listKeys`); the main process resolves values directly from the safeStorage vault when constructing the container env. The lone exception is the env-row in `WorkspaceForm` — the renderer briefly holds the value the user just typed before it ships to `vault:setSecret`. There is no way around that.
- **Renderer is isolated.** `contextIsolation: true`, `nodeIntegration: false`. No `require`, no `process`, no `fs` from renderer code.
- **`sandbox: false`** because preload uses `ipcRenderer`. The renderer itself still has no Node access.
- **Renderer cannot escape the IPC surface.** It can: list/create/start/stop/remove workspaces carrying the fleet label, list/get/set/delete per-workspace secrets, attach/detach a PTY. It cannot: shell out, read arbitrary files, touch other Docker containers, hit the network with Node APIs.
- **Workspace isolation is Docker's.** No additional sandboxing layered on top. Containers run as the host user's UID (via `User: '<uid>:<gid>'`) and can write to the bind-mounted host workspace as that user.
- **Host-private zone — default-deny container exposure.** `<userData>` is the main process's private domain: the SQLite state DB, `config.json`, `error.log`, the safeStorage vault, and every workspace's durable transcript mirror (`<userData>/state/<id>/_history/`). **Nothing under `<userData>` is bind-mounted into a container** except a workspace's *own* `.claude` dir, its `.claude.json`, its broker socket dir, its **own per-id read-only MCP socket dir** `<userData>/mcp/<id>/` (§11/#117 — the per-id leaf only; the shared parent `<userData>/mcp/` is never mounted, so a container cannot reach a sibling's socket), and — in OAuth mode — the shared credentials/remote-settings files. The docker socket is held only by the main process — it is never mounted into a workspace container, so there is no docker-in-docker escape path. The invariant: cross-workspace or sensitive data is **mediated by the main process** (the MCP server is exactly that mediator — it exposes the DB read-only, never the file), never exposed by a raw bind mount. So a workspace can read fleet-wide *session/event* data **through the MCP server's read-only tools**, but can never read another workspace's transcripts, secrets, or DB file off the filesystem. This is why the durable transcript mirror (§11) lives under `<userData>` and not in the container-visible fleet root. The **loadout library** (`<userData>/loadouts/`, §7) follows the same rule: never bind-mounted, so a workspace sees only the *installed snapshot* in its own `.claude/`; loadout discovery for a workspace's Claude is **mediated** by the read-only MCP `list_loadouts`/`get_loadout` tools, never by exposing the library folder.
- **The one deliberate cross-container surface is `<fleetRoot>/shared` → `/shared` (rw in every container).** It exists so workspaces can exchange files on purpose; treat it accordingly — **secrets must not be written to `/shared`**, since every workspace can read it.
- **OAuth credentials are shared across workspaces by design.** In `oauth` mode all workspaces file-bind one `.credentials.json` (one login covers the fleet), so a token present in one container is the same token in every OAuth workspace. `apikey` mode is per-workspace (the key is injected as an env var, visible only inside that container). Either way, a container legitimately holds its *own* auth — the boundary being protected is *other* workspaces' data and the host-private zone, not a workspace's view of its own credentials.
- **External link handling**: `setWindowOpenHandler` denies in-app navigation and opens external URLs via `shell.openExternal`.
- **Port-forward preview — loopback-only, no new published ports.** The host `PortForward` listener binds `127.0.0.1` only — not `0.0.0.0`, no LAN exposure. The broker dials `127.0.0.1:<port>` inside its own container only — never an arbitrary host or IP; `port` is a constrained uint16. No new Docker published ports are created on any platform: Linux/macOS ride the existing bind-mounted Unix socket; Windows rides the existing loopback-TCP broker port. The new `DIAL`/`LISTPORTS` frames do not widen who can reach the broker (still only the host-owned Unix socket or loopback-TCP on Windows), preserving the broker's existing no-auth posture.
- **Vault availability + the WSL plaintext trade**: the main process probes secret-storage usability once (`vault:available`). On macOS/Windows and Linux-with-a-keyring this is real OS-backed encryption. On Linux with **no** keyring (e.g. WSL), `vault.ts` opts into safeStorage's plaintext backend (`setUsePlainTextEncryption(true)`) so `vault:available` returns true and API-key auth works — but secret values are then stored **base64, not encrypted**, in `<userData>/secrets.enc`. This is a deliberate trade: the prior `keytar` path failed entirely on WSL, and the file already lives in the per-user `userData` dir. If storage is somehow unusable even so, `vault:available` returns false → the env editor disables the per-row "secret" toggle (a row can still be a plain env var, value in the manifest) and the auth-mode picker degrades to OAuth-only unless `ANTHROPIC_API_KEY` is supplied as plain env, with a `BottomBar` notice. (Surfacing the *plaintext* case distinctly in the UI is a future nicety, not yet wired.)

## 10. Project layout

```
claude-fleet/
├── CLAUDE.md                          # pointer to .claude/rules/
├── README.md                          # one-paragraph project summary + dev commands
├── docs/
│   └── SPEC.md                        # this file
├── .claude/
│   └── rules/
│       └── spec-maintenance.md        # the rule
├── docker/
│   ├── Dockerfile                     # BASE runner (multi-stage, builds broker); lean + standalone
│   ├── versions.yaml                  # pinned tool versions (source of truth for the scripts)
│   ├── scripts/                       # shared, standalone, arch-aware installers (one per toolset)
│   │   ├── _arch.sh                   #   uname → amd64/arm64 + x86_64/aarch64
│   │   ├── apt-tools.sh               #   make, shellcheck, dnsutils (dig), python3, pre-commit
│   │   ├── gh.sh  yq.sh  tenv.sh      #   gh; yq; tenv → OpenTofu + Terramate
│   │   ├── opa.sh  iac-lint.sh        #   OPA; tflint + trivy
│   │   ├── kubectl.sh  helm.sh        #   kubectl + kustomize; helm
│   │   └── aws-cli.sh  azure-cli.sh   #   AWS CLI v2; Azure CLI (build-arg gated)
│   └── devops/
│       └── Dockerfile                 # FROM base + the platform-engineering toolset (runner-devops)
├── .dockerignore                      # opt-in: broker/** + docker/Dockerfile + docker/scripts/** + docker/runner/**
├── broker/                            # in-container session multiplexer (Go)
│   ├── go.mod / go.sum
│   ├── cmd/broker/main.go             # entrypoint; reads env, listens on socket
│   └── internal/
│       ├── proto/                     # wire-protocol frame codec
│       ├── session/                   # PTY supervision + ring buffer + Manager
│       └── server/                    # connection loop, frame dispatch
├── electron.vite.config.ts            # electron-vite config (main / preload / renderer)
├── electron-builder.yml               # packaging config (targets + asarUnpack)
├── Makefile                           # cross-build unsigned Windows installer from Linux/WSL via Wine
├── package.json
├── tsconfig.json                      # references node + web tsconfigs
├── tsconfig.node.json                 # main + preload
├── tsconfig.web.json                  # renderer
└── src/
    ├── main/
    │   ├── index.ts                   # app lifecycle, BrowserWindow
    │   ├── ipc.ts                     # registerIpc() — workspace:* / pty:* / etc. live here
    │   ├── backend.ts                 # Backend contract (shared by docker/local/mock)
    │   ├── backendRouter.ts           # resolveKind() — per-workspace backend routing (#16)
    │   ├── docker.ts                  # Docker backend (dockerode + broker-aware PTY attach)
    │   ├── local.ts                   # local host-process backend (#16: node-pty spawn, lifecycle, HOME/auth)
    │   ├── localSessions.ts           # in-process session manager for local PTYs (broker analog, #16)
    │   ├── mcpLocalBridge.ts          # stdio↔socket MCP bridge for local workspaces, run via Electron-as-node (#16)
    │   ├── loadoutCore.ts             # pure loadout engine: parse loadout.md + apply/revert files (fs+yaml; unit-tested)
    │   ├── loadouts.ts                # loadout library: list/get/install/uninstall + built-in starters (#16-followup)
    │   ├── broker.ts                  # host-side BrokerClient + frame codec
    │   ├── mock.ts                    # mock backend behind CLAUDE_FLEET_MOCK=1
    │   ├── workspaces.ts              # WorkspaceSpec types + manifest read/write/list
    │   ├── sessions.ts                # per-workspace sessions.json read/write
    │   ├── imageLibrary.ts            # imageLibrary.json read/write + auto-record
    │   ├── db.ts                      # SQLite cache: events/sessions tables, ingest, summary, cost queries
    │   ├── mcpServer.ts               # read-only MCP server (#12); one listener per workspace at <userData>/mcp/<id>/mcp.sock (#117); tools over the state DB
    │   ├── mcpSocket.ts               # pure per-id socket-path + bind helpers (shared by mcpServer.ts + docker.ts bind)
    │   ├── mcpStatusBroadcast.ts      # pure mcp:status fan-out to renderer windows (drives the MCP-unreachable toast, #159)
    │   ├── jsonlWatcher.ts            # chokidar-based JSONL tailer feeding db.ingestLine
    │   ├── pricing.ts                 # Claude 4.x USD rates + costFor(model, tier, tokens)
    │   ├── pricing.test.ts            # Vitest unit tests for pricing math
    │   ├── errorLog.ts                # JSON-lines crash log to <userData>/error.log
    │   ├── paths.ts                   # state-dir path conventions (incl. broker dir, shared OAuth credentials)
    │   ├── config.ts                  # app config (<userData>/config.json): fleet root + private/shared folder paths
    │   ├── wsl.ts                     # isWslEnvironment() — drives fs:openPath's explorer.exe bridge
    │   ├── fs.ts                      # isDirectory / mkdirp helpers
    │   ├── migration.ts               # one-shot ULID migration + legacy keytar purge + fleet-folder creation on first boot
    │   ├── portforward.ts             # PortMonitor (3s LISTPORTS poll, ports:detected) + PortForward (loopback net.Server, DIAL relay)
    │   └── vault.ts                   # safeStorage-encrypted secret vault (<userData>/secrets.enc) + env resolve
    ├── preload/
    │   └── index.ts                   # contextBridge.exposeInMainWorld('api', …)
    └── renderer/
        ├── index.html
        └── src/
            ├── main.tsx               # React root
            ├── App.tsx                # 3-pane shell + modal owner; refresh() polls workspace:list
            ├── toasts.ts              # pure toast model + reducer (unit-tested); kinds/placements
            ├── styles.css             # design tokens + component styles
            ├── types.d.ts             # declare global window.api
            └── components/
                ├── WorkspaceTabStrip.tsx  # top: app name + workspace chips + actions
                ├── LeftRail.tsx           # left sidebar accordion: Sessions + Loadout Library (#16)
                ├── SessionsPane.tsx       # Sessions list (embedded in LeftRail)
                ├── LibraryPane.tsx        # loadout Library: search/tag-filter + cards + install (#16)
                ├── LoadoutReviewModal.tsx # review-before-install: files manifest + Open folder (#16)
                ├── Toast.tsx              # unified toast: ToastStack (global) + ToastView (in-tab); kind/sticky/action
                ├── TerminalPane.tsx       # center: per-workspace session tab strip + stack
                ├── TerminalSession.tsx    # one session: xterm + PTY + key bindings + session-ended overlay
                ├── ObservabilityPane.tsx  # right sidebar: live session summary (cost + tokens + tools)
                ├── BottomBar.tsx          # footer hint bar
                ├── WorkspaceModal.tsx     # tabbed shell: Saved (variant-B search + inline expand-edit) + New
                ├── WorkspaceForm.tsx      # reusable form (color, description, labels, env, resources); mode-aware
                ├── EditWorkspaceModal.tsx # single-purpose edit modal for live workspaces (chip ⋮ Edit)
                ├── DeleteWorkspaceModal.tsx # confirm modal: stop + remove + purge vault
                ├── AdvancedImageSearchModal.tsx # magnifying-glass next to Image: ref/digest search + Tags filter
                ├── SettingsModal.tsx      # app settings (fleet root); opened from the top-strip gear
                └── CloseWorkspaceModal.tsx
```

## 11. Open decisions

These are decided in spirit but not yet implemented. When you implement one, move it out of this section and into the relevant body section above.

### Loadout library v2 — remote OCI sources + update detection (Phase 2)
**Phase 2 (remote OCI sources, index artifact, update detection) is implemented and tested** — ociClient (`src/main/ociClient.test.ts`), loadoutSources (`src/main/loadoutSources.test.ts`), and loadoutInstall (`src/main/loadoutInstall.test.ts`) have their own dedicated unit test suites. The paired index publisher shipped in `claude-fleet-loadouts` (the `publish-loadouts.yml` workflow now emits `<source>/index:latest`). Both sides landed in the same change per the CLAUDE.md cross-repo contract rule. `ociCore.test.ts` focuses on the pure OCI core logic (ref parsing, layer-path safety, index parsing, version compare, catalog assembly) with no network or electron-wired behaviors.

### Per-container Claude Code state visibility on the host
Each container gets its own host-side state dir, bind-mounted into the container at `/home/fleet/.claude/`. This is the foundation for the observability watcher, sessions table, durable mirror, and permission-request log — all of which read events from `<state-dir>/projects/-workspace/*.jsonl` directly off the host filesystem.

**Decisions made:**
- **Host layout**: `<userData>/state/<container-name>/.claude/`, where `<userData>` is Electron's `app.getPath('userData')` (`~/.config/claude-fleet/` on Linux). State dirs are keyed by container name — recreating a container with the same name reuses its prior state. Use a different name to start fresh.
- **Container layout**: the host state dir is bind-mounted at `/home/fleet/.claude/` read-write. The container's `WorkingDir` is `/workspace`, so Claude Code writes JSONLs to `~/.claude/projects/-workspace/<session-uuid>.jsonl` — the sanitized-cwd is deterministically `-workspace`.
- **UID/GID**: the container runs as the host user's UID/GID via `User: '<uid>:<gid>'` set at create time. `HOME=/home/fleet` is set in the env so tooling that consults `HOME` finds the bind-mounted `.claude/` even when the runtime UID has no `/etc/passwd` entry. This replaces the earlier idea of baking UIDs at image-build time — the published runner image now has a single fixed UID for the in-image `fleet` user, and the host's UID is supplied at container start.
- **Create-time behavior**: if `<userData>/state/<id>/.claude/` does not exist, the main process creates it (owned by the host user) before starting the container. If it exists, it's reused as-is.
- **Removal behavior**: when the user removes a container, a confirmation modal asks "Also delete this container's state dir?" with **Keep** as the default. Picking Delete recursively removes `<userData>/state/<id>/`. Picking Keep leaves the state intact so a future container with that name inherits it.

**Implementation:**
- `src/main/docker.ts createContainer`: add the state-dir bind to `HostConfig.Binds` alongside the existing workspace bind. Ensure the host dir exists (`mkdir -p`) with host-user ownership before starting the container.
- `src/main/docker.ts removeContainer`: take `opts: { deleteState: boolean }`. When true, recursively remove the state dir after the Docker container is removed.
- `src/main/ipc.ts`: extend `docker:remove` to accept the `deleteState` flag from the renderer.
- Removal-confirmation modal: implemented as `CloseContainerModal`, opened from the main-pane header's **Close…** button. See §8 "Close a container".
- Runner image (#5): the image is published to GHCR by CI (`ghcr.io/imioimi/claude-fleet/runner:latest`). The app pulls it on first use; UID is handled at container start via `User`, not baked at image-build time.

**Open:**
- **State-dir name sanitization.** Container names can contain characters that are invalid or hazardous as path components (`/`, `:`, leading dots). Validate/restrict at the create form (`[a-zA-Z0-9_-]+`) so the name maps cleanly to a directory name. Lands with the create-container UX (#4).
- **Cross-user / multi-host portability.** State is tied to the host user (UID typically 1000). Moving a state dir to another machine requires matching UIDs or a chown. Out of scope; document if it becomes a real workflow.
- **Settings reset.** `.claude/` will eventually also hold `settings.json`, custom commands, file checkpoints, tasks state. All of it survives container recreate by default. If we later want a "reset settings without losing project history" affordance, decide what's keepable vs. wipeable.

### Observability layer: cost, tokens, tool calls
Per-session cost and token counts derived from Claude transcript JSONL events. **Status: shipped (#2).** Foundation + cost rollup + pane + slot consumers + live push + per-model context window + per-tab mapping + tool-call detail (duration/status) + per-turn cost series, plus the expanded rail (sparkline, scope toggle, Fleet view) and per-terminal context rows. Residual (out of this issue's scope): richer per-tab state and ingesting subagent JSONLs.

**Shipped:**
- The JSONL→SQLite cache + watcher (§7 *JSONL→SQLite cache*), the `observability:eventsForSession` catch-up IPC (§6), and the `chokidar`+`better-sqlite3` runtime pieces (§4). Watcher tails every workspace's transcripts and ingests new lines idempotently into `events`, updating `sessions` with derived metadata.
- `summaryForWorkspace` (§6) plus the right-rail pane (§5) — title, model, event count, last-activity, prominent USD, token totals, top tools.
- Cost rollup (`src/main/pricing.ts` + `costForSession` / `costForWorkspace` in `src/main/db.ts`, §6 IPCs). USD is derived per `(model, service_tier)` group with hardcoded Claude 4.x rates — Opus $15/$75/$1.50/$18.75, Sonnet $3/$15/$0.30/$3.75, Haiku $1/$5/$0.10/$1.25 per 1M tokens (input / output / cache-read / cache-creation). Standard tier full price, batch tier 50%, unknown model or tier degrades to $0 + one-time `console.warn`. Unit-tested in `src/main/pricing.test.ts` via Vitest.
- Slot consumers (#34): chip secondary line ("active 2m ago" / "idle 1h ago" from `summary.lastActiveAt`) and terminal-pane context bar (fill driven by `summary.lastTurnContextTokens / summary.contextWindowTokens`). Both read from App.tsx's shared summary map so chip + pane + bar share one source of truth (see §5 *Centralized observability distribution*).
- Live summary push: `JsonlWatcher` extends `EventEmitter`, emits `'ingest'` on every batch that inserts ≥1 new event, and `ipc.ts` broadcasts `observability:summary` to every BrowserWindow. The renderer's `onSummary` subscription updates the shared map in <100ms of the JSONL flush. A 30s safety poll covers missed events and refreshes relative-time displays.
- Per-model context window (`src/main/contextWindow.ts`): replaces the renderer's hardcoded 200K. Defaults to 200K per Claude 4.x family, recognizes the `[1m]` marker in the model id, and auto-upgrades to 1M when observed usage already crossed 200K (handles the 1M beta header case, where the model string itself doesn't change). Plumbed through `WorkspaceSummary.contextWindowTokens`; the context bar's 80% compaction tick is now positioned correctly because the limit is data-driven. Unit-tested in `src/main/contextWindow.test.ts`.
- Per-tab mapping (`broker_sessions` table): each terminal tab's broker session id maps to a specific claude session UUID. **Learned deterministically at spawn time (#195):** whenever a backend actually spawns claude for a tab (broker CREATE for docker, fresh pty spawn for local), the host decides the claude UUID up front — `resumeOf` when resuming, else a generated UUID passed as `--session-id` — and writes the mapping before the process starts. A plain re-attach to a live claude never relearns. Rows carry a **`verified`** flag (v7): deterministic learns set 1; every pre-#198 row migrated as 0. Unverified rows still serve observability attribution but are refused as resume targets (`lookupVerifiedBrokerSession` / `sessions:resolveResumeTarget`). The legacy passive path (`pendingAttaches.ts`: record a pending attach, pair FIFO-oldest when `JsonlWatcher` emits `'new-session'`) remains only as a fallback for sessions the host did not name; production attach paths no longer feed it. It has **no TTL** (claude writes its first JSONL only when the user types, which can be hours later) and FIFO pairing across >1 pending entries is a guess — logged as `mapping-ambiguous-consume`, and a mapping overwritten with a different claude id as `mapping-remapped` (both `warn`, in `errors`). The guess-based pairing is what cross-wired a tab to the wrong conversation in #195, which is why the deterministic path replaced it. Mapping persists in SQLite so re-attaching after an app restart (when broker still has claude alive and no new JSONL appears) still resolves to the right session. **Fallback semantics:** `summaryForBrokerSession` returns null when no mapping exists, and the renderer surfaces the ObservabilityPane's empty state directly — no workspace-summary fallback. We tried a conditional fallback (loaded tabs fall back, fresh tabs don't); it produced two user-visible bugs (new session inheriting previous tab's data; switching between unmapped tabs showing the same content on both — "doesn't update"). Per-tab semantics now never inherit from sibling tabs. **Known consequence:** tabs created before this table existed have no mapping and stay empty until recreated; the workspace's overall activity is still surfaced on the chip subline and the right-rail pane's USD/eventCount via the tab's own session once a mapping lands. Unit-tested in `src/main/pendingAttaches.test.ts`; e2e regressions in `tests/smoke.spec.ts` (`broker_sessions: a single pending attach`, `broker_sessions: mapping is learned even when the user types many minutes after attaching the tab`, `broker_sessions: multi-tab attaches that interleave`, `ObservabilityPane: clicking +`, `ObservabilityPane: switching between two loaded-from-inventory tabs`, `summaryForBrokerSession: returns null for an unmapped broker session`). **Diagnostic signals:** two structured events are recorded into the `errors` table (reachable via `list_errors`) to make a blank rail diagnosable without grepping logs: a `warn`-level signal fires once per unique `(workspace, tab, outcome)` when `summaryForBrokerSession` cannot resolve — as type `mapping-unresolved` when no broker→claude mapping exists, or `mapping-stale-session` when a mapping exists but the claude session has no DB rows; `new-session-dropped` (level `info`) fires when a `'new-session'` JSONL event arrives with no pending attach to pair with. Neither changes the "no workspace fallback" rail behavior; they are purely diagnostic.

**Outstanding:**
- **Richer tab states.** Tab dots are live / ended today. `idle` and `needs-input` states want the permission-request log (#11) and a recency signal before they can be wired meaningfully.
- **Subagent JSONLs.** Today `depth: 0` skips them. Decide whether to surface them in the events stream as a separate `parent_session_id` field, or treat them as opaque tool runs.
- **Pricing refresh process.** `pricing.ts` is hand-maintained. When Anthropic publishes new rates, the constants need updating. Consider an annual recheck cadence and/or a comment-pinned source URL.

### Sessions table

**Status: shipped.** Global, workspace-filterable list of every Claude session the watcher has indexed, each resumable via `claude --resume <id>`, renamable, and deletable. Implementation lives in the body: §6 *Sessions* (`sessions:list`/`rename`/`delete`/`resume` IPC), §6 *PTY* (`resumeOf` attach), §7 *Session inventory* (`resumeOf` field) + *JSONL→SQLite cache* (the `sessions` table is the index; JSONL stays the source of truth), and §8 *Browse & resume a past session* (the `SessionsPane` UI). It's workspace-keyed (not container-keyed) — sessions outlive any one container, and eligibility is "workspace manifest still exists."

**Resume mechanism.** The host knows the Claude session UUID up front, so the broker→claude mapping is written **directly** at CREATE time rather than via the watcher's pending-attach queue — `claude --resume` appends to the existing `<uuid>.jsonl`, so no `new-session` event ever fires. The broker gained an optional `args` field on `CREATE` (`broker/internal/proto`) threaded through `Manager.Create` → `newSession` → `exec.Command(claude, args...)`; the host passes `["--resume", "<uuid>"]` (or, for a fresh session, `["--session-id", "<uuid>"]` — same mechanism, #195).

**Broker env-var contract.** Every claude PTY spawned by the broker receives two env vars injected by `newSession` on top of the inherited container env: `TERM=xterm-256color` (required for the TUI) and `CLAUDE_FLEET_BROKER_SESSION_ID=<id>` (the broker session id — the same stable id the host uses as the tab key in `sessions.json`). The local backend (`localSessions.ts`) sets the same `CLAUDE_FLEET_BROKER_SESSION_ID` env var on every local PTY spawn so that local workspaces participate in the same identity chain. In-container hooks (`session-report.sh`, `summarize.sh`) read `CLAUDE_FLEET_BROKER_SESSION_ID` to pair their MCP calls with the tab that owns the PTY, without any out-of-band IPC. This is the env-var side of the broker→claude identity chain (#207).

**SessionStart hook → verified mapping (`session-report.sh`).** Registered under `SessionStart` in `hooks.settings.json` (fires on startup, resume, **and `/clear`** — the drift case). The hook reads `session_id` from the hook payload and `CLAUDE_FLEET_BROKER_SESSION_ID` from env, then calls the `report_session_mapping` MCP tool over the workspace's own socket. The host writes the mapping with `verified=1` (claude's own testimony, not the FIFO-guess path) and logs `mapping-remapped` if the broker session id was previously mapped to a different claude id. This corrects `/clear` drift — after a clear, claude starts a new session id in the same tab, and `SessionStart` reports the new id, keeping the host's `broker_sessions` row current without any polling. Container backend only; local backend currently lacks this hook.

**Open (residual):**
- **Auto-title (`ai_title`) — shipped, not an LLM build.** This was once an open question ("which model / when / how much transcript"); it's moot. Claude Code emits `ai-title` transcript lines natively and the watcher already ingests them (§7 *JSONL→SQLite cache → Title derivation*), so titles are accurate with zero app-side LLM cost. The only residual is **fragility**: the title depends on an undocumented native transcript line type, so a `claude` pin bump should re-verify the `ai-title` line still appears (`tests/ai-title.spec.ts` is the guard). A future app-generated titler is unnecessary unless Claude Code stops emitting the line.
- **In-progress sessions.** The list shows active sessions too (they refresh on every ingest push). No distinct "live row" affordance vs. ended sessions yet — tab-state richness is tracked under *Observability layer*.
- **Deleting a live session's transcript.** `sessions:delete` unlinks the JSONL even if claude is still appending to it (rare — you'd be deleting the session you're in). On Linux the open fd keeps the inode alive, so claude keeps writing to the now-unlinked file until it reopens; the row reappears on the next new transcript. Acceptable for v1; revisit if it bites.

### Resumable sessions on workspace pause/resume — "expert workspaces"

The goal: **expert workspaces** that load a domain context once (an organization's architecture, a particular application's source, a body of documentation) and then sleep with that context intact. The user pauses the workspace, closes the app, comes back hours or days later, unpauses, and finds every session right where it was — same conversation history, same in-memory analyses, same MCP server state — ready to do a quick task and go back to sleep. Re-priming the context on every wake defeats the purpose.

**Status: shipped in two phases.** Phase 1 (sessions persistence + paused UI) and Phase 2 (in-container Go broker + host-side BrokerClient) are both landed. The relevant body sections describe the implementation; what remains here is just the residual open questions.

- Phase 1 see: §6 (Sessions IPC), §7 (Session inventory), §8 (Attach a terminal → Paused state).
- Phase 2 see: §5 (Architecture diagram + broker description), §6 (PTY IPC with `brokerSessionId`), §7 (broker socket bind), §10 (`broker/` Go module).

**Open (residual):**

- **Container restart policy — wired (`unless-stopped`, see §7 *Docker container shape*).** On a host reboot / daemon restart the container comes back and its broker re-launches. The broker's *in-memory* PTY state (live `claude` processes) is still lost — but the Sessions table's resume (§6 *PTY* `resumeOf`) rebuilds a session from its on-disk transcript, so "wake-and-go across reboots" now works without broker checkpoint/restore: the container is back automatically, and the user re-resumes from disk. True in-memory continuity across reboots (no re-priming) would still need session checkpoint/restore inside the broker — out of scope.
- **Clean-exit flush of sessions.json — not needed.** The renderer already persists `sessions.json` on every tab mutation (add/close/switch), and `ipcRenderer.invoke` dispatches the write to main synchronously, so there's no main-side unflushed inventory state to sweep at `before-quit`. The reboot/crash case — the one durability actually cares about — never fires `before-quit`/`beforeunload` anyway, so a quit-time flush wouldn't help it. (Main's `before-quit` still stops the watcher and `closeDb()`s, which checkpoints the SQLite WAL.)
- **Ring buffer size.** Default 64 KiB per session (env override: `CLAUDE_FLEET_BROKER_RING`). Big enough to repaint a screenful of context on reconnect; small enough that 6 workspaces × 6 sessions = 2.3 MiB of buffer is negligible. Revisit if users frequently want more replayed history on reconnect.
- **Interaction with the durable transcript mirror.** Re-attach via broker keeps the same broker session id across long quiet periods (pause + relaunch). The mirror watcher (when it lands) must not treat a long quiet period as a session end.
- **Resource accounting.** `docker pause` freezes processes but doesn't release RAM; an expert workspace pins memory until the container is removed. Several heavy sessions × several expert workspaces can be substantial on a developer machine. Decide whether to surface per-workspace RAM usage in the chip / past-list and whether to warn when the total exceeds a threshold.
- **Pause depth.** "Deep sleep" (allow swap-out, slower wake) vs. "light sleep" (kept resident, instant wake). Out of scope until a user actually needs the differentiation.
- **Broker crash blast radius.** Single multiplexer means a broker bug kills every session in that workspace at once. We accept this tradeoff for the cleaner architecture; mitigate by writing the broker defensively (each session's error handling is local) and by relying on the manager's per-session goroutine isolation. If real crashes appear, revisit the per-session-process model.

### Drag-and-drop file ingestion
Drop OS files, pasted images, web content, or text fragments onto the window; the app saves them into the selected container's workspace so the agent can read them.

**Status: SHIPPED (#87, revived on native Windows).** Originally built then shelved (PR #87, closed unmerged 2026-06-17) because drag-and-drop can't be exercised on the **WSLg dev** setup — OS drag events aren't forwarded Windows→Linux into the Electron window and clipboard image bytes don't reliably cross (a real OS drag event also can't be synthesized in Electron for e2e). It is now revived against a **native Windows build**, where the OS integrations work. Implementation: `src/main/files.ts` + `dropNaming.ts` (all four sources, 100 MB/file + 1 GB/dropbox caps with reject-on-overflow, magic-byte MIME sniffing, collision suffixing, a URL fetch with a 20s abort + streaming size guard, a `*` `.gitignore` in the dropbox); a `useDropIngestion` renderer hook + full-window overlay; results surface through the existing bottom-center toast stack (`pushToast`, with `ok`/`error` variants added alongside the loadout-reload `progress` toast). Unit (`dropNaming.test.ts`) + e2e (`drag-drop.spec.ts`, which drives the `files:*` IPC directly since a real OS drag can't be synthesized). **WSLg caveat retained:** under WSLg dev the overlay still won't receive OS drops; the right-rail Private/Shared folder-reveal links remain the fallback there.

**Decisions made:**
- **Drop target**: anywhere on the window. The file is routed to whichever workspace is currently selected. If none is selected, the drop is rejected with a hint ("Select a workspace first, then drop.").
- **Save location**: `<fleetRoot>/<id>/_dropped/` — the selected workspace's private folder (via `config.ts:fleetPrivateDir`, the same dir mounted at `/workspace`). Filename collisions resolved by suffix (`foo.png`, `foo-2.png`, `foo-3.png`). Inside the container the agent reads from `/workspace/_dropped/<name>`.
- **Post-save behavior**: toast confirmation showing the saved container path, plus the path is copied to the system clipboard (via `clipboard.writeText`). User pastes it into their prompt manually — no auto-typing into the PTY.
- **Sources accepted**:
  - **OS file drag** — drop from Explorer/Finder/Nautilus. Renderer reads the path via `webUtils.getPathForFile(file)`; main copies from source to destination.
  - **Clipboard paste** (Cmd/Ctrl+V) anywhere on the window — image bytes from the clipboard saved as `paste-<ISO-timestamp>.<ext>` (extension derived from clipboard format).
  - **Web drag** — content dragged out of a browser. If a URL, the main process fetches it and writes the body; if inline bytes, written directly. Filename derived from the source URL or Content-Disposition; falls back to `web-<ISO-timestamp>.<ext>`.
  - **Text / HTML drag** — selected text dragged in. Written as `dropped-<ISO-timestamp>.txt` (plain text) or `.html` (when the drag carries HTML).

**IPC surface (as built).** Each takes the selected `workspaceId` and returns the container-visible saved path(s):
- `files:dropOsFiles(workspaceId, sourcePaths: string[])` → `string[]` (saved paths) — caps validated across the whole batch before any copy, so a partial over-limit drop writes nothing.
- `files:dropBytes(workspaceId, payload: { suggestedName?, mime?, bytes })` → `string`
- `files:dropUrl(workspaceId, url: string)` → `string`
- `files:dropText(workspaceId, payload: { mime: 'text/plain' | 'text/html', text: string })` → `string`
- `clipboard:readImage()` → `{ bytes, mime } | null` — supports Ctrl+V image ingestion. The renderer can't read clipboard image bytes under contextIsolation, and xterm swallows the native `paste` event while the terminal is focused, so `TerminalSession`'s Ctrl+V handler calls this and, when an image is present, dispatches a `cf:drop-image` window event that `useDropIngestion` routes to `files:dropBytes`.

**Resolved (were open):** per-file (100 MB) + per-dropbox (1 GB) caps with reject-on-overflow (no eviction); magic-byte MIME sniffing with clipboard/MIME-type fallback (unknown ⇒ saved extensionless); URL fetch with a 20s abort + streaming size guard; the dropbox carries its own `*` `.gitignore` so drops are never committed regardless of the consumer repo's rules.

**Open:**
- **Whether to expose drops in the sessions table.** A row showing "5 files dropped" alongside the session might be useful. Out of scope for v1 but worth recording.

### Durable transcript mirror
**Status: shipped (#10).** A host-private, append-only mirror of every event Claude Code emits for a session, kept so the transcript survives compaction. Settings are **per-workspace** (the manifest), with a per-session override.

**Settings (workspace manifest, not a profiles table).** `WorkspaceSpec.mirror = { default: 'on'|'off', cleanup: 'delete'|'preserve' }`. Factory values (applied to legacy manifests with no `mirror` block, by `readWorkspaceManifest`): `default: 'on'`, `cleanup: 'delete'`. Edited in the create/edit workspace form's "Transcript mirror" disclosure. (The original design pinned these to a "profile" + a `profile_settings` SQLite table; the app is workspace-centric now, so they live on the manifest — no new table.)

**Location — host-private (security invariant, §9).** `<userData>/state/<id>/_history/<claude-session-id>.jsonl`. A sibling of the `.claude`/`broker` subdirs but, unlike those, **not bind-mounted into any container** — so no workspace can read another's (or even its own) mirror off the filesystem. This deliberately reverses the original `/workspace/_history` (container-visible) design: cross-workspace transcript access is a real goal, but it must be **mediated** (host UI today; the read-only MCP server, §11, later), never a bind mount. Cleaned up for free when the workspace state dir is removed (`workspace:remove --deleteState`).

**Format.** Raw JSONL — the exact lines Claude Code writes to its own transcript. Compaction-proof: the watcher reuses the SQLite dedup signal — it appends a line to the mirror **only when `ingestLine` reports a genuinely new insert**, so a compaction-triggered re-read from offset 0 never double-appends, and the mirror is never truncated.

**Effective-setting resolution (`mirrorPolicy.ts`).** A pure in-memory registry resolves, per claude session: per-session override → workspace default → factory `on`. The override is chosen at attach, keyed by the renderer's *broker* session id, then copied onto the *claude* session id when the broker→claude mapping is learned (the same hook that feeds the per-tab observability mapping). Consequence: a few lines emitted before the mapping is learned follow the workspace default rather than an off-override — the only window where the two can disagree.

**Per-session override (UI).** A toggle at the right of the session-tab strip shows the active tab's effective setting and flips it. `TerminalSession` pins the effective value via `mirror:setOverride` immediately before `pty:attach`, so it's locked before any line is ingested. Flipping mid-session is **live, not locked**: turning off stops further mirroring; turning on starts from now and does not backfill earlier turns (the watcher consults the policy per batch). The override persists on the tab's `SessionEntry.mirror` in `sessions.json`.

**Close-time cleanup.** The tab's `×` calls `mirror:hasForBrokerSession`; if a mirror file exists it opens a confirm modal (Keep / Delete, with the workspace's `cleanup` default styled primary), then drops the tab. If no mirror exists (e.g. a fresh tab with no activity, or no broker→claude mapping yet) the tab closes immediately. App quit, container stop, workspace switch, and `claude` exiting do **not** delete mirrors.

**IPC surface (as built).** All transcript handlers take the renderer's broker session id and resolve broker→claude internally via the `broker_sessions` table:
- `mirror:setOverride(workspaceId, brokerSessionId, 'on'|'off')` — set the per-session override (and, if the mapping is already known, propagate it live).
- `transcript:hasForBrokerSession(workspaceId, brokerSessionId)` → `boolean`.
- `transcript:deleteForBrokerSession(workspaceId, brokerSessionId)` → `void`.
- `transcript:list(workspaceId)` → `string[]` (claude session ids with a mirror file; for the sessions-table orphan-cleanup affordance).
- `setWorkspaceDefault` is refreshed in `mirrorPolicy` on every `workspace:list` poll and on `workspace:create`/`writeManifest`, so manifest edits take effect without a restart.

**Resumed sessions.** `claude --resume <id>` reuses the claude UUID and appends to the existing `<id>.jsonl`; the mirror likewise keeps appending to the same `_history/<id>.jsonl`. The resume attach learns the broker→claude mapping directly (no pending-attach queue), so the override propagates immediately.

**Open:**
- **Orphaned mirrors.** A mirror with no live tab (app crash, reboot, never-closed tab) lingers under `_history/`. `transcript:list` exists to surface these in the sessions table with a "Delete mirror" affordance — UI not built yet (depends on #3 surfacing per-session rows).
- **Per-target sharing ("allow workspace A's transcripts to be read by B").** Today the model is coarse: mirror on = the transcript exists host-side and can be mediated to other workspaces; mirror off = it never leaves. Fine-grained per-workspace ACLs are a future refinement, and the read channel itself (the MCP server, §11) isn't built.
- **Compaction race test.** Mirror append-on-new-insert is covered by reasoning + the dedup contract; a forced-`/compact` integration test against the real watcher would harden it (the watcher has no unit harness today).

### Permission-request log
Always-on structured log of every prompt Claude makes to the user. Substrate for tuning `.claude/settings.json` permissions and CLAUDE.md guidance over time.

> **STATUS: PARTIALLY UNBLOCKED — `AskUserQuestion` pose-time signal now exists.**
>
> **Researched 2026-06-15, re-investigated 2026-06-29.** The original design assumed the structured prompts are observable from the JSONL transcript or a hook. Findings:
> - **Generic permission prompts (Bash/Edit/… `ask`):** still not in the JSONL — a gated tool just emits `tool_use`→`tool_result`, and the interactive allow/deny prompt leaves no transcript event. They also do not occur in claude-fleet because claude auto-allows tools (`tool_dispatch … permissionDecisionMs=5`, no prompt shown).
> - **`Notification`-hook capture** (the cleanest generic path): a hook provisioned into the container's `~/.claude/settings.json` never loads when dropped in cold — claude reports `Found 0 total hooks in registry` unless the hook is approved. The approved path is `--settings <file>` at launch, which is a **trusted load** that bypasses the approval gate (verified, Claude Code 2.1.177).
> - **`AskUserQuestion`:** claude does **not** write the `tool_use` to the JSONL while the prompt is pending (verified live: question box on screen, zero tool_use rows in the transcript). The JSONL line only flushes at answer time. **However**, a `PreToolUse[AskUserQuestion]` hook fires at pose time — before the user answers — and a `PostToolUse[AskUserQuestion]` hook fires at answer time. By loading these hooks via the trusted `--settings` mechanism (baked into the runner image as `hooks.settings.json`, launched with `--settings /usr/local/lib/claude-fleet/hooks.settings.json`), the app gains a reliable pose-time signal. This is the foundation of the waiting-chip indicator (§5, §6, §7).
> - **`ExitPlanMode` and permission prompts** remain unsurfaced — no hook fires for them and they leave nothing in the JSONL while pending. Capture of those events is still blocked.
>
> **Decision (updated 2026-06-29):** The `AskUserQuestion` waiting signal is **built and shipped** via the baked runner hook + `signal_input_wait` MCP tool + `inputwait:update` IPC push + violet chip indicator. Permission prompts and `ExitPlanMode` remain undetected and the full permission-request log (structured table of every gated prompt) remains deferred — the JSONL / hook coverage for those events is still absent.
>
> **Shipped:** the **busy/idle** chip indicator (#79, `activityDetector.ts`, PTY title glyph) **and** the **waiting indicator** (violet `--wait` dot, `?` glyph, `needs input` subline — see §5 *Top row*). The waiting indicator covers `AskUserQuestion` only.

**Decisions made (original design — partially superseded by the status note above):**
- **Scope**: structured prompts only — permission requests (Bash/Edit/Write/etc. that hit `ask` rules or unlisted patterns), `AskUserQuestion` tool calls, `ExitPlanMode` approvals. Plain-text questions in assistant messages are out of scope; they don't map cleanly to settings.json entries.
- **Storage**: SQLite table in the same DB the observability and sessions layers use.
- **UI affordance**: passive log view only — sortable, filterable, no one-click "add to allow rules" buttons. The user reads, copies patterns, and edits `.claude/settings.json` by hand. Intentional friction so the allowlist doesn't widen faster than the user can notice.
- **Default**: always on. Per-container disable via a flag on the container's create spec for anyone who wants to turn it off.

**SQLite schema (sketch):**
```sql
CREATE TABLE prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  container_id TEXT,
  ts INTEGER NOT NULL,                   -- event timestamp (ms)
  kind TEXT NOT NULL,                    -- 'permission' | 'ask' | 'plan'
  tool_name TEXT,                        -- gated tool name when kind='permission'
  request_payload TEXT NOT NULL,         -- JSON of the prompt details
  response_payload TEXT,                 -- JSON of how the user resolved it
  decided_at INTEGER                     -- when the user resolved it (ms)
);
```

**Implementation:**
The same watcher that drives observability emits `prompts` rows when it sees the relevant event kinds in the JSONL stream. Container-level disable is honored at the watcher when it processes events for that container.

**IPC surface (sketch):**
- `prompts:list({ containerId?, sessionId?, kind?, since?, until? })` → row[]
- `prompts:get(id)` → row with full payloads

**Open:**
- **Event detection in the JSONL stream.** Need to confirm the exact event types Claude Code emits for each structured prompt kind (a dedicated permission event vs. a tool-use event for `AskUserQuestion` / `ExitPlanMode`) and the response payload shape.
- **What gets stored in `request_payload`.** Full prompt object vs. just the actionable fields (tool name, command, paths). Tradeoff is completeness vs. disk vs. accidentally storing sensitive payload content.
- **UI placement.** Top-level "Prompts" tab, panel inside session detail, or both.
- **Retention.** None for v1 (rows are small). Revisit if it grows unmanageable.
- **Cross-session aggregation.** If the same `Bash(...)` pattern triggers a prompt across many sessions, surfacing the aggregate (count, first/last seen) would highlight high-value allowlist candidates. Worth doing in the same UI iteration.

### In-container SQLite access via MCP
Read-only MCP server exposed by claude-fleet that lets the agent inside each container query the application's state DB (sessions, events, derived cost).

**Status: SHIPPED (#12).** Host-side server (slice 1) + container wiring (slice 2). Verified end-to-end on a real runner container: `claude mcp list` reports `claude-fleet-state … ✔ Connected` — claude auto-connects with no approval gate.

**Decisions made:**
- **Mechanism**: MCP server. Idiomatic for Claude Code, which supports MCP natively. The agent gets typed tools plus a snapshot-scoped `query` tool for ad-hoc SQL.
- **Access pattern**: strictly read-only. No mutation tools.
- **Transport**: newline-delimited JSON-RPC 2.0 over a Unix socket — **not** HTTP. MCP's HTTP transport wants a URL, which would force a network port; a stdio bridge over the socket keeps it network-free. (Hand-rolled, no MCP SDK dep — matches the broker.)
- **Caller identity = per-workspace socket (#117)**: there is one listener per workspace at `<userData>/mcp/<id>/mcp.sock`, bind-mounted into only that container. The host stamps every `tools/call` with the workspace id of the listener that accepted the connection — **identity is ambient from the mount, never asserted on the wire** (no `caller_id` arg, token, or env var to forge or steal). This is the security spine the cross-workspace committee permission model (#116/#118) builds on. **Local-workspace caveat:** a local (non-container) workspace has full host-FS access and could open any socket, so its derived identity is *not* unspoofable — only containers' is; `assertControl` (#118) refuses local workspaces. **Windows caveat:** the shared TCP listener can't derive identity from *which* socket accepted, so there it rides a per-workspace token that is itself leaf-bind-mounted into only that one container (so still not forgeable/stealable across containers) — see the Windows transport bullet below.
- **Visibility = workspace-scoped, always (#122/#146)**: every read is confined to the caller's **own** workspace plus any workspace it holds a `read` grant over (opted-in + reachable, resolved via `assertControl`). The typed read tools (`list_sessions`, `get_session`, `get_cost`, `list_events`, `session_summary`) filter to that set server-side, and a caller-supplied `workspace_id` can only *narrow* it, never widen. This is not optional — there is **no fleet-global mode and no env flag**; one workspace's agent can never enumerate or read another's sessions, costs, or transcripts. The `query` tool runs arbitrary read-only SQL but enforces isolation **structurally**: `buildSnapshot` copies only the caller's allowed-workspace rows into a fresh in-memory DB, then DETACHes the real DB before the caller's SQL ever runs — so no join/`UNION`/subquery/`sqlite_master` introspection can reach another workspace's rows (this was the real isolation breach fixed in #146 — the prior `CLAUDE_FLEET_SCOPED_READS` flag defaulted off, leaving reads fleet-global). Implementation: `mcpServer.ts` computes the caller's allowed set per call via `resolveAllowedWorkspaces` (which calls the injected `ipc.ts:allowedReadWorkspaces`, falling back to self-only when no resolver is wired) and hands it to the tools via `ToolCtx.allowedWorkspaces` — always a non-empty set, never "unrestricted".
- **Runaway protection**: the read-only connection is the hard write-guard; results are row-capped (1000).
- **Windows transport (loopback TCP + per-workspace token, win32 only).** A Windows host can't `listen()` on a unix socket at a Windows path (EACCES), so the per-workspace-socket model above can't work there. On win32 the server instead binds **one** shared loopback-TCP listener at `127.0.0.1:7071` (`MCP_TCP_PORT`, override `CLAUDE_FLEET_MCP_TCP_PORT`; fixed not ephemeral because the in-container bridge command is baked into `~/.claude.json` at create-time and a paused container must reconnect to the same port across restarts). Because the TCP source address is always `127.0.0.1` (Docker Desktop NATs `host.docker.internal` through the host loopback — so containers reach it but the LAN cannot), it carries no identity; caller identity instead rides a **per-workspace 256-bit token** written to `<userData>/mcp/<id>/token` and leaf-bind-mounted into only that container (`CONTAINER_MCP_TOKEN` = `/fleet/mcp/token`). The in-container bridge sends the token as its **first line**; the host maps token→workspace id (`mcpServer.ts` `tokenToId`), preserving the #117 caller-identity spine. An unknown token drops the connection before any tool runs. The in-container bridge (`bridge.cjs`, above) dials `host.docker.internal:7071` instead of the unix socket (`docker.ts:managedMcpServerEntry` selects the env). Linux/macOS keep the per-workspace unix sockets unchanged. See `docs/design/windows-broker-tcp.md` (Phase 2).
- **Durable bind-failure logging (#159).** A host-listener `error` event (the win32 TCP listener or a per-workspace unix listener) routes through `mcpServer.ts:reportListenerError` to **both** `console.warn` and `errorLog.logError` — so a swallowed bind failure (chiefly **EADDRINUSE**, when a stale/duplicate `claude-fleet` still holds `:7071`) leaves a durable, actionable line in `error.log` instead of vanishing on a double-click launch. The EADDRINUSE detection + message live in the pure, unit-tested `src/main/mcpListenerError.ts`. A **single-instance lock** (`index.ts` `requestSingleInstanceLock`) removes the common cause by refusing to start a second process (it focuses the running window instead). The port is **not** auto-rebound on conflict: it's contractually fixed by the baked-in container bridge, so silently moving it would break every existing container. **UI surfacing (#159 follow-up):** a renderer-side **sticky "MCP unreachable" toast** (the unified toast component, `error` kind) shows the user the condition without reading the log — fed by the `mcp:status` broadcast, **dismissible** for a prolonged outage (the ✕ snoozes it; change-only broadcasts mean it doesn't nag back), with an **Open log** action (`app:openErrorLog`), auto-clearing on reconnect.

**Implementation (`src/main/mcpServer.ts`):**
The main process's writers use the read-write `state.db` connection; the MCP server opens its **own** `better-sqlite3` connection `{ readonly: true, fileMustExist: true }`, shared across all workspace listeners. `startMcpServer(userData)` (called in `index.ts` whenReady after `openDb`) opens that connection but binds **no** socket itself; instead `ensureWorkspaceSocket(id)` creates one listener per workspace at `<userData>/mcp/<id>/mcp.sock`, capturing `id` in the accept callback so it becomes the connection's caller id. Listeners are brought up for every known workspace at startup (iterating `listWorkspaceManifests()`) and on `workspace:create`; `removeWorkspaceSocket(id)` tears one down on `workspace:remove`; `stopMcpServer()` closes them all on `before-quit`. Each accepted connection is one MCP session (newline-delimited JSON-RPC: `initialize` / `tools/list` / `tools/call` / `ping`, notifications get no reply); the caller id rides through to each tool via `ToolCtx`, and each tool scopes its reads to `ToolCtx.allowedWorkspaces`. The cross-workspace isolation of the read tools is pinned by `src/main/mcpServer.test.ts`.

**Migration (existing containers).** The in-container path is unchanged (`/fleet/mcp/mcp.sock`), so the reconnecting socat bridge command in `~/.claude.json` needs no rewrite — only the *host* side of the bind moved from the shared `<userData>/mcp/` to the per-id `<userData>/mcp/<id>/`. An already-running container created before #117 keeps its old shared-dir bind until it is **recreated** (e.g. on next start), at which point it picks up the per-id leaf; its MCP reads simply stop resolving in the interim (the global socket no longer has a listener). This mirrors the earlier `mcp.sock` → `mcp/mcp.sock` move (#18). The load-bearing isolation property — a container can never see a sibling's socket — is pinned by `src/main/mcpSocket.test.ts` (bind always names the per-id leaf, never the parent) and the per-workspace fan-out is exercised end-to-end in `tests/mcp-server.spec.ts`.

**Tool surface (shipped):**
- `list_sessions({ workspace_id?, since?, until?, limit? })` → rows from `sessions`; epoch-ms columns (`started_at`, `last_active_at`) include ISO sibling fields (`*_iso`)
- `get_session({ id })` → one row; same ISO siblings
- `get_cost({ session_id })` → token totals + USD **derived** from per-(model, service_tier) usage via `pricing.ts` (there is no `cost` table)
- `list_events({ session_id, type?, tool_name?, since?, limit?, columns? })` → curated event columns (omits `raw_jsonl`); includes parsed tool columns `tool_input`, `tool_use_id`, `tool_result_is_error`; `tool_name` filter and `columns` projection (allowlist-validated; `raw_jsonl` not selectable); `ts_iso` sibling for the `ts` column
- `session_summary({ id })` → `filesEdited`/`filesEditedCount`, `commands`/`commandsCount`, `usd` + token totals, `started_at`/`last_active_at` (+ ISO) — files/commands/cost/timespan in one call; collapses `list_events` + `get_cost` (#174)
- `list_errors({ workspace_id?, session_id?, level?, type?, since?, limit? })` → rows from `errors`, newest-first, with a `ts_iso` sibling. **Scoping:** own workspace(s) (`allowedWorkspaces`) PLUS any row whose `workspace_id IS NULL` (global app-level crash rows), regardless of caller. A caller-supplied `workspace_id` only narrows — it cannot expand beyond this set. Global crash rows (NULL `workspace_id`) are visible to every workspace; crash text is treated as non-private. Operational errors (with a `workspace_id`) are workspace-scoped like `list_sessions` / `list_events`.
- `query({ sql, params?, include_raw?, max_rows? })` → a single read-only SQL statement run against a per-call in-memory **snapshot** seeded only with the caller's allowed-workspace rows. The real DB is DETACHed before the statement runs, so joins/`UNION`/subqueries/`sqlite_master` introspection cannot reach another workspace's rows. `raw_jsonl` excluded unless `include_raw`; writes/DDL/multi-statement rejected; capped by `max_rows` + a ~50 KB result ceiling. Tables available: `events`, `sessions`, `broker_sessions`, `session_summaries`, `session_tags`, `usage_events`.
- `search_transcripts({ query, limit?, workspace_id?, kind? })` → ranked results (cosine similarity) from `embeddings`. `query` is embedded locally on the host (same `bge-small-en-v1.5` model); results are strictly confined to the caller's `allowedWorkspaces` — a supplied `workspace_id` can only *narrow* that set, never widen it. `limit` default 10, max 50. `kind` = `'turn'` | `'summary'` (omit for both). Returns `{ kind, sessionId, workspaceId, ts, text, score }[]`. Throws `'transcript search index is unavailable'` when the embedding pipeline failed to load (degrades gracefully — ingest is unaffected). Records one `search-impression` usage event per distinct session id in the result.
- `signal_input_wait({ sessionId, waiting })` — called by the in-container runner hook (not by the workspace's own Claude). `sessionId` is the claude session UUID; `waiting` is a boolean. The host updates its per-workspace waiting-session set and broadcasts `inputwait:update`. Caller identity is ambient (the workspace's per-id socket); no read/write grant is required — it is a write-path signal from the container's own hook, not a cross-workspace read. Container backend only.
- `report_session_mapping({ brokerSessionId, sessionId })` — called by the `SessionStart` hook inside the container (not by the model). Records the tab↔session mapping with `verified=1`; logs `mapping-remapped` if a different claude id was previously stored for this broker session (drift correction for `/clear`). Caller identity is ambient; affects only the caller's own workspace.
- `mark_useful({ sessionId, note? })` — explicit agent feedback after a `search_transcripts` result helped. The `search_transcripts` tool description instructs agents to call this when a result led to their answer. Scoped: the session must belong to an allowed workspace. Records a `marked-useful` usage event; note truncated to 500 chars.
- `get_config()` — returns effective fleet tunables for this workspace: `{ app: { version }, runnerImage: { name } | null, summarizer: { model, minNewTurns, minIntervalS, windowChars } }` (shape built by the pure `resolveWorkspaceConfig` in `src/main/config.ts`). Summarizer values resolve as app defaults overridden by the workspace's `env.plain` (`CF_SUMMARY_MODEL`, `CF_SUMMARY_MIN_NEW_TURNS`, `CF_SUMMARY_MIN_INTERVAL_S`, `CF_SUMMARY_WINDOW_CHARS`) and reflect what the host set at container create; manual in-container env changes are not visible until recreate. `app.version` describes the **live host process** — current across app restarts without a recreate — so a workspace can always tell what claude-fleet it's talking to. `runnerImage.name` is the manifest's configured image reference (`null` for local workspaces); it identifies the tag, not the build — surfacing the live container's image id/created date would need a docker inspect and remains an open follow-up on #219.
- (`list_prompts` dropped — the prompt log #11 is blocked, so there is no `prompts` table.)

**Container wiring (slice 2, shipped):**
- `docker.ts createWorkspace` binds this workspace's **own per-id** socket directory `<userData>/mcp/<id>/` → `/fleet/mcp/` **`:rw`** (per-workspace socket, #117 — the per-id *leaf*, never the shared parent, so a container sees only its own `mcp.sock` and the host derives an unspoofable caller id; see the dedicated subsection below). `:rw` because connecting to a Unix socket needs write access — the read-only guarantee is the DB connection, not the mount. Binding the directory, not the socket file, is deliberate and mirrors the broker: the server `unlink`s + recreates the socket (new inode) on every app restart, and a **paused container survives that restart** — a single-file bind would pin the dead inode and break MCP after pause+restart (#18). With the dir mount the container resolves `/fleet/mcp/mcp.sock` fresh and sees whatever socket currently lives there.
- The container-side bridge is a **node script** (`mcpContainerBridge.ts` → `bridge.cjs`) the host writes into `<userData>/mcp/<id>/` — the per-id dir already bind-mounted into exactly that container — refreshed by `ensureWorkspaceSocket` on every app start, so bridge upgrades need **no runner-image rebuild**. It line-buffers claude's stdin, tracks each request by JSON-RPC id, reconnects forever (keepalive on, 1s backoff), and **re-sends every still-unanswered request** (token first, on Windows) after each reconnect; notifications are sent at most once. This replaced the `socat` shell pipelines, whose failure mode was the **first-call hang**: the Windows `{ printf token; exec cat; } | socat` pipeline silently ate the first request written after a host-app restart (socat's peer died with the app; `cat` only noticed on that write's SIGPIPE and died carrying it; nothing ever re-sent it), and the unix `socat` loop lost any in-flight request the same way. Re-sent reads are idempotent (read-only server); `committee_*` effects are **at-least-once across an app restart** — accepted vs. an indefinite hang. `socat` stays in the runner image for compatibility with pre-bridge `~/.claude.json` entries.
- `ensureWorkspaceClaudeJson` writes a **user-scope** `mcpServers` entry into the per-workspace `~/.claude.json`: `{ "claude-fleet-state": { type: "stdio", command: "node", args: ["/fleet/mcp/bridge.cjs"], env: { CLAUDE_FLEET_MCP_UNIX: "/fleet/mcp/mcp.sock" } } }` (Windows: `env` carries `CLAUDE_FLEET_MCP_TCP: "host.docker.internal:7071"` + `CLAUDE_FLEET_MCP_TOKEN_FILE: "/fleet/mcp/token"` instead). The bridge's reconnect loop is what keeps MCP alive across an app restart while a container is paused, and its resend-unanswered semantics are what prevent the restart from eating a request. Because the server is **stateless per-connection**, the reconnected socket serves tool calls without re-`initialize`. User-scope entries are trusted, so `claude` auto-connects with **no approval gate** (verified: `claude mcp list` → `✔ Connected`). **Ownership split:** the onboarding/account fields (`hasCompletedOnboarding`, `projects`) are seeded only when the file is absent (claude owns them after), but the `mcpServers["claude-fleet-state"]` entry is **app-managed infrastructure** and is **reconciled on every create** (every other key preserved byte-for-byte; malformed files left untouched). That's what upgrades a pre-#18 workspace's stale one-shot `socat` to the reconnecting bridge when its container is recreated. **Caveat:** the *dir bind* only applies at container create time, but the managed `mcpServers` entry is also **reconciled at every app start** for all known container workspaces (`index.ts` startup loop) — the file is bind-mounted, so the rewrite lands inside running containers immediately. A live claude still uses the bridge process it spawned at its own start; it picks up the new entry when the MCP server process respawns (tab Refresh / new session), NOT requiring a container recreate. Without the startup reconcile, a bridge fix never reached existing workspaces and the first-call-after-restart hang persisted indefinitely.
- The socket path helpers live in the pure `src/main/mcpSocket.ts` (`mcpSocketDir` for the shared parent, `mcpWorkspaceSocketDir`/`mcpWorkspaceSocketPath` for the per-id leaf, `mcpWorkspaceBind` for the Docker bind string, plus `CONTAINER_MCP_DIR`/`CONTAINER_MCP_SOCKET`) so `docker.ts` can bind without importing `better-sqlite3` (which would break docker.ts's vitest-loadable graph).
- **Schema docs**: the typed tools' descriptions name their columns. The `query` tool sees six tables — `events`, `sessions`, `broker_sessions`, `session_summaries`, `session_tags`, `usage_events` — pre-filtered to the caller's allowed-workspace rows; `raw_jsonl` on `events` is opt-in via `include_raw`.

### Cross-workspace committee control (#116)
Give one workspace permission to talk to and control others, so a **manager** session can convene a **committee of expert workspaces** — unpause a panel, have them review/argue over a PR, synthesize a verdict. Built in phases (#117–#123); this section is amended each phase.

**Status: in progress.** Phase 1 (#117, per-workspace MCP socket + caller identity — the security spine) and Phase 2 (#118, permission model + opt-in/grant UI) shipped. Phase 3 (#119, the pause/unpause control plane — first real cross-workspace effect) is described below. The remaining effects (post/collect/status, #120–#121) and the console + loadouts (#123) are not built yet.

**Architecture (recommended, from the design pass).** The existing host MCP server (above) is the cross-workspace control plane — every container already reaches it, it runs in `main` where it can call `pauseWorkspace`/`sendInput`, and it's already in the §9 security model. The **manager is an ordinary Claude session** that gains `committee.*` MCP tools via a loadout — not a privileged broker peer. The **host is the sole authority**.

**Security model (the spine).** Identity is **ambient from the mount, never asserted on the wire**: the per-workspace MCP socket (#117) means the host stamps every call with the id of the listener that accepted the connection — no `caller_id` arg, token, or env var to forge. **Authority lives in the host-private manifest, never mounted** — a compromised workspace cannot read or edit its own grants. **Default-deny, both ends:** a workspace is unreachable unless it opts in, and a caller needs an explicit per-target verb grant. **Container-only:** a local (non-container) workspace has full host-FS access and could open any socket, so its identity isn't unspoofable — `assertControl` refuses local workspaces on both ends. Prompt-injection ≠ privilege escalation: `post` (a later phase) can make an expert *say* anything, but never *do* anything it isn't host-granted (a non-goal to sanitize injected text).

**Permission model (data shape, #118).** Two host-private manifest blocks on `WorkspaceSpec` (`src/main/workspaces.ts`), added to **both** the type **and** the strict allowlist constructor in `readWorkspaceManifest` (which drops unrecognized fields, so both sites must change or grants vanish on round-trip), and sanitized on read (bad verbs / non-boolean `reachable` dropped):
```ts
type CommitteeVerb = 'read' | 'post' | 'pause';
control?:       { canControl?: Array<{ id: string; verbs: CommitteeVerb[] }> };  // outbound (makes this a "manager")
accessibility?: { reachable: boolean; acceptFrom?: string[]; roleHint?: string }; // inbound opt-in (makes this a reachable "expert")
```
- **`read`** = query the target's sessions/events/cost; **`post`** = inject input into its live session; **`pause`** = pause/unpause (and cold-start) it. (#118 shipped the data + gate + UI; the `pause` effect shipped in #119, `post`/`read` effects (collect) in #120, and #122 scopes read *visibility* behind a flag.)
- A workspace holding ≥1 grant is a **manager**; one with `reachable: true` is a reachable **expert**.

**Enforcement — `src/main/control.ts`.** A single `assertControl(callerId, targetId, verb)` is the gate every committee effect must pass. It re-reads **both manifests fresh on every call** (instant revocation — no cached authority) and delegates to a pure `decideControl(caller, target, …)` (unit-tested truth table). Permit **iff** all hold; otherwise default-deny with a reason:
1. `callerId !== targetId` (no self-control).
2. Both manifests exist.
3. **Both** caller and target are `kind: 'container'` (local refused).
4. **Target is not itself a manager** — *no manager can be controlled by another manager*. Since only managers initiate control, "target holds grants" is exactly "a manager being controlled," so this keeps the committee a strict two-level hierarchy (managers → experts) with no chains/loops. This overrides the target's own opt-in.
5. Target opted in: `accessibility.reachable === true` and (`acceptFrom` empty **or** includes `callerId`).
6. Caller holds the verb: `control.canControl[targetId].verbs` includes `verb`.

**UI (#118).** Chosen direction: opt-in lives in the **edit modal**; grants live in a **left-rail "Committee" accordion section** (a third `acc` section beside Sessions / Library — `LeftRail.tsx`).
- **Chip markers** (`WorkspaceTabStrip.tsx`, glyphs + role predicates in `committee.tsx`): a **wifi glyph** (info-blue) when reachable, a **hierarchy / org-chart "manager" glyph** (neutral `--ink`) when the workspace holds grants — both left of the status dot so opt-in/role is never silent. `isManager`/`isReachable` mirror the main-side `control.ts:isManager`.
- **Opt-in** (`WorkspaceForm.tsx`, edit mode only): a "Committee access" disclosure — Reachable toggle + role hint + an **accept-from manager multiselect** + a plain-language consent warning ("granted managers can read this session, type into it, and pause it"). Saved into `accessibility` via `workspace:writeManifest`. Off ⇒ `accessibility` cleared. The accept-from control is a checkbox list of the fleet's current **manager** workspaces (`eligibleAcceptFromManagers` in `committee.tsx` — other container workspaces with ≥1 outbound grant; self excluded), selected by name rather than typed as ids (#164). None checked ⇒ `acceptFrom` omitted ⇒ "any granted manager"; an empty fleet shows a "grant a manager first" hint. The saved list is pruned to current managers on every save, so a previously-saved id whose workspace is no longer a manager has no checkbox and drops on save.
- **Grant matrix** (`CommitteePane.tsx`): keyed off the *selected* workspace as manager; rows are the other reachable container peers (managers + opted-out shown excluded with a reason), columns are the three verbs. Toggling a checkbox does an optimistic local update then `getManifest`→`writeManifest` on the manager's manifest. A local selected workspace shows "can't act as a manager — container-only."
- **Manifest write merge (`workspace:writeManifest`):** the handler now **merges over the existing manifest** (`{ ...existing, ...spec, workspaceRoot }`) so renderer-unmanaged fields survive an edit — the edit form omits `control` (edited in the rail) and `installedLoadouts` (written by the loadouts engine), and a wholesale overwrite would silently wipe them. A key present in the incoming spec (even `undefined`, e.g. clearing `accessibility`) is authoritative. (This also fixes a latent pre-#118 `installedLoadouts`-on-edit drop.) `listAllWorkspaces` carries `control`/`accessibility` through to the renderer so chips + matrix reflect current state.

**Pause/unpause control plane (#119) — first real effect.** A granted manager can pause/unpause a reachable expert.
- **MCP tools** `committee_pause(id)` / `committee_unpause(id)` (`mcpServer.ts`) — the manager's Claude calls these over its per-workspace socket; `callerId` is the accepting listener's id. They **do not** touch the read-only DB connection; they proxy to host effect functions injected via `setCommitteeHandlers` (so `mcpServer.ts` needn't import the docker/backend graph). Tool dispatch is now async (`callTool` awaits `tool.run`; `dispatchLine` funnels sync + async results through one promise chain).
- **IPC** `committee:pause` / `committee:unpause` (`ipc.ts`, `committeePause`/`committeeUnpause`) — the same effect functions, with `callerId` supplied by the host UI (the human operator — the ultimate authority, who can edit manifests directly anyway). Exposed to the renderer as `window.api.committee.pause/unpause` for the future console (#123).
- Both paths call `assertControl(callerId, targetId, 'pause')` first, then: **pause** resolves the target's live `containerId` from `listAllWorkspaces` (pause is keyed by containerId) and calls `backend.pauseWorkspace`; **unpause** calls `backend.startWorkspace(id)` (unpauses a paused container, cold-starts a stopped one) then **waits for the broker** (`docker.ts:waitForBrokerReady`) before returning.
- **Frozen-broker correctness:** a paused container's broker (PID 1) is frozen — a socket *connect* still succeeds (kernel backlog) but it never answers. So `waitForBrokerReady` polls a fresh `LIST` (not just connect) on the `REATTACH_RETRIES`×`REATTACH_RETRY_MS` backoff, each attempt bounded by a short timeout, until the thawed broker replies. This guarantees a later `post` (#120) never lands in a still-frozen broker. Skipped for mock/local (no broker).
- `pause` is a **combined verb** (pause + unpause + cold-start) — it grants lifecycle, not just resume. The **manager is never paused**, and experts hold no grants so they can't pause each other.

**Post + collect (#120) — the messaging round-trip.** A manager pushes a message into an expert and pulls its replies.
- **`committee_post(id, message)`** (MCP) / `committee:post` (IPC) → `assertControl('post')` → inject `message` into the expert's live session as a **paste-then-submit** sequence, the same shape as a human pasting and pressing Enter; no new broker frame.
  - **Submit contract (`ptyInput.ts::injectAndSubmit`, the load-bearing detail).** Writing `message + '\r'` in a single chunk does **not** submit: Claude Code's TUI reads a chunk of text-plus-carriage-return as a *paste*, so the `\r` becomes a literal newline in the composer and the message sits unsent until a human presses Enter. So delivery is two writes: (1) the body wrapped in bracketed-paste markers (`ESC[200~ … ESC[201~`, keeping multi-line bodies intact), then (2) after a ~40ms gap a lone `\r` as a **discrete** Enter keypress the TUI registers as a submit. Both post paths (attached-reuse and headless) share this helper so they can't drift.
  - **Reuse the renderer's attachment when present (the load-bearing detail, verified against a real container).** The broker is **one-writer-per-session**, and the renderer **always-mounts + auto-attaches every running workspace** — so for an expert visible in this app the renderer already holds the writer, and a *competing* attach is rejected `already attached`. (A real-container test caught exactly this; the mock harness can't.) So `ipc.ts` tracks `ptyHandleId → workspaceId` (`handleWorkspaceId`, kept in lockstep with `ptySessions`) and `committeePost` writes to that live handle's stream (`stream.write` === INPUT on the host channel). The human watching that tab **sees the injection** (which is the desired behavior; #123 adds a toast so they know why).
  - **Headless fallback:** if no renderer is attached (a truly headless expert), fall back to `Backend.committeePost` — a **transient** broker attach (`LIST` → guard **0** "not attached yet" / **>1** "single-tab expert only" → `ATTACH` with reattach-retry → `injectAndSubmit` → `DETACH`), holding the one-writer slot only for the paste-then-submit (the `DETACH` waits for the deferred `\r`). `post` returns `{ via: 'attached' | 'headless' }`. Mock acks without a broker; local throws (container-only).
  - `post` never reads the session's output stream — replies come back via `collect` from the DB, so output capture never depends on the write path.
- **`committee_collect(id, since?)`** (MCP) / `committee:collect` (IPC) → `assertControl('read')` → resolve the expert's **most-recently-active** session from the DB (`listSessions(id)[0]`; v1 single-tab ⇒ the live one) → `eventsForSession(sessionId, since)` → decode user/assistant turns. **Cursored by the autoincrement `events.id`, never `ts`** (`ts` is nullable and is claude's clock — skew/null would scramble a time window). Returns `{ sessionId, cursor, turns: [{ id, role, text }] }`; the manager polls with `since = cursor`. Pure DB read — works whether or not anyone is attached, and is the *only* way the committee reads expert output.
- The effect functions live in `ipc.ts` (`committeePost`/`committeeCollect`), shared by the IPC channels and the MCP tools (injected via `setCommitteeHandlers`). `Backend.committeePost` is the per-backend transient-attach hook used only on the headless fallback (docker real / mock ack / local throw); collect needs no backend (the events DB is shared).
- **Tested:** `tests/committee-post.real.spec.ts` drives `post` against a **real runner container** (skipped when Docker/the image is absent) and asserts it reuses the renderer attachment (`via: 'attached'`) — the regression that guards the one-writer bug. `mcp-server.spec.ts` covers the `collect` data path against a real DB; `committee-post.spec.ts` covers the grant gate in mock.

**Status + runaway guards (#121) — making the loop run unattended and safely.**
- **`committee_status(id)`** (MCP) / `committee:status` (IPC) → `assertControl('read')` → the expert's metadata `{ id, name, description, labels, roleHint, installedLoadouts: [{ id, title }] }` plus liveness `{ paused, busy, stalled, lastActiveAt }`. `paused` from the workspace state; `busy` is **host-computed** (below); `stalled` = busy past the turn timeout; `lastActiveAt` best-effort from the DB. The metadata adds no exposure — a `read` grant already authorizes reading the target; loadout titles are length-capped (`ROSTER_TITLE_MAX`) and surfaced as data, not instructions.
- **Host-side busy/idle (renderer-independent).** The renderer's chip busy indicator reads claude's title-glyph (braille spinner = busy) via `src/renderer/src/activityDetector.ts`. The committee must not depend on renderer React state, so `src/main/activityDetector.ts` (a pure copy of that twin — the two tsconfigs are disjoint, so it's duplicated, not shared) runs in **main**, tapping the **same broker output stream** the `pty:attach` handler already forwards to the renderer, and maintains a `committeeBusy` map keyed by workspace id. Because the renderer always-mounts + auto-attaches every running workspace, main always has that stream to scan whenever the app is open (and the committee can't run with the app closed — the MCP server lives in main). Known limitation (carried from §11): idle ≈ "done **or** waiting on a permission prompt" — the glyph can't distinguish them; mitigated by the no-stall expert loadout (#123) + the turn timeout.
- **Host-enforced runaway guards (`src/main/committeeRuns.ts`).** A looping/misbehaving manager can't talk past these — they run in main, keyed by manager id:
  - **Max posts per run** (`COMMITTEE_MAX_POSTS`, default 40). Checked in `committeePost` *before* delivering; on breach the host **force-pauses every expert the manager controls** (bypassing `assertControl` — the host is enforcing, not the manager) and throws. There is **deliberately no dollar cost cap**: committee experts are meant to run without a spend ceiling, so `wouldExceed` checks only the post count.
  - **Per-expert turn timeout** (`COMMITTEE_TURN_TIMEOUT_MS`, default 180s): `committeePost` refuses to post to an expert busy past the timeout ("appears stuck — pause/unpause it"), so one wedged expert can't be piled onto.
  - Both are env-overridable. **v1 run model:** no explicit "convene" primitive yet, so a "run" = everything a manager has posted since the host started (counter resets on restart); #123's run-committee skill can add an explicit reset. *(Defaults chosen here — revisit with the console in #123.)*

**Discovery — `committee_roster` (no per-target grant).** A manager's Claude can enumerate the experts available to it instead of having to be handed ids. `committee_roster` (MCP, no args) / `committee:roster` (IPC) returns one entry per **discoverable** expert: `{ id, name, description, labels, roleHint, installedLoadouts: [{ id, title }], status: { paused, busy, stalled, lastActiveAt }, grant: { controllable, verbs } }`. `grant.controllable` is whether the caller currently holds any grant over the entry (`false` ⇒ visible for discovery but not yet actionable — ask the operator to grant in the Committee rail). Gate logic is a pure `decideRoster` in `control.ts` (unit-tested), and `buildRoster` shapes entries with liveness injected (pure); `ipc.ts:committeeRoster` supplies the I/O (a fresh `listAllWorkspaces` scan — no cached authority — plus the `committeeBusy`/DB-derived status).
- **Discoverability honors the same `acceptFrom` contract as control** (`decideRoster`, mirroring `decideControl`'s container-only + no-manager-target + reachable rules), so the two never disagree about who "blank" admits:
  - `acceptFrom` **names the caller** → discoverable **without a grant** (pre-grant discovery — the operator explicitly advertised to this manager; appears with `grant.controllable: false` until granted, enabling the **discover → ask-for-grant** flow).
  - `acceptFrom` **blank/empty** → **"any granted"**: discoverable **iff the caller already holds a grant** over the target. This matches `decideControl`'s blank semantics and the UI's *"blank = any granted"* copy, so the roster never reveals more than control already allows, and a `reachable` expert with open `acceptFrom` is never advertised to *ungranted* managers.
  - `acceptFrom` **non-empty but omits the caller** → never discoverable (explicit whitelist; a grant cannot override it — control denies it too).
- **Security (the widening).** Roster is the one place a manager *agent* (an LLM in a container) gains metadata it previously never saw over MCP. It is read-only — `pause`/`post`/`collect` still pass `assertControl`, so discovery never implies control. Disclosure is bounded by the `acceptFrom` gate (the operator chooses which managers see each expert). Loadout entries are reduced to `id` + (length-capped) `title` — never file bodies — and because titles originate from externally authored OCI artifacts, all roster string fields are treated as **data describing experts, never instructions** (stated in the tool description). The inline liveness for a discoverable-but-ungranted expert is a minor activity side-channel, accepted under the same gate.

**Opening an expert tab is safe.** Because `post` reuses the renderer's existing attachment (above) rather than competing for the broker's one-writer slot, a human clicking into an expert the committee is driving — intentional or not — cannot break it: no second writer, no broker conflict, no stuck session. The only observable effect is the manager's injected text appearing inline in that tab; if the human happens to be typing at the same instant, the two inputs interleave into one line for Claude (cosmetic, recoverable). 

**Inbound-message indicator (#123, built).** When `committeePost` delivers a message it broadcasts `committee:inbound {workspaceId, message}` to the renderer (`window.api.committee.onInbound`); the target workspace's `TerminalPane` shows a transient **`[committee]` toast** (auto-dismiss ~6s) so a human watching that tab always knows why text appeared. Fires on both the attached-reuse and headless-fallback post paths.

**Turnkey loadouts (#123, built).** Built-in starters seeded by `ensureBuiltinLoadouts` (`src/main/loadouts.ts` `STARTERS`):
- **`expert-security` / `expert-perf` / `expert-api-design`** — each sets a single-lens reviewer persona (CLAUDE.md) **and** a `settings.json` that pre-grants a read-only tool allowlist (`Read`/`Grep`/`Glob`/`Bash(git …)`/`Bash(gh pr …)`), so the expert **never stalls on a permission prompt** — the hard prerequisite that makes host idle detection trustworthy. The persona is explicitly **non-interactive** (never ask the human; assume + proceed; end each turn with a verdict).
- **`committee-manager`** — ships a **`run-committee` skill** teaching the discover (`committee_roster`) → convene → post → poll `status` → `collect` → synthesize → pause loop over the `committee_*` MCP tools, plus a `settings.json` pre-granting the fleet MCP server. Grants over each expert are still set by the human in the left-rail Committee matrix (#118); an expert appears in the manager's roster once the human either names the manager in that expert's `acceptFrom` (visible pre-grant) or grants the manager control over an expert whose `acceptFrom` is open.

**Deferred within #123 (the loop is fully runnable without them):** the **committee console** (a human read-out of per-expert paused/busy/last-collected + Convene/Pause-all buttons — the manager's Claude already drives everything via the MCP tools, so this is polish) and **mailbox durability** (a `committees/<topic>.json` thread file — deferred because per-expert transcripts already survive in the DB, the manager's own conversation survives via broker durability, and there is no explicit *convene/topic* primitive yet to key a file by).

**Reads are workspace-scoped (#122/#146).** See the "In-container SQLite access via MCP" subsection above: the read tools are always confined to the caller + its read-granted, reachable targets — there is no fleet-global mode (the `CLAUDE_FLEET_SCOPED_READS` flag, which defaulted off and left reads fleet-global, was an isolation breach and is gone, #146). **Migration:** a skill that reads another workspace must hold an explicit `read` grant over it (and that workspace must be reachable). The `query` tool is available but snapshot-scoped — it can only express SQL over the caller's own allowed-workspace rows; cross-workspace joins/aggregates are not possible.

**Phased delivery.** #117 socket/identity ✓ → #118 model + UI ✓ → #119 pause/unpause ✓ → #120 post/collect ✓ → #121 busy-idle + status + runaway guards ✓ → #122 scoped reads (made permanent + hardened in #146) ✓ → #123 expert/manager loadouts + `[committee]` inbound toast ✓ → discovery: `committee_roster` + enriched `committee_status` ✓ (committee console + mailbox durability deferred).

### Dev-mode mock fleet
When `CLAUDE_FLEET_MOCK=1` is set in the main process's environment, `ipc.ts` swaps the real `docker.ts` implementation for `src/main/mock.ts`. The mock:
- maintains an in-memory `Map<id, FleetContainer>` seeded with two fakes (`mock-alpha` running, `mock-beta` exited);
- implements `ping`/`list`/`create`/`stop`/`remove`/`ensureImage` against that map;
- returns a custom `Duplex` "fake shell" from `attachPty` that emits a welcome banner, echoes typed characters, handles Enter/backspace/Ctrl-C, and responds to a small command set (`help`, `clear`, `whoami`, `echo`).

The renderer shows a `MOCK MODE` chip in the header (driven by a new `app:mockMode` IPC channel) so the state is obvious. The vault and JSONL-watcher code paths are untouched — mock mode only stubs Docker/PTY. To exercise an API-key profile in mock mode, supply `ANTHROPIC_API_KEY` via env as well; the OAuth path (blank profile) needs nothing.

Intentionally narrow scope: this is for iterating on UI without a daemon, image, or credits. The packaged build never reads the env var.

### Testing strategy
**Decided:**
- **E2E**: Playwright via its Electron integration (`_electron.launch`). Drives the packaged or dev-mode app from outside; can interact with menus, panes, modals, and assert on rendered state. Lives in `tests/`.
- **Unit / integration**: Vitest. Test files live next to source as `*.test.ts` (Vitest's default pickup pattern). Run via `npm run test:unit`; the `npm test` umbrella runs unit before E2E. Test files **must not** import modules that pull in native bindings (`better-sqlite3`, `keytar`) — those are built for Electron's Node ABI via `electron-builder install-app-deps` and crash under system Node. The same applies to modules that import `electron` (e.g., `vault.ts` uses `safeStorage`, `config.ts` uses `app`) — they only load in an Electron context. Keep unit tests against pure modules (e.g., `pricing.ts`, `wsl.ts`, `observabilityWorkspace.ts`); exercise `db.ts`/`vault.ts` via the Playwright e2e suite instead.
- **Scope at v1**: no upfront test plan. Tests get added as features land — each feature lands with at least smoke coverage of the new surface. Avoids the "set up the test infra in advance" anti-pattern when there's nothing to test yet.

**Deferred:**
- **MCP-based test harness.** A write-capable MCP server that test authors (or claude itself) could drive to exercise the app declaratively. Compelling for agent-authored test generation but premature given that no tests exist yet and standard tooling fits the immediate need. Revisit when there's a concrete pain point that Playwright + Vitest can't solve cleanly — most likely when "have claude write E2E tests for feature X" becomes a recurring workflow.

**Open:**
- **CI integration.** GitHub Actions vs. local-only. Headless Electron in CI requires Xvfb (Linux) or equivalent.
- **Test fixtures.** Shared in-memory DB seed vs. per-test container/profile fixtures.

### App-level Settings surface
The `SettingsModal` (top-strip gear) is the app-level Settings panel. It holds the **fleet root** and the **hardware-acceleration toggle** (issue #13 — see §6 *Settings*), both persisted to `config.json`. Settings live in `config.json` (not SQLite) so they survive a DB wipe and, critically, can be read synchronously at startup before the `ready` event (the HWA toggle's hard requirement).

**Open:**
- **Likely future occupants:** log-verbosity, default `mirrorDefault`/`cleanupDefault` for new profiles, dev-shortcut indicators ("ANTHROPIC_API_KEY is sourced from env"), pull-progress UI preference, fast-mode toggle, etc. The modal is currently a single untabbed panel; it gains tabs/sections once enough toggles accumulate.

### Create-container UX
The current flow is three sequential `window.prompt()` dialogs. Functional but crude. Needs a real modal form with: name, workspace root (with a directory picker — `dialog.showOpenDialog` from main), subdir, profile dropdown (populated from `vault:list`), and optional CPU/memory caps.

### Profile-to-container binding
Right now the profile name is stamped on the container as a label and the API key is baked into env at create time. If the user rotates the key in the vault, existing containers keep the old one until recreated. We may want a "rotate" action that recreates the container with the new key; we may not. Open.

### Runner image build
The runner image is published by CI (`.github/workflows/publish-runner.yml`) to `ghcr.io/imioimi/claude-fleet/runner:latest` as a multi-arch (`linux/amd64` + `linux/arm64`) image on every push to `main` that touches `docker/**`. Tags emitted: `latest` (main only) and `sha-<short>`.

**Build-context contract (load-bearing).** The Docker build context is the repo root with a deny-all `.dockerignore` that opts paths back in (`!broker/**`, `!docker/Dockerfile`, `!docker/scripts/**`, `!docker/runner/**`). **Anything the Dockerfile `COPY`s must be opted in here** — a `COPY` of an unlisted path fails the build with `"…": not found` and **nothing publishes**, leaving the previous (stale) `:latest` in place. This is exactly how the runner hook assets (`docker/runner/hooks.settings.json` + `input-wait-report.sh`) were once added with the `--settings` launch flag but *without* the `.dockerignore` opt-in: the app shipped a flag pointing at a file no published image contained, so every new in-container `claude` died with "Settings file not found". The publish workflow **should also smoke-test the built base image** (`test -f …/hooks.settings.json`) so a silently-absent asset can't ship green. Coupling note: the app's `claude --settings …` launch (§4 hooks) hard-depends on the image carrying that file; keep the flag and the image asset in lockstep, or make the launch degrade gracefully when the file is absent.

On first container-create (or app startup), the app should `docker pull` the image if it isn't already present locally. New IPC channel `docker:ensureImage` returns a pull-progress stream; the UI surfaces this as a one-time toast or as part of the create-container flow.

A local-build fallback (`docker build` from the bundled `docker/` dir) is useful for offline development and when iterating on the Dockerfile. Implementation can be a CLI flag, a settings toggle, or simply a documented dev workflow (`docker build -t ghcr.io/imioimi/claude-fleet/runner:latest docker/` and the pull becomes a no-op).

**Open:**
- **Package visibility.** GHCR images are private by default for the first push; the package owner has to flip it to public in the GitHub package settings. Decide whether the image is public (anyone can pull, suitable since the code is public) or private (auth required to use the app from CI/another machine).
- **Tag pinning vs. floating.** The app currently hardcodes `:latest`. Consider pinning to a specific SHA in shipped builds so an unexpected image update can't break a released app version.
- **Pull progress UI.** Whether the first-run pull is blocking (modal with progress bar) or background (spinner + queued container-create).

### How `claude` authenticates inside the container
Two modes, picked at create-container time via `manifest.authMode`:

- **API key**: env contains `ANTHROPIC_API_KEY` (typically as a secret env var resolved from the per-workspace vault entry at container-start time). Used when the user has a Console API key.
- **OAuth (Claude.ai Pro/Max)**: no `ANTHROPIC_API_KEY` is injected. A single shared credentials file at `<userData>/claude-shared/.credentials.json` is file-bound into every OAuth workspace as `/home/fleet/.claude/.credentials.json` (layered on top of the per-workspace `.claude` dir bind). The first OAuth workspace's run of `claude` prints a login code; the user completes the flow in their browser; OAuth tokens land in the shared file. Every subsequent OAuth workspace mounts the same file and skips the browser dance. Token refresh in any workspace updates the shared file in place and propagates to all of them.

Claude Code's auth precedence puts `ANTHROPIC_API_KEY` ahead of OAuth tokens, which is why API-key and OAuth modes are mutually exclusive at the env-injection level: OAuth mode skips the env var entirely so the OAuth path is reached.

**Non-goals (deferred):**
- Per-workspace OAuth isolation (a different Claude.ai account per workspace). A future `oauthIsolated: boolean` setting could opt a workspace out of the shared bind in favor of a per-workspace file. Not built because nobody's asked for it yet.
- Multiple Claude.ai accounts simultaneously.
