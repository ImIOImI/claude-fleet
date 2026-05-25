# claude-fleet — product spec

This document is the single source of truth for what claude-fleet is and how it's built. The bar is rebuild-from-spec: a competent engineer (or Claude) reading only this file should be able to rebuild a functionally equivalent application.

See [`.claude/rules/spec-maintenance.md`](../.claude/rules/spec-maintenance.md) for the rule that keeps this doc honest.

---

## 1. Overview

**claude-fleet** is a desktop application for driving a small fleet (3–6) of Claude Code **workspaces** from a single window. The user picks a credential profile and a host workspace directory; the app spins up a workspace (today: a Docker container backed by `dockerode`) running `claude` in a PTY, renders the live terminal with xterm.js, and surfaces structured observability (cost, tokens, tool calls, transcript history) sourced from the workspace's bind-mounted Claude transcript JSONL.

It is a local-only operator console — not a remote orchestrator, not a multi-user service, not a cloud product. Everything runs on the user's machine, against the user's local Docker daemon.

**Terminology.** "Workspace" is the user-level concept the UI talks about: a named place where a Claude session runs against a directory. It's persisted on disk as a manifest at `<userData>/state/<name>/workspace.json` independent of any backend's lifecycle, so workspaces survive container deletion and can be restarted. "Container" in this doc refers specifically to the Docker container that today is the only implemented workspace backend. A local-host (non-container) backend is anticipated but not yet built.

## 2. Goals

- Run multiple Claude Code sessions in parallel, each fully isolated in its own workspace with its own host-directory bind-mount.
- One window, one keyboard, one set of credentials — no juggling terminals or shells.
- Workspaces persist across backend lifecycle. A workspace identified by name has a host-side manifest at `<userData>/state/<name>/workspace.json` that survives container deletion. The new-workspace modal surfaces a "past workspaces" list (running / stopped / deleted) one click away from restart — restart starts the existing container if present, or recreates from the saved spec if the container is gone.
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
| Local DB | `better-sqlite3` | Synchronous SQLite for the history/cost layer. Single-file, embedded, no daemon. *(Planned — see §11 Open decisions.)* |

The runner image is `claude-fleet/runner:latest`, built from `docker/Dockerfile`. Base: `node:22-bookworm-slim`. Installs `git`, `ca-certificates`, `curl`, `ripgrep`, `jq`, `less`, `tini`, and globally installs `@anthropic-ai/claude-code`. Runs as non-root user `fleet` (UID/GID 1000 by default). Entrypoint is `tini`; default `CMD` is `sleep infinity` so the container stays alive and is `exec`'d into for each terminal session.

## 5. Architecture

Three processes, per Electron convention:

```
┌────────────────────┐   IPC (contextBridge)   ┌────────────────────┐
│  Main (Node)       │ ◄─────────────────────► │  Renderer (React)  │
│  - dockerode       │                         │  Layout:           │
│  - keytar (lazy)   │   exposes window.api    │   ┌─ top strip ─┐  │
│  - clipboard       │   via preload script    │   ├──┬───────┬──┤  │
│  - native Menu     │                         │   │S │ term  │ O│  │
│  - better-sqlite3* │                         │   ├──┴───────┴──┤  │
│  - JSONL watcher*  │                         │   └─ bottom bar ┘  │
└─────────┬──────────┘                         └────────────────────┘
          │
          │  Docker socket
          ▼
┌────────────────────┐
│  Docker daemon     │
│  ┌──────────────┐  │
│  │ runner ct 1  │  │   bind: hostWorkspace → /workspace
│  │ ┌──────────┐ │  │   exec: `claude` (TTY)
│  │ │ claude   │ │  │
│  │ └──────────┘ │  │
│  └──────────────┘  │
│  ┌──────────────┐  │
│  │ runner ct 2  │  │ ...
│  └──────────────┘  │
└────────────────────┘
```

\* planned, see §11.

**Main process** owns everything privileged:
- Docker daemon access via `dockerode` (default socket).
- OS keychain access via `keytar`.
- PTY session lifecycle: holds the duplex stream handle for each active `docker exec`, forwards data to the renderer over per-session IPC channels, forwards renderer input back to the stream, forwards resize events to Docker.
- (Planned) JSONL transcript watching + SQLite persistence.

