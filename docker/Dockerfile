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
      tini \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

RUN groupadd --gid ${USER_GID} fleet 2>/dev/null || true \
 && useradd  --uid ${USER_UID} --gid ${USER_GID} --shell /bin/bash --create-home fleet

USER fleet
WORKDIR /workspace

ENV TERM=xterm-256color \
    DISABLE_AUTOUPDATER=1 \
    DISABLE_TELEMETRY=1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
