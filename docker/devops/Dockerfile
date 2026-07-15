# syntax=docker/dockerfile:1
# DevOps runner image — the base claude-fleet runner + the SumerSports
# platform-engineering toolset (GitHub CLI, OpenTofu/Terramate, OPA, tflint/
# trivy, kubectl/helm/kustomize, Argo CD/Workflows/Rollouts, dnsutils, Doppler,
# AWS CLI; Azure CLI opt-in).
# The committee experts/manager run on this image (loadouts reach for gh,
# IaC tools).
#
# Built FROM the published base so the base stays lean and standalone; future
# images can likewise stack on either. Build with the REPO ROOT as context
# (like the base) so the shared installers under docker/scripts/ are reachable.
ARG BASE_IMAGE=ghcr.io/imioimi/claude-fleet/runner:latest
FROM ${BASE_IMAGE}

# Tool versions — defaults mirror docker/versions.yaml; CI passes them via
# --build-arg from that file so there's one source of truth.
ARG GH_VERSION=2.87.3
ARG TENV_VERSION=4.8.3
ARG TOFU_VERSIONS="1.11.5 1.10.5"
ARG TERRAMATE_VERSION=0.17.1
ARG OPA_VERSION=1.13.2
ARG AWS_CLI_VERSION=2.33.27
ARG AZURE_CLI_VERSION=2.83.0
ARG DOPPLER_VERSION=3.76.0
ARG ARGOCD_VERSION=3.4.5
ARG ARGO_WORKFLOWS_VERSION=4.0.7
ARG ARGO_ROLLOUTS_VERSION=1.9.0
# Heavy / creds-dependent CLIs. AWS is on by default; Azure is OFF by default
# (its pip tree roughly doubles the image to ~3.4 GB) — opt in per build.
ARG INSTALL_AWS_CLI=true
ARG INSTALL_AZURE_CLI=false

# Capability metadata — claude-fleet surfaces image labels as searchable chips
# in the workspace image picker, so these let you find "the one with kubectl /
# aws / tofu". The cloud CLIs reflect the build args (accurate per build).
LABEL org.opencontainers.image.title="claude-fleet runner · devops" \
      org.opencontainers.image.description="Base claude-fleet runner + platform-engineering toolset: gh, OpenTofu/Terramate (tenv), OPA, tflint/trivy, kubectl/kustomize/helm, Argo CD/Workflows/Rollouts, dnsutils, Doppler, AWS CLI." \
      com.claude-fleet.variant="devops" \
      com.claude-fleet.capabilities="gh yq tofu opentofu terramate opa tflint trivy kubectl kustomize helm dig dnsutils pre-commit shellcheck doppler argocd argo argo-workflows argo-rollouts" \
      com.claude-fleet.cloud="aws=${INSTALL_AWS_CLI} azure=${INSTALL_AZURE_CLI}"

# tenv's `tofu` shim reads TENV_ROOT at runtime; point every container UID
# (docker run --user) at the world-readable root the build populated.
ENV TENV_ROOT=/opt/tenv

USER root
COPY docker/scripts/ /opt/install-scripts/
# The installers hit api.github.com (tenv resolving tofu/terramate, the
# kustomize tag lookup, the tflint/trivy installers). Unauthenticated CI builds
# get 60 req/hr/IP and fail with "rate-limited by GitHub". Mount CI's token as a
# BuildKit secret (NOT a build-arg — keeps it out of the image history/layers)
# and export the env vars those tools read; the build still works without it
# (the secret mount is optional), just risks the anonymous rate limit.
RUN --mount=type=secret,id=github_token set -eux; \
    if [ -f /run/secrets/github_token ]; then \
      GITHUB_TOKEN="$(cat /run/secrets/github_token)"; \
      export GITHUB_TOKEN TENV_GITHUB_TOKEN="$GITHUB_TOKEN"; \
    fi; \
    cd /opt/install-scripts; \
    bash apt-tools.sh; \
    bash gh.sh; \
    bash yq.sh; \
    bash tenv.sh; \
    bash opa.sh; \
    bash iac-lint.sh; \
    bash kubectl.sh; \
    bash helm.sh; \
    bash argo.sh; \
    bash doppler.sh; \
    if [ "$INSTALL_AWS_CLI" = "true" ]; then bash aws-cli.sh; fi; \
    if [ "$INSTALL_AZURE_CLI" = "true" ]; then bash azure-cli.sh; fi; \
    rm -rf /opt/install-scripts

# Back to the unprivileged fleet user. ENTRYPOINT (tini) + CMD (broker) are
# inherited from the base — this is still a fleet runner, just a fatter one.
USER fleet
WORKDIR /workspace
