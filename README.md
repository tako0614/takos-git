# takos-git

A standalone, installable **Takos git hosting service**. It serves read-only git
Smart HTTP (`git clone` / `fetch`) from an R2 object store, gated by scoped
bearer tokens that Takosumi mints at bind time. It is a plain OpenTofu module +
prebuilt Cloudflare Worker, installed through Takosumi like any other Capsule.

This is a **separate, lower-level primitive** from the Takos product's workspace
storage. It publishes the `takos.git.hosting` service export
(`source.git.smart_http`), distinct from `takos.storage.workspace` (the product
filesystem API) and `takos.storage.object` (the object store).

## What it is

- A Worker exposing git Smart HTTP over its own R2 bucket (objects are
  content-addressed loose objects; refs are a small per-repo JSON blob).
- The packfile engine (object store, pack writer, tree/commit parsing,
  reachability) is lifted from the takos worker's worker-native git core and made
  self-contained (no D1, no accounts coupling).
- Every request is gated by a scoped token bounded to a repo prefix + verb set.
  git sends the token as the HTTP Basic password (username ignored, GitHub-PAT
  style).

## HTTP surface

| Method | Path                                            | Verb | Notes                    |
| ------ | ----------------------------------------------- | ---- | ------------------------ |
| GET    | `/healthz`                                      | —    | liveness, no auth        |
| GET    | `/git/<repo>.git/info/refs?service=git-upload-pack` | `r` | ref advertisement    |
| POST   | `/git/<repo>.git/git-upload-pack`               | `r`  | clone/fetch (packfile)   |
| POST   | `/git/<repo>.git/git-receive-pack`              | —    | `403` — push is P1-deferred |

## Scope (P0/P1)

Read-only clone/fetch. **Push (`receive-pack`) is intentionally out of scope for
P1** — writes go through a forge API in a later phase. Objects are served as an
undeltified packfile.

## Develop

```sh
bun test              # unit + REAL `git clone` E2E against the worker
bun run check         # typecheck
bun run build:worker  # emit dist/worker.js
```

## Deploy (OpenTofu)

Self-contained module; inert until the feature flags are on:

```sh
tofu apply \
  -var enable_cloudflare_resources=true \
  -var enable_cloudflare_worker_script=true \
  -var cloudflare_account_id=<id> \
  -var cloudflare_workers_subdomain=<subdomain>
```

`git_token_signing_key` is the shared HMAC key (generated when empty), emitted as
the **sensitive** `takos_git_signing_key` output that the Takosumi git credential
issuer reads to mint per-consumer clone tokens; the same value is injected into
the Worker as `GIT_TOKEN_SIGNING_KEY`.
