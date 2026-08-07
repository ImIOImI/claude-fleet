# Local-workspace launcher — run claude in WSL (or via a custom command)

**Date:** 2026-08-05
**Status:** designed (not yet implemented)
**Builds on:** local-backend workspaces (#16), Windows claude resolution (`claudeResolve.ts`, v0.4.1), per-workspace MCP sockets (#117), JSONL watcher local roots (`registerLocalWorkspace`)

## Problem

A local workspace spawns the resolved `claude` binary directly via node-pty — no shell, host env inherited. On Troy's machine the app runs on native Windows, so local claude runs as a Windows process. His actual dev environment is WSL + zsh: PATH, dotfiles, tools, and projects all live in the WSL distro. There is no way to tell fleet *how* to invoke claude for a local workspace.

Wanted: a per-workspace choice of launcher — native (today's behavior), **WSL distro + login shell** (fully discovered/probed, no hand-typed commands), or a **free-form custom command** for exotic setups — with observability and the fleet-state MCP server still working when claude lives on the far side of the Windows↔WSL boundary.

## Decisions already made (this brainstorm)

1. **Approach:** extend the existing local backend with a `launcher` manifest field + a pure `localLauncher.ts` translation module. Not a new workspace kind (would duplicate ~80% of `local.ts`), not a template-string-only substrate (an opaque string can't support probing, path translation, watcher roots, or MCP wiring).
2. **Scope: everything in v1.** WSL sessions get full observability (polled watcher over `\\wsl.localhost\`) *and* fleet-state MCP (interop stdio bridge). No degraded v1.
3. **Working dirs live in the WSL filesystem** (e.g. `/home/troy/projects/foo`). Browse… opens the `\\wsl.localhost\<distro>\` share and translates back to a Linux path; typing a Linux path directly also works. `/mnt/c` projects are not a target (slow cross-OS IO), though nothing forbids typing one.
4. **Platform gating is runtime, not build-time.** WSL mode: win32 only — UI hidden, IPC rejects, manifest validator refuses `mode: 'wsl'` off-Windows. Custom mode: all platforms. No per-platform bundles; the launcher module is inert pure TS elsewhere.
5. **`-lic` (login + interactive) shell invocation** so `.zshrc` is sourced and the session env matches the user's real terminal.

## Design

### A. Data model (manifest)

New optional field on `WorkspaceSpec`, meaningful only for `kind: 'local'`; absent ⇒ `{ mode: 'native' }` (today's behavior, no migration needed):

```ts
launcher?:
  | { mode: 'native' }
  | { mode: 'wsl'; distro: string; shell: string;      // 'Ubuntu', '/usr/bin/zsh'
      home: string; claudePath: string }                // probed at save time, cached
  | { mode: 'custom'; command: string }                 // template with {args} / {claude}
```

- `home` / `claudePath` are **save-time probe caches** so attach and the watcher never re-probe WSL per use. Editing + re-saving the workspace re-probes. If an attach fails against the cache (distro reinstalled, claude moved), the error message says to re-save the workspace.
- The allowlist manifest parser in `workspaces.ts` validates the union strictly; `mode: 'wsl'` is rejected unless `process.platform === 'win32'`, so a hand-edited manifest can't activate it elsewhere.

### B. `localLauncher.ts` (new pure module)

Electron-free, IO-injected (same discipline as `claudeResolve.ts` / `localSessions.ts`). One function:

```
buildLaunch({ launcher, claudeArgs, cwd, env, ids }) → { file, args, cwd, env }
```

consumed by `local.ts:attachPty` in place of the direct `{ file: claudeBin, … }` today.

**native** — unchanged passthrough.

**wsl** — spawns:

```
wsl.exe -d <distro> --cd <linux-cwd> -- <shell> -lic '<cmd>'
```

- `<cmd>` = `echo $$ > /tmp/claude-fleet-<workspaceId>-<sessionId>.pid; exec <claudePath> <flags…>` with every fleet flag (`--mcp-config`, `--resume`) POSIX-single-quoted. `exec` makes claude replace the shell ⇒ the pidfile holds claude's real Linux pid.
- **Env:** workspace env vars cross via `WSLENV` (`KEY1/u:KEY2/u:…` appended to any existing `WSLENV`, values set on the Windows-side spawn env). No values are embedded in the command string, so no quoting hazards and nothing leaks into `wsl.exe`'s argv.
- **Pause/resume (works, unlike native-Windows local):** `pauseWorkspace` / `startWorkspace` branch on launcher mode: `wsl.exe -d <distro> -- kill -STOP $(cat <pidfile>)` / `kill -CONT …` instead of the POSIX `pty.kill(signal)` path. `stopWorkspace` kills the pty **and** best-effort `wsl.exe -d <distro> -- kill $(cat <pidfile>)` — conpty teardown alone is not guaranteed to reap the Linux-side process. Pidfiles live in the distro's `/tmp`, so they vanish on WSL restart; stale-pidfile signals are harmless no-ops.
- **Path translation** helpers (pure, unit-tested): `\\wsl.localhost\<distro>\home\troy\x` ↔ `/home/troy/x` (accept legacy `\\wsl$\` too).
- **claude resolution inside the distro:** reuse `resolveClaudeBin()` verbatim, injecting an `execFile` that prefixes `wsl.exe -d <distro> --`; the POSIX chain (`command -v` → well-known dirs → login shell) applies unchanged. `CLAUDE_FLEET_LOCAL_CLAUDE_BIN` continues to mean the *host* binary and does not apply to wsl mode.

**custom** — the template gets `{args}` (fleet's pre-quoted flags) and optional `{claude}` (host-resolved binary path) substituted, then runs via the platform shell: `cmd.exe /d /s /c <string>` on win32, `sh -c <string>` elsewhere. A template without `{args}` gets the flags appended, and the form warns (resume/MCP depend on them). Fleet treats the environment as opaque: transcripts are assumed at the host `~/.claude` (true for wrappers that stay on the host); a wrapper that relocates claude degrades observability — stated in the field's help text.

### C. Fleet-state MCP across the boundary (wsl mode)

No TCP, no firewall surface. WSL's **Windows-interop** lets a Linux process exec a Windows `.exe` with stdin/stdout piped across the boundary — exactly MCP stdio transport. The session-scoped `mcp-config.json` for a WSL workspace becomes:

```json
{ "command": "/mnt/c/…/claude-fleet.exe",
  "args": ["<windows path to bridge script>", "<windows socket path>"],
  "env": { "ELECTRON_RUN_AS_NODE": "1" } }
```

- `command` is `process.execPath` translated to its WSL (`/mnt/c/…`) form so the distro can exec it; `args` stay Windows paths because the bridge runs as a Windows process and dials the same per-workspace listener as today. **Caller identity is untouched** — it derives from which listener accepted, nothing on the wire.
- The config file is written under the workspace state dir as today; the `--mcp-config` flag passes its `/mnt/c/…` translation since claude reads it inside the distro.
- If interop is disabled (`wsl.conf [interop] enabled=false` — detected at probe time), MCP wiring is skipped for that workspace and the form shows a note; same graceful degradation as today's missing-socket case.
- The security caveat from SPEC §9 carries over unchanged: local workspaces (WSL included) have host-equivalent reach, so their MCP identity is not unspoofable and `assertControl` keeps refusing them for committee control.

### D. Observability (transcripts → SQLite)

Claude in WSL writes `~/.claude/projects/<encoded-linux-cwd>/<uuid>.jsonl` inside the distro's filesystem. The watcher already supports per-workspace local roots (`registerLocalWorkspace`); a WSL workspace registers

```
\\wsl.localhost\<distro>\<home-without-leading-slash>\.claude\projects\<encoded-cwd>\
```

built from the cached `home`. inotify events do not propagate over the 9P share, so WSL roots go into a **second chokidar instance with `usePolling: true`** (~1.5 s interval); native roots keep event-driven watching. Everything downstream (offsets, uuid dedup, cost rollup, `session_summary`) is untouched.

### E. Discovery + probing (new IPC, win32-only)

- `local:listWslDistros` → `{ distros: string[], defaultDistro: string | null }`. Runs `wsl.exe --list --quiet` (+ `--verbose` for the default). **stdout is UTF-16LE** — decoded explicitly. Utility distros (`docker-desktop*`, `rancher-desktop*`) filtered. `wsl.exe` missing/erroring ⇒ `{ distros: [] }` and the renderer hides the WSL option.
- `local:probeWslDistro(distro)` → `{ shells, loginShell, home, claudePath, interopEnabled }`:
  - login shell: `wsl.exe -d <d> -- sh -c 'getent passwd "$(id -un)" | cut -d: -f7'`
  - shell choices: `/etc/shells`, filtered to paths that exist in the distro
  - `home`: `sh -c 'echo "$HOME"'`
  - `claudePath`: `resolveClaudeBin` through the wsl-prefixed execFile
  - `interopEnabled`: attempt `/init`-mediated exec of a trivial Windows binary (`cmd.exe /c exit 0`); failure ⇒ false
- Both handlers reject on non-win32. Parsing lives in a pure `wslProbe.ts` with injected exec (UTF-16 decode, list/`getent`/`/etc/shells` parsing all unit-tested on Linux CI).

### F. UI (WorkspaceForm, local kind only)

"**Run claude in**" section:

- *This computer* (default) | *WSL distro* — the WSL radio renders only on win32 **and** when `listWslDistros` returned ≥1 distro.
- Picking WSL: distro dropdown (default distro pre-selected) → probe fires → shell dropdown (login shell pre-selected) + inline status: `✓ claude found at /home/troy/.local/bin/claude` or an actionable error ("claude not found in Ubuntu — install it there or pick another distro"); save disabled until the probe passes. Interop-off shows a non-blocking "fleet tools unavailable in this workspace" note.
- Working directory for WSL mode: text field takes a Linux path; Browse… opens the picker at `\\wsl.localhost\<distro>\` and the picked UNC path is translated back.
- *Custom launch command* lives under Advanced, all platforms, with `{args}` / `{claude}` help text and the observability caveat.

The renderer learns the platform via the existing preload surface (add a constant if not already exposed).

### G. Testing

- **Unit (vitest, pure, runs on Linux CI):**
  - `localLauncher`: wsl argv assembly, POSIX single-quoting, pidfile command prefix, WSLENV construction, UNC↔Linux translation (incl. `\\wsl$`), custom-template substitution + missing-`{args}` append, win32 gating.
  - `wslProbe`: UTF-16LE decode, distro list + default parsing, `getent`/`/etc/shells` parsing, interop detection, error → empty results.
  - `workspaces` manifest parser: launcher union round-trip, `wsl`-off-win32 rejection.
- **e2e (Playwright, Windows CI lane):** `Vampire/setup-wsl` installs a distro on the `windows-2022+` runner (WSL2 now that hosted runners have nested virtualization; the action falls back to WSL1, which still covers listing, probing, spawn, interop, `\\wsl.localhost\`, and signals — polling makes the watcher test valid on both). Setup seeds a fake `claude` shell script in the distro (banner + echo + writes a valid transcript JSONL under `~/.claude/projects/<encoded-cwd>/`). Spec: create workspace → WSL section lists the distro → probe finds shell + fake claude → attach → PTY output produced inside the distro → watcher ingested the JSONL (session visible in history) → pause/unpause flips STOP/CONT on the Linux pid. All WSL specs gate on `wsl.exe --list` succeeding and skip cleanly elsewhere. Linux e2e asserts the WSL section is absent and the custom field present. Adds ~1–4 min to the Windows job (Alpine cheapest).
- **Manual truth:** Troy's machine (WSL2 + zsh + real claude) runs the same specs unskipped.

### H. SPEC.md updates (same PR)

- §6 IPC: `local:listWslDistros`, `local:probeWslDistro`.
- §7.3 local backend: launcher union + defaulting, WSL spawn/env/pause mechanics, save-time probe caching, interop MCP bridge, polled watcher roots.
- Data model: `launcher` manifest field.
- §9 security: `custom` mode executes a user-supplied command on the host — the same trust the local backend already grants the user over their own machine; WSL workspaces inherit the existing local-workspace identity caveat.

## Follow-ups (explicitly out of v1)

- Committee control for WSL workspaces — stays refused (`assertControl`), same as all local workspaces.
- Lifting the win32 gate on a structured shell-wrap mode for Linux/macOS local workspaces if demand appears (custom mode covers it meanwhile).
- Per-distro default working-directory memory in the picker.
