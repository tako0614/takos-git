# Takos Git — production deploy runbook

This is the operator runbook for deploying takos-git (the GitHub-parity forge +
self-hosted Actions) to Cloudflare. **Secrets and the `tofu apply` are run in the
operator environment, never committed** (see the ecosystem `CLAUDE.md`). The
OpenTofu module creates nothing until the enable flags below are set.

takos-git is an installable Capsule: normally Takosumi runs the `tofu apply` + the
wrangler steps for you during install. This runbook documents the same sequence for
a direct/self-host deploy.

## What each layer owns

| Layer | Created by | Notes |
| --- | --- | --- |
| Worker script + bindings, R2 buckets, D1 database, Queue, DO namespaces | `tofu apply` (`main.tf`) | provider 5.19.1 — DO/queue configured inside `cloudflare_workers_script` |
| D1 schema | released Worker self-migration | forward-only `schema_migrations` ledger; no separate wrangler migration step |
| Actions runner **container image** attach | `wrangler` `[[containers]]` step reading the `actions_runner_container` output | provider 5.19.1 has **no** container attribute — this is the one part tofu can't express |
| Worker code bundle (`dist/worker.js`) + SPA (`web/dist`) | CI/release artifact (`worker_bundle_url` + `worker_bundle_sha256`) | `dist/` is not committed |
| Human identity + short-lived Interface credentials | Takosumi Accounts (OIDC) | issuer/client registered out of band |

## 0. Prerequisites

- A Cloudflare account id (Workers Paid — Containers + Durable Objects + D1 + R2 + Queues).
- A Takosumi Accounts **OIDC client** for this deployment: `client_id`, optional
  `client_secret` (confidential client), and the redirect URI
  `https://<public-host>/api/auth/callback` in its `redirectUris`.
- The install-target **Workspace id** (`APP_WORKSPACE_ID`) — only its members can sign in.
- The install-target **Capsule id** (`APP_CAPSULE_ID`).
- A random **`app_session_secret`** ≥ 32 chars (session cookie HMAC).
- Random **`actions_runner_secret`** (HMAC for the `/internal/actions/*` runner routes)
  and **`actions_secrets_key`** (AES key for workflow-secret encryption at rest) — only
  needed when `enable_actions=true`.
- Built artifacts: `bun run build:worker` (→ `dist/worker.js`) and `bun run build:web`
  (→ `web/dist`), published as a release/CI artifact with its SHA-256.
- The runner image built + pushed to a registry: `docker build containers/runner` (only
  when Actions execution is wanted).

Keep every secret in the operator environment (e.g. `.secrets/<env>/`), never in any repo.

## 1. `tofu apply`

Minimum (git hosting + metadata + web UI, no Actions execution yet):

```sh
tofu apply \
  -var enable_cloudflare_resources=true \
  -var enable_cloudflare_worker_script=true \
  -var enable_metadata=true \
  -var cloudflare_account_id=<id> \
  -var public_url=https://git.example.com \
  -var takosumi_accounts_issuer_url=<issuer> \
  -var takosumi_accounts_client_id=<client-id> \
  -var app_session_secret=<32+ char secret> \
  -var 'env={APP_WORKSPACE_ID="<workspace-id>",APP_CAPSULE_ID="<capsule-id>"}' \
  -var takosumi_accounts_client_secret=<secret>
```

Omit `takosumi_accounts_client_secret` for a public PKCE client.

Add self-hosted Actions:

```sh
  -var enable_actions=true \
  -var actions_runner_secret=<hmac> \
  -var actions_secrets_key=<aes-key> \
  -var actions_runner_image=<registry/image:tag> \
  -var actions_runner_max_instances=10
```

`enable_metadata=true` provisions the D1 database that the whole collaboration
surface (ACL, issues, PRs, releases, …) needs. Without it the Worker still serves
Git Smart-HTTP (scope-only) + MCP, but `/api/v1` returns 503 and the SPA has no data.

Read the outputs: `launch_url`, `api_url`, `hosting_api_url`, `mcp_url`,
`metadata_database_id`, and (when Actions on) `actions_runner_container`.

## 2. Verify the self-applied D1 schema

The released Worker embeds the forward-only migrations and applies them
idempotently on its first D1-backed request. Call `GET /api/v1/ping` and verify a
non-500 response; no separate `wrangler d1 migrations apply` step is part of the
Capsule install.

## 3. Attach the Actions runner container (Actions only)

The provider can't bind a container image, so finish it with wrangler, reading the
tofu outputs. In the Worker's wrangler config:

```toml
[[containers]]
class_name     = "ActionsJobRunner"       # the DO the tofu migration already declares
image          = "<actions_runner_image output>"
max_instances  = 10                        # <actions_runner_max_instances>

[[queues.consumers]]
queue          = "<workflow queue name>"   # binds the run-tick queue → ActionsRunCoordinator
```

Then `wrangler deploy` (or the operator's managed publish) so the container image and
queue consumer attach to the already-provisioned DO namespaces + queue.

## 4. Set secrets on the Worker

Push the non-tofu secrets as Worker secrets (never in `main.tf` state):
`APP_SESSION_SECRET`, `OIDC_CLIENT_SECRET` (confidential), `ACTIONS_RUNNER_SECRET`,
`ACTIONS_SECRETS_KEY`, and `PUBLISHED_MCP_AUTH_TOKEN` if a standalone MCP bearer is wanted.

## 5. Smoke checklist

- `GET /healthz` → 200.
- `GET /` → the SPA home (repo list). `GET /icons/takos-git.svg` → the launcher tile.
- Sign in via Takosumi Accounts (member of `APP_WORKSPACE_ID`) → avatar shows; a
  non-member is rejected at `/api/auth/callback`.
- Create a repo (SPA **New**, or `POST /api/v1/repos`, or MCP `git_repo_create`), then
  `git clone`/`push` with a short-lived Interface credential (username ignored, credential
  as the HTTP-Basic password).
- Private repo → 404 to a non-collaborator; public repo → anonymous read.
- Open an issue + PR, request review, merge (respecting branch protection).
- With Actions on: push a `.github/workflows/ci.yml` → a run + queued check-run appears;
  the runner container executes `run:` steps and the check-run flips to success/failure.
- Provider-side secrets absent from `tofu output` / repo (`tofu output` shows only ids/urls).

## Notes / current limits

- Full GitHub REST/GraphQL/Actions wire-compat is **not** a goal; surfaces are versioned.
- `uses:` in the runner covers `checkout` + `upload-artifact` + `download-artifact`;
  `cache`/`setup-*` are follow-ups.
- Webhook auto-fire is wired for issues/pulls/releases/forks; GitHub-compatible signatures
  are not a goal (documented HMAC scheme).
- Smart-HTTP enforces per-repo ACL only when the metadata plane (D1) is present; a
  metadata-less deploy degrades to scope-only Git hosting.
