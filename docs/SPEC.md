# claude-fleet — product spec

This document is the single source of truth for what claude-fleet is and how it's built. The bar is rebuild-from-spec: a competent engineer (or Claude) reading only this file should be able to rebuild a functionally equivalent application.

See [`.claude/rules/spec-maintenance.md`](../.claude/rules/spec-maintenance.md) for the rule that keeps this doc honest.

---

## 1. Overview

**claude-fleet** is a desktop application for driving a small fleet (3–6) of containerized Claude Code instances from a single window. The user picks a credential profile and a host workspace directory; the app spins up a Docker container running `claude` in a PTY, renders the live terminal with xterm.js, and surfaces structured observability (cost, tokens, tool calls, transcript history) sourced from the container's bind-mounted Claude transcript JSONL.

It is a local-only operator console — not a remote orchestrator, not a multi-user service, not a cloud product. Everything runs on the user's machine, against the user's local Docker daemon.

## 2. Goals

- Run multiple Claude Code sessions in parallel, each fully isolated in its own Docker container with its own workspace bind-mount.
- One window, one keyboard, one set of credentials — no juggling terminals or shells.
- Live terminal fidelity: cursor, colors, resize, paste, scrollback — all the things xterm.js gives you.
- Structured observability layered on top of the raw terminal: per-session cost, token counts, tool calls, transcript history — read from the Claude transcript JSONL that the CLI already writes, not by scraping the terminal stream.
- A global, container-filterable table of past Claude Code sessions with auto-generated short descriptions — selectable to resume any session in any container, regardless of which container originally ran it. Sessions persist across container deletion; the table is the durable record of past work.
- Drop OS files, pasted images, web content, or text fragments onto the window and have them saved into the selected container's workspace where the agent can read them. The window is the inbox; the path lands on the clipboard for the user to reference in their next prompt.
- Every terminal session writes a durable, append-only mirror of every event Claude Code emits to `<workspace>/_history/<session-id>.jsonl`. Claude's working transcript can be compacted at will; the mirror preserves the pre-compaction record. The mirror persists across pane switches, container restarts, and app exits — only an explicit "Close terminal" action prompts the user to keep or delete it (default: delete).
- An always-on, structured log of every prompt Claude makes to the user — permission requests, `AskUserQuestion` calls, and plan-mode approvals — captured to a SQLite table the UI can review. The point is to give the user a substrate for tuning `.claude/settings.json` permissions and CLAUDE.md guidance over time: read what Claude is repeatedly asking about, then decide what to allow, deny, or document.
- Claude inside each container can query the application's state DB (sessions, cost, prompts, events) through a read-only MCP server exposed by claude-fleet. The agent gets typed tools for common queries plus a raw read-only SQL escape hatch — enough to consult past sessions, summarize cost patterns, or audit what it's been asking the user about.
- Credentials never touch the renderer process or the host filesystem in plaintext. They live in the OS keychain and are injected into containers as environment variables by the main process.

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
│  - dockerode       │                         │  - xterm.js        │
│  - keytar          │   exposes window.api    │  - sidebar, panes  │
│  - better-sqlite3* │   via preload script    │  - profiles modal  │
│  - JSONL watcher*  │                         │                    │
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

## 6. IPC surface

All channels are `ipcMain.handle`/`ipcRenderer.invoke` (promise-based) except the PTY data stream, which uses one-way `webContents.send` from main to renderer.

### Docker
- `docker:ping` → `boolean` — is the daemon reachable.
- `docker:list` → `FleetContainer[]` — list managed containers (filtered by label).
- `docker:create(spec: CreateContainerSpec)` → `FleetContainer` — create + start a runner container.
- `docker:stop(id)` → `void` — stop with 5s grace; ignores 304 (already stopped) and 404.
- `docker:remove(id)` → `void` — force-remove; ignores 404.

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

## 7. Data model

### Container labels
Every managed container carries:
- `com.claude-fleet.managed` = `"true"` — discovery filter. `docker:list` filters on this label exclusively, so unmanaged containers never appear in the UI.
- `com.claude-fleet.subdir` — the subdirectory inside the bind-mounted workspace where `claude` runs.
- `com.claude-fleet.profile` — the vault profile name whose key was injected into this container.

### Container shape
- `Tty: true`, `OpenStdin: true`, `StdinOnce: false` — required for interactive `docker exec` later.
- `WorkingDir: /workspace/${subdir}` (or `/workspace` if subdir is empty).
- Bind: `${hostWorkspaceRoot}:/workspace:rw`. The runner does *not* own a private workspace; it shares the host's.
- Env: caller passes a `Record<string,string>`, typically `{ ANTHROPIC_API_KEY: <from vault> }`.
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

