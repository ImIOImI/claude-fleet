# broker

In-container session multiplexer for claude-fleet. See [`docs/SPEC.md`](../docs/SPEC.md) §5 for the architecture and §11 → *Resumable sessions on workspace pause/resume* for the why.

## Layout

```
broker/
├── cmd/broker/main.go             entrypoint; reads env, listens on socket
└── internal/
    ├── proto/                     wire-protocol frame codec + types
    ├── session/                   PTY supervision, ring buffer, Manager
    └── server/                    accept loop, per-conn dispatch
```

## Build

```bash
cd broker
CGO_ENABLED=0 go build -ldflags="-s -w" -o /tmp/broker ./cmd/broker
```

The Dockerfile in `../docker/Dockerfile` builds this same binary in a `golang:1.22-alpine` stage and copies it into the runtime image.

## Test

```bash
cd broker
go test -race ./...
```

The session/server tests use `/bin/cat` as a stand-in for `claude`, so no Anthropic credentials are needed.

## Run locally

```bash
CLAUDE_FLEET_BROKER_SOCKET=/tmp/broker.sock \
CLAUDE_FLEET_BROKER_CLAUDE=/bin/cat \
CLAUDE_FLEET_BROKER_RING=4096 \
  /tmp/broker
```

Then poke it from another terminal:

```bash
# socat exists to make this manual; in real use the host-side
# BrokerClient (src/main/broker.ts) drives the protocol.
socat - UNIX-CONNECT:/tmp/broker.sock
```

Frames are length-prefixed binary, so you'll need a real client (or the Go tests in `internal/server/`) to drive the protocol end-to-end.
