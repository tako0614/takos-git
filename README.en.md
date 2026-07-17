日本語: [README.md](README.md)

# takos-git

A standalone, installable **collaborative Git hosting product**. It serves
standard `git clone`, `fetch`, and `push` from an R2 object store and publishes
a Workspace-bound browser, hosting API, and repository-management MCP server.
It is a plain OpenTofu module + prebuilt Cloudflare Worker, installed through
Takosumi like any other Capsule.

This is a separate, lower-level primitive from product-specific workspace
filesystem services. It publishes `source.git.smart_http` and
`source.git.hosting`, distinct from `storage.object`, plus
`mcp.server` for repository lifecycle calls. The source-owner boundary
and migration toward GitHub-like collaboration are defined in
[`docs/collaborative-hosting.md`](docs/collaborative-hosting.md).

## What it owns

- Git Smart HTTP over an app-owned R2 bucket. Objects are content-addressed
  loose objects; each repo's refs are one JSON document.
- Short-lived `taksrv_` Interface OAuth credentials. Clone/fetch requires
  `source.git.smart_http.read`; push requires
  `source.git.smart_http.write`.
- Receive-pack pack/checksum/delta validation, object-closure checks, atomic
  per-request ref replacement, and fast-forward-only normal branch updates.
- A dependency-free Streamable HTTP MCP endpoint with exactly four tools:
  `git_repo_list`, `git_repo_create`, `git_repo_info`, and `git_repo_delete`.
- A Takosumi Accounts authorization-code + PKCE browser session that requires
  membership in the installed Workspace.
- An authenticated `/api/v1` read API for repositories, branches, recent
  commits, trees, and blobs, exposed through the browser console at `/` and
  `/ui`.

Clone, commit, fetch, and push are deliberately **not** custom MCP tools. An
agent uses an installed computer/sandbox Capsule and normal Git CLI with an
invocation-only Interface credential.

## HTTP surface

| Method | Path                                                 | Permission                                   | Notes                     |
| ------ | ---------------------------------------------------- | -------------------------------------------- | ------------------------- |
| GET    | `/healthz`                                           | —                                            | liveness                  |
| GET    | `/`, `/ui`                                           | —                                            | browser console           |
| GET    | `/api/auth/login`, `/api/auth/callback`              | OIDC                                         | browser sign-in           |
| GET    | `/api/auth/session`                                  | cookie                                       | browser session state     |
| POST   | `/api/auth/logout`                                   | cookie                                       | browser sign-out          |
| GET    | `/api/v1/repos/...`                                  | browser session or `source.git.hosting.read` | repository/code browser   |
| GET    | `/git/<repo>.git/info/refs?service=git-upload-pack`  | `source.git.smart_http.read`                 | clone/fetch advertisement |
| POST   | `/git/<repo>.git/git-upload-pack`                    | `source.git.smart_http.read`                 | clone/fetch packfile      |
| GET    | `/git/<repo>.git/info/refs?service=git-receive-pack` | `source.git.smart_http.write`                | push advertisement        |
| POST   | `/git/<repo>.git/git-receive-pack`                   | `source.git.smart_http.write`                | validated push            |
| POST   | `/mcp`                                               | `mcp.invoke`                                 | repository lifecycle MCP  |

Takosumi-managed Git, hosting, and MCP calls use service-side Interfaces that
explicitly map the ordinary `api_url` / `hosting_api_url` / `mcp_url` Outputs
as resource URIs. Their
declarations list the permissions above, and InterfaceBindings grant only the
needed permissions. The Worker verifies exact audience, scope, Workspace, and
Capsule plus complete Interface, Binding, and positive revision evidence through
Accounts UserInfo. The service-side InstallConfig supplies `APP_WORKSPACE_ID`
and `APP_CAPSULE_ID` through the ordinary non-secret `env` input; declarations
and credentials do not enter Outputs.

An explicitly supplied `PUBLISHED_MCP_AUTH_TOKEN` is retained only as
standalone direct/self-host MCP authentication. It is not InterfaceBinding
delivery and is never exposed as an Output. Empty configuration creates no
static credential.

