# Takos Git Takoform Capsule

This is the canonical managed resource definition for the default Takos Git
service. The repository root remains the direct Cloudflare path.

The default managed graph is one `EdgeWorker`, one authoritative
`ObjectBucket`, and one SQLite `SQLDatabase` for rebuildable collaborative
metadata. The Worker tag, URL, and SHA-256 are pinned together.

Self-hosted Actions remains disabled in the default product configuration. It
requires a separate portable design for Queue consumer/DLQ, stateful actor, and
ContainerService semantics; this Capsule must not partially provision that
feature.

Takosumi owns runtime secrets, Accounts/Interface context, public URL and OIDC,
metadata migration readiness, bucket cleanup before destroy, health checks, and
rollback.
