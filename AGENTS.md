# AGENTS.md — takos-git

Standalone installable Capsule providing `source.git.smart_http` (git Smart
HTTP). Sibling to takos-storage; **not** part of the Takos worker.

## Boundaries

- OSS installable Capsule listed by the Takosumi Store as discovery metadata
  only. Plain OpenTofu module + prebuilt Worker.
- **Distinct from** product-specific workspace filesystem services and
  `storage.object` (the object store). Do not reuse those names.
- Standard Git Smart HTTP clone/fetch/push. `git-upload-pack` requires `r` and
  `git-receive-pack` requires `w`; normal branch updates are fast-forward only.
- `/mcp` is the repository-lifecycle surface and publishes exactly
  `git_repo_list/create/info/delete`. Clone, commit, fetch, and push remain
  standard Git CLI operations rather than custom MCP tools.
- Access is via **bind-time scoped tokens** minted by Takosumi, verified here
  with the shared `GIT_TOKEN_SIGNING_KEY`. Token format is `src/git-token.ts`
  (`tksvc_` prefix, HMAC-SHA256, audience `source.git.smart_http`) — the Takosumi
  minting side MUST match byte-for-byte.
- The R2 bucket (objects + per-repo refs) is provisioned by this module's own
  `main.tf`, not by the takos deploy module.
- The published MCP server uses a generated `PUBLISHED_MCP_AUTH_TOKEN` secret.
  It also accepts scoped service grants, in which case repo-prefix and verb
  checks come directly from the signed token.

## Engine

`src/git/` is lifted from `takos/src/worker/application/services/takos-git/local/`
(object-store / pack / pack-common / object / tree-ops / sha1 / git-objects) and
made self-contained: no `infra/db`, no drizzle, no accounts. Refs are a per-repo
JSON blob (`refs-store.ts`); reachability walks objects straight from R2
(`reachability.ts`). Receive-pack validates pack checksums, materializes deltas,
verifies object closure and fast-forward branch updates, then replaces the
per-repo refs document once. Keep this subset pure (R2 + Web Crypto only) so it
typechecks without `@cloudflare/workers-types`.

## Tasks

- `bun test` — unit + REAL Git CLI clone/push/reclone/non-fast-forward E2E
  (`git-clone.test.ts` runs git against `Bun.serve`; skips if no git binary).
- `bun run check` — `bunx tsc --noEmit`.
- `bun run build:worker` — emit local `dist/worker.js` for self-host applies;
  hosted installs should use `worker_bundle_url` + `worker_bundle_sha256` from a
  Git release or CI artifact. Do not commit built output.
- `tofu fmt` / `tofu validate`.

## Conventions

- `outputs.tf` publishes generic service outputs (`launch_url`, `url`,
  `public_url`, `api_url`, `mcp_url`, `app_deployment`, `service_exports`),
  `source.git.smart_http`, and `protocol.mcp.server`.
  Object KEYS in projected outputs must avoid
  token/secret/password/credential/auth/bearer/session/cookie/key substrings
  (the Takosumi output secret-scan drops the whole output otherwise).
