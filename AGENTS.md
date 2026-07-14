# AGENTS.md — takos-git

Standalone installable collaborative Git hosting Capsule. It provides standard
Git Smart HTTP plus an app-owned browser/API collaboration surface. Sibling to
takos-storage; **not** part of the Takos worker.

## Boundaries

- OSS installable Capsule listed by the Takosumi Store as discovery metadata
  only. Plain OpenTofu module + prebuilt Worker.
- **Distinct from** product-specific workspace filesystem services and
  `storage.object` (the object store). Do not reuse those names.
- Standard Git Smart HTTP clone/fetch/push. `git-upload-pack` requires
  `source.git.smart_http.read` and `git-receive-pack` requires
  `source.git.smart_http.write`; normal branch updates are fast-forward only.
- Repository metadata, browser UI, code browsing, Issues, pull requests,
  reviews, releases, webhooks, and checks belong here as they are implemented.
  Takosumi owns installation/identity/Interface authorization, not Git product
  state. Follow `docs/collaborative-hosting.md` for the migration order.
- `/mcp` is the repository-lifecycle surface and publishes exactly
  `git_repo_list/create/info/delete`. Clone, commit, fetch, and push remain
  standard Git CLI operations rather than custom MCP tools.
- Git Smart HTTP uses short-lived Accounts-backed Interface OAuth credentials
  (`taksrv_`). Clone/fetch requires `source.git.smart_http.read`; push requires
  `source.git.smart_http.write`. The Worker verifies audience, Workspace,
  Capsule, Interface, Binding, and resolved revision through the configured
  issuer. There is no app-local grant minting or signing key.
- Browser sessions use Accounts authorization-code + PKCE and require exact
  membership in `APP_WORKSPACE_ID`. The hosting read API also accepts a
  short-lived `source.git.hosting.read` Interface OAuth credential with
  `hosting_api_url` as its exact audience.
- The R2 bucket (objects + per-repo refs) is provisioned by this module's own
  `main.tf`, not by the takos deploy module.
- The published MCP server accepts a `mcp.invoke` Interface OAuth credential.
  An explicitly supplied `PUBLISHED_MCP_AUTH_TOKEN` is retained only as
  ordinary direct/self-host standalone auth and is not an InterfaceBinding
  credential. Empty configuration creates no static credential.

## Engine

`src/git/` is lifted from `takos/src/worker/application/services/takos-git/local/`
(object-store / pack / pack-common / object / tree-ops / sha1 / git-objects) and
made self-contained: no `infra/db`, no drizzle, no accounts. Refs are a per-repo
JSON blob (`refs-store.ts`); reachability walks objects straight from R2
(`reachability.ts`). Receive-pack validates pack checksums, materializes deltas,
verifies object closure and fast-forward branch updates, then replaces the
per-repo refs document once. Keep this subset pure (R2 + Web Crypto only) so it
typechecks without `@cloudflare/workers-types`.

The hosting layer (`browser-auth.ts`, `forge-api.ts`, and later metadata/UI
modules) may compose the pure engine but must not move Takos shell, chat,
Space/account tables, or Takosumi handler implementation into this repo.

## Tasks

- `bun test` — unit + REAL Git CLI clone/push/reclone/non-fast-forward E2E
  (`git-clone.test.ts` runs git against `Bun.serve`; skips if no git binary).
- `bun run check` — `bunx tsc --noEmit`.
- `bun run build:worker` — emit local `dist/worker.js` for self-host applies;
  hosted installs should use `worker_bundle_url` + `worker_bundle_sha256` from a
  Git release or CI artifact. Do not commit built output.
- `tofu fmt` / `tofu validate`.

## Conventions

- `outputs.tf` publishes ordinary module results only: canonical `launch_url`,
  `api_url`, `hosting_api_url`, `mcp_url`, and provider-native runtime/bucket identifiers. Runtime
  Interface declarations and credentials are Takosumi-side configuration, not
  nested OpenTofu outputs. The direct MCP bearer remains sensitive state plus a
  provider secret binding and must not be published as an output.