`Profile = { name: string; apiKey: string }`. The renderer only ever sees the `name`; the `apiKey` returned from `vault:get` is consumed by the main process when constructing the container env, *not* round-tripped through the UI.

## 8. User flows

### Startup
1. Main creates the window, registers IPC handlers.
2. Renderer mounts; on first render it calls `docker:ping`. If false, the header shows "Docker daemon unreachable — start Docker Desktop (with WSL2 integration)."
3. If reachable, renderer calls `docker:list` and polls every 5s thereafter to pick up state changes from outside the app.

### Create a container
1. User clicks **+ New container** in the sidebar.
2. UI collects: container name, host workspace root, subdir, profile name. *(Currently via sequential `window.prompt()` dialogs — see §11, this is a known UX gap.)*
3. Renderer calls `vault:get(profileName)`. If null, alert and abort.
4. Renderer calls `docker:create` with `env: { ANTHROPIC_API_KEY: profile.apiKey }`. Main creates and starts the container.
5. Sidebar refreshes; the new container appears.

### Attach a terminal
1. User selects a container in the sidebar.
2. `<TerminalPane>` mounts: creates an `xterm` `Terminal`, fits to its host div.
3. Calls `pty:attach(containerId, cols, rows)` → gets a `sessionId`.
4. Registers `onData` (writes chunks into xterm) and `onEnd` (writes `[session ended]`).
5. Forwards `term.onData` to `pty:input(sessionId, data)`.
6. A `ResizeObserver` re-fits and calls `pty:resize` on host div resize.
7. On unmount: unsubscribe listeners, `pty:detach`, dispose the terminal.

Each `pty:attach` runs `claude` fresh inside the container via `docker exec` — it is *not* the container's main process. The container's main process is `sleep infinity`, kept alive by `tini`.

### Manage profiles
1. User clicks **Profiles…** in the sidebar.
2. Modal lists names from `vault:list`. Add form takes `name` + `apiKey` (password input). Delete asks for confirmation.
3. All writes go to the OS keychain via the main process.

## 9. Security model

- **API keys never reach the renderer.** `vault:get` returns the key to the main process, which embeds it in the container's env. The renderer only ever holds profile *names*. (Exception: `ProfilesDialog` does receive the key the user just typed, in the brief moment between input and `vault:set` — there is no way around this.)
- **Renderer is isolated.** `contextIsolation: true`, `nodeIntegration: false`. No `require`, no `process`, no `fs` from renderer code.
- **`sandbox: false`** because preload uses `ipcRenderer`. The renderer itself still has no Node access.
- **Renderer cannot escape the IPC surface.** It can: list/create/stop/remove containers carrying the fleet label, list/get/set/delete profiles, attach/detach a PTY. It cannot: shell out, read arbitrary files, touch other Docker containers, hit the network with Node APIs.
- **Container isolation is Docker's.** No additional sandboxing layered on top. Containers run as non-root user `fleet` (UID 1000) and can write to the bind-mounted workspace as that user.
- **External link handling**: `setWindowOpenHandler` denies in-app navigation and opens external URLs via `shell.openExternal`.

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
    │   ├── ipc.ts                     # registerIpc() — all channels live here
    │   ├── docker.ts                  # dockerode wrapper + PTY attach
    │   └── vault.ts                   # keytar wrapper + name index
    ├── preload/
    │   └── index.ts                   # contextBridge.exposeInMainWorld('api', …)
    └── renderer/
        ├── index.html
        └── src/
            ├── main.tsx               # React root
            ├── App.tsx                # daemon-status header, sidebar + main pane
            ├── styles.css
            ├── types.d.ts             # declare global window.api
            └── components/
                ├── Sidebar.tsx
                ├── TerminalPane.tsx
                └── ProfilesDialog.tsx
