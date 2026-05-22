# claude-fleet

Desktop app for managing a fleet of Claude Code container instances.

Drives 3–6 Docker containers, each running `claude` in its own PTY. Live terminals are
rendered with xterm.js; structured observability (cost, tokens, tool calls, history) is
sourced from each container's bind-mounted Claude transcript JSONL.

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

## Test

```bash
npm test          # build then run the Playwright smoke suite
npm run test:e2e  # run tests against the existing build (no rebuild)
```

Three smoke tests (`tests/smoke.spec.ts`) cover the surface area we've broken before: preload load, `+ New container` opening the modal, and the Create button surfacing validation errors. Tests need a display (WSLg, X server, or Xvfb in CI).

### Authenticating `claude` inside the container

Two modes, picked at container-create time:

- **OAuth (Claude.ai Pro/Max)**: leave the profile-name field blank in the create flow. No API key is injected; the first time `claude` runs in the terminal it prints a login code, you complete the flow in your browser, and the resulting credentials are saved to the bind-mounted `.claude/.credentials.json` so they persist across container restarts.
- **API key (Console billing)**: type a profile name. The named profile is read from the OS keychain (or, if the keychain isn't usable, from the `ANTHROPIC_API_KEY` env var as a dev fallback — see #8). The key is injected as `ANTHROPIC_API_KEY` into the container.

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
