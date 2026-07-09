# AGENTS.md — takos-git

Standalone installable Capsule providing `source.git.smart_http` (git Smart
HTTP). Sibling to takos-storage; **not** part of the Takos worker.

## Boundaries

- OSS installable Capsule listed by the Takosumi Store as discovery metadata
  only. Plain OpenTofu module + prebuilt Worker.
- **Distinct from** product-specific workspace filesystem services and
  `storage.object` (the object store). Do not reuse those names.
- Read-only clone/fetch for P1. Push (`receive-pack`) is deferred; the route
  returns 403.
- Access is via **bind-time scoped tokens** minted by Takosumi, verified here
  with the shared `GIT_TOKEN_SIGNING_KEY`. Token format is `src/git-token.ts`
  (`takstor_` prefix, HMAC-SHA256, audience `source.git.smart_http`) — the Takosumi
  minting side MUST match byte-for-byte.
- The R2 bucket (objects + per-repo refs) is provisioned by this module's own
  `main.tf`, not by the takos deploy module.

## Engine

`src/git/` is lifted from `takos/src/worker/application/services/takos-git/local/`
(object-store / pack / pack-common / object / tree-ops / sha1 / git-objects) and
made self-contained: no `infra/db`, no drizzle, no accounts. Refs are a per-repo
JSON blob (`refs-store.ts`); reachability walks objects straight from R2
(`reachability.ts`). Keep this subset pure (R2 + Web Crypto only) so it
typechecks without `@cloudflare/workers-types`.

## Tasks

- `bun test` — unit + REAL `git clone` E2E (`git-clone.test.ts` runs a git
  subprocess against `Bun.serve`; skips if no git binary).
- `bun run check` — `bunx tsc --noEmit`.
- `bun run build:worker` — emit `dist/worker.js`.
- `tofu fmt` / `tofu validate`.

## Conventions

- `outputs.tf` publishes `service_exports[0].name = "source.git.smart_http"`.
  Object KEYS in projected outputs must avoid
  token/secret/password/credential/auth/bearer/session/cookie/key substrings
  (the Takosumi output secret-scan drops the whole output otherwise).
