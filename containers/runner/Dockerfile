# takos-git self-hosted Actions runner image.
#
# The Cloudflare Container the `ActionsJobRunner` Durable Object starts. Runs the
# in-container step server (`executor-main.ts`) as a non-root user in a workspace
# jail. Minimal by design: git + bun + the common CI tooling a `run:` shell step
# expects. Mirrors the takos-computer sandbox image hardening (non-root, workspace
# jail).
#
# EGRESS/CPU/MEMORY ARE NOT ENFORCED BY THIS IMAGE OR BY THE DO. The executor
# enforces step timeouts and secret redaction; log/artifact caps are enforced on
# the `/internal/actions/*` callback surface. The `default-deny` egress and the
# CPU/memory ceiling in `RUNNER_CONTAINER_REQUIREMENTS`
# (`src/features/actions/runner/policy.ts`) must be applied by the container
# platform through the out-of-band wrangler `[[containers]]` step. Until then a
# `run:` step reaches the network unrestricted.
#
# Build context is the takos-git repo ROOT so the container sources keep their
# repo-relative imports (`containers/runner/src` → `../../../src/features/...`):
#   docker build -f containers/runner/Dockerfile -t takos-git-actions-runner .
#
# NOTE: this image cannot be built or run in the current dev environment; it is
# built and pushed by takos-git CI and bound via a wrangler `[[containers]]` image
# (see main.tf / docs/collaborative-hosting.md — the cloudflare TF provider 5.19.1
# cannot express a container image binding standalone).

FROM oven/bun:1

# Common developer/CI tooling a `run:` step expects. Kept lean.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git curl jq unzip xz-utils build-essential python3 \
    && rm -rf /var/lib/apt/lists/*

# Non-root user + a dedicated workspace jail. Steps of one job share this tree.
RUN groupadd -r runner && useradd -r -g runner -m runner \
    && mkdir -p /work && chown runner:runner /work

WORKDIR /app

# Preserve the repo-relative layout the container sources import against.
COPY --chown=runner:runner containers/runner/ ./containers/runner/
COPY --chown=runner:runner src/features/actions/ ./src/features/actions/

RUN chmod +x ./containers/runner/start.sh

USER runner
ENV PORT=8080 RUNNER_WORKSPACE=/work
EXPOSE 8080

ENTRYPOINT ["/app/containers/runner/start.sh"]
