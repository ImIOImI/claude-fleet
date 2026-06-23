# DevOps runner image — the base claude-fleet runner + the SumerSports
# platform-engineering toolset (GitHub CLI, OpenTofu/Terramate, OPA, tflint/
# trivy, kubectl/helm/kustomize, dnsutils, AWS/Azure CLIs). The committee
# experts/manager run on this image (their loadouts reach for `gh`, IaC tools).
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
# Heavy / creds-dependent CLIs — on by default for the "everything" devops
# image; flip off for a leaner variant.
ARG INSTALL_AWS_CLI=true
ARG INSTALL_AZURE_CLI=true

# tenv's `tofu` shim reads TENV_ROOT at runtime; point every container UID
# (docker run --user) at the world-readable root the build populated.
ENV TENV_ROOT=/opt/tenv

USER root
COPY docker/scripts/ /opt/install-scripts/
RUN set -eux; cd /opt/install-scripts; \
    bash apt-tools.sh; \
    bash gh.sh; \
    bash yq.sh; \
    bash tenv.sh; \
    bash opa.sh; \
    bash iac-lint.sh; \
    bash kubectl.sh; \
    bash helm.sh; \
    if [ "$INSTALL_AWS_CLI" = "true" ]; then bash aws-cli.sh; fi; \
    if [ "$INSTALL_AZURE_CLI" = "true" ]; then bash azure-cli.sh; fi; \
    rm -rf /opt/install-scripts

# Back to the unprivileged fleet user. ENTRYPOINT (tini) + CMD (broker) are
# inherited from the base — this is still a fleet runner, just a fatter one.
USER fleet
WORKDIR /workspace