**Preload** is a tightly scoped bridge. It uses `contextBridge.exposeInMainWorld('api', …)` to expose a typed `window.api` to the renderer. Window options: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: false` (sandbox is off because the preload needs `ipcRenderer`).

**Renderer** is pure React. It has zero Node access. It can only do what `window.api` lets it do. Everything privileged flows through IPC.

The renderer layout is a 3-row × 3-col shell:
- **Top row** (`WorkspaceTabStrip`): app name, workspace chips (each with a deterministic hue ring + status dot), `+ New workspace`, daemon status pill, `MOCK MODE` chip when active, `Profiles…`. Only live workspaces (running/stopped) appear here; deleted workspaces are surfaced in the new-workspace modal's past list.
- **Body row** (3 columns):
  - **Sessions pane** (left, ~280px): placeholder until #3 lands the JSONL-backed sessions table.
  - **Main pane** (center, fluid): header with selected workspace's name/status and `Close…` button, plus the xterm `TerminalPane` (or empty/first-run/disconnected states).
  - **Observability pane** (right, ~320px): placeholder until #2 lands the cost/token/event watcher.
- **Bottom row** (`BottomBar`): static hint bar with key bindings and degraded-vault notice when applicable.

Modals (`CreateWorkspaceModal`, `CloseWorkspaceModal`, `ProfilesDialog`) are owned by `App` and rendered above the shell.

## 6. IPC surface

All channels are `ipcMain.handle`/`ipcRenderer.invoke` (promise-based) except the PTY data stream, which uses one-way `webContents.send` from main to renderer.

### Workspace
- `workspace:ping` → `boolean` — is the backend reachable (for the Docker backend, is the daemon up).
- `workspace:list` → `Workspace[]` — merged list of live (running/stopped) workspaces plus deleted workspaces (those with a manifest on disk but no live container).
- `workspace:create(input: CreateWorkspaceInput)` → `Workspace` — create + start a runner workspace AND write its manifest to `<userData>/state/<name>/workspace.json`.
- `workspace:start(name)` → `Workspace | null` — start an existing (live, possibly stopped or paused) workspace by name. Paused containers are `unpause`d; stopped containers are `start`ed. Returns null if no live container has that name (caller should recreate from manifest via the create flow).
- `workspace:getManifest(name)` → `WorkspaceSpec | null` — read the persisted manifest.
- `workspace:stop(id)` → `void` — stop with 5s grace; ignores 304/404.
- `workspace:pause(id)` → `void` — `docker pause` (cgroups freezer). Idempotent: 409 (already paused) and 404 (container gone) are treated as no-ops.
- `workspace:remove(id, opts?: { deleteState? })` → `void` — force-remove; if `deleteState`, also `rm -rf <userData>/state/<name>` (which removes the manifest too, so the workspace disappears from the past list).
- `workspace:ensureImage(channelId)` → progress over `workspace:ensureImage:progress:${channelId}`, resolves when the runner image is locally present (no-op if it already is; otherwise pulls from GHCR).

### Images
- `images:list` → `ImageEntry[]` — every image known to the library, including labels.
- `images:remove(ref)` → `void` — remove an image entry. The image itself is not deleted from the Docker daemon; only the library entry goes away.

### Sessions
Per-workspace terminal-session inventory (the tab list shown above the terminal body). Renderer-owned read/write of the whole file; main has no notion of session lifecycle today.
- `sessions:read(workspaceName)` → `SessionInventory` — read `<userData>/state/<name>/sessions.json`. Returns an empty inventory (`{ version: 1, sessions: [], nextNum: 2 }`) if the file is missing or malformed.
- `sessions:write(workspaceName, inventory)` → `void` — atomic write of the whole inventory.

### Vault
- `vault:list` → `string[]` — profile names.
- `vault:get(name)` → `Profile | null` — `{ name, apiKey }`.
- `vault:set(profile)` → `void` — upsert; also updates the name index.
- `vault:delete(name)` → `void` — delete + remove from index.

### PTY
- `pty:attach(containerId, cols, rows)` → `sessionId: string` — opens a `docker exec` running `claude` with TTY; main retains the stream handle, returns an opaque session id.
- `pty:input(sessionId, data: string)` → `void` — write user input to the stream.
- `pty:resize(sessionId, cols, rows)` → `void` — forward window resize to Docker.
- `pty:detach(sessionId)` → `void` — destroy the stream, drop the session.

Per-session events from main to renderer:
- `pty:data:${sessionId}` — `Buffer` chunks from the container's stdout/stderr.
- `pty:end:${sessionId}` — stream ended.
- `pty:error:${sessionId}` — stream error (stringified).

The renderer's `window.api.pty.onData/onEnd` register listeners and return unsubscribe functions.

### Clipboard + context menu
The renderer cannot use `navigator.clipboard` reliably (focus/permission gotchas in Electron, and the renderer is contextIsolated). All clipboard access goes through main:
- `clipboard:write(text)` → `void` — `electron.clipboard.writeText` (no-op on empty).
- `clipboard:read()` → `string` — `electron.clipboard.readText`.
- `menu:showTerminalContextMenu({ hasSelection })` → `'copy' | 'paste' | 'selectAll' | null` — builds a native `Menu`, popups it on the focused window, resolves with the chosen action or `null` on dismiss. Copy item is disabled when `hasSelection` is false.

## 7. Data model

### Workspace manifest (on disk)
For each workspace, `<userData>/state/<name>/workspace.json` records the persistent spec:

```ts
type WorkspaceKind = 'container' | 'local';

