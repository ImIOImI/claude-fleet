# claude-fleet — product spec

This document is the single source of truth for what claude-fleet is and how it's built. The bar is rebuild-from-spec: a competent engineer (or Claude) reading only this file should be able to rebuild a functionally equivalent application.

See [`.claude/rules/spec-maintenance.md`](../.claude/rules/spec-maintenance.md) for the rule that keeps this doc honest.

---

## 1. Overview

**claude-fleet** is a desktop application for driving a small fleet (3–6) of Claude Code **workspaces** from a single window. The user picks an auth mode (OAuth via Claude.ai, or API key supplied as a per-workspace env-var secret); the app spins up a workspace (today: a Docker container backed by `dockerode`) — each gets a private host folder plus a fleet-wide shared folder under an app-level "fleet root" — running `claude` in a PTY, renders the live terminal with xterm.js, and surfaces structured observability (cost, tokens, tool calls, transcript history) sourced from the workspace's bind-mounted Claude transcript JSONL.

It is a local-only operator console — not a remote orchestrator, not a multi-user service, not a cloud product. Everything runs on the user's machine, against the user's local Docker daemon.

**Terminology.** "Workspace" is the user-level concept the UI talks about: a named place where a Claude session runs against a directory. It's persisted on disk as a manifest at `<userData>/state/<id>/workspace.json` independent of any backend's lifecycle, so workspaces survive container deletion and can be restarted. "Container" in this doc refers specifically to the Docker container that today is the only implemented workspace backend. A local-host (non-container) backend is anticipated but not yet built.

## 2. Goals

- Run multiple Claude Code sessions in parallel, each fully isolated in its own workspace with its own host-directory bind-mount.
- One window, one keyboard, one set of credentials — no juggling terminals or shells.
- Workspaces persist across backend lifecycle. Each workspace has an immutable ULID `id` and a mutable display `name`; the host-side manifest at `<userData>/state/<id>/workspace.json` survives container deletion and rename. The workspace modal's Saved tab lists every stopped / paused / deleted workspace; each row expands inline into an edit form so the user can adjust the spec before the Resume button starts the container (looked up by `com.claude-fleet.id` label) — or recreates from the saved spec, reusing the same ULID so state-dir + vault history stay attached.
- Persistent **expert workspaces**: pause an entire workspace plus its session set, then resume later and re-attach to every session right where it was — same conversation, same in-memory context. Lets the user build domain-specific agents that load their architecture / documentation / codebase knowledge once, sleep when idle, and wake up ready to act (analyze a PR, answer a question, run a check) without re-priming the context every time.
- Live terminal fidelity: cursor, colors, resize, paste, scrollback — all the things xterm.js gives you.
- Structured observability layered on top of the raw terminal: per-session cost, token counts, tool calls, transcript history — read from the Claude transcript JSONL that the CLI already writes, not by scraping the terminal stream.
- A global, workspace-filterable table of past Claude Code sessions with auto-generated short descriptions — selectable to resume any session in any workspace, regardless of which workspace originally ran it. Sessions persist across workspace deletion; the table is the durable record of past work.
- Drop OS files, pasted images, web content, or text fragments onto the window and have them saved into the selected workspace's directory where the agent can read them. The window is the inbox; the path lands on the clipboard for the user to reference in their next prompt.
- A durable, append-only mirror of every event Claude Code emits, written to `<workspace>/_history/<session-id>.jsonl` so the agent or user can refer back to pre-compaction turns. Whether the mirror is written, and whether it survives an explicit "Close terminal", are per-profile defaults (factory: write the mirror, delete on close). Both defaults can be overridden — the write decision at open time, the cleanup decision in the modal at close time. The mirror, when written, persists across pane switches, workspace restarts, and app exits; only the explicit Close action prompts the cleanup question.
- An always-on, structured log of every prompt Claude makes to the user — permission requests, `AskUserQuestion` calls, and plan-mode approvals — captured to a SQLite table the UI can review. The point is to give the user a substrate for tuning `.claude/settings.json` permissions and CLAUDE.md guidance over time: read what Claude is repeatedly asking about, then decide what to allow, deny, or document.
- Claude inside each workspace can query the application's state DB (sessions, cost, prompts, events) through a read-only MCP server exposed by claude-fleet. The agent gets typed tools for common queries plus a raw read-only SQL escape hatch — enough to consult past sessions, summarize cost patterns, or audit what it's been asking the user about.
- Credentials never touch the renderer process or the host filesystem in plaintext. They live in the OS keychain and are injected into workspaces as environment variables by the main process.

## 3. Non-goals

- **Not a remote orchestrator.** No SSH, no Kubernetes, no remote daemons. Local Docker only.
- **Not multi-user.** One user, one machine, one keychain.
- **Not a generic terminal multiplexer.** Every session targets `claude` in a managed container. No arbitrary shells, no `docker exec` on unmanaged containers.
- **Not a session recorder.** Terminal output is rendered but not persisted; durable history comes from Claude's own transcript JSONL, not from the PTY stream.
- **Not a Claude Code replacement.** The CLI inside the container is the source of truth for what runs. This app is a viewport and lifecycle manager around it.
- **No auto-updater, no telemetry.** The runner image sets `DISABLE_AUTOUPDATER=1` and `DISABLE_TELEMETRY=1`.

## 4. Stack

| Layer | Choice | Why |
|---|---|---|
| Shell | Electron | Native window with full Node.js access in the main process — needed for Docker socket, OS keychain, and SQLite. |
| Bundler | `electron-vite` + Vite | One config covers main/preload/renderer with sensible defaults; HMR for the renderer; no hand-rolled Webpack. |
| UI | React 18 + TypeScript | Standard, well-understood. TypeScript is non-negotiable given the IPC surface area. |
| Terminal | `@xterm/xterm` + `@xterm/addon-fit` | The de facto web terminal. Handles ANSI, resize, scrollback, paste, copy-on-select. |
| Docker client | `dockerode` | Promise-based wrapper over the Docker Engine API with first-class streaming `exec` attach (needed for live PTY). Avoids shelling out to the `docker` CLI. |
| Credentials | `keytar` | OS keychain integration (Keychain on macOS, Credential Vault on Windows, libsecret on Linux). API keys never hit disk in plaintext. |
| Local DB | `better-sqlite3` | Synchronous SQLite for the history/cost layer. Single-file, embedded, no daemon. JSONL→SQLite cache + cost rollup ship under #2; surrounding observability work (live push, slot consumers) follows. |
| File watcher | `chokidar` | Tails JSONL transcripts as Claude Code appends to them. Battle-tested cross-platform layer above `fs.watch` (atomic-rename handling, polling fallback on WSL). Imported via dynamic `await import('chokidar')` because v5 is ESM-only and the main bundle is CommonJS. |
| Unit tests | `vitest` | Fast, Vite-native runner for pure-TS modules (e.g., `pricing.ts`). Picks up `*.test.ts` next to source. E2E lives in `tests/` under Playwright. |

**Native modules.** `better-sqlite3` and `keytar` ship as N-API native bindings — they must match Electron's bundled Node ABI, not the system Node. The repo's `postinstall` script runs `electron-builder install-app-deps` to pull prebuilt binaries (or rebuild) for the current Electron version. Without this hook, `npm install` builds the bindings against the system Node and Electron fails to load them at runtime with a `NODE_MODULE_VERSION` mismatch.

The runner image is `claude-fleet/runner:latest`, built from `docker/Dockerfile`. Base: `node:22-bookworm-slim`. Installs `git`, `ca-certificates`, `curl`, `ripgrep`, `jq`, `less`, `tini`, and globally installs `@anthropic-ai/claude-code` **pinned to a specific version**. Runs as non-root user `fleet` (UID/GID 1000 by default). Entrypoint is `tini`; default `CMD` is `sleep infinity` so the container stays alive and is `exec`'d into for each terminal session.

**Why claude is pinned, not `:latest`.** claude 2.1.150 added a "Managed settings require approval" startup gate that fires when an org pushes a privileged setting (e.g., `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`) into the user's `remote-settings.json`. In 2.1.150 specifically, the prompt was unnavigable over our broker PTY — input bytes reached claude (verified via `/proc/<pid>/io` rchar growing and tty-echo coming back), but the prompt's parser didn't act on Enter, digits, or arrow-Enter combos, leaving every new OAuth workspace stuck before the main TUI. 2.1.169 fixed navigation and the pin currently sits at 2.1.177 (verified the gate still navigates over a PTY). Pinning the version protects against a silent re-regression in the same code path. Bumping the pin is deliberate — verify navigation works against a built image before raising the floor (see issue #65 for the test recipe and the broker probe script used to verify).

## 5. Architecture

Three processes, per Electron convention:

