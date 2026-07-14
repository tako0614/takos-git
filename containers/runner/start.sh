#!/bin/sh
# Entrypoint for the takos-git Actions runner container: start the in-container
# step server. `executor-main.ts` binds $PORT (8080) and serves POST /runs/:jobId.
set -e
exec bun /app/containers/runner/src/executor-main.ts
