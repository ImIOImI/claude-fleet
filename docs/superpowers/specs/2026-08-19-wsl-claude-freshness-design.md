# WSL-launcher workspaces: detect a newer in-distro claude and offer to adopt it

## Problem

A wsl-launcher workspace pins `launcher.claudePath` at save time (`wslProbe.ts` →
`resolveClaudeBin`) and `wrapSpawnForLauncher` execs that path unconditionally on
every session spawn — the user's login-shell PATH never gets a vote. When the
distro later gains a newer claude at a *different* path (e.g. an old native
install at `~/.local/bin/claude` shadowed by an npm/nvm 2.1.x the user actually
uses), the workspace silently runs the stale binary forever. Restarting the
workspace or creating sessions never re-probes. Worse, the probe order itself
(`command -v` on a minimal PATH → well-known dirs → login shell last) means even
a manual re-probe re-finds the same stale well-known path.

Observed in the field: host WSL claude at 2.1.235, workspace stuck on 2.0.76.

## Fix (approved design)

Start-time freshness check + non-blocking toast with an explicit adopt action.

### Detection — new pure module `src/main/wslClaudeFreshness.ts`

Same injected-exec discipline as `wslProbe.ts` (vitest-loadable, no electron
imports).

- Candidate paths, deduped:
  1. the pinned `launcher.claudePath`;
  2. the login shell's `command -v claude` via `<loginShell> -lic`, taking the
     last absolute-path line (rc-chatter tolerance, as in `claudeResolve.ts`);
  3. the well-known dirs from `claudeResolve.ts` (`~/.local/bin/claude`,
     `/usr/local/bin/claude`, `/opt/homebrew/bin/claude`, `/usr/bin/claude`).
- One `wsl.exe -d <distro> --exec sh -c` batch runs `<path> --version` per
  candidate. Versions parsed with `/\d+\.\d+\.\d+/`, compared as numeric
  triples. Unparseable or failing candidates are skipped.
- Returns `{ pinned: {path, version|null}, best: {path, version} } | null` —
  non-null only when `best.version` is strictly newer than the pinned
  binary's version, **or** the pinned binary no longer runs (then any working
  candidate counts; today that workspace fails to spawn with no explanation).
- `launcher.ignoreClaudeVersion` (new optional manifest field): when set,
  suppress results whose `best.version` is not strictly newer than it.

### Trigger

`local.ts startWorkspace()`, only when `launcher.mode === 'wsl'`. Fire-and-
forget after start returns — never delays attach. One check per start (~1–2 s
background). No timer for long-lived workspaces (YAGNI, decided).

### Surfacing — one-way IPC `local:claude-update-available`

Broadcast to all windows (same shape as `ports:detected`). Payload:
`{ workspaceId, distro, pinned: {path, version|null}, best: {path, version} }`.
Renderer toast: “Claude Code 2.1.235 found in Ubuntu — this workspace is pinned
to 2.0.76. [Use newer] [Keep]”. Copy notes that only *new* sessions pick up the
change. Toast uses the shared toast/`ModalBackdrop`-era conventions (no raw
backdrop handlers).

### Decisions — `ipcMain.handle('local:claude-update-decision', (workspaceId, decision))`

One channel for both toast buttons:
- `{ action: 'adopt', path }` rewrites `launcher.claudePath` via
  `writeWorkspaceManifest` and clears `ignoreClaudeVersion`. Existing PTYs
  keep their running process.
- `{ action: 'ignore', version }` persists `launcher.ignoreClaudeVersion`;
  the toast reappears only for something strictly newer.

## Testing

- vitest on the pure module: version parsing, candidate ranking, ignore
  semantics, missing-pinned case, rc-chatter tolerance.
- vitest on the manifest plumbing (adopt handler writes the field; keep writes
  the ignore version).
- No e2e: needs a real Windows + WSL host. Gate = typecheck + unit + build;
  Troy eyeballs the toast on the host.

## Spec maintenance

Adds two IPC channels, one manifest field, and a user flow → update
`docs/SPEC.md` (IPC surface, data model, user flows) in the same PR.

## Out of scope

- native / custom launcher modes (they resolve the host claude per spawn —
  never pinned).
- Changing `resolveClaudeBin`'s probe order at save time.
- Periodic re-checks while a workspace stays running.