interface WorkspaceSpec {
  name: string;
  workspaceRoot: string;   // host path bind-mounted into the workspace
  workspaceSubdir: string; // subdirectory the agent works in
  profile: string;         // vault profile name, or 'oauth'
  kind: WorkspaceKind;     // 'container' today; 'local' is selectable in UI, not yet wired
  image?: string;          // image ref for kind='container'; undefined for 'local'
  createdAt: number;
  lastUsedAt: number;
}
```

The manifest is written on `workspace:create` and updated on successful `workspace:start`. The API key is NOT persisted; only the `profile` name is, which is resolved against the keychain at start time. `workspace:remove(_, { deleteState: true })` removes the state dir (and thus the manifest), so the workspace disappears from the past list.

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
For each workspace, `<userData>/state/<name>/sessions.json` records the renderer's per-workspace tab list. Loaded by `TerminalPane` on mount, persisted on every change (add tab, close tab, switch active). PTYs themselves are not persisted — only the display ids, names, and which tab was active. On relaunch the renderer recreates the tabs and each `TerminalSession` opens a fresh `docker exec claude` per its tab. In-memory context (anything Claude held in process memory) is not yet preserved across app restarts; the in-container broker that fixes this is a deferred follow-up (see §11 Open decisions).

```ts
interface SessionEntry {
  id: string;        // stable display id; NOT the PTY session id (that's per-attach)
  name: string;      // 'main', 'session 2', 'session 3', …
  createdAt: number;
}