```
┌────────────────────┐   IPC (contextBridge)   ┌────────────────────┐
│  Main (Node)       │ ◄─────────────────────► │  Renderer (React)  │
│  - dockerode       │                         │  Layout:           │
│  - keytar (lazy)   │   exposes window.api    │   ┌─ top strip ─┐  │
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

Each broker session has **at most one live writer**. An `ATTACH` to a session that already holds a writer is rejected (`ATTACHED` with `OK:false`, error `session: already attached`) rather than silently replacing it — otherwise the displaced connection keeps believing it's attached while claude's OUTPUT flows to the newcomer, blinding the original. The host's normal re-attach `DETACH`es first, so it never trips this; the guard exists for a second connection on the socket (an external probe, or a future second window). Reconnect-after-disconnect still works: a dropped connection's deferred cleanup `DETACH`es its sessions, clearing the writer for the next attach.

**Main process** owns everything privileged:
- Docker daemon access via `dockerode` (default socket).
- OS keychain access via `keytar`.
- PTY session lifecycle: holds the duplex stream handle for each active `docker exec`, forwards data to the renderer over per-session IPC channels, forwards renderer input back to the stream, forwards resize events to Docker.
- JSONL transcript watching (`chokidar`) + SQLite persistence (`better-sqlite3`). The watcher tails every workspace's `<state>/<id>/.claude/projects/-workspace/*.jsonl` non-recursively and ingests new lines into the SQLite cache (see §7 *JSONL→SQLite cache*). Cost rollup (`src/main/pricing.ts`) groups events by `(model, service_tier)` and applies hardcoded Claude 4.x rates to derive USD; the rest of #2 (live push, slot consumers for chip/tab/context-bar) lands later.

**Preload** is a tightly scoped bridge. It uses `contextBridge.exposeInMainWorld('api', …)` to expose a typed `window.api` to the renderer. Window options: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: false` (sandbox is off because the preload needs `ipcRenderer`).

**Renderer** is pure React. It has zero Node access. It can only do what `window.api` lets it do. Everything privileged flows through IPC.

The renderer layout is a 3-row × 3-col shell:
- **Top row** (`WorkspaceTabStrip`): app name, workspace chips (each with a per-workspace hue + status dot), `+ New workspace`, daemon status pill, `MOCK MODE` chip when active. The chip hue comes from the manifest's `color.hue` field when set, falling back to a name-hash of the same 14-hue preset palette so unset workspaces still get a stable distinct color. Only live workspaces (running/stopped) appear here; deleted workspaces are surfaced in the new-workspace modal's past list. Each chip carries a small secondary line below the workspace name driven by observability — `active 2m ago` when the session is fresh, `idle 1h ago` when it's been quiet > 5 min, or empty when no events have been ingested yet. The activity text reads off `summary.lastActiveAt` from the shared summary map described below. A running chip also shows a **busy indicator** — its status dot pulses and the secondary line reads `working…` while claude is actively working. Busy/idle is detected in the renderer (`activityDetector.ts`) by watching each session's PTY stream for claude's terminal-title (OSC) glyph: a braille spinner (U+2800–U+28FF) means busy, `✳` means idle. `TerminalSession` reports per-session flips up to `TerminalPane`, which aggregates to a per-workspace busy flag App distributes to the chip via `busyByWorkspace`. (Busy/idle only — a true "needs your input" signal isn't available: claude renders AskUserQuestion/permission prompts with no distinct title glyph and doesn't write them to the JSONL while pending; see §11.)
- **Centralized observability distribution.** `App.tsx` owns a single `summaries: Record<workspaceId, WorkspaceSummary | null>` map (keyed by ULID) and distributes it to the chip strip, observability pane, and terminal-pane context bar via props. The map is filled two ways:
  1. **Live push.** The main-process `JsonlWatcher` emits `'ingest'` after every batch that genuinely inserts ≥1 new event (compaction re-reads that hit dedup_key are suppressed). `ipc.ts` subscribes, computes the workspace summary, and sends `observability:summary` to every BrowserWindow with `{ workspaceId, summary }`. The renderer's `window.api.observability.onSummary(cb)` (registered in App.tsx) updates the map immediately — chip relative-time, USD total, and context-bar fill refresh in <100ms of the JSONL flush.
  2. **30s safety poll.** App.tsx also re-fetches every workspace's summary every 30s. This backs up the push for any lost event and forces a re-render so the chip's `Date.now() - lastActiveAt` text rolls forward ("active 2m ago" → "active 12m ago") even when no new ingests are happening. It's 15× less frequent than the previous unconditional 2s poll because push handles the hot path.
- **Body row** (3 columns):
  - **Sessions pane** (left, ~280px): placeholder until #3 lands the JSONL-backed sessions table.
  - **Main pane** (center, fluid): header with selected workspace's name/status and `Close…` button, plus the xterm `TerminalPane` (or empty/first-run/disconnected states). At the top of the terminal area, a **context bar** carries the workspace's hue track + a width-driven fill — `--pct` set inline by `TerminalPane` from `summary.lastTurnContextTokens / summary.contextWindowTokens × 100`. The effective context window comes from `src/main/contextWindow.ts`: 200K per Claude 4.x family by default, 1M when the model id carries the `[1m]` marker (e.g. `claude-opus-4-7[1m]`), and a heuristic 1M auto-upgrade when any observed turn in the session has already crossed 200K (catches the 1M beta header case, since that flag doesn't show up in the model string Claude Code writes to JSONL). Falls back to a full identity band (100%) when no observability data is available, so a fresh workspace still reads visually correct. Tooltip on the band shows `tokens / limit (pct%)`. A subtle vertical tick at 80% (`.terminal-accent-band::after`) marks the compaction threshold — claude auto-compacts around there, so the tick is the heads-up that the next turn might trigger one.
  - **Observability pane** (right, ~320px): a **scope toggle** at the top switches between *This workspace* and *Fleet · N*. **Fleet scope** is a pure-renderer aggregate built from the shared per-workspace `summaries` map (no extra IPC): total USD across all live workspaces, a stacked-share bar (one hue segment per workspace, `flex` = its `usd`), and per-workspace rows (hue dot + name + state + cost). **Workspace scope** is the default — a live view of the **active terminal tab**'s Claude session in the selected workspace. Shows session title (from `ai-title` event or first-user-message head), latest model, last-activity relative time, event count, prominent USD total with a per-turn cost **sparkline** (`costSeries`, accent bars with recent turns brighter; hidden until ≥2 non-zero turns), token totals (input / cache-create / cache-read / output), recent tool calls (name + input summary + duration + ok/error status, from `recentToolCalls`), and a **Context · N terminals** section — one fill bar per session tab in the workspace (App reads `sessions.json` and fetches `summaryForBrokerSession` per tab), tinted warn ≥75% / danger ≥90% with an 80% compaction tick and the active tab dotted/bold. Empty state when the focused tab has no per-tab data yet. Below the session data, a **Workspace** block (rendered whenever a workspace is selected, even before any events) shows two clickable folder rows plus the runner image and resource limits in a bordered card: **private** (`<fleetRoot>/<id>` mounted at /workspace, visible only to that container) and **shared** (`<fleetRoot>/shared` mounted into every container). Each row is a button that reveals the host folder in the OS file manager via `fs:openPath`. The shared path comes from `config:get` (fetched once in App.tsx). Per-tab resolution comes from the `broker_sessions` mapping table (§11 *Per-tab mapping*). `TerminalPane` bubbles its active tab id up via `onActiveTabChange`; App.tsx fetches `summaryForBrokerSession(workspaceId, activeTabId)` for the selected workspace and re-fetches on every push for that workspace. **No workspace fallback** — when the per-tab fetch returns null the pane shows its empty state directly, regardless of how the tab was added. The fallback was tried (loaded-from-inventory tabs → workspace summary, fresh tabs → empty) but produced two user-visible bugs: clicking `+` showed the previous tab's data via the fallback, and switching between two unmapped tabs showed the same workspace-summary content on both ("doesn't update"). Per-tab semantics are now honest: each tab shows its own data or empty, never inherits from a sibling tab. The pane header carries a **collapse toggle** (`›`) that minimizes the rail to a thin 28px reopen strip (the `.app-body` grid's third column shrinks `320px`→`28px`); the strip is one tall click target whose `‹` button restores it. State is held in `App.tsx` (`obsCollapsed`) and persisted to `localStorage` under `obsRailCollapsed` — a pure UI preference, so it deliberately uses `localStorage` rather than the main-side `config.json`. The rail stays mounted while collapsed only in the sense that React re-renders it as the strip; the heavy summary subtree is not rendered, but the shared `summaries` map in App keeps polling so reopening is instant.
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
- `workspace:ensureImage(channelId)` → progress over `workspace:ensureImage:progress:${channelId}`. Always asks the registry, so improvements to `:latest` (broker landing, claude version bumps) reach existing users on subsequent creates. Docker's pull semantics no-op when local layers match the remote digest. If the registry is unreachable and a local copy exists, falls back to the cached image with a warning; if neither, the error propagates so the caller can surface it.

### Images
- `images:list` → `ImageEntry[]` — every image known to the library, including labels.
- `images:remove(ref)` → `void` — remove an image entry. The image itself is not deleted from the Docker daemon; only the library entry goes away.

### Sessions
Two distinct things share this namespace: the per-workspace **terminal-tab inventory** (`read`/`write`) and the global **Sessions table** (`list`/`rename`/`delete`/`resume`).

The tab inventory is the tab list shown above the terminal body. Renderer-owned read/write of the whole file; main has no notion of tab lifecycle.
- `sessions:read(workspaceId)` → `SessionInventory` — read `<userData>/state/<id>/sessions.json`. Returns an empty inventory (`{ version: 1, sessions: [], nextNum: 2 }`) if the file is missing or malformed.
- `sessions:write(workspaceId, inventory)` → `void` — atomic write of the whole inventory.

The Sessions table (#3) is a global, workspace-filterable list of every Claude session the watcher has indexed, each resumable via `claude --resume`. Backed by the sqlite `sessions` table (see §7 *JSONL→SQLite cache*).
- `sessions:list(workspaceId?)` → `SessionListItem[]` — newest-active first. Omit `workspaceId` for the global list; pass it to scope to one workspace. Each item is the `sessions` row (`id`, `workspaceId`, `aiTitle`, `firstUserMessage`, `userSetName`, `startedAt`, `lastActiveAt`) plus derived `eventCount` + `usd` (one grouped pass over `events`, no N+1), overlaid with `workspaceName`, `workspaceColorHue`, `workspaceState`. **Eligibility:** a session appears iff its workspace's manifest still exists — a truly-deleted workspace (manifest removed) drops out of `listAllWorkspaces` and its sessions are filtered; a closed-but-kept workspace (manifest present, no live container → state `'deleted'`) still appears. Enforced in the IPC layer, the only place that knows about on-disk manifests. The renderer's display title is `userSetName ?? aiTitle ?? firstUserMessage ?? '(untitled)'`.
- `sessions:rename(sessionId, name)` → `void` — set the manual name override (`user_set_name`); an empty/whitespace name clears it back to NULL so the auto title resurfaces.
- `sessions:delete(workspaceId, sessionId)` → `void` — drop the session's `events`, `broker_sessions`, and `sessions` rows, then unlink the on-disk transcript (`<state>/<id>/.claude/projects/-workspace/<sessionId>.jsonl`). The watcher's `unlink` handler only clears its in-memory offset state, so the DB rows are removed explicitly. Best-effort unlink (a missing file is fine).
- `sessions:resume(workspaceId)` → `{ containerId } | null` — bring the workspace's container up (`startWorkspace` unpauses a paused one, starts a stopped one, no-ops a running one) and return its `containerId` so the renderer can open a resume tab. **Null** when the container is gone and can't be brought up here (e.g. closed-but-kept workspace with no recreatable container) — the renderer surfaces a non-fatal "couldn't resume" notice. The actual `claude --resume <id>` happens through the normal attach flow (see §6 *PTY*).

### Vault
Per-workspace secret storage backed by `keytar`. Profiles are gone; each workspace owns its own bag of secret env-var values keyed by `<workspaceId>:<envVarName>`. The renderer never sees a secret value it didn't just write — values come back over `vault:getSecret`, and the main process consumes them directly when constructing the container env via `resolveEnv` (`src/main/vault.ts`).
- `vault:available` → `boolean` — probe whether the OS keychain is reachable. Cached after first call. Returns false on systems without libsecret-1 / a reachable keyring; the API-key auth mode degrades to disabled in that case.
- `vault:listKeys(workspaceId)` → `string[]` — every secret-env-var key stored for the workspace. Backed by a per-workspace index entry (`__secrets__:<id>` in keytar) so listing is one keychain read.
- `vault:getSecret(workspaceId, key)` → `string | null` — fetch a single value. Null when missing or keychain unavailable.
- `vault:setSecret(workspaceId, key, value)` → `void` — upsert; also adds the key to the workspace's index if not already there. Throws when the keychain isn't reachable.
- `vault:deleteSecret(workspaceId, key)` → `void` — delete a single value; updates (or drops, if last) the index.
- `vault:deleteAllForWorkspace(workspaceId)` → `void` — purge every secret + the index for one workspace. Called at workspace-delete time so credentials don't outlive the manifest.

### PTY
- `pty:attach(containerId, brokerSessionId, cols, rows, resumeOf?)` → `ptyHandleId: string` — opens a connection to the workspace's in-container broker (Unix socket at `<state>/<id>/broker/broker.sock`) and either re-attaches to an existing broker session or creates one. `brokerSessionId` is the stable id from `sessions.json` (so re-attach across an app restart finds the same live PTY). Main retains a `BrokerClient` plus the resulting Duplex, returns an opaque `ptyHandleId` the renderer uses for subsequent input/resize/detach calls. **`resumeOf`** (a Claude session UUID) makes this a *resume* attach: the broker `CREATE` spawns `claude --resume <resumeOf>` instead of a bare `claude`, and the broker→claude mapping is learned **directly** (not via the pending-attach queue) because `claude --resume` appends to the existing `<uuid>.jsonl` rather than writing a new one — so the watcher's `new-session` hook never fires for it. `resumeOf` only takes effect at CREATE time; on a re-attach where the broker session is already alive, ATTACH succeeds first and the resume args are correctly ignored (no second claude spawned). **On failure** the handler captures the last ~100 lines of broker stdout/stderr via `docker logs` and writes them to `error.log` under a `pty-attach-failed` entry alongside the thrown message — the broker is otherwise invisible to the host, and the worst-case "ATTACHED timed out" + "unsolicited frame type 4" pattern after a pause/resume is impossible to diagnose without seeing what the broker was actually doing.

Broker RPC timeout is 30s (`RPC_TIMEOUT_MS` in `src/main/broker.ts`). 10s was the original budget but routinely fired during the first ATTACH after a workspace pause/resume — the broker's `CREATE` path spawns the `claude` binary via `pty.StartWithSize`, and that first spawn (auth checks, MCP server warm-up, occasional network call) regularly takes 15–25s. The host's late-arriving response then lands with no waiter, producing the "unsolicited frame type 4" warning. 30s covers the observed worst case with margin without making honestly-stuck sessions hang the UI indefinitely.
- `pty:input(ptyHandleId, data: string)` → `void` — write user input to the broker as an INPUT frame on the channel.
- `pty:resize(ptyHandleId, cols, rows)` → `void` — send a RESIZE frame.
- `pty:detach(ptyHandleId)` → `void` — send a DETACH frame (session lives on inside the broker) and close the socket.

Per-session events from main to renderer:
- `pty:data:${sessionId}` — `Buffer` chunks from the container's stdout/stderr.
- `pty:end:${sessionId}` — stream ended.
- `pty:error:${sessionId}` — stream error (stringified).

The renderer's `window.api.pty.onData/onEnd` register listeners and return unsubscribe functions.

### Observability
- `observability:eventsForSession(sessionId, sinceEventId?, limit?)` → `EventRow[]` — rows from the `events` table for the given session, ordered by `id` ascending, restricted to `id > sinceEventId`. Caller polls with the highest `id` it has seen to get incremental updates. Returns up to `limit` rows (default 500).
- `observability:summaryForWorkspace(workspaceId)` → `WorkspaceSummary | null` — picks the most-recently-active Claude session in the workspace and returns `{ sessionId, title, model, startedAt, lastActiveAt, eventCount, inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, usd, lastTurnContextTokens, contextWindowTokens, topTools[], recentToolCalls[], costSeries[] }`. `recentToolCalls[]` is the latest tool calls newest-first (`{ name, input, durationMs, status: 'ok'|'error'|'pending', ts }` — duration/status from the tool_use→tool_result match). `costSeries[]` is per-turn USD over recent assistant turns, oldest→newest (the sparkline series; each assistant event with usage is one turn, priced per-row so mixed models/tiers are correct). Returns null when no events have been ingested for the workspace yet. `lastTurnContextTokens` is `input + cache_read + cache_creation` from the most recent assistant event — a context-window-fullness proxy that drives the terminal-pane context bar; null when no assistant event has been seen yet. `contextWindowTokens` is the session's effective context window (200K / 1M, see §5 *Main pane* for derivation rules). App.tsx fires this once per workspace at mount/resubscribe and then every 30s as a safety net; the hot path is the live `observability:summary` push (see §5 *Centralized observability distribution*).
- `observability:summaryForBrokerSession(workspaceId, brokerSessionId)` → `WorkspaceSummary | null` — per-tab variant. Resolves the broker→claude mapping in the `broker_sessions` table and returns that claude session's summary, or **null** when no mapping is known. **No workspace fallback at this layer** — a freshly-added tab carries an unmapped broker session id but legitimately has no data, and returning the workspace's most-recently-active session there surfaces the previous tab's numbers (the user-visible "new session shows the last session's info" bug). The renderer applies a workspace-summary fallback only for tabs loaded from `sessions.json` (where the mapping just hasn't caught up — pre-PR tabs, concurrent-attach skip cases); freshly-added tabs (the `+` button, close-last-auto-recreate) leave the pane on its empty state until the watcher learns a mapping and real per-tab data flows in.
- `observability:summary` (main → renderer) — broadcast every time the watcher ingests new lines for a workspace. Payload: `{ workspaceId, summary: WorkspaceSummary | null }`, where `summary` is the same shape `summaryForWorkspace` returns. Exposed to the renderer as `window.api.observability.onSummary(cb)`, which returns an unsubscribe. One push per ingest batch (one JSONL flush ≈ one push); duplicate-only re-reads after compaction are suppressed at the watcher. The fan-out runs through `broadcastObservabilitySummary` (`src/main/observabilityBroadcast.ts`), which guards each target with `win.isDestroyed()`, `webContents.isDestroyed()`, AND a try/catch around `send` — during BrowserWindow teardown the render frame can be disposed while both destroyed-flags still read false, and `webContents.send` then throws "Render frame was disposed before WebFrameMain could be accessed". The watcher's emit path isn't an awaited handler, so an unswallowed throw unwinds into Node's EventEmitter internals; the per-target catch keeps one stale window from breaking the whole broadcast.
- `observability:getCost(sessionId)` → `{ inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, usd }` — token totals + USD for one session. USD is derived from the `events` rows grouped by `(model, service_tier)`; pricing comes from `src/main/pricing.ts` (hardcoded Claude 4.x rates, standard tier full price, batch tier 50%, unknown model/tier degrades to $0 + one-time `console.warn`). The pane reads the equivalent `usd` field from `summaryForWorkspace`; this endpoint exists for the sessions table (#3) and per-session detail views.
- `observability:getCostForWorkspace(workspaceId)` → same shape, aggregated across every session in the workspace.

### Error log
Both main and renderer hook the standard "uncaught" channels and forward each crash through a single sink to `<userData>/error.log`. Main installs `process.on('uncaughtException')` + `process.on('unhandledRejection')` directly. The renderer wires `window.addEventListener('error', …)` + `window.addEventListener('unhandledrejection', …)` in `src/renderer/src/main.tsx` *before* mounting React, so a crash during App's initial render still lands. Each row is one JSON object: `{ ts, source: 'main' | 'renderer', type, message, stack?, extra? }`. No rotation; users can delete the file at will.
- `app:logError({ type, message, stack?, extra? })` → `void` — renderer → main bridge. The renderer never writes the log directly (sandbox / cross-process consistency).
- `app:errorLogPath()` → `string` — absolute path of the log, exposed for a future "Open error log" affordance.

### Filesystem
Host-filesystem helpers used by the workspace-create flow and the observability rail. The renderer is contextIsolated/sandboxed, so all disk access goes through main:
- `fs:isDirectory(path)` → `boolean` — whether `path` is an existing directory (workspace-root validation).
- `fs:mkdirp(path)` → `void` — create a directory and parents.
- `fs:openPath(path)` → `string` — reveal a host path in the OS file manager. On native macOS/Windows/Linux this is `shell.openPath`. **Under WSL** (detected once at load via `src/main/wsl.ts` — Linux platform + `WSL_DISTRO_NAME` or "microsoft" in `/proc/version`) `shell.openPath` can't reach a GUI file manager (no `xdg-open`/no Linux file manager), so the path is translated with `wslpath -w` and opened with `explorer.exe` (whose exit code is ignored — it returns 1 even on success). Resolves `''` on success or an error string; never rejects. Empty/non-string input returns `'No path provided'`. Drives the observability rail's Workspace **private/shared** folder rows; the renderer routes any error string to `app:logError`.
- `dialog:pickDirectory(defaultPath?)` → `string | null` — native open-directory dialog; null on cancel.

### Settings (app config)
App-level settings persist to `<userData>/config.json`: `{ fleetRoot?: string, disableHardwareAcceleration?: boolean }`. Both are surfaced via the top-strip gear → `SettingsModal`.
- **Fleet root** — the single host dir holding every workspace's private folder (`<fleetRoot>/<id>`) and the shared folder (`<fleetRoot>/shared`).
- **disableHardwareAcceleration** — when true, the app calls `app.disableHardwareAcceleration()` at startup. Silences Chromium's noisy GPU-init failure on WSLg (rendering falls back to CPU). Must be read **synchronously** at module load, before the `ready` event — `config.ts:hardwareAccelDisabledAtStartup()` does a `readFileSync` of `config.json` rather than going through the async cache. Changing it requires an app restart to take effect.
- `config:get()` → `{ fleetRoot, sharedDir, disableHardwareAcceleration }` — current fleet root + its derived `<fleetRoot>/shared` + the persisted HWA flag (the persisted value, not the effective one — the env override below isn't reflected). Fleet-root precedence: `CLAUDE_FLEET_ROOT` env override (the e2e suite sets this in `tests/_helpers.ts` so test runs don't pollute the real `~/fleet`) → the persisted config value → the `~/fleet` default.
- `config:setFleetRoot(path)` → `{ fleetRoot, sharedDir }` — persist a new fleet root (the dir is created). Takes effect for new containers and for existing ones on next restart (running containers keep their current mounts until recreated).
- `config:setHardwareAccelDisabled(disabled)` → `{ disableHardwareAcceleration }` — persist the HWA flag. `CLAUDE_FLEET_DISABLE_HWA=1` is an env override (dev shortcut) that forces it on regardless of the persisted value, matching the `CLAUDE_FLEET_MOCK` / `ANTHROPIC_API_KEY` pattern.

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
  workspaceRoot: string;   // derived private folder `<fleetRoot>/<id>` (not user-supplied); bind-mounted at /workspace
  workspaceSubdir: string; // optional working subdir inside /workspace
  kind: WorkspaceKind;     // 'container' today; 'local' is selectable in UI, not yet wired
  image?: string;          // image ref for kind='container'; undefined for 'local'
  authMode: AuthMode;      // 'oauth' (default) or 'apikey' (requires ANTHROPIC_API_KEY in env)
  env: {
    plain: Record<string, string>; // values live in the manifest
    secretKeys: string[];          // values live in keytar under `<id>:<key>`
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

The manifest is written on `workspace:create` and updated on successful `workspace:start`. Secret env values are NOT persisted here — only the *list* of keys (`secretKeys`). Values land in the OS keychain under `<id>:<key>` and are resolved at container-start time via `vault.resolveEnv(id, plain, secretKeys)`.

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
  name: string;      // 'main', 'session 2', 'session 3', …
  createdAt: number;
  resumeOf?: string; // set on a resume tab — first attach runs `claude --resume <resumeOf>`
}

interface SessionInventory {
  version: 1;
  sessions: SessionEntry[];
  nextNum: number;   // auto-increment for 'session N' naming; doesn't decrement on close
  activeId?: string; // tab to focus on attach
}
```

Writes are atomic (write-to-temp + rename). Reads tolerate missing/malformed files by returning `{ version: 1, sessions: [], nextNum: 2 }`. The first attach to a fresh workspace inserts a single `main` tab and persists it immediately. A **resume tab** (created from the Sessions list) carries `resumeOf` so that even after the broker dies (host reboot) the re-attach re-resumes the same Claude session rather than starting a fresh one.

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

### Docker container labels (backend implementation)
Today the only workspace backend is a Docker container. The container name is `cf-<id>` (must be unique on the host); lookup is always by the `com.claude-fleet.id` label, which means renaming a workspace does not require touching the container at all. Each managed container carries:
- `com.claude-fleet.managed` = `"true"` — discovery filter. `dockerode listContainers` filters on this label exclusively, so unmanaged containers never appear in the UI.
- `com.claude-fleet.id` — the workspace's ULID. **Stable identity lookup key**; survives renames.
- `com.claude-fleet.name` — the workspace's user-facing label at create time. Snapshot only; the source of truth for current name is the manifest.
- `com.claude-fleet.workspace-root` — the workspace's private folder (`<fleetRoot>/<id>`), stamped so `listLiveWorkspaces` can return it without a manifest read.
- `com.claude-fleet.subdir` — the optional working subdir inside `/workspace`.

### Docker container shape
- `Tty: true`, `OpenStdin: true`, `StdinOnce: false` — required for interactive `docker exec` later.
- `WorkingDir: /workspace/${subdir}` (or `/workspace` if subdir is empty).
- Binds: `<fleetRoot>/<id>:/workspace:rw` (this workspace's private folder), `<fleetRoot>/shared:/shared:rw` (the fleet-wide shared folder, mounted into every container), `<userData>/state/<id>/.claude:/home/fleet/.claude:rw` (per-workspace persistent Claude state), and `<userData>/state/<id>/broker:/run/broker:rw` (the directory the in-container broker creates its Unix socket in). The private + shared host dirs are created (`mkdir -p`) before the container starts. When `authMode === 'oauth'`, one additional **file-bind** is layered on top of the `.claude` dir bind: `<userData>/claude-shared/.credentials.json:/home/fleet/.claude/.credentials.json:rw` — so the first workspace's Claude.ai login covers every subsequent one and token refresh in any workspace propagates to all of them. The shared host file is created (touched empty) by `docker.ts:ensureSharedCredentialsFile()` before the container starts, because Docker refuses to file-bind a missing host path. `apikey` workspaces don't get the file-bind — auth comes via `ANTHROPIC_API_KEY` in the env. A parallel OAuth-only file-bind maps `<userData>/claude-shared/remote-settings.json:/home/fleet/.claude/remote-settings.json:rw` (touched empty by `docker.ts:ensureSharedRemoteSettingsFile()`): claude fetches the org's managed settings (e.g. OTEL telemetry endpoints) into this file and shows a one-time "Managed settings require approval" gate whenever it finds managed settings not already on disk — so without sharing, every new workspace re-prompts. Approving the gate once writes the fetched settings into the shared file in place; every subsequent OAuth workspace then finds them already present and skips the gate. Security is preserved: claude re-fetches on each start, so a genuine change to the org's settings still re-triggers the gate.
- A second **file-bind** (all auth modes) maps `<userData>/state/<id>/claude.json:/home/fleet/.claude.json:rw`. This file lives in `$HOME`, *beside* `~/.claude` rather than inside it, so the `.claude` dir bind does not cover it — yet it is where claude stores onboarding/account state (`hasCompletedOnboarding`, per-project `hasTrustDialogAccepted`). Without persisting it, every freshly-created container starts blank and re-runs the onboarding wizard (theme / "trust this folder" / setup) even when the credential is already valid — which reads to the user as "having to log in again." `docker.ts:ensureWorkspaceClaudeJson()` seeds the host file (only if absent) with `{ hasCompletedOnboarding: true, projects: { "<workingDir>": { hasTrustDialogAccepted: true } } }`, where `<workingDir>` is the container's cwd, so the wizard is pre-completed. Seeding only when absent lets claude own the file once it runs (startup counts, MCP/project state accumulate and persist across restarts/recreation). Safe with no credentials yet: the seed skips the wizard but claude still performs the real OAuth login when the token is genuinely missing. Trusting `/workspace` is implied by the act of creating the workspace against that host directory.
- Env: `manifest.env.plain` merged with secret values resolved at create time via `vault.resolveEnv(id, plain, secretKeys)` (missing secret keys resolve to the empty string so the container still starts; claude itself surfaces the auth failure). `HOME=/home/fleet` is also set so tooling finds the bind-mounted `.claude/`.
- `User: <hostUid>:<hostGid>` so bind-mounted files are owned by the host user.
- Optional resource limits: `cpus` (→ `NanoCpus`), `memoryMb` (→ `Memory`).
- `AutoRemove: false` — containers persist across restarts unless explicitly removed.
- `RestartPolicy: { Name: 'unless-stopped' }` — survive a host reboot / docker daemon restart. On daemon start the container comes back, its broker re-launches, and the user can resume sessions from disk (transcripts + the `broker_sessions` mapping persist). `unless-stopped` (not `always`) respects an explicit `workspace:stop` — a deliberately stopped workspace stays down across reboots; only ones running when the daemon went away come back.

### JSONL→SQLite cache
Each workspace's Claude transcripts (`<userData>/state/<id>/.claude/projects/-workspace/<session-uuid>.jsonl`) are tailed by a single SQLite cache at `<userData>/state.db` (WAL mode). JSONL stays authoritative — the DB can be dropped at any time and the watcher rebuilds it from the JSONLs on next start.

**Schema (v1):**

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
  ai_title TEXT,                       -- latest `ai-title.aiTitle` (dormant — no producer yet)
  first_user_message TEXT,             -- last-prompt or first user.content
  user_set_name TEXT                   -- manual override set via sessions:rename
);
CREATE INDEX idx_sessions_workspace ON sessions(workspace_id);
```

This `sessions` table is the index behind the Sessions table feature (§6 *Sessions*, §8 *Browse & resume a past session*): `listSessions` reads it (joined to a grouped `events` pass for cost + event count), `renameSession` sets `user_set_name`, and `deleteSession` removes the session's rows here + in `events`/`broker_sessions` before the IPC layer unlinks the JSONL.

**Why these design choices:**
- **Unique `(session_id, dedup_key)`** makes ingestion idempotent. Re-tailing a JSONL from byte 0 (after crash, after losing in-memory offsets) produces no duplicates: heavy events use their `uuid` as the key; light events without a `uuid` use a SHA-256 hash of the raw line. Insert uses `INSERT OR IGNORE`.
- **`raw_jsonl` stored verbatim** so the DB is rebuildable and so new extract columns can be backfilled from existing rows without re-tailing.
- **Subagent JSONLs** (`<session-id>/subagents/agent-*.jsonl`) are deliberately *not* ingested today — the watcher uses `depth: 0` to skip them. Surface them later if needed.

**Watcher behavior:**
- One `JsonlWatcher` instance per main process. Started on `app.whenReady` (after `listWorkspaceManifests`), stopped on `before-quit`.
- Each workspace is registered with `registerWorkspace(id)`, which `mkdir -p`s `<state>/<id>/.claude/projects/-workspace` and adds it to the chokidar watch set. The mkdir is non-obvious but load-bearing: chokidar v5 silently drops paths that don't exist at `add()` time (its docs imply it queues missing paths and watches them when they appear, but in practice the create-detection misses files claude later writes there). Symptom when omitted: any workspace whose claude first-run happens AFTER `registerWorkspace` never gets its JSONLs ingested — the observability pane stays empty for that workspace forever.
- Per-file byte offsets are kept in memory only. On add/change: read from offset to EOF, find the last `\n`, ingest complete lines, advance offset past the newline. Trailing partial line waits for the next event.
- Compaction (file shrinks below the stored offset) resets the offset to 0; `dedup_key` ensures already-ingested rows aren't duplicated.
- Mock mode (`CLAUDE_FLEET_MOCK=1`) skips watcher + DB entirely — no real JSONLs to read.

### Vault layout
`keytar` stores per-workspace secret env-var values:
- `service`: `claude-fleet` (constant)
- `account`: `<workspaceId>:<envVarName>` (e.g. `01ARZ3NDEKTSV4RRFFQ69G5FAV:ANTHROPIC_API_KEY`)
- `password`: the secret value (e.g. an API key)

Plus a per-workspace index entry:
- `service`: `claude-fleet`, `account`: `__secrets__:<workspaceId>`, `password`: JSON array of secret key names for that workspace.

The per-workspace index exists because keytar has no list operation; it makes "list this workspace's secret keys" (the common case for the env editor) an O(1) keychain read and makes `vault:deleteAllForWorkspace` cheap because the index already enumerates every account to remove.

The old `__profiles__:*` shape (global per-profile API keys) is gone. The startup migration in `src/main/migration.ts` purges every keytar entry under `service=claude-fleet` whose account doesn't fit the new `<id>:<key>` or `__secrets__:<id>` form, so `__profiles__:*` entries disappear on first boot of this code on any pre-existing install.

Values are read from the renderer only on explicit `vault:getSecret`; during normal operation, the main process consumes them directly via `resolveEnv` when constructing the container env (not round-tripped through the UI).

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
1. User clicks **+ New workspace** in the top strip.
2. `<WorkspaceModal>` opens. Two tabs at top: **Saved** (count badge) + **New**, underlined-tab style. Default tab is Saved when at least one non-running workspace exists, else New.
3. The Saved tab lists every stopped / paused / deleted workspace — sorted with a Variant-B label-filter search at the top: text input matches name + description (substring, case-insensitive), and a **Labels** dropdown opens a checkbox list of fleet-wide labels with usage counts. Selected labels filter the list as OR (any-match); active filters surface as removable pills above the list with an `N of M` count on the right. Each row shows a color identity bar, name, description, state badge, and last-used relative time. Clicking a row's header animates it open (CSS `grid-template-rows: 0fr → 1fr`, 320ms cubic-bezier; chevron rotates 180°; form contents fade-and-slide in over 220ms with 80ms delay) and renders `WorkspaceForm` inline in `mode='edit'` with the persisted spec pre-filled. The expanded row's footer is **Delete (danger)** on the far left, then `Cancel · Clone · Resume` on the right.
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
   4. Calls `workspace:ensureImage`, then `workspace:create` with the payload (id, name, description, labels, color, workspaceSubdir, kind, image, authMode, env: { plain, secretKeys }, resources) — no host path.
8. Main creates the workspace's private folder (`<fleetRoot>/<id>`) and the shared folder (`<fleetRoot>/shared`), creates the container (`docker create cf-<id>` with the `com.claude-fleet.id` label, the private folder bound at `/workspace` and shared at `/shared`, env resolved through `vault.resolveEnv`), writes the manifest, records the image in the library, and returns the `Workspace`.
9. The top strip refreshes; the new workspace appears and is auto-selected.

### Attach a terminal
1. User selects a workspace in the top strip (only live workspaces appear there).
2. `<TerminalPane>` mounts. It reads the workspace's persisted `sessions.json` via `sessions:read(workspaceId)`. If the inventory is non-empty the saved tabs are restored (including which one was active); otherwise a single auto-created `main` tab is inserted and persisted right away. The pane manages a tab strip above the terminal body and one `<TerminalSession>` per tab stacked in the body — only the active tab is `visibility: visible`, the rest stay mounted so their PTYs and scrollback are preserved across tab switches.
3. Each `<TerminalSession>` creates an `xterm` `Terminal`, fits to its host div, calls `pty:attach(containerId, cols, rows)` → gets a `sessionId`. It registers `onData` (writes chunks into xterm) and `onEnd` (shows the session-ended overlay). `term.onData` forwards to `pty:input(sessionId, data)`. A `ResizeObserver` re-fits and calls `pty:resize` on host div resize. The end-state overlay has two variants: a **natural** card ("claude session ended — Start new session") when `pty:end` fires after a successful attach, and an **attach-error** card surfacing the error message verbatim plus a `docker pull` hint when `pty:attach` itself throws (most often: stale runner image missing the broker, broker socket unreachable). The attach-error variant exists because the overlay is `position: absolute` over `.terminal-host` — without it, any error text written into xterm would be hidden behind the modal.
4. Clicking the **+** in the tab strip creates a new session. The first session is named `main`; subsequent sessions are `session 2`, `session 3`, … via a counter that doesn't decrement on close (so names stay stable). Each tab carries a small status dot showing two states today: **live** (PTY attached, normal-color dot) and **ended** (PTY exited, grey dot). Lifecycle is driven by the existing `pty:end` signal each `TerminalSession` already observes; `TerminalSession` reports state changes via an `onLifecycleChange(sessionId, 'live' | 'ended')` callback the parent `TerminalPane` aggregates into a `Set<string>` of ended tab ids. The dot flips back to live on the next "Start new session" click. Clicking a tab switches the active session. The **×** on a tab closes it; closing the last session auto-creates a fresh `main` so the strip is never empty. Every change is persisted to `sessions.json` immediately so a sudden quit doesn't lose tabs. Richer per-tab states (`idle`, `needs-input`) land when the observability watcher + permission-request log expose the relevant signals.
5. On unmount (workspace removed, or app close): each `<TerminalSession>` unsubscribes listeners, calls `pty:detach`, disposes the terminal.

**Always-mounted TerminalPanes.** App.tsx renders one `<TerminalPane>` per live workspace (state ≠ `deleted`), all permanently mounted; the one matching `selectedId` has `visible={true}` and the rest are CSS-hidden (`visibility: hidden` to preserve xterm layout dimensions; `pointer-events: none` so hidden panes don't intercept clicks on the visible one stacked at the same coords). Keying is by workspace name (not containerId) so the pane survives container stop+start — sessions.json is per-workspace, not per-container. **Workspace switches are a CSS toggle, not a remount**: xterm scrollback, broker connections, and PTY state persist across selection changes; only an actual workspace removal triggers teardown. This is the architectural fix for a long tail of timing-sensitive bugs (HISTORY frame dropped on re-attach, xterm `Viewport.syncScrollArea` crash on remount, broker `EventEmitter` race on attach) — all of those were second-order effects of the previous tear-down-on-switch model.

**Paused state.** When the selected workspace's state is `paused`, the terminal pane renders a modal card centered in the session-stack ("workspace paused" + Resume button) while the underlying `TerminalSession`s stay mounted but are dimmed (~40% opacity + greyscale + pointer-events disabled). The session tab strip and accent band stay live so the user can see which tabs exist and which workspace they're looking at. The chip in the workspace ribbon also shows a small ⏸ glyph and an amber status dot. The Resume button calls `workspace:start(name)`, which `docker unpause`s the container; the next `workspace:list` poll picks up the running state and the overlay disappears. Workspace-ribbon chips for other workspaces remain interactive so the user can switch to another workspace without resuming. **Caveat (PR1):** today the PTYs are bound to the docker-exec instances inside the (frozen) container, so they thaw correctly across a pause that happens *while the app is running*. Across an app restart the PTYs are re-spawned and any in-memory state Claude held is lost; the broker layer that preserves it is deferred (see §11).

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
The left rail (`SessionsPane`, the 280px column) is the Sessions table. It mirrors the ObservabilityPane's scope control: **This workspace** (the selected one) or **All** (every live workspace). A search box filters by title + workspace name; the list refetches on scope/selection change, on every `observability:summary` push (throttled, so just-active sessions surface live), and after the pane's own rename/delete actions.

Each row shows the display title (resume on click), and — in **All** scope — a workspace color dot + name, plus relative last-active time and USD cost. Hover reveals row actions:
- **Resume (↻)**: App calls `sessions:resume(workspaceId)` to bring the container up, selects that workspace, and hands the matching `TerminalPane` a resume request. The pane opens a new tab whose `SessionEntry.resumeOf` is the Claude session UUID; that tab's first attach runs `claude --resume <uuid>` in the container (see §6 *PTY*). If the container can't be brought up, App logs a non-fatal warning and does nothing.
- **Rename (✎)**: inline edit → `sessions:rename`; empty clears the override.
- **Delete (🗑)**: a two-click inline confirm → `sessions:delete` (drops cache rows + unlinks the transcript). No modal — the action is row-local and the confirm is reversible up to the second click.

## 9. Security model

- **Secret env-var values stay out of the renderer except at write time.** Per-workspace secrets are persisted via `vault:setSecret(workspaceId, key, value)`. After that, the renderer holds only the *list* of secret key names (via `vault:listKeys`); the main process resolves values directly from keytar when constructing the container env. The lone exception is the env-row in `WorkspaceForm` — the renderer briefly holds the value the user just typed before it ships to `vault:setSecret`. There is no way around that.
- **Renderer is isolated.** `contextIsolation: true`, `nodeIntegration: false`. No `require`, no `process`, no `fs` from renderer code.
- **`sandbox: false`** because preload uses `ipcRenderer`. The renderer itself still has no Node access.
- **Renderer cannot escape the IPC surface.** It can: list/create/start/stop/remove workspaces carrying the fleet label, list/get/set/delete per-workspace secrets, attach/detach a PTY. It cannot: shell out, read arbitrary files, touch other Docker containers, hit the network with Node APIs.
- **Workspace isolation is Docker's.** No additional sandboxing layered on top. Containers run as the host user's UID (via `User: '<uid>:<gid>'`) and can write to the bind-mounted host workspace as that user.
- **Host-private zone — default-deny container exposure.** `<userData>` is the main process's private domain: the SQLite state DB, `config.json`, `error.log`, the keytar vault, and every workspace's durable transcript mirror (`<userData>/state/<id>/_history/`). **Nothing under `<userData>` is bind-mounted into a container** except a workspace's *own* `.claude` dir, its `.claude.json`, and its broker socket dir (and, in OAuth mode, the shared credentials/remote-settings files). The docker socket is held only by the main process — it is never mounted into a workspace container, so there is no docker-in-docker escape path. The invariant: cross-workspace or sensitive data is **mediated by the main process** (and, in future, the read-only MCP server, §11), never exposed by a bind mount. A workspace can therefore never read another workspace's transcripts, secrets, or state off the filesystem. This is why the durable transcript mirror (§11) lives under `<userData>` and not in the container-visible fleet root.
- **The one deliberate cross-container surface is `<fleetRoot>/shared` → `/shared` (rw in every container).** It exists so workspaces can exchange files on purpose; treat it accordingly — **secrets must not be written to `/shared`**, since every workspace can read it.
- **OAuth credentials are shared across workspaces by design.** In `oauth` mode all workspaces file-bind one `.credentials.json` (one login covers the fleet), so a token present in one container is the same token in every OAuth workspace. `apikey` mode is per-workspace (the key is injected as an env var, visible only inside that container). Either way, a container legitimately holds its *own* auth — the boundary being protected is *other* workspaces' data and the host-private zone, not a workspace's view of its own credentials.
- **External link handling**: `setWindowOpenHandler` denies in-app navigation and opens external URLs via `shell.openExternal`.
- **Vault availability degradation**: the main process probes `keytar` once at startup (`vault:available`). When the OS keychain is unreachable (typically bare WSL with no Secret Service), the env editor disables the per-row "secret" toggle (a row can still be added as a plain env var, but the value lives in the manifest in that case), and the auth-mode picker degrades to OAuth-only unless `ANTHROPIC_API_KEY` is supplied as a plain env. A `BottomBar` notice surfaces the degraded state. The packaged Windows build hits Credential Manager via DPAPI and never enters this mode; this path exists for Linux dev environments without a keyring.

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
│   └── Dockerfile                     # runner image (multi-stage, builds broker)
├── .dockerignore                      # opt-in: broker/** + docker/Dockerfile only
├── broker/                            # in-container session multiplexer (Go)
│   ├── go.mod / go.sum
│   ├── cmd/broker/main.go             # entrypoint; reads env, listens on socket
│   └── internal/
│       ├── proto/                     # wire-protocol frame codec
│       ├── session/                   # PTY supervision + ring buffer + Manager
│       └── server/                    # connection loop, frame dispatch
├── electron.vite.config.ts            # electron-vite config (main / preload / renderer)
├── electron-builder.yml               # packaging config
├── package.json
├── tsconfig.json                      # references node + web tsconfigs
├── tsconfig.node.json                 # main + preload
├── tsconfig.web.json                  # renderer
└── src/
    ├── main/
    │   ├── index.ts                   # app lifecycle, BrowserWindow
    │   ├── ipc.ts                     # registerIpc() — workspace:* / pty:* / etc. live here
    │   ├── docker.ts                  # Docker backend (dockerode + broker-aware PTY attach)
    │   ├── broker.ts                  # host-side BrokerClient + frame codec
    │   ├── mock.ts                    # mock backend behind CLAUDE_FLEET_MOCK=1
    │   ├── workspaces.ts              # WorkspaceSpec types + manifest read/write/list
    │   ├── sessions.ts                # per-workspace sessions.json read/write
    │   ├── imageLibrary.ts            # imageLibrary.json read/write + auto-record
    │   ├── db.ts                      # SQLite cache: events/sessions tables, ingest, summary, cost queries
    │   ├── jsonlWatcher.ts            # chokidar-based JSONL tailer feeding db.ingestLine
    │   ├── pricing.ts                 # Claude 4.x USD rates + costFor(model, tier, tokens)
    │   ├── pricing.test.ts            # Vitest unit tests for pricing math
    │   ├── errorLog.ts                # JSON-lines crash log to <userData>/error.log
    │   ├── paths.ts                   # state-dir path conventions (incl. broker dir, shared OAuth credentials)
    │   ├── config.ts                  # app config (<userData>/config.json): fleet root + private/shared folder paths
    │   ├── wsl.ts                     # isWslEnvironment() — drives fs:openPath's explorer.exe bridge
    │   ├── fs.ts                      # isDirectory / mkdirp helpers
    │   ├── migration.ts               # one-shot ULID migration + legacy keytar purge + fleet-folder creation on first boot
    │   └── vault.ts                   # keytar wrapper, per-workspace secret keying + env resolve
    ├── preload/
    │   └── index.ts                   # contextBridge.exposeInMainWorld('api', …)
    └── renderer/
        ├── index.html
        └── src/
            ├── main.tsx               # React root
            ├── App.tsx                # 3-pane shell + modal owner; refresh() polls workspace:list
            ├── styles.css             # design tokens + component styles
            ├── types.d.ts             # declare global window.api
            └── components/
                ├── WorkspaceTabStrip.tsx  # top: app name + workspace chips + actions
                ├── SessionsPane.tsx       # left sidebar (placeholder until #3)
                ├── TerminalPane.tsx       # center: per-workspace session tab strip + stack
                ├── TerminalSession.tsx    # one session: xterm + PTY + key bindings + session-ended overlay
                ├── ObservabilityPane.tsx  # right sidebar: live session summary (cost + tokens + tools)
                ├── BottomBar.tsx          # footer hint bar
                ├── WorkspaceModal.tsx     # tabbed shell: Saved (variant-B search + inline expand-edit) + New
                ├── WorkspaceForm.tsx      # reusable form (color, description, labels, env, resources); mode-aware
                ├── EditWorkspaceModal.tsx # single-purpose edit modal for live workspaces (chip ⋮ Edit)
                ├── DeleteWorkspaceModal.tsx # confirm modal: stop + remove + purge keytar
                ├── AdvancedImageSearchModal.tsx # magnifying-glass next to Image: ref/digest search + Tags filter
                ├── SettingsModal.tsx      # app settings (fleet root); opened from the top-strip gear
                └── CloseWorkspaceModal.tsx
```

## 11. Open decisions

These are decided in spirit but not yet implemented. When you implement one, move it out of this section and into the relevant body section above.

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
Per-session cost and token counts derived from Claude transcript JSONL events. **Status: foundation + cost rollup + pane v1 + slot consumers + live push + per-model context window + per-tab mapping + tool-call detail (duration/status) + per-turn cost series shipped; the expanded rail (sparkline, scope toggle, fleet view), tab-state richness, and subagent JSONLs remain.**

**Shipped:**
- The JSONL→SQLite cache + watcher (§7 *JSONL→SQLite cache*), the `observability:eventsForSession` catch-up IPC (§6), and the `chokidar`+`better-sqlite3` runtime pieces (§4). Watcher tails every workspace's transcripts and ingests new lines idempotently into `events`, updating `sessions` with derived metadata.
- `summaryForWorkspace` (§6) plus the right-rail pane (§5) — title, model, event count, last-activity, prominent USD, token totals, top tools.
- Cost rollup (`src/main/pricing.ts` + `costForSession` / `costForWorkspace` in `src/main/db.ts`, §6 IPCs). USD is derived per `(model, service_tier)` group with hardcoded Claude 4.x rates — Opus $15/$75/$1.50/$18.75, Sonnet $3/$15/$0.30/$3.75, Haiku $1/$5/$0.10/$1.25 per 1M tokens (input / output / cache-read / cache-creation). Standard tier full price, batch tier 50%, unknown model or tier degrades to $0 + one-time `console.warn`. Unit-tested in `src/main/pricing.test.ts` via Vitest.
- Slot consumers (#34): chip secondary line ("active 2m ago" / "idle 1h ago" from `summary.lastActiveAt`) and terminal-pane context bar (fill driven by `summary.lastTurnContextTokens / summary.contextWindowTokens`). Both read from App.tsx's shared summary map so chip + pane + bar share one source of truth (see §5 *Centralized observability distribution*).
- Live summary push: `JsonlWatcher` extends `EventEmitter`, emits `'ingest'` on every batch that inserts ≥1 new event, and `ipc.ts` broadcasts `observability:summary` to every BrowserWindow. The renderer's `onSummary` subscription updates the shared map in <100ms of the JSONL flush. A 30s safety poll covers missed events and refreshes relative-time displays.
- Per-model context window (`src/main/contextWindow.ts`): replaces the renderer's hardcoded 200K. Defaults to 200K per Claude 4.x family, recognizes the `[1m]` marker in the model id, and auto-upgrades to 1M when observed usage already crossed 200K (handles the 1M beta header case, where the model string itself doesn't change). Plumbed through `WorkspaceSummary.contextWindowTokens`; the context bar's 80% compaction tick is now positioned correctly because the limit is data-driven. Unit-tested in `src/main/contextWindow.test.ts`.
- Per-tab mapping (`broker_sessions` table, `pendingAttaches.ts`): each terminal tab's broker session id maps to a specific claude session UUID. Learned passively — `attachPty` records a pending attach (workspace, broker_session), and `JsonlWatcher` emits `'new-session'` the first time a JSONL appears for a path; the IPC layer pairs them by taking the **oldest** pending attach for the workspace (FIFO). **No TTL** on pending entries — claude doesn't write its first JSONL until the user types in the session, and that delay can be minutes to hours. The original 30s TTL was the cause of the user-reported "open a new workspace, type in main → no observability data" symptom: the user opened main, did work in sessions 2 and 3 (which got mapped because they typed within the window), and by the time they came back to type in main its pending entry had been pruned and the next 'new-session' event found nothing to pair with. Pending entries now live until consumed (or explicitly removed via `removePendingAttach` when a tab is closed before claude ever writes). FIFO across multiple unmapped entries is correct in the common case where the broker spawns claudes in attach-order; broker-goroutine races can swap pairings within one batch — accepted vs the prior always-blank failure. Mapping persists in SQLite so re-attaching after an app restart (when broker still has claude alive and no new JSONL appears) still resolves to the right session. **Fallback semantics:** `summaryForBrokerSession` returns null when no mapping exists, and the renderer surfaces the ObservabilityPane's empty state directly — no workspace-summary fallback. We tried a conditional fallback (loaded tabs fall back, fresh tabs don't); it produced two user-visible bugs (new session inheriting previous tab's data; switching between unmapped tabs showing the same content on both — "doesn't update"). Per-tab semantics now never inherit from sibling tabs. **Known consequence:** tabs created before this table existed have no mapping and stay empty until recreated; the workspace's overall activity is still surfaced on the chip subline and the right-rail pane's USD/eventCount via the tab's own session once a mapping lands. Unit-tested in `src/main/pendingAttaches.test.ts`; e2e regressions in `tests/smoke.spec.ts` (`broker_sessions: a single pending attach`, `broker_sessions: mapping is learned even when the user types many minutes after attaching the tab`, `broker_sessions: multi-tab attaches that interleave`, `ObservabilityPane: clicking +`, `ObservabilityPane: switching between two loaded-from-inventory tabs`, `summaryForBrokerSession: returns null for an unmapped broker session`).

**Outstanding:**
- **Richer tab states.** Tab dots are live / ended today. `idle` and `needs-input` states want the permission-request log (#11) and a recency signal before they can be wired meaningfully.
- **Subagent JSONLs.** Today `depth: 0` skips them. Decide whether to surface them in the events stream as a separate `parent_session_id` field, or treat them as opaque tool runs.
- **Pricing refresh process.** `pricing.ts` is hand-maintained. When Anthropic publishes new rates, the constants need updating. Consider an annual recheck cadence and/or a comment-pinned source URL.

### Sessions table

**Status: shipped.** Global, workspace-filterable list of every Claude session the watcher has indexed, each resumable via `claude --resume <id>`, renamable, and deletable. Implementation lives in the body: §6 *Sessions* (`sessions:list`/`rename`/`delete`/`resume` IPC), §6 *PTY* (`resumeOf` attach), §7 *Session inventory* (`resumeOf` field) + *JSONL→SQLite cache* (the `sessions` table is the index; JSONL stays the source of truth), and §8 *Browse & resume a past session* (the `SessionsPane` UI). It's workspace-keyed (not container-keyed) — sessions outlive any one container, and eligibility is "workspace manifest still exists."

**Resume mechanism.** The host knows the Claude session UUID up front, so the broker→claude mapping is written **directly** at attach time rather than via the watcher's pending-attach queue — `claude --resume` appends to the existing `<uuid>.jsonl`, so no `new-session` event ever fires. The broker gained an optional `args` field on `CREATE` (`broker/internal/proto`) threaded through `Manager.Create` → `newSession` → `exec.Command(claude, args...)`; the host passes `["--resume", "<uuid>"]`.

**Open (residual):**
- **Auto-title (`ai_title`).** The column + ingest hook (`type: 'ai-title'`) exist but nothing populates them yet — the display title currently falls back to the first user message. An LLM-generated short description is the intended occupant; open questions: which model, when (on first surface? on significant `last_active_at` advance?), and how much transcript to feed it. This is the natural consumer of the future meta-observability LLM-parsing layer (see *Permission-request log*).
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

**Decisions made:**
- **Drop target**: anywhere on the window. The file is routed to whichever container is currently selected in the sidebar. If no container is selected, the drop is rejected with a hint ("select a container first").
- **Save location**: `<workspaceRoot>/_dropped/` for the selected container. Filename collisions resolved by suffix (`foo.png`, `foo-2.png`, `foo-3.png`). Inside the container the agent reads from `/workspace/_dropped/<name>`.
- **Post-save behavior**: toast confirmation showing the saved path, plus the path is copied to the system clipboard (via `clipboard.writeText`). User pastes it into their prompt manually — no auto-typing into the PTY.
- **Sources accepted**:
  - **OS file drag** — drop from Explorer/Finder/Nautilus. Renderer reads the path via `webUtils.getPathForFile(file)`; main copies from source to destination.
  - **Clipboard paste** (Cmd/Ctrl+V) anywhere on the window — image bytes from the clipboard saved as `paste-<ISO-timestamp>.<ext>` (extension derived from clipboard format).
  - **Web drag** — content dragged out of a browser. If a URL, the main process fetches it and writes the body; if inline bytes, written directly. Filename derived from the source URL or Content-Disposition; falls back to `web-<ISO-timestamp>.<ext>`.
  - **Text / HTML drag** — selected text dragged in. Written as `dropped-<ISO-timestamp>.txt` (plain text) or `.html` (when the drag carries HTML).

**IPC surface (sketch):**
- `files:dropOsFiles(containerId, sourcePaths: string[])` → `string[]` (saved paths)
- `files:dropBytes(containerId, payload: { suggestedName, mime, bytes })` → `string`
- `files:dropUrl(containerId, url: string)` → `string`
- `files:dropText(containerId, payload: { mime: 'text/plain' | 'text/html', text: string })` → `string`

**Open:**
- **Max file size / total dropbox size.** A single drop could fill the host disk. Cap per file (e.g., 100 MB) and per container dropbox (e.g., 1 GB) with eviction or rejection on overflow.
- **MIME / format detection.** For clipboard and web sources where filename isn't given, sniff bytes (magic numbers) before falling back to the clipboard-format extension. Decide whether unknown formats are saved with no extension or rejected.
- **Web-drag CORS / large downloads.** Need a timeout, a progress indicator if the fetch takes more than a beat, and a sensible error if the URL is unreachable from the main process.
- **`.gitignore` interaction.** `_dropped/` should be added to the runner image's default `.gitignore` (or the spec should require users to add it). Otherwise drops get committed by accident.
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

> **STATUS: BLOCKED — no usable data source (researched 2026-06-15).** The original design below assumes the structured prompts are observable from the JSONL transcript (or a hook). Live testing against the real runner image disproved every capture path:
> - **Generic permission prompts (Bash/Edit/… `ask`):** not in the JSONL at all — a gated tool just emits `tool_use`→`tool_result`, and the interactive allow/deny prompt leaves no transcript event. And they don't even occur in claude-fleet: claude **auto-allows** tools (debug log: `tool_dispatch … permissionDecisionMs=5`, no prompt shown).
> - **`Notification`-hook capture** (the cleanest path to permission/idle/elicitation events): a hook provisioned into the container's `~/.claude/settings.json` **never loads** — claude's own `--debug` reports `Found 0 total hooks in registry`, even with the `matcher` field. It appears gated behind a hook-approval/trust step with no documented way to pre-seed non-interactively in a container (same shape as the managed-settings gate).
> - **`AskUserQuestion` / `ExitPlanMode`:** claude renders the selection UI in the **TUI but does not write the `tool_use` to the JSONL while the prompt is pending** (verified live: question box on screen, zero tool_use rows in the transcript). They have never appeared as `tool_use` in any real transcript. (A query over these shipped in #77 and was **reverted** once this was confirmed — its e2e only passed against synthesized rows claude doesn't actually produce.)
>
> **Net:** the "Claude is waiting on the user" signal lives only in the interactive PTY/TUI, not in the JSONL or a loadable hook. A true needs-input affordance is **blocked** pending either claude-side support (a transcript event or a usable hook) or fragile PTY-body parsing of the prompt box.
>
> **Decision (2026-06-16): shelved indefinitely.** We are not pursuing fragile PTY-body parsing. The feature is parked until a **meta-observability** capability exists — a layer that watches the model's responses/terminal stream and hands them to a separate LLM for parsing/classification (e.g. "is this turn waiting on the user, and what is it asking?"). That LLM-parsing substrate is the prerequisite; the permission-request log and the richer `needs-input` tab state both depend on it and should not be revisited before it lands. No further work on #11 until then.
>
> **Shipped instead (#79):** a **busy/idle** chip indicator derived from claude's terminal-title glyph in the PTY stream (braille spinner = busy, `✳` = idle) — see §5 *Top row*. That's the one "is claude working vs waiting" signal reliably present; it's busy/idle, not needs-input-specific.

**Decisions made (original design — superseded by the BLOCKED note above):**
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
Read-only MCP server exposed by claude-fleet that lets the agent inside each container query the application's state DB (sessions, cost, events, prompts).

**Decisions made:**
- **Mechanism**: MCP server. Idiomatic for Claude Code, which supports MCP natively. The agent gets typed tools instead of having to learn raw SQL by default.
- **Access pattern**: strictly read-only. No mutation tools. The DB is owned by the desktop app; the agent has no business modifying its own cost data, session metadata, or prompt log.
- **Tool surface**: typed tools cover common cases; a raw `query(sql)` tool covers the rest. Read-only at the DB connection layer makes the escape hatch safe.
- **Connection**: HTTP over a Unix socket bind-mounted into each container. No network exposure; auth is implicit via filesystem permissions; survives Docker network changes.

**Implementation:**
The main process opens the SQLite file in read-write mode for its own writers (observability watcher, sessions reconciler, prompt-log writer). The MCP server uses a separate connection opened in read-only mode (via the SQLite URI form `file:state.db?mode=ro`). The server listens on `<app-data>/mcp.sock` on the host. Each container's create spec adds a bind-mount of this socket to `/fleet/mcp.sock` inside the container.

**Tool surface (sketch):**
- `list_sessions({ container?, since?, until?, limit? })` → rows from `sessions`
- `get_session({ id })` → one row with all metadata
- `get_cost({ session_id })` → row from `cost`
- `list_prompts({ container?, session_id?, kind?, since?, limit? })` → rows from `prompts`
- `list_events({ session_id, type?, since?, limit? })` → rows from `events`
- `query({ sql })` → arbitrary read-only SQL; rejected at the connection layer if the statement is a write

**Open:**
- **MCP config delivery to the container.** Options: bake `.mcp.json` into the runner image at `/etc/claude/mcp.json` (or similar), write `.mcp.json` into the bind-mounted workspace at container-create time, or pass `--mcp-config` to `claude` when launching it. Choice affects whether per-container customization is possible.
- **Schema documentation.** Typed-tool descriptions usually suffice; raw-SQL users may want the schema spelled out. Decide whether to ship a CLAUDE.md fragment with the schema, embed it in the `query` tool's description, or both.
- **Cross-container visibility.** Today the schema doesn't restrict by container at the DB level — a `sessions` row from container A is visible to the agent in container B. Matches the goal that sessions are global, but explicitly decide whether the MCP server should optionally scope to "this container's data only" by stamping each connection with its container ID at the time the socket is opened.
- **Runaway-query protection.** Even read-only queries can be expensive. Decide on per-query statement timeout, row-count cap, or both.

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
- **Unit / integration**: Vitest. Test files live next to source as `*.test.ts` (Vitest's default pickup pattern). Run via `npm run test:unit`; the `npm test` umbrella runs unit before E2E. Test files **must not** import modules that pull in native bindings (`better-sqlite3`, `keytar`) — those are built for Electron's Node ABI via `electron-builder install-app-deps` and crash under system Node. Keep unit tests against pure modules (e.g., `pricing.ts`); integration tests against `db.ts` would need an Electron-context runner and aren't worth the lift yet.
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