The service-side `interfaceBlueprints` declaration is explicit (the binding
subject is selected after install):

| Interface type          | Resource URI input | Supported InterfaceBinding permissions                      |
| ----------------------- | ------------------ | ----------------------------------------------------------- |
| `source.git.smart_http` | `api_url`          | `source.git.smart_http.read`, `source.git.smart_http.write` |
| `source.git.hosting`    | `hosting_api_url`  | `source.git.hosting.read`                                   |
| `mcp.server`            | `mcp_url`          | `mcp.invoke`                                                |

To enable browser sign-in, provide `takosumi_accounts_issuer_url`,
`takosumi_accounts_client_id`, and an `app_session_secret` of at least 32
characters together. Confidential clients also receive
`takosumi_accounts_client_secret` as a secret input. A managed InstallConfig
explicitly supplies `env.APP_WORKSPACE_ID` and `env.APP_CAPSULE_ID`; secrets do
not enter the repository or Outputs.

## Develop

```sh
bun test              # unit + real Git CLI clone/push/reclone E2E
bun run check         # typecheck
bun run build:worker  # emit local dist/worker.js for self-host applies
tofu fmt -check
tofu validate
```

Post-deploy smoke uses separate `TAKOS_GIT_MCP_TOKEN`,
`TAKOS_GIT_READ_TOKEN`, and `TAKOS_GIT_WRITE_TOKEN` values because exact scopes
are not interchangeable. Supplying `TAKOS_GIT_HOSTING_READ_TOKEN` also checks
`/api/v1`. The old `TAKOS_GIT_ACCESS_TOKEN` is migration fallback only and is
not used by new InterfaceBindings.

## Deploy (OpenTofu)

The module is inert until its Cloudflare feature flags are enabled:

```sh
tofu apply \
  -var enable_cloudflare_resources=true \
  -var enable_cloudflare_worker_script=true \
  -var cloudflare_account_id=<id> \
  -var public_url=https://git.example \
  -var takosumi_accounts_issuer_url=https://accounts.example \
  -var 'env={APP_WORKSPACE_ID="<workspace-id>",APP_CAPSULE_ID="<capsule-id>"}'
```

`public_url` and `takosumi_accounts_issuer_url` are bare HTTPS origins with no
userinfo, path, query, or fragment (a trailing slash is canonicalized away).

Hosted installs consume `worker_bundle_url` + `worker_bundle_sha256` from a Git
release or CI artifact. Do not commit `dist/worker.js`.

Repository objects are isolated below a repository-owned object prefix, so the
normal repository delete API removes all data owned by that repository. The
Cloudflare provider cannot delete a non-empty R2 bucket. For Takosumi-managed
runs, the operator therefore stores a versioned `pre_destroy` lifecycle action
and explicit policy in the service-side InstallConfig. Non-secret target values
such as the bucket name are explicit service configuration. Takosumi contains
no Git-specific cleanup logic and never infers commands or credentials from an
OpenTofu Output.

The lifecycle action runs `bun run git:pre-destroy`. It reads the allowlisted
`cloudflare_account_id`, `object_bucket_name`, and optional
`actions_logs_bucket_name` from `TAKOSUMI_OUTPUTS_JSON`. Managed runners also
deliver validated non-secret provider configuration (including `base_url`) as
`TAKOSUMI_PROVIDER_CONFIGS_JSON`; direct Cloudflare runs must explicitly set
`TAKOS_GIT_CLOUDFLARE_API_MODE=direct`. An unresolved API base fails before the
provider token is sent anywhere. The action empties both buckets in bounded
pages and removes every temporary cleaner before returning.

Standalone direct/self-host clients may explicitly supply
`published_mcp_auth_token` from external secret management. The module injects
it as Worker-internal `PUBLISHED_MCP_AUTH_TOKEN` material and never exposes it
as an Output. Empty configuration creates no static credential.
