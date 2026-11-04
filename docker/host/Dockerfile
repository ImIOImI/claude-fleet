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

FROM ${BASE_IMAGE}
USER root
# AWS RDS global CA bundle for the host store's TLS to RDS. AWS re-issues it
# when CAs are added; update the checksum with it.
ADD --checksum=sha256:90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/certs/rds-global-bundle.pem
COPY --from=host-build /src/out/host/fleet-host.mjs /usr/local/lib/fleet-host/fleet-host.mjs
COPY docker/host/fleet-host-entry /usr/local/bin/fleet-host-entry
RUN chmod 0644 /usr/local/lib/fleet-host/fleet-host.mjs /etc/ssl/certs/rds-global-bundle.pem \
 && chmod 0755 /usr/local/bin/fleet-host-entry \
 && printf '#!/bin/sh\nexec node /usr/local/lib/fleet-host/fleet-host.mjs "$@"\n' > /usr/local/bin/fleet-host \
 && chmod 0755 /usr/local/bin/fleet-host \
 && mkdir -p /etc/fleet-host
USER fleet
ENV FLEET_HOST_PORT=8080 \
    FLEET_HOST_CONFIG=/etc/fleet-host/config.yaml \
    FLEET_HOST_STATE=/home/fleet/.claude/fleet-host
EXPOSE 8080
CMD ["/usr/local/bin/fleet-host-entry"]
