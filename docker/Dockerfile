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

# The node:22 base ships a 'node' user at UID 1000; remove it so we can
# claim UID 1000 for 'fleet'. Make /home/fleet world-writable so the
# container can run as any host UID at start time (via docker run --user)
# and still have a writable $HOME for tooling that consults it.
RUN userdel -r node 2>/dev/null || rm -rf /home/node \
 && groupadd --gid ${USER_GID} fleet \
 && useradd  --uid ${USER_UID} --gid ${USER_GID} --shell /bin/bash --create-home fleet \
 && chmod 777 /home/fleet

USER fleet
WORKDIR /workspace

ENV TERM=xterm-256color \
    DISABLE_AUTOUPDATER=1 \
    DISABLE_TELEMETRY=1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
