# Changelog

## v0.5.0 — plain Capsule and hardened Interface authorization

- Removes the Takosumi-specific provider wrapper and repository manifest. The
  repository root is the only plain OpenTofu Capsule entry; service-side
  InstallConfig blueprints own Interface declarations and Binding proposals.
- Requires explicit canonical public/issuer origins for Smart HTTP, hosting API,
  and MCP Interface OAuth. Caller Host values never become OAuth audience
  authority, and public/issuer URLs are canonical bare HTTPS origins.
- Makes `git:pre-destroy` consume allowlisted lifecycle outputs, empty both Git
  and optional Actions R2 buckets in bounded pages, and always remove its
  temporary hash-token cleaner even after an ambiguous upload response.
- Pins every mirrored provider exactly and adds reproducible pull-request and
  release quality lanes. The random provider remains only as the pre-0.4 state
  destroy bridge and creates no resources.

## v0.4.1 — install fixes: D1 self-migration + upgrade provider bridge

Makes v0.4 actually install/upgrade cleanly via Takosumi/OpenTofu.

- **The Worker self-applies the D1 baseline schema on first use** (guarded by a
  `schema_migrations` ledger; the DDL is now fully `IF NOT EXISTS`). A fresh install
  no longer needs a separate `wrangler d1 migrations apply` step — otherwise D1 was
  empty and every collaboration endpoint 500'd.
- **Upgrade provider bridge:** re-declares the `hashicorp/random` provider (pinned to
  the runner mirror's `3.9.0`, added to the lockfile) so an offline/mirror-only runner
  can plan an upgrade from a pre-0.4 install and destroy the orphaned
  `random_id.signing_key` / `random_id.mcp_auth_token` resources still in its state.
  v0.4 creates no `random_*` resources; the declaration is a one-cycle bridge.

## v0.4.0 — GitHub-parity forge + self-hosted Actions

The big one: takos-git grows from a read-only Git Smart-HTTP hosting shell into a
GitHub-like collaborative Git host with self-hosted CI. Canonical spec:
[`docs/github-parity-build.md`](docs/github-parity-build.md).

### Added

- **Metadata plane (D1) + real ACL.** Workspace-scoped Principals, user/org owner
  namespaces, org memberships, teams, and per-repo roles (owner / maintainer / writer
  / reader). Public / private / internal visibility with existence non-disclosure
  (private → 404). Git objects and refs stay authoritative in R2; D1 is a rebuildable
  projection, and cross-store writes go through a single two-phase writer.
- **Code browser.** File tree, blob view (line numbers, blame, images), commit list,
  commit diff, ref compare — powered by new tree-diff, 3-way merge, merge-base, blame,
  and unified-diff primitives.
- **Collaboration core.** Issues, comments, labels, milestones; pull requests with
  reviews, inline comments, diff/files/commits, and merge (merge / squash / rebase)
  gated by branch protection; releases + assets + tags; forks + upstream sync; webhooks
  with deliveries; check runs + commit statuses.
- **Actions (self-hosted).** Workflow parser / scheduler / matrix, push + dispatch
  triggers, run/job/step persistence, and check-run projection — executed by a runner
  embedded in the Worker (Cloudflare Container + Durable Objects, Queue dispatch,
  in-container step executor for `run:` + checkout / upload-artifact / download-artifact).
- **GitHub-like web app.** A SolidJS + Vite SPA (code, issues, pull requests, actions,
  releases, settings), embedded into the single Worker artifact — no separate static
  asset binding required for an install.
- **Per-repo ACL on Git Smart-HTTP** when the metadata plane is present (a push needs
  the write scope AND a writer role AND branch-protection clearance); D1-less deploys
  keep working as scope-only Git hosting.
- Deploy runbook at [`docs/deploy.md`](docs/deploy.md).

### Notes

- Full GitHub REST / GraphQL / Actions wire-compatibility is not a goal; surfaces are
  versioned. Actions container execution requires the operator's `wrangler [[containers]]`
  step (see the deploy runbook); the control plane runs without it (runs stay queued).

## v0.3.x and earlier

Git Smart-HTTP hosting shell: clone / fetch / push over R2, Interface-OAuth auth,
repository-lifecycle MCP, browser OIDC session, and a read-only hosting API.