interface SessionInventory {
  version: 1;
  sessions: SessionEntry[];
  nextNum: number;   // auto-increment for 'session N' naming; doesn't decrement on close
  activeId?: string; // tab to focus on attach
}
```

Writes are atomic (write-to-temp + rename). Reads tolerate missing/malformed files by returning `{ version: 1, sessions: [], nextNum: 2 }`. The first attach to a fresh workspace inserts a single `main` tab and persists it immediately.

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
Today the only workspace backend is a Docker container. Each managed container carries:
- `com.claude-fleet.managed` = `"true"` — discovery filter. `dockerode listContainers` filters on this label exclusively, so unmanaged containers never appear in the UI.
- `com.claude-fleet.workspace-root` — the host workspace root, stamped so `listLiveWorkspaces` can return it without a manifest read.
- `com.claude-fleet.subdir` — the subdirectory the agent works in.
- `com.claude-fleet.profile` — the vault profile name whose key was injected (or `"oauth"`).

### Docker container shape
- `Tty: true`, `OpenStdin: true`, `StdinOnce: false` — required for interactive `docker exec` later.
- `WorkingDir: /workspace/${subdir}` (or `/workspace` if subdir is empty).
- Binds: `${workspaceRoot}:/workspace:rw` (the user's host dir) and `<userData>/state/<name>/.claude:/home/fleet/.claude:rw` (per-workspace persistent Claude state).
- Env: caller passes a `Record<string,string>`, typically `{ ANTHROPIC_API_KEY: <from vault> }` for API-key mode or `{}` for OAuth mode. `HOME=/home/fleet` is also set so tooling finds the bind-mounted `.claude/`.
- `User: <hostUid>:<hostGid>` so bind-mounted files are owned by the host user.
- Optional resource limits: `cpus` (→ `NanoCpus`), `memoryMb` (→ `Memory`).
- `AutoRemove: false` — containers persist across restarts unless explicitly removed.

### Vault layout
`keytar` stores per-profile credentials under:
- `service`: `claude-fleet` (constant)
- `account`: the profile name
- `password`: the API key

Plus one index entry:
- `service`: `claude-fleet`, `account`: `__profiles__`, `password`: JSON array of profile names.

The index exists because `keytar` has no list operation. It is maintained on every `setProfile`/`deleteProfile`.

`Profile = { name: string; apiKey: string }`. The renderer only ever sees the `name`; the `apiKey` returned from `vault:get` is consumed by the main process when constructing the workspace env, *not* round-tripped through the UI.

## 8. User flows

### Startup
1. Main creates the window, registers IPC handlers.
2. Renderer mounts; on first render it calls `workspace:ping`. If false, the main pane shows "Docker daemon unreachable — start Docker Desktop (with WSL2 integration)."
3. If reachable, renderer calls `workspace:list` and polls every 5s thereafter to pick up state changes from outside the app. The list includes live workspaces (running/stopped) and deleted workspaces (manifest on disk, no container) — the renderer keys selection by an `id` that's the live containerId or `deleted:<name>` for the deleted ones.

### Create a workspace
1. User clicks **+ New workspace** in the top strip.
2. `<CreateWorkspaceModal>` opens. The top section is a "past workspaces" list pulled from `workspace:list` — sorted most-recently-used first, each row showing name, host path, state dot (running/stopped/deleted), and a relative timestamp.
3. Clicking a past workspace calls `handleRestart(workspace)`:
   - `workspace:start(name)` is tried first. If the container exists (live or stopped), it's started and selected.
   - If `workspace:start` returns null (no live container), the renderer falls through to the create flow using the saved manifest values (including the original `kind` and `image`) — resolving the API key from the vault when `profile !== 'oauth'`.
4. Otherwise the user fills the form. The first decision is **Type**: a radio between **Container** (default — isolated Docker runner) and **Local** (runs on this host, "coming soon" — submitting throws). For Container, an **Image** input appears next, defaulting to the most-recently-used library image (or the bundled runner if the library is empty). Below the input, the image library renders as a scrollable list with free-text filtering across the ref + every label key/value; clicking a row fills the input. The form then collects name (with pet-name placeholder), workspace root (with directory picker + last-used persistence), subdir, and profile name. **Create & start** submits.
5. Renderer calls `vault:get(profileName)` if a profile name was entered. If null, an error appears inline.
6. Renderer calls `workspace:ensureImage` (pulls the chosen image from its registry if needed), then `workspace:create` with `{ kind, image, env, … }`. Main creates the container, writes the manifest, records the image into the library (via `imageLibrary.recordImage` with labels from `docker inspect`), and returns the `Workspace`.
7. The top strip refreshes; the new workspace appears.

### Attach a terminal
1. User selects a workspace in the top strip (only live workspaces appear there).
2. `<TerminalPane>` mounts. It reads the workspace's persisted `sessions.json` via `sessions:read(workspaceName)`. If the inventory is non-empty the saved tabs are restored (including which one was active); otherwise a single auto-created `main` tab is inserted and persisted right away. The pane manages a tab strip above the terminal body and one `<TerminalSession>` per tab stacked in the body — only the active tab is `visibility: visible`, the rest stay mounted so their PTYs and scrollback are preserved across tab switches.
3. Each `<TerminalSession>` creates an `xterm` `Terminal`, fits to its host div, calls `pty:attach(containerId, cols, rows)` → gets a `sessionId`. It registers `onData` (writes chunks into xterm) and `onEnd` (shows the session-ended overlay). `term.onData` forwards to `pty:input(sessionId, data)`. A `ResizeObserver` re-fits and calls `pty:resize` on host div resize.
4. Clicking the **+** in the tab strip creates a new session. The first session is named `main`; subsequent sessions are `session 2`, `session 3`, … via a counter that doesn't decrement on close (so names stay stable). Clicking a tab switches the active session. The **×** on a tab closes it; closing the last session auto-creates a fresh `main` so the strip is never empty. Every change is persisted to `sessions.json` immediately so a sudden quit doesn't lose tabs.
5. On unmount (workspace switch or app close): each `<TerminalSession>` unsubscribes listeners, calls `pty:detach`, disposes the terminal. The outer `<TerminalPane>` is keyed by `containerId` in App.tsx, so workspace switches force a clean remount — session state is re-read from `sessions.json`, not carried in renderer memory.

**Paused state.** When the selected workspace's state is `paused`, the terminal pane renders a modal card centered in the session-stack ("workspace paused" + Resume button) while the underlying `TerminalSession`s stay mounted but are dimmed (~40% opacity + greyscale + pointer-events disabled). The session tab strip and accent band stay live so the user can see which tabs exist and which workspace they're looking at. The chip in the workspace ribbon also shows a small ⏸ glyph and an amber status dot. The Resume button calls `workspace:start(name)`, which `docker unpause`s the container; the next `workspace:list` poll picks up the running state and the overlay disappears. Workspace-ribbon chips for other workspaces remain interactive so the user can switch to another workspace without resuming. **Caveat (PR1):** today the PTYs are bound to the docker-exec instances inside the (frozen) container, so they thaw correctly across a pause that happens *while the app is running*. Across an app restart the PTYs are re-spawned and any in-memory state Claude held is lost; the broker layer that preserves it is deferred (see §11).

Each `pty:attach` runs `claude` fresh inside the container via `docker exec` — it is *not* the container's main process. The container's main process is `sleep infinity`, kept alive by `tini`. Multiple sessions in the same workspace are independent `docker exec claude` processes side by side.

**Copy and paste**: the terminal pane has selection-aware key bindings. Ctrl+C copies when a selection exists and falls through as SIGINT when not; Ctrl+V pastes. Ctrl+Shift+C / Ctrl+Shift+V are unconditional copy / paste (terminal-convention alternates). Right-click opens a native context menu (Copy / Paste / Select All) via `menu:showTerminalContextMenu`. Clipboard reads and writes route through `clipboard:read` / `clipboard:write` in main, not `navigator.clipboard`. The terminal's `wordSeparator` is tuned to whitespace + brackets + quotes only, so double-clicking a URL selects the whole URL (URL-safe characters like `/`, `?`, `&`, `=`, `.`, `:` stay inside the word).

**Clickable links**: `term.registerLinkProvider` walks back to the first non-wrapped row, forward through `isWrapped` continuations, concatenates the rows, and matches URLs against the joined text — so a URL that soft-wraps across multiple rows is registered as a single link spanning all of them. Activation calls `window.open`, which `setWindowOpenHandler` routes through `shell.openExternal`.

### Manage profiles
1. User clicks **Profiles…** in the sidebar.
2. Modal lists names from `vault:list`. Add form takes `name` + `apiKey` (password input). Delete asks for confirmation.
3. All writes go to the OS keychain via the main process.

### Close a workspace
1. User selects a workspace, then clicks **Close…** in the main-pane header.
2. `<CloseWorkspaceModal>` opens, showing the workspace name and current status. A single checkbox — "Also delete the state directory" — is unchecked by default (Keep is the spec default; recreating with the same name inherits prior Claude state and keeps the workspace in the past list).
3. Action buttons depend on current state:
   - **Running**: `Stop only` (calls `workspace:stop` → state goes to `stopped`), `Pause` (calls `workspace:pause` → state goes to `paused`, processes frozen via cgroups, recoverable), and `Stop & remove` (calls `workspace:stop` then `workspace:remove(id, { deleteState })`).
   - **Paused**: `Resume` (calls `workspace:start` → unpauses), and `Stop & remove` (forces SIGKILL via `remove --force`, so pause state doesn't block removal).
   - **Exited / stopped**: only `Remove` (calls `workspace:remove(id, { deleteState })`).
4. On success, the modal closes, the selection clears, and the top strip refreshes. With `deleteState=false` the workspace transitions to "deleted" state (still in the past list, recoverable via restart). With `deleteState=true` it's fully purged. Failures surface inline in the modal.

## 9. Security model

- **API keys never reach the renderer.** `vault:get` returns the key to the main process, which embeds it in the container's env. The renderer only ever holds profile *names*. (Exception: `ProfilesDialog` does receive the key the user just typed, in the brief moment between input and `vault:set` — there is no way around this.)
- **Renderer is isolated.** `contextIsolation: true`, `nodeIntegration: false`. No `require`, no `process`, no `fs` from renderer code.
- **`sandbox: false`** because preload uses `ipcRenderer`. The renderer itself still has no Node access.
- **Renderer cannot escape the IPC surface.** It can: list/create/start/stop/remove workspaces carrying the fleet label, list/get/set/delete profiles, attach/detach a PTY. It cannot: shell out, read arbitrary files, touch other Docker containers, hit the network with Node APIs.
- **Workspace isolation is Docker's.** No additional sandboxing layered on top. Containers run as the host user's UID (via `User: '<uid>:<gid>'`) and can write to the bind-mounted host workspace as that user.
- **External link handling**: `setWindowOpenHandler` denies in-app navigation and opens external URLs via `shell.openExternal`.
- **Vault availability degradation**: the main process probes `keytar` once at startup (`vault:available`). When the OS keychain is unreachable (typically bare WSL with no Secret Service), the renderer hides the **Profiles…** button, the create-workspace flow accepts only OAuth or env-sourced API keys, and `getProfile` falls back to `ANTHROPIC_API_KEY` from the environment. A header banner surfaces the degraded state. The packaged Windows build hits Credential Manager via DPAPI and never enters this mode; this path exists for Linux dev environments without a keyring.

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
│   ├── Dockerfile                     # runner image
│   └── .dockerignore
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
    │   ├── docker.ts                  # Docker backend (dockerode wrapper + PTY attach)
    │   ├── mock.ts                    # mock backend behind CLAUDE_FLEET_MOCK=1
    │   ├── workspaces.ts              # WorkspaceSpec types + manifest read/write/list
    │   ├── sessions.ts                # per-workspace sessions.json read/write
    │   ├── imageLibrary.ts            # imageLibrary.json read/write + auto-record
    │   ├── paths.ts                   # state-dir path conventions
    │   ├── fs.ts                      # isDirectory / mkdirp helpers
    │   └── vault.ts                   # keytar wrapper + name index
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
                ├── ObservabilityPane.tsx  # right sidebar (placeholder until #2)
                ├── BottomBar.tsx          # footer hint bar
                ├── CreateWorkspaceModal.tsx  # form + past-workspaces list
                ├── CloseWorkspaceModal.tsx
                └── ProfilesDialog.tsx
```

