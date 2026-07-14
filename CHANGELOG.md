# Changelog

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
