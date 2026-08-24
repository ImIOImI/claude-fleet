# syntax=docker/dockerfile:1
# Qwen runner image — the base claude-fleet runner + qwen-code CLI + socat.
# Committee workspaces with harness='qwen-code' run on this image; the broker
# execs `qwen` instead of `claude` (CLAUDE_FLEET_BROKER_CLAUDE=qwen).
# fleet-state MCP is bridged via `socat` over the bind-mounted socket at
# /fleet/mcp/mcp.sock (no reconnect-bridge needed — qwen is short-lived per
# invocation, unlike the persistent claude PTY session).
#
# Built FROM the published base so the base stays lean and standalone.
# Build with the REPO ROOT as context (like the base) so the shared installers
# under docker/scripts/ are reachable.
ARG BASE_IMAGE=ghcr.io/imioimi/claude-fleet/runner:latest
FROM ${BASE_IMAGE}

# Tool version — default mirrors docker/versions.yaml; CI passes via --build-arg.
ARG QWEN_VERSION=0.22.0

# Capability metadata — claude-fleet surfaces image labels as searchable chips
# in the workspace image picker.
LABEL org.opencontainers.image.title="claude-fleet runner · qwen" \
      org.opencontainers.image.description="Base claude-fleet runner + qwen-code CLI + socat MCP bridge." \
      com.claude-fleet.variant="qwen" \
      com.claude-fleet.capabilities="qwen socat"

USER root
COPY docker/scripts/_arch.sh docker/scripts/qwen.sh /opt/install-scripts/
RUN apt-get update && apt-get install -y --no-install-recommends socat \
 && rm -rf /var/lib/apt/lists/* \
 && cd /opt/install-scripts && QWEN_VERSION="${QWEN_VERSION}" bash qwen.sh \
 && rm -rf /opt/install-scripts

# Back to the unprivileged fleet user. ENTRYPOINT (tini) + CMD (broker) are
# inherited from the base — this is still a fleet runner, just with qwen added.
USER fleet
WORKDIR /workspace
