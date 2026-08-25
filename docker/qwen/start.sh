#!/bin/sh
# Qwen runner entrypoint: launches the fleet transcript sidecar in the background,
# then execs the broker so tini (ENTRYPOINT) reaps the broker as PID 1's child.
# If the sidecar dies the broker keeps running — the & decouples their lifecycles.
# The sidecar's two required env vars (CF_QWEN_PROJECTS_DIR, CF_FLEET_PROJECTS_DIR)
# are injected by the host at `docker create` time (docker.ts createWorkspaceInner).
node /usr/local/lib/claude-fleet/qwen/sidecar.mjs &
exec /usr/local/bin/broker
