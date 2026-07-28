# Takos Git — self-host / operator deployment reference

This reference is for an operator deploying takos-git (the collaborative forge
+ self-hosted Actions) into infrastructure that operator controls. It is not
the Takos ecosystem's official artifact-publication or hosted-production
deploy path. GitHub Actions in this repository neither deploys nor publishes.
An ecosystem surface is deployed by this repository's own entrypoint, which does
not exist yet; writing it is the next step. The shared rules live in
`takos-control/engineering.policy.json` → `deploy`.

**Secrets and the `tofu apply` are run in the operator environment, never
committed.** The OpenTofu module creates nothing until the enable flags below
are set.

takos-git is an installable Capsule: normally Takosumi runs the `tofu apply` + the
wrangler steps for you during install. This runbook documents the same sequence for
a direct/self-host deploy.

## What each layer owns

| Layer | Created by | Notes |
| --- | --- | --- |
| Worker script + bindings, R2 buckets, D1 database, Queue, DO namespaces | `tofu apply` (`main.tf`) | provider 5.19.1 — DO/queue configured inside `cloudflare_workers_script` |
| D1 schema | released Worker self-migration | forward-only `schema_migrations` ledger; no separate wrangler migration step |
| Actions runner **container image** attach | `wrangler` `[[containers]]` step reading the `actions_runner_container` output | provider 5.19.1 has **no** container attribute — this is the one part tofu can't express |
| Self-contained Worker (`dist/worker.js`) + embedded-SPA evidence (`dist/embedded-spa-assets.json`) | operator-selected local build or deploy-published immutable artifact (`worker_bundle_url` + `worker_bundle_sha256`) | `dist/` is not committed; candidate preparation hash-probes the Worker index/module assets |
| Human identity + short-lived Interface credentials | Takosumi Accounts (OIDC) | issuer/client registered out of band |

## 0. Prerequisites

- A Cloudflare account id (Workers Paid — Containers + Durable Objects + D1 + R2 + Queues).
- A Takosumi Accounts **OIDC client** for this deployment: `client_id`, optional
  `client_secret` (confidential client), and the redirect URI
  `https://<public-host>/api/auth/callback` in its `redirectUris`.
- The install-target **Workspace id** (`APP_WORKSPACE_ID`) — only its members can sign in.
- The install-target **Capsule id** (`APP_CAPSULE_ID`).
- A random **`app_session_secret`** ≥ 32 chars (session cookie HMAC).
- A random **`webhook_secret_key`** ≥ 32 chars — seals per-webhook secrets at rest and
  signs every outbound delivery. Required whenever `enable_metadata=true`, including an
  automation-only install with no browser sign-in; `app_session_secret` is accepted as
  the fallback only when browser auth is fully configured. takos-git delivers **only**
  HMAC-signed webhooks: without a usable key, deliveries are recorded `failed`
  (`signing_unconfigured`) rather than sent unsigned.
- Random **`actions_runner_secret`** (HMAC for the `/internal/actions/*` runner routes)
  and **`actions_secrets_key`** (AES key for workflow-secret encryption at rest) — only
  needed when `enable_actions=true`.
- A reviewed Worker candidate. A self-host operator may run `bun run build`
  locally; an official release must use a deploy-published immutable
  candidate. Repository CI does not publish either form. A missing, empty, or
  inconsistent SPA fails the Worker build.
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
  -var webhook_secret_key=<32+ char secret> \
  -var worker_bundle_sha256=<worker.js.sha256 from the release> \
  -var 'env={APP_WORKSPACE_ID="<workspace-id>",APP_CAPSULE_ID="<capsule-id>"}' \
  -var takosumi_accounts_client_secret=<secret>
```

Omit `takosumi_accounts_client_secret` for a public PKCE client.

`worker_bundle_sha256` is **not optional on the default `worker_release_tag` path**.
The release manifest is fetched over a mutable tag with no signature, so it selects
the bundle URL but is never trusted for the digest — otherwise anyone who can
re-point that tag ships a Worker holding the R2 objects bucket plus
`APP_SESSION_SECRET` / `WEBHOOK_SECRET_KEY` / `ACTIONS_*`. Take the digest from the
release's `worker.js.sha256` and pin it here.

Add self-hosted Actions:

```sh
  -var enable_actions=true \
  -var actions_runner_secret=<hmac> \
  -var actions_secrets_key=<aes-key> \
  -var actions_runner_image=<registry/image:tag> \
  -var actions_runner_max_instances=10 \
  -var actions_container_binding_applied=true
```

> **Actions execution is not deployable yet.** `actions_container_binding_applied`
> attests that the runner Container is really attached — both the `[[containers]]`
> wrangler step (step 3) **and** a Worker bundle that ships the
> `@cloudflare/containers` runtime. takos-git does not depend on that package today,
> so `ActionsJobRunner` cannot load a container and every dispatched job fails
> immediately. The precondition keeps that failure at plan time instead of turning
> every CI run red. Leave `enable_actions=false` until the dependency lands.
>
> Runner **egress and CPU/memory are not enforced by takos-git.** `RunnerPolicy`
> (`src/features/actions/runner/policy.ts`) only covers what this Worker enforces:
> concurrency, job/step timeouts, and the log/artifact byte caps. The default-deny
> egress and the CPU/memory ceiling in `RUNNER_CONTAINER_REQUIREMENTS` must be applied
> by the container platform in the same out-of-band step; until then a `run:` step
> reaches the network unrestricted.

`enable_metadata=true` provisions the D1 database that the whole collaboration
surface (ACL, issues, PRs, releases, …) needs. Without it the Worker still serves
Git Smart-HTTP (scope-only) + MCP, but `/api/v1` returns 503 and the SPA has no data.

The module also registers a one-minute scheduled trigger. It drains bounded
batches of leased webhook deliveries and repository-deletion records; the same
drains may run opportunistically on requests, and the leases make concurrent
invocations safe.

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

For a direct/self-host install, keep the rendered configuration in the
operator-owned apply process. For a hosted deploy, the configuration is input to
this repository's deploy entrypoint. There is no credentialed workflow and no
second raw Wrangler publication path.

## 4. Worker secrets

`APP_SESSION_SECRET`, `OIDC_CLIENT_SECRET`, `WEBHOOK_SECRET_KEY`,
`ACTIONS_RUNNER_SECRET`, `ACTIONS_SECRETS_KEY` and `PUBLISHED_MCP_AUTH_TOKEN` are
`secret_text` bindings the module itself writes from its sensitive variables, so supply
them as `-var` values from the operator environment (`.secrets/<env>/`), never as literals
in a committed `.tfvars`. Do **not** push them separately with `wrangler secret put`: the
next apply replaces the script's binding set and would drop an out-of-band secret.

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