## 11. Open decisions

These are decided in spirit but not yet implemented. When you implement one, move it out of this section and into the relevant body section above.

### Per-container Claude Code state visibility on the host
Each container gets its own host-side state dir, bind-mounted into the container at `/home/fleet/.claude/`. This is the foundation for the observability watcher, sessions table, durable mirror, and permission-request log — all of which read events from `<state-dir>/projects/-workspace/*.jsonl` directly off the host filesystem.

**Decisions made:**
- **Host layout**: `<userData>/state/<container-name>/.claude/`, where `<userData>` is Electron's `app.getPath('userData')` (`~/.config/claude-fleet/` on Linux). State dirs are keyed by container name — recreating a container with the same name reuses its prior state. Use a different name to start fresh.
- **Container layout**: the host state dir is bind-mounted at `/home/fleet/.claude/` read-write. The container's `WorkingDir` is `/workspace`, so Claude Code writes JSONLs to `~/.claude/projects/-workspace/<session-uuid>.jsonl` — the sanitized-cwd is deterministically `-workspace`.
- **UID/GID**: the container runs as the host user's UID/GID via `User: '<uid>:<gid>'` set at create time. `HOME=/home/fleet` is set in the env so tooling that consults `HOME` finds the bind-mounted `.claude/` even when the runtime UID has no `/etc/passwd` entry. This replaces the earlier idea of baking UIDs at image-build time — the published runner image now has a single fixed UID for the in-image `fleet` user, and the host's UID is supplied at container start.
- **Create-time behavior**: if `<userData>/state/<name>/.claude/` does not exist, the main process creates it (owned by the host user) before starting the container. If it exists, it's reused as-is.
- **Removal behavior**: when the user removes a container, a confirmation modal asks "Also delete this container's state dir?" with **Keep** as the default. Picking Delete recursively removes `<userData>/state/<name>/`. Picking Keep leaves the state intact so a future container with that name inherits it.

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
Per-session cost and token counts derived from Claude transcript JSONL events. Outstanding:
- **Watcher.** Main process watches each container's bind-mounted `.claude/projects/` (see above), tails new events into SQLite as they arrive.
- **Schema.** `events(session_id, ts, type, payload_json)` and `cost(session_id, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, usd)`. Cost is rolled up from per-event token usage; pricing table refreshed periodically.
- **IPC surface.** `observability:getCost(sessionId)`, `observability:streamEvents(sessionId)` for live tailing.
- **UI surface.** Probably a status row inside the sessions table plus a per-session detail pane. To be sketched.

