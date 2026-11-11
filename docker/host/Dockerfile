# syntax=docker/dockerfile:1
# runner-host / runner-devops-host: a runner image plus fleet-host (remote
# workspaces). Build with the repo root as context; BASE_IMAGE picks the runner.
ARG BASE_IMAGE=ghcr.io/imioimi/claude-fleet/runner:latest

FROM node:22-bookworm-slim AS host-build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.host.json vite.host.config.ts ./
COPY src ./src
RUN npx vite build --config vite.host.config.ts

# fleet-embedder (D76). Same digest as embedder/scripts/ci-build-linux.sh; bump both together.
FROM rust:1.91-bookworm@sha256:c1e5f19e773b7878c3f7a805dd00a495e747acbdc76fb2337a4ebf0418896b33 AS embedder-build
WORKDIR /w
COPY embedder ./embedder
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    embedder/scripts/install-zigbuild.sh /opt/zb \
 && PATH=/opt/zb/bin:$PATH embedder/scripts/ci-build.sh

# The sidecar's two model files at a pinned HF commit, checked against the committed manifest (D77).
FROM rust:1.91-bookworm@sha256:c1e5f19e773b7878c3f7a805dd00a495e747acbdc76fb2337a4ebf0418896b33 AS embed-weights
ARG EMBED_HF_REVISION=ea104dacec62c0de699686887e3f920caeb4f3e3
WORKDIR /model
COPY docker/host/embed-weights.sha256 ./SHA256SUMS
RUN for f in tokenizer.json onnx/model_quantized.onnx; do \
      mkdir -p "$(dirname "$f")" \
      && curl -fsSL --retry 3 -o "$f" "https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/${EMBED_HF_REVISION}/$f" || exit 1; \
    done \
 && sha256sum -c SHA256SUMS

FROM ${BASE_IMAGE}
USER root
# AWS RDS global CA bundle for the host store's TLS to RDS. AWS re-issues it
# when CAs are added; update the checksum with it.
ADD --checksum=sha256:90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/certs/rds-global-bundle.pem
COPY --from=host-build /src/out/host/ /usr/local/lib/fleet-host/
COPY --from=embedder-build /w/embedder/bin/fleet-embedder /usr/local/lib/fleet-host/embed/fleet-embedder
COPY --from=embed-weights /model/ /usr/local/lib/fleet-host/embed/model/
COPY embedder/reference/bge-small-q8.json /usr/local/lib/fleet-host/embed/reference.json
COPY docker/host/fleet-host-entry /usr/local/bin/fleet-host-entry
# The gh shim goes first on PATH; git asks fleet-host-cred for github.com.
COPY docker/host/gh /usr/local/lib/fleet-host/bin/gh
COPY docker/host/gitconfig /etc/gitconfig
RUN find /usr/local/lib/fleet-host -type f -exec chmod 0644 {} + \
 && chmod 0755 /usr/local/lib/fleet-host/embed/fleet-embedder \
 && chmod 0644 /etc/ssl/certs/rds-global-bundle.pem /etc/gitconfig \
 && chmod 0755 /usr/local/bin/fleet-host-entry /usr/local/lib/fleet-host/bin /usr/local/lib/fleet-host/bin/gh \
 && printf '#!/bin/sh\nexec node /usr/local/lib/fleet-host/fleet-host.mjs "$@"\n' > /usr/local/bin/fleet-host \
 && printf '#!/bin/sh\nexec node /usr/local/lib/fleet-host/fleet-host-cred.mjs "$@"\n' > /usr/local/bin/fleet-host-cred \
 && chmod 0755 /usr/local/bin/fleet-host /usr/local/bin/fleet-host-cred \
 && groupadd --gid 1001 fleet-host \
 && useradd --uid 1001 --gid 1001 --home-dir /var/lib/fleet-host/state --no-create-home --shell /usr/sbin/nologin fleet-host \
 && mkdir -p /var/lib/fleet-host/state /var/lib/fleet-host/projects \
 && chown fleet-host:fleet-host /var/lib/fleet-host/state && chmod 0700 /var/lib/fleet-host/state \
 && mkdir -p /etc/fleet-host /run/fleet-host \
 && chown fleet:fleet /run/fleet-host && chmod 0700 /run/fleet-host \
 && node /usr/local/lib/fleet-host/fleet-host.mjs write-mcp-bridge /usr/local/lib/fleet-host/mcp-bridge.cjs \
 && mkdir -p /run/fleet && chown fleet:fleet /run/fleet && chmod 0700 /run/fleet
USER fleet
ENV PATH=/usr/local/lib/fleet-host/bin:$PATH \
    FLEET_HOST_PORT=8080 \
    FLEET_HOST_CONFIG=/etc/fleet-host/config.yaml \
    FLEET_HOST_STATE=/home/fleet/.claude/fleet-host \
    FLEET_HOST_EMBED_DIR=/usr/local/lib/fleet-host/embed
# A real embed against the committed reference, as the runtime uid (D78).
RUN fleet-host embed-check
EXPOSE 8080
CMD ["/usr/local/bin/fleet-host-entry"]