```

## 11. Open decisions

These are decided in spirit but not yet implemented. When you implement one, move it out of this section and into the relevant body section above.

### Per-container Claude Code state visibility on the host
Both the observability layer and the sessions table need host-side access to each container's Claude Code state — primarily the session JSONLs at `~/.claude/projects/<sanitized-cwd>/<session-uuid>.jsonl`. The sanitized-cwd is just the absolute path with `/` replaced by `-` (e.g., `/workspace` → `-workspace`). Options:

- **Per-container host state dir, bind-mounted to `/home/fleet/.claude/`.** Each container gets its own host-side state dir (e.g., `<app-data>/state/<container-name>/.claude/`). Host has direct `fs.watch` access; settings and any persisted auth tokens survive container recreate as long as the state dir is reused. Currently the leading option.
- **Bind-mount only the `projects/<sanitized-cwd>/` subdir.** Narrower exposure. Settings would not persist across recreate, which complicates the OAuth question below.
- **No bind-mount; `docker cp` / `docker exec` on demand.** Cleanest container, but live watching requires polling or `inotifywait` inside the container. Likely too clunky for live observability.

Blocking for the two subsections that follow.

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
Every terminal session writes a durable, append-only mirror of every event Claude Code emits. The mirror persists indefinitely until the user explicitly closes the terminal — at which point a modal asks whether to delete or preserve it.

**Decisions made:**
- **Mirror behavior**: always written for every terminal session. There is no opt-in at session start; the watcher mirrors unconditionally. Cheap (just tailing the source JSONL), and the keep/delete choice can be made retroactively.
- **Location**: `<workspaceRoot>/_history/<session-id>.jsonl` on the host. Visible inside the container as `/workspace/_history/<session-id>.jsonl`.
- **Format**: raw JSONL — exact append-only mirror of the events Claude Code emits to its own transcript at `~/.claude/projects/<sanitized-cwd>/<session-id>.jsonl`. Pre-compaction events stay in the mirror even when the source JSONL is rewritten.
- **Cleanup trigger**: a deliberate "Close terminal" button in the pane header. Switching containers in the sidebar, closing the app, stopping the container, or `claude` exiting inside the PTY do **not** trigger cleanup — they leave the mirror on disk.
- **Cleanup confirmation**: clicking Close opens a modal asking "Delete the durable transcript mirror for this session?" with **Delete** as the default action. Choosing Delete removes the mirror file; choosing Preserve leaves it on disk.

**Implementation:**
The same JSONL watcher that drives observability mirrors every line to `_history/<session-id>.jsonl` as it sees it. The mirror is append-only at the application level — on source-file shrink (compaction), the watcher continues appending new events; it never truncates the mirror. Depends on the per-container `.claude/` host visibility question that blocks observability and the sessions table.

**IPC surface (sketch):**
- `pty:close(sessionId, opts: { deleteMirror: boolean })` — detaches the PTY and, if `deleteMirror` is true, removes the mirror file. Called when the user resolves the modal.
- `transcript:list(containerId)` → `string[]` (filenames in `<workspace>/_history/`).
- `transcript:delete(containerId, sessionId)` → manual cleanup of an orphaned mirror, callable from the sessions-table UI later.

**Open:**
- **UI placement of the Close button.** Pane header is the natural location (near the container name/status). Decide between a labeled "Close" button and an X icon.
- **Orphaned mirrors.** App crash, host reboot, container restart, or simply never clicking Close leave the mirror on disk indefinitely. The sessions-table UI should surface these with a "Delete mirror" affordance so they can be cleaned up later.
- **Resumed sessions.** `claude --resume <id>` reuses a session UUID (unless `--fork-session` is set). On resume the watcher appends new events to the existing `_history/<id>.jsonl`; the Close-time modal at the end of the resumed session decides the file's fate as a whole.
- **Race on compaction.** Line-based tailing with `fs.watch` rename/change events triggering re-reads of tail, never truncates of the mirror. Test against forced `/compact`.
- **Indication in the sessions table.** Whether the sessions table should surface a "mirror exists" flag and the file size, so disk usage is visible at a glance.

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

### Create-container UX
The current flow is three sequential `window.prompt()` dialogs. Functional but crude. Needs a real modal form with: name, workspace root (with a directory picker — `dialog.showOpenDialog` from main), subdir, profile dropdown (populated from `vault:list`), and optional CPU/memory caps.

### Profile-to-container binding
Right now the profile name is stamped on the container as a label and the API key is baked into env at create time. If the user rotates the key in the vault, existing containers keep the old one until recreated. We may want a "rotate" action that recreates the container with the new key; we may not. Open.

### Runner image build
The README tells the user to `docker build -t claude-fleet/runner:latest docker/` manually. Should the app build the image itself if missing? If so, that's another IPC channel (`docker:ensureImage`) and a UX consideration (build progress in the UI). Open.

### How `claude` authenticates inside the container
Today: `ANTHROPIC_API_KEY` env var. Claude Code also supports OAuth via `claude login`. The container is fresh on each create, so there's no persistent `~/.claude/` unless we bind-mount one. If we want OAuth, we need a per-profile bind-mount for `~/.claude/` and a way to do the initial login. Out of scope for v1; revisit if users ask.