### Sessions table
Global, container-filterable table of past Claude Code sessions, each resumable via `claude --resume <session-id>`.

**Decisions made:**
- **Storage**: SQLite index, JSONL stays the source of truth. SQLite is a cache that can be rebuilt from JSONLs.
- **Eligibility**: a session appears iff (a) its JSONL exists on disk and (b) the `cwd` recorded in its first event still exists on the host. Filter (b) hides sessions whose workspace was deleted — they can't be resumed cleanly.
- **Short description**: auto-generated by an LLM call from the transcript. Cached in `auto_description`. Optionally overridden by a user-set name (matching Claude Code's built-in `-n/--name` mechanism).
- **Scope**: stored globally (sessions are not bound to any particular container's lifetime); UI provides a container filter.

**SQLite schema (sketch):**
```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                  -- session UUID (= JSONL filename stem)
  cwd TEXT NOT NULL,                    -- workspace path from first JSONL event
  container_id TEXT,                    -- container that ran it; NULL once container is deleted
  container_name TEXT,                  -- last-known name, retained for display when container_id is NULL
  profile TEXT,                         -- vault profile used at session start
  started_at INTEGER NOT NULL,          -- first event timestamp (ms)
  last_active_at INTEGER NOT NULL,      -- last event timestamp (ms)
  first_user_message TEXT,              -- head of JSONL, fallback display when auto_description is absent
  auto_description TEXT,                -- LLM-generated
  user_set_name TEXT                    -- optional manual override
);
```

**Reconciliation.** On startup and on JSONL change events: new JSONLs → insert row; deleted JSONLs → drop row; modified → bump `last_active_at`.

**Resume flow.** User selects a row → main process locates the target container (or recreates it from the recorded profile/workspace if it's gone) → opens a new PTY and runs `claude --resume <id>` in the recorded `cwd`.

**Deletion.** UI-side "Delete session" prunes the SQLite row and removes the underlying JSONL (or shells out to `claude project purge` for whole-project deletion).

**Open**:
- Which model generates `auto_description`, and when (on session end? lazily on first display? on a schedule?). Likely cheap/fast model; one-shot generation when the session is first surfaced, regenerated only if `last_active_at` advances significantly.
- How much of the transcript to feed into the description prompt (full vs. truncated head+tail vs. tool-call summary).
- In-progress sessions: should the table show currently-active sessions, and if so how (live-updating row vs. only on session end)?

### Resumable sessions on workspace pause/resume — "expert workspaces"

The end-state goal: **expert workspaces** that load a domain context once (an organization's architecture, a particular application's source, a body of documentation) and then sleep with that context intact. The user pauses the workspace, closes the app, comes back hours or days later, unpauses, and finds every session right where it was — same conversation history, same in-memory analyses, same MCP server state — ready to do a quick task (review a PR, answer a question) and go back to sleep. Re-priming the context on every wake defeats the purpose.

This is a two-phase build. Phase 1 (the persistence + UI foundation) is landed; phase 2 (the in-container broker that actually preserves in-memory context across an app restart) is still ahead.

**Phase 1 — landed:**
- **Session inventory persistence.** Each workspace's tab list is stored at `<userData>/state/<name>/sessions.json`. Loaded on `TerminalPane` mount, written on every change. See §6 (Sessions IPC) and §7 (Session inventory).
- **Paused UI.** The workspace ribbon chip shows a paused dot + ⏸ glyph. The terminal pane overlays a modal card ("workspace paused / Resume") scoped to the session-stack — the underlying terminals stay mounted but dimmed and pointer-events-disabled. The workspace ribbon stays interactive so the user can switch workspaces without resuming. See §8 ("Attach a terminal" → Paused state).
- **Resume.** The modal's Resume button calls `workspace:start(name)`, which `docker unpause`s the container. The poll picks up the running state and the overlay disappears.

**Phase 2 — still open:**

The hole today: PTY stream handles live in main-process memory only. App restart loses them, and on next launch the renderer must spawn fresh `docker exec claude` per saved tab — which means the conversation reloads (the JSONL still exists) but everything Claude held in memory (computed analyses, file watches, MCP server state) is gone. Across a same-app-instance pause this is fine (the docker-exec processes themselves are frozen and thaw correctly). Across an app restart it's not.

The chosen fix: an **in-container broker daemon** that owns each `claude` PTY and exposes them over a Unix socket bind-mounted from the host. The Electron main attaches to that socket instead of running `docker exec claude` directly. The broker outlives any individual host connection — quit the app, restart, reconnect to the socket, get the same session bytes back. The runner image's existing `tini` PID 1 supervises both `sleep infinity` (today's container keepalive) and the broker.

Why not tmux/dtach: tmux is cheaper to ship but stacks two TUIs (xterm → tmux → claude) and tmux's prefix key + mouse handling collide with claude's. dtach has no scrollback. A small broker we own gives a clean byte-stream layer with no second TUI in the middle.

Why not resume-by-transcript only: the conversation comes back but cognition doesn't. Defeats the expert-workspace goal.

**Open (phase 2):**
- **Broker process model.** Single multiplexing daemon serving all sessions on one socket, or per-session daemons each on their own socket. Multiplexing is simpler to install (one binary in the image) but ties session lifecycles together if the broker crashes; per-session is more isolated but more processes.
- **Broker implementation language.** Node.js (already in the runner image, smaller diff to ship) vs. Go (smaller binary, no runtime, simpler dependency story). Tradeoffs are install-size vs. dev-iteration friction.
- **Wire protocol.** Length-prefixed binary frames with channel ids (multiplex multiple sessions over one socket); or a simple text command protocol (`ATTACH <id>` then raw bytes). Need to decide on resize semantics, signal forwarding (Ctrl-C, Ctrl-Z), and how to surface broker-internal errors to the host.
- **Scrollback / ring buffer.** Broker has to remember some bytes per session so reconnecting clients get more than "blank screen until next output." Ring buffer size per session — fixed (1 MB? 10 MB?) or configurable.
- **Clean-exit flush of sessions.json.** Add an `app:before-quit` hook to write any pending inventory changes (today's opportunistic per-change writes already mean the gap is small, but a final sweep is cheap insurance).
- **Container restart policy.** Survives app restart today; does not survive host reboot (`RestartPolicy` is unset). For the broker to outlive a host reboot, containers need `unless-stopped` and the broker must come back up on container start. Configurable per workspace, off by default.
- **Interaction with the durable transcript mirror.** Re-attach via broker keeps the same session UUID across long quiet periods (pause + relaunch). The mirror watcher must not treat a long quiet period as a session end.
- **Resource accounting.** `docker pause` doesn't release RAM; an expert workspace pins memory until the container is removed. Several heavy sessions × several expert workspaces can be substantial. Decide whether to surface per-workspace RAM usage in the chip / past-list and whether to warn when the total exceeds a threshold.
- **Pause depth.** "Deep sleep" (allow swap-out, slower wake) vs. "light sleep" (kept resident, instant wake). Out of scope for now; record once the broker work surfaces a need.

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
An append-only mirror of every event Claude Code emits for a terminal session. Whether the mirror is written at all, and whether it survives an explicit close, are per-profile defaults that can be overridden per-session.

**Decisions made:**
- **Two profile-level defaults**:
  - `mirrorDefault: 'on' | 'off'` — when `on`, the watcher mirrors the session unconditionally; when `off`, no mirror is written for sessions opened against this profile by default.
  - `cleanupDefault: 'delete' | 'preserve'` — the selected option when the close-time modal opens. The user can flip it before confirming.
  - **Factory values for new profiles**: `mirrorDefault = 'on'`, `cleanupDefault = 'delete'`. Out of the box mirrors are written, and they default to delete-on-close so they don't accumulate by accident.
- **Open-time override**: at terminal attach, the profile's `mirrorDefault` applies, but the user can override it for that single session. Override is locked in for the duration — flipping to `on` mid-session would silently miss early turns.
- **Location**: `<workspaceRoot>/_history/<session-id>.jsonl` on the host. Visible inside the container as `/workspace/_history/<session-id>.jsonl`.
- **Format**: raw JSONL — exact append-only mirror of the events Claude Code emits to its own transcript at `~/.claude/projects/<sanitized-cwd>/<session-id>.jsonl`. Pre-compaction events stay in the mirror even when the source JSONL is rewritten.
- **Cleanup trigger**: a deliberate "Close terminal" button in the pane header. Switching containers in the sidebar, closing the app, stopping the container, or `claude` exiting inside the PTY do **not** trigger cleanup — they leave the mirror on disk.
- **Cleanup confirmation**: clicking Close opens a modal asking "Delete the durable transcript mirror for this session?" with the profile's `cleanupDefault` pre-selected. The user can flip the selection before confirming. If the session was opened with mirroring disabled (no file exists), the modal is skipped.

**Implementation:**
The same JSONL watcher that drives observability mirrors every line to `_history/<session-id>.jsonl` for sessions whose effective mirror setting is `on`. The mirror is append-only at the application level — on source-file shrink (compaction), the watcher continues appending new events; it never truncates the mirror. Depends on the per-container `.claude/` host visibility question that blocks observability and the sessions table.

Profile shape extends to `Profile = { name, apiKey, mirrorDefault, cleanupDefault }`. The API key stays in keytar (secret); the two settings live in a new SQLite `profile_settings` table — same DB as observability, sessions, and prompts. `vault:get`/`vault:set` in the main process merge the two stores; the renderer continues to see one combined `Profile` object.

**SQLite schema (sketch):**
```sql
CREATE TABLE profile_settings (
  name TEXT PRIMARY KEY,
  mirror_default TEXT NOT NULL DEFAULT 'on',         -- 'on' | 'off'
  cleanup_default TEXT NOT NULL DEFAULT 'delete'     -- 'delete' | 'preserve'
);
```

**IPC surface (sketch):**
- `pty:attach(containerId, cols, rows, opts: { mirrorOverride?: 'on' | 'off' })` — when `mirrorOverride` is set, it overrides the profile default for this session only.
- `pty:close(sessionId, opts: { deleteMirror: boolean })` — detaches the PTY and applies the modal's outcome. Skipped (no `deleteMirror` decision needed) if the session was opened with mirroring `off`.
- `transcript:list(containerId)` → `string[]` (filenames in `<workspace>/_history/`).
- `transcript:delete(containerId, sessionId)` → manual cleanup of an orphaned mirror, callable from the sessions-table UI later.

**Open:**
- **UI placement of the open-time override.** TerminalPane currently auto-attaches on mount; the override needs a moment to be set before the PTY starts. Candidates: a pane-header toggle visible before attach plus a "Start session" button that delays auto-attach, a one-time confirmation dialog at attach, or a quick toggle in the sidebar's container row that takes effect at the next attach.
- **Profiles dialog UI.** The existing modal needs new controls for the two defaults; decide between labeled toggles, a small "Defaults" section, or an "Advanced" disclosure.
- **UI placement of the Close button.** Pane header, near the container name/status. Labeled "Close" or an X icon.
- **Orphaned mirrors.** App crash, host reboot, container restart, or simply never clicking Close leave the mirror on disk indefinitely. The sessions-table UI surfaces these with a "Delete mirror" affordance so they can be cleaned up later. (See issue #3.)
- **Resumed sessions.** `claude --resume <id>` reuses a session UUID (unless `--fork-session` is set). On resume the watcher appends new events to the existing `_history/<id>.jsonl`; the Close-time modal at the end of the resumed session decides the file's fate as a whole. The open-time override at resume applies to whether new events get appended — flipping from `on` to `off` on resume stops appending but does not delete prior content.
- **Race on compaction.** Line-based tailing with `fs.watch` rename/change events triggering re-reads of tail, never truncates of the mirror. Test against forced `/compact`.
- **Migration.** Existing keytar profiles created before this feature have no `profile_settings` row; on first read after upgrade, insert a row with factory defaults.

### Permission-request log
Always-on structured log of every prompt Claude makes to the user. Substrate for tuning `.claude/settings.json` permissions and CLAUDE.md guidance over time.

**Decisions made:**
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
- **E2E**: Playwright via its Electron integration (`_electron.launch`). Drives the packaged or dev-mode app from outside; can interact with menus, panes, modals, and assert on rendered state.
- **Unit / integration**: Vitest. Native to the Vite-based stack and what `electron-vite` recommends.
- **Scope at v1**: no upfront test plan. Tests get added as features land — each feature lands with at least smoke coverage of the new surface. Avoids the "set up the test infra in advance" anti-pattern when there's nothing to test yet.

**Deferred:**
- **MCP-based test harness.** A write-capable MCP server that test authors (or claude itself) could drive to exercise the app declaratively. Compelling for agent-authored test generation but premature given that no tests exist yet and standard tooling fits the immediate need. Revisit when there's a concrete pain point that Playwright + Vitest can't solve cleanly — most likely when "have claude write E2E tests for feature X" becomes a recurring workflow.

**Open:**
- **When to install Playwright/Vitest.** With the first feature that needs verification beyond manual.
- **CI integration.** GitHub Actions vs. local-only. Headless Electron in CI requires Xvfb (Linux) or equivalent.
- **Test fixtures.** Shared in-memory DB seed vs. per-test container/profile fixtures.

### App-level Settings surface
No Settings panel exists yet. The first concrete item that needs one is a toggle for hardware acceleration (issue #13) — Chromium's GPU process fails noisily on WSLg with `viz_main_impl.cc(166) ERROR: Exiting GPU process during initialization`. The fix in code is one line — `app.disableHardwareAcceleration()` before `app.whenReady()` — but it needs a UI control to flip without editing source.

**Open:**
- **Env-var escape hatch first, or full panel up front.** `CLAUDE_FLEET_DISABLE_HWA=1` would be a five-minute shortcut (and matches the dev-fallback pattern we already use for `ANTHROPIC_API_KEY`); a real Settings modal is more work but is the right end state.
- **Persistence.** SQLite alongside `profile_settings` is the natural home — same DB the watcher and the rest of the app already share. A JSON config file under `userData` is the alternative if we want the Settings to survive a DB wipe.
- **Likely future occupants** once the surface exists: log-verbosity, default `mirrorDefault`/`cleanupDefault` for new profiles, dev-shortcut indicators ("ANTHROPIC_API_KEY is sourced from env"), pull-progress UI preference, fast-mode toggle, etc.

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
Two modes, picked at create-container time:

- **API key**: profile carries an `apiKey`; container env includes `ANTHROPIC_API_KEY` at create time. Used when the user has a Console API key.
- **OAuth (Claude.ai Pro/Max)**: profile-name field is left blank in the create flow. No `ANTHROPIC_API_KEY` is injected; the first time `claude` runs in the terminal it prints a login code, the user completes the flow in their browser, and OAuth tokens are written to `<container-state>/.claude/.credentials.json` (host side, via the bind-mount from #1). Future sessions in this container — or in a recreated container with the same name — pick up the credentials automatically.

Claude Code's auth precedence puts `ANTHROPIC_API_KEY` ahead of OAuth tokens, which is why API-key and OAuth modes are mutually exclusive at the env-injection level: OAuth mode skips the env var entirely so the OAuth path is reached.

**Open** (none right now — both modes are wired up).
