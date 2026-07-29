# Takos Git Takoform Capsule

This is the canonical managed resource definition for the default Takos Git
service. The repository root remains the direct Cloudflare path.

The default managed graph is one JavaScript `HttpService`, one authoritative
`ObjectBucket`, and one SQLite `RelationalDatabase` for rebuildable
collaborative metadata. The Worker tag, URL, and SHA-256 are pinned together.

The graph owns its complete opaque launcher, Smart HTTP, hosting API, and MCP
Interface documents through generic `takoform_interface` resources. Takoform
does not define any protocol-specific provider blocks. The host resolves the
public service origin; runtime consumers discover an Interface and call the
application endpoint directly under host-governed authorization.

Self-hosted Actions remains disabled in the default product configuration. It
requires a separate portable design for Queue consumer/DLQ, stateful actor, and
ContainerService semantics; this Capsule must not partially provision that
feature.

Takosumi owns runtime secrets, Accounts/Interface context, binding credentials,
public URL and OIDC, metadata migration readiness, bucket cleanup before
destroy, health checks, and rollback.
