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

## Build the runner image

The app expects a local image tagged `claude-fleet/runner:latest`:

```bash
docker build -t claude-fleet/runner:latest docker/
```
