# claude-fleet

Desktop app for managing a fleet of Claude Code **workspaces**.

A workspace is a named place where a Claude Code session runs against a directory. Today the backend is a Docker container (the only one implemented); a local non-container backend is planned. The app drives 3–6 workspaces, each running `claude` in its own PTY rendered with xterm.js, with structured observability (cost, tokens, tool calls, history) sourced from each workspace's bind-mounted Claude transcript JSONL. Workspaces persist across backend restarts via a manifest in `<userData>/state/<name>/workspace.json`, so removing the container doesn't lose the workspace — it stays one click away in the new-workspace modal's past list.

## Docs

- [`docs/SPEC.md`](docs/SPEC.md) — product spec. Single source of truth for what claude-fleet is, how it's built, and which decisions are pending. Start here if you're new.
- [`design/README.md`](design/README.md) — hi-fi visual reference. Canonical design tokens (`design/tokens.css`) and 11 unpacked artboards (`design/components/*.jsx`); refer to these when implementing UI.

## Stack

- Electron + Vite + React + TypeScript (via `electron-vite`)
- `dockerode` for the Docker daemon
- `@xterm/xterm` for terminal panes
- `keytar` for the credentials vault (OS keychain)
- `better-sqlite3` for local history/cost storage

## Prerequisites

- Node 20+
- Docker daemon reachable (Docker Desktop with WSL2 integration, or native dockerd)

## Develop

```bash
npm install
npm run dev
```

### Running dev on WSL

`keytar` needs a Secret Service implementation (gnome-keyring, KeePassXC) on Linux. Bare WSL doesn't ship one, so the Profiles dialog will be hidden and the app falls back to reading `ANTHROPIC_API_KEY` from the environment — enough for daily dev work:

```bash
ANTHROPIC_API_KEY=sk-... npm run dev
```

A header banner shows when the fallback is active. To exercise the Profiles dialog end-to-end (multiple named profiles, vault writes), install and start a keyring:

```bash
sudo apt install gnome-keyring libsecret-1-0
eval "$(gnome-keyring-daemon --start --components=secrets)"
export DBUS_SESSION_BUS_ADDRESS  # set by the daemon
npm run dev
```

This only matters for development on WSL. The packaged Windows build uses Credential Manager (DPAPI) via `keytar` — no setup required.

### Mock mode (no Docker, no API key)

Iterate on the UI without a Docker daemon, runner image, or API credit:

```bash
CLAUDE_FLEET_MOCK=1 npm run dev
```

The top strip pre-populates with two fake workspaces; `+ New workspace` adds more to an in-memory store. Selecting a workspace attaches a tiny mock shell that echoes input and responds to `help`, `clear`, `whoami`, and `echo`. A `MOCK MODE` chip in the header makes the state obvious. Restart `npm run dev` to reset the fake fleet.

Mock mode is dev-only — the env var is ignored by the packaged build.

## Test

```bash
npm test          # build then run the Playwright smoke suite
npm run test:e2e  # run tests against the existing build (no rebuild)
```

The smoke suite (`tests/smoke.spec.ts`) covers regressions we've hit before: preload loading, `+ New workspace` opening the modal, validation surfacing inline, OAuth-mode submission, missing-workspace confirm flow, past-workspaces restart, and the mock-mode UI. Tests need a display (WSLg, X server, or Xvfb in CI).

### Authenticating `claude` inside a workspace

Two modes, picked at workspace-create time:

- **OAuth (Claude.ai Pro/Max)**: leave the profile-name field blank in the create flow. No API key is injected; the first time `claude` runs in the terminal it prints a login code, you complete the flow in your browser, and the resulting credentials are saved to the bind-mounted `.claude/.credentials.json` so they persist across workspace restarts.
- **API key (Console billing)**: type a profile name. The named profile is read from the OS keychain (or, if the keychain isn't usable, from the `ANTHROPIC_API_KEY` env var as a dev fallback — see #8). The key is injected as `ANTHROPIC_API_KEY` into the workspace container.

For the dev fallback to work, launch with the env var set:

```bash
ANTHROPIC_API_KEY=sk-... npm run dev
```

The env fallback is a dev shortcut; production builds should not rely on it — solve #8 before shipping.

## Runner image

The app uses `ghcr.io/imioimi/claude-fleet/runner:latest` (published by `.github/workflows/publish-runner.yml`). Once issue #5 lands, the app will `docker pull` it automatically. Until then, pull manually:

```bash
docker pull ghcr.io/imioimi/claude-fleet/runner:latest
```

Or build from source (useful when iterating on `docker/Dockerfile`):

```bash
docker build -t ghcr.io/imioimi/claude-fleet/runner:latest docker/
```
