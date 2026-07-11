# takos-git

A standalone, installable **Git Smart HTTP service**. It serves standard
`git clone`, `fetch`, and `push` from an R2 object store and publishes a small
repository-management MCP server. It is a plain OpenTofu module + prebuilt
Cloudflare Worker, installed through Takosumi like any other Capsule.

This is a separate, lower-level primitive from product-specific workspace
filesystem services. It publishes `source.git.smart_http`, distinct from
`storage.object`, plus `protocol.mcp.server` for repository lifecycle calls.

## What it owns

- Git Smart HTTP over an app-owned R2 bucket. Objects are content-addressed
  loose objects; each repo's refs are one JSON document.
- Scoped `tksvc_` grants minted by Takosumi. `r` authorizes upload-pack and `w`
  authorizes receive-pack, both limited to the signed repository prefix.
- Receive-pack pack/checksum/delta validation, object-closure checks, atomic
  per-request ref replacement, and fast-forward-only normal branch updates.
- A dependency-free Streamable HTTP MCP endpoint with exactly four tools:
  `git_repo_list`, `git_repo_create`, `git_repo_info`, and `git_repo_delete`.
- A small browser console at `/` and `/ui` for service health, refs, and clone
  command discovery.

Clone, commit, fetch, and push are deliberately **not** custom MCP tools. An
agent uses an installed computer/sandbox Capsule and normal Git CLI with a
scoped credential.

## HTTP surface

| Method | Path                                                   | Scope | Notes |
| ------ | ------------------------------------------------------ | ----- | ----- |
| GET    | `/healthz`                                             | —     | liveness |
| GET    | `/`, `/ui`                                             | —     | browser console |
| GET    | `/git/<repo>.git/info/refs?service=git-upload-pack`    | `r`   | clone/fetch advertisement |
| POST   | `/git/<repo>.git/git-upload-pack`                      | `r`   | clone/fetch packfile |
| GET    | `/git/<repo>.git/info/refs?service=git-receive-pack`   | `w`   | push advertisement |
| POST   | `/git/<repo>.git/git-receive-pack`                     | `w`   | validated push |
| POST   | `/mcp`                                                 | Bearer | repository lifecycle MCP |

The MCP publication gets a generated `PUBLISHED_MCP_AUTH_TOKEN` secret scoped
to that installed Capsule. `/mcp` also accepts signed service grants; those
calls are filtered by the grant's Workspace repo prefix and `r`/`w` verbs.

## Develop

```sh
bun test              # unit + real Git CLI clone/push/reclone E2E
bun run check         # typecheck
bun run build:worker  # emit local dist/worker.js for self-host applies
tofu fmt -check
tofu validate
```

## Deploy (OpenTofu)

The module is inert until its Cloudflare feature flags are enabled:

```sh
tofu apply \
  -var enable_cloudflare_resources=true \
  -var enable_cloudflare_worker_script=true \
  -var cloudflare_account_id=<id> \
  -var public_subdomain=<service-subdomain> \
  -var cloudflare_workers_subdomain=<workers-dev-subdomain>
```

Hosted installs consume `worker_bundle_url` + `worker_bundle_sha256` from a Git
release or CI artifact. Do not commit `dist/worker.js`.

`service_grant_signing_key` is emitted only as a sensitive output for the
Takosumi grant issuer and injected into the Worker as
`GIT_TOKEN_SIGNING_KEY`. The generated MCP bearer is likewise sensitive and is
injected as `PUBLISHED_MCP_AUTH_TOKEN`.
