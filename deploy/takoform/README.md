# Takos Git Takoform Capsule

This is the canonical portable resource definition and the repository
manifest's default module for Takos Git. The repository root remains the
explicit direct Cloudflare path.

The graph uses current Takoform resources: an `ObjectBucket`, a
`SqliteDatabase`, and a ModuleWorker bundle/version/deployment/endpoint with a
cron trigger. The module references one content-addressed WorkerBundle manifest
that is already committed to the selected Host. Artifact download and digest
verification happen in the host/runner preflight, outside OpenTofu; the module
does not execute shell commands or fetch mutable release URLs.

Takoform owns only the deployable Resource graph. The repository manifest owns
the `source.git.smart_http` and `mcp.server` declarations and maps their
resource URIs from ordinary module Outputs after apply. The Host resolves the
public service origin; runtime consumers discover a Ready Interface and use a
short-lived Interface credential. No Interface, Binding, Workspace, Capsule,
or provider authority is copied into the Resource graph.

The portable default deliberately does not declare the browser launcher or
hosting API. Those surfaces require a browser-session secret and host runtime
materialization that cannot be represented truthfully by this module yet. The
direct root module remains available for an operator that explicitly supplies
that configuration.

Self-hosted Actions remains disabled in the default product configuration. It
requires a separate portable design for Queue consumer/DLQ, stateful actor, and
ContainerService semantics; this Capsule must not partially provision that
feature.

Takosumi owns Plan review, runtime secrets, Accounts/Interface context, binding
credentials, OIDC delivery, lifecycle policy, health checks, and rollback. The
selected Takoform Host owns Resource placement and the endpoint Output.
