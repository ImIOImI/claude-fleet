# ─── Stage 1: build the in-container broker binary ───────────────────────
# The broker is claude-fleet's session multiplexer. It owns every claude
# PTY inside the container and exposes them over a Unix socket the host
# attaches to instead of running `docker exec claude` directly. This
# stage compiles the Go binary against the broker module at //broker.
#
# The image is built with the REPO ROOT as build context (see the CI
# workflow and the host's local-build fallback), so paths below are
# relative to claude-fleet/.
FROM golang:1.22-alpine AS broker-build

WORKDIR /src
COPY broker/go.mod broker/go.sum ./
RUN go mod download
COPY broker/ .
# CGO disabled → fully static binary. ldflags strip debug info to keep
# the runtime image small (~6 MB instead of ~20 MB).
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /out/broker ./cmd/broker

# ─── Stage 2: runtime image ──────────────────────────────────────────────
FROM node:22-bookworm-slim

ARG USER_UID=1000
ARG USER_GID=1000

RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      ca-certificates \
      curl \
      ripgrep \
      jq \
      less \
      socat \
      tini \
    && rm -rf /var/lib/apt/lists/*

# Claude is pinned, not pulled fresh on every build. The "Managed
# settings require approval" startup gate that claude 2.1.150 added
# (when an org pushes a privileged setting like
# OTEL_EXPORTER_OTLP_LOGS_ENDPOINT down to the client) was unnavigable
# over our broker PTY in 2.1.150 — Enter / arrows / digit-plus-Enter
# all reached claude (echo confirmed) but the prompt didn't advance.
# 2.1.169 fixed navigation; 2.1.177 (current) keeps it working — verified
# the gate still navigates over a PTY before bumping. The pin protects
# against silent regressions in this code path — bump deliberately, after
# re-verifying the prompt (see issue #65 for the test recipe).
RUN npm install -g @anthropic-ai/claude-code@2.1.177

# The node:22 base ships a 'node' user at UID 1000; remove it so we can
# claim UID 1000 for 'fleet'. Make /home/fleet world-writable so the
# container can run as any host UID at start time (via docker run --user)
# and still have a writable $HOME for tooling that consults it.
RUN userdel -r node 2>/dev/null || rm -rf /home/node \
 && groupadd --gid ${USER_GID} fleet \
 && useradd  --uid ${USER_UID} --gid ${USER_GID} --shell /bin/bash --create-home fleet \
 && chmod 777 /home/fleet

# Drop the broker binary in PATH. World-executable so any host UID
# (set via docker run --user) can run it.
COPY --from=broker-build /out/broker /usr/local/bin/broker
RUN chmod 0755 /usr/local/bin/broker

# Pre-create /run/broker so the broker doesn't need to mkdir it at
# startup as a non-root user. World-rwx so any host UID can own files
# (the broker socket) inside it.
RUN mkdir -p /run/broker && chmod 0777 /run/broker

# claude-fleet "needs input" hook: reports AskUserQuestion pose/clear edges to
# the host MCP server so the chip can show a waiting state. Loaded via --settings
# on each claude launch (trusted; no /hooks approval gate).
RUN mkdir -p /usr/local/lib/claude-fleet
COPY docker/runner/input-wait-report.sh /usr/local/lib/claude-fleet/input-wait-report.sh
COPY docker/runner/hooks.settings.json /usr/local/lib/claude-fleet/hooks.settings.json
RUN chmod 0755 /usr/local/lib/claude-fleet/input-wait-report.sh \
 && chmod 0644 /usr/local/lib/claude-fleet/hooks.settings.json

USER fleet
WORKDIR /workspace

ENV TERM=xterm-256color \
    DISABLE_AUTOUPDATER=1 \
    DISABLE_TELEMETRY=1 \
    CLAUDE_FLEET_BROKER_SOCKET=/run/broker/broker.sock

# tini reaps zombies (claude processes spawned and reaped by the
# broker) and forwards signals. The broker is the long-running
# foreground process — when it exits, the container exits.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/broker"]
