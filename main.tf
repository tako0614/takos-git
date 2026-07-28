terraform {
  required_version = ">= 1.5"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "= 5.19.1"
    }
    http = {
      source  = "hashicorp/http"
      version = "= 3.6.0"
    }
    # Declared (pinned to the runner provider-mirror version) ONLY so an upgrade
    # from a pre-0.4 install can destroy the orphaned random_id.signing_key /
    # random_id.mcp_auth_token resources still in its state. v0.4+ creates no
    # random_* resources (secrets are operator-provided); this can be removed once
    # no installs carry the legacy resources.
    random = {
      source  = "hashicorp/random"
      version = "= 3.9.0"
    }
  }
}

variable "enable_cloudflare_resources" {
  description = "Provision the takos-git Cloudflare backing resources (R2 bucket) with the cloudflare/cloudflare provider."
  type        = bool
  default     = false
}

variable "cloudflare_account_id" {
  description = "Cloudflare account id used when enable_cloudflare_resources is true."
  type        = string
  default     = ""

  validation {
    condition     = !var.enable_cloudflare_resources || trimspace(var.cloudflare_account_id) != ""
    error_message = "cloudflare_account_id is required when enable_cloudflare_resources is true."
  }
}

variable "project_name" {
  description = "Prefix for takos-git backing resource names."
  type        = string
  default     = "takos-git"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,50}[a-z0-9]$", var.project_name))
    error_message = "project_name must be 3-52 lowercase letters, numbers, or hyphens, and start/end with an alphanumeric character."
  }
}

variable "public_subdomain" {
  description = "Public subdomain label used for the hosted service. Defaults to project_name."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.public_subdomain) == "" || can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", var.public_subdomain))
    error_message = "public_subdomain must be empty or a 1-63 character lowercase DNS label."
  }
}

variable "public_url" {
  description = "Canonical HTTPS origin for the git service (an optional trailing slash is removed). When empty, launch_url is derived from public_subdomain and cloudflare_workers_subdomain."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.public_url) == "" || can(regex("^https://([A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?|\\[[0-9A-Fa-f:]+\\])(:[0-9]{1,5})?/?$", trimspace(var.public_url)))
    error_message = "public_url must be empty or a bare HTTPS origin with no userinfo, path, query, or fragment."
  }
}

variable "takosumi_accounts_issuer_url" {
  description = "Bare HTTPS Takosumi Accounts issuer origin (an optional trailing slash is removed) used for browser sign-in and Interface OAuth UserInfo validation."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.takosumi_accounts_issuer_url) == "" || can(regex("^https://([A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?|\\[[0-9A-Fa-f:]+\\])(:[0-9]{1,5})?/?$", trimspace(var.takosumi_accounts_issuer_url)))
    error_message = "takosumi_accounts_issuer_url must be empty or a bare HTTPS origin with no userinfo, path, query, or fragment."
  }
}

variable "takosumi_accounts_client_id" {
  description = "Optional OIDC client id for the takos-git browser session. Set it together with app_session_secret and takosumi_accounts_issuer_url."
  type        = string
  default     = ""
}

variable "takosumi_accounts_client_secret" {
  description = "Optional confidential OIDC client secret for the takos-git browser session. Public PKCE clients may leave this empty."
  type        = string
  default     = ""
  sensitive   = true
}

variable "app_session_secret" {
  description = "HMAC secret for the takos-git browser OAuth state and session cookies. Required when takosumi_accounts_client_id is set."
  type        = string
  default     = ""
  sensitive   = true

  validation {
    condition     = trimspace(var.app_session_secret) == "" || length(var.app_session_secret) >= 32
    error_message = "app_session_secret must be empty or at least 32 characters."
  }
}

variable "webhook_secret_key" {
  description = "Key material sealing per-webhook HMAC secrets at rest and signing every outbound delivery (Worker secret WEBHOOK_SECRET_KEY). Independent of browser auth: an automation-only install (Interface OAuth, no app_session_secret) still reaches the webhook API and must be able to sign. Required whenever enable_metadata is true; app_session_secret is accepted as the fallback for a single-secret deploy."
  type        = string
  default     = ""
  sensitive   = true

  validation {
    condition     = trimspace(var.webhook_secret_key) == "" || length(var.webhook_secret_key) >= 32
    error_message = "webhook_secret_key must be empty or at least 32 characters."
  }
}

variable "published_mcp_auth_token" {
  description = "Optional standalone bearer protecting /mcp for direct/self-host clients. When empty, only Interface OAuth is accepted and no static bearer is provisioned."
  type        = string
  default     = ""
  sensitive   = true

  validation {
    condition     = trimspace(var.published_mcp_auth_token) == "" || length(trimspace(var.published_mcp_auth_token)) >= 32
    error_message = "published_mcp_auth_token must be empty or at least 32 characters."
  }
}

variable "env" {
  description = "Additional non-secret Worker environment variables projected as plain_text bindings. Secrets must use dedicated sensitive variables or Provider Connections."
  type        = map(string)
  default     = {}

  validation {
    condition = alltrue([
      for name, value in var.env :
      can(regex("^[A-Z_][A-Z0-9_]{0,127}$", name)) &&
      !can(regex("(SECRET|TOKEN|PASSWORD|CREDENTIAL|PRIVATE_?KEY|API_?KEY)", upper(name))) &&
      !contains([
        "BUCKET",
        "APP_URL",
        "OIDC_ISSUER_URL",
        "OIDC_CLIENT_ID",
        "OIDC_CLIENT_SECRET",
        "APP_SESSION_SECRET",
        "PUBLISHED_MCP_AUTH_TOKEN",
        "WEBHOOK_SECRET_KEY",
      ], name)
    ])
    error_message = "env keys must be uppercase Worker plain-text variable names and must not be secret-like or reserved by the takos-git module."
  }
}

variable "cloudflare_workers_subdomain" {
  description = "Cloudflare workers.dev subdomain used to derive launch_url for Worker-dev deployments."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.cloudflare_workers_subdomain) == "" || can(regex("^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$", var.cloudflare_workers_subdomain))
    error_message = "cloudflare_workers_subdomain must be empty or a valid workers.dev subdomain label."
  }
}

variable "enable_cloudflare_worker_script" {
  description = "Deploy the takos-git Worker script, bindings, route, and optional workers.dev enablement through OpenTofu."
  type        = bool
  default     = false
}

variable "enable_metadata" {
  description = "Provision the D1 metadata plane (repositories, ACL, issues, PRs, releases, Actions state) and bind it to the Worker as DB. Git objects and refs stay authoritative in R2; D1 is fully rebuildable from R2 for every git-derived table. Off by default keeps takos-git R2-only."
  type        = bool
  default     = false
}

variable "enable_actions" {
  description = "Provision the self-hosted Actions runner backing resources (Workflow Queue + Dead-Letter Queue, the runner-coordinator and job-runner Durable Object namespaces, and the Actions logs/artifacts R2 bucket) and bind them to the Worker. Requires enable_metadata, enable_cloudflare_worker_script, and actions_container_binding_applied. Off by default keeps takos-git a single-file, R2-only Worker with no Container/DO/Queue bindings. Runner egress and CPU/memory are enforced only by the container platform, never by takos-git: a `run:` step reaches the network unrestricted unless the `[[containers]]` step applies the RUNNER_CONTAINER_REQUIREMENTS shape."
  type        = bool
  default     = false
}

variable "actions_runner_secret" {
  description = "HMAC key for the run-scoped /internal/actions/* routes and runner tokens. Required when enable_actions is true. Kept out of any repo; supplied from the operator environment."
  type        = string
  default     = ""
  sensitive   = true

  validation {
    condition     = trimspace(var.actions_runner_secret) == "" || length(var.actions_runner_secret) >= 32
    error_message = "actions_runner_secret must be empty or at least 32 characters."
  }
}

variable "actions_secrets_key" {
  description = "AES key used to encrypt Actions secrets at rest in D1. Required when enable_actions is true. Kept out of any repo; supplied from the operator environment."
  type        = string
  default     = ""
  sensitive   = true

  validation {
    condition     = trimspace(var.actions_secrets_key) == "" || length(var.actions_secrets_key) >= 32
    error_message = "actions_secrets_key must be empty or at least 32 characters."
  }
}

variable "actions_runner_image" {
  description = "Container image ref for the self-hosted Actions runner (built from containers/runner/Dockerfile and pushed by takos-git CI). Attached to the ActionsJobRunner Durable Object class through a wrangler `[[containers]]` step; the cloudflare provider 5.19.1 cannot express a container image binding. Informational for OpenTofu (surfaced as an output for the wrangler step)."
  type        = string
  default     = ""
}

variable "actions_container_binding_applied" {
  description = "Operator attestation that the runner Container is actually attached: the `[[containers]]` wrangler step has been applied for this Worker AND the deployed bundle ships the `@cloudflare/containers` runtime. Both are out-of-band (the cloudflare provider 5.19.1 has no `containers` attribute, and the takos-git bundle does not depend on `@cloudflare/containers` today), and without them EVERY Actions job fails at dispatch. enable_actions is refused while this is false so the failure lands at plan time instead of on every CI run."
  type        = bool
  default     = false
}

variable "actions_runner_max_instances" {
  description = "Maximum concurrent runner Container instances (wrangler `[[containers]].max_instances`). Applied by the wrangler container step, not by OpenTofu."
  type        = number
  default     = 10

  validation {
    condition     = var.actions_runner_max_instances >= 1 && var.actions_runner_max_instances <= 1000
    error_message = "actions_runner_max_instances must be between 1 and 1000."
  }
}

variable "worker_bundle_path" {
  description = "Local path to a source-built Worker module JS file. Used only when worker_release_tag and worker_bundle_url are both empty."
  type        = string
  default     = "dist/worker.js"
}

variable "worker_release_tag" {
  description = "Release tag selected from the append-only release.lock.json. The lock pins both the manifest and Worker artifact; unlisted tags are rejected. Set empty to use worker_bundle_path."
  type        = string
  default     = "v0.5.1"

  validation {
    condition     = trimspace(var.worker_release_tag) == "" || can(regex("^v[0-9]+\\.[0-9]+\\.[0-9]+([-+][0-9A-Za-z.-]+)?$", trimspace(var.worker_release_tag)))
    error_message = "worker_release_tag must be empty or a SemVer-like Git tag beginning with v."
  }
}

variable "worker_bundle_url" {
  description = "Optional HTTPS URL for a prebuilt Worker module JS artifact. When set, OpenTofu downloads it and verifies worker_bundle_sha256 before upload."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.worker_bundle_url) == "" || can(regex("^https://[^[:space:]]+$", trimspace(var.worker_bundle_url)))
    error_message = "worker_bundle_url must be empty or an https URL."
  }
}

variable "worker_bundle_sha256" {
  description = "Explicit SHA-256 assertion for the Worker module JS. Required with worker_bundle_url; optional with worker_release_tag but, when supplied, must equal the release.lock.json digest. Accepts lowercase hex or sha256:<hex>."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.worker_bundle_sha256) == "" || can(regex("^(sha256:)?[a-f0-9]{64}$", trimspace(var.worker_bundle_sha256)))
    error_message = "worker_bundle_sha256 must be empty, a lowercase 64-character hex SHA-256 digest, or sha256:<hex>."
  }
}

variable "worker_main_module" {
  description = "Module name used as the Cloudflare Worker main module when uploading worker_bundle_path."
  type        = string
  default     = "worker.js"
}

variable "enable_workers_dev_subdomain" {
  description = "Enable the Worker on the account's workers.dev subdomain when enable_cloudflare_worker_script is true."
  type        = bool
  default     = true
}

variable "cloudflare_route_zone_id" {
  description = "Optional Cloudflare zone id used to create a Worker route. For Takosumi Cloud compat this is the virtual zone id."
  type        = string
  default     = ""
}

variable "cloudflare_route_pattern" {
  description = "Optional Worker route pattern, for example git.app.takos.jp/*."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.cloudflare_route_pattern) == "" || can(regex("^[^[:space:]]+/\\*$", trimspace(var.cloudflare_route_pattern)))
    error_message = "cloudflare_route_pattern must be empty or a Worker route pattern ending in /*."
  }
}

variable "worker_compatibility_date" {
  description = "Cloudflare Workers compatibility date for the OpenTofu-managed Worker script."
  type        = string
  default     = "2026-04-01"
}

variable "worker_compatibility_flags" {
  description = "Cloudflare Workers compatibility flags for the OpenTofu-managed Worker script."
  type        = set(string)
  default     = ["global_fetch_strictly_public"]
}

locals {
  cloudflare_resources_enabled = var.enable_cloudflare_resources
  cloudflare_worker_enabled    = local.cloudflare_resources_enabled && var.enable_cloudflare_worker_script
  metadata_enabled             = local.cloudflare_resources_enabled && var.enable_metadata
  actions_enabled              = local.cloudflare_resources_enabled && var.enable_actions
  cloudflare_route_enabled     = local.cloudflare_worker_enabled && trimspace(var.cloudflare_route_zone_id) != "" && trimspace(var.cloudflare_route_pattern) != ""
  # A release tag is only a selector. The checked-in, append-only lock owns the
  # executable URL and both expected digests; the remotely fetched manifest is
  # validated against the lock and can never authorize its own artifact.
  worker_release_lock                     = jsondecode(file("${path.module}/release.lock.json"))
  worker_release_tag                      = trimspace(var.worker_release_tag)
  worker_bundle_explicit_url              = trimspace(var.worker_bundle_url)
  worker_bundle_sha256_input              = trimspace(var.worker_bundle_sha256)
  worker_bundle_sha256_assertion          = startswith(local.worker_bundle_sha256_input, "sha256:") ? replace(local.worker_bundle_sha256_input, "sha256:", "") : local.worker_bundle_sha256_input
  worker_release_requested                = local.cloudflare_worker_enabled && local.worker_bundle_explicit_url == "" && local.worker_release_tag != ""
  worker_release_pin                      = try(local.worker_release_lock.releases[local.worker_release_tag], null)
  worker_release_pinned                   = local.worker_release_pin != null
  worker_bundle_uses_release_pin          = local.worker_release_requested && local.worker_release_pinned
  worker_bundle_uses_explicit_url         = local.cloudflare_worker_enabled && local.worker_bundle_explicit_url != ""
  worker_release_artifact_filename        = try(local.worker_release_pin.artifact.filename, "")
  worker_release_artifact_url             = try(local.worker_release_pin.artifact.url, "")
  worker_release_artifact_sha256_input    = try(local.worker_release_pin.artifact.sha256, "")
  worker_release_artifact_expected_sha256 = startswith(local.worker_release_artifact_sha256_input, "sha256:") ? replace(local.worker_release_artifact_sha256_input, "sha256:", "") : local.worker_release_artifact_sha256_input
  worker_release_manifest_url             = try(local.worker_release_pin.manifest.url, "")
  worker_release_manifest_sha256_input    = try(local.worker_release_pin.manifest.sha256, "")
  worker_release_manifest_expected_sha256 = startswith(local.worker_release_manifest_sha256_input, "sha256:") ? replace(local.worker_release_manifest_sha256_input, "sha256:", "") : local.worker_release_manifest_sha256_input
  worker_release_manifest                 = local.worker_bundle_uses_release_pin ? jsondecode(data.http.worker_release_manifest[0].response_body) : null
  worker_release_manifest_digest          = local.worker_bundle_uses_release_pin ? sha256(data.http.worker_release_manifest[0].response_body) : ""
  worker_bundle_url                       = local.worker_bundle_uses_explicit_url ? local.worker_bundle_explicit_url : (local.worker_bundle_uses_release_pin ? local.worker_release_artifact_url : "")
  worker_bundle_uses_url                  = local.cloudflare_worker_enabled && local.worker_bundle_url != ""
  worker_bundle_local_path                = startswith(var.worker_bundle_path, "/") ? var.worker_bundle_path : "${path.module}/${var.worker_bundle_path}"
  worker_bundle_body                      = local.worker_bundle_uses_url ? data.http.worker_bundle[0].response_body : (local.worker_release_requested ? "" : null)
  worker_bundle_content_sha256            = local.cloudflare_worker_enabled ? (local.worker_bundle_uses_url ? sha256(data.http.worker_bundle[0].response_body) : (local.worker_release_requested ? sha256("") : filesha256(local.worker_bundle_local_path))) : null

  resource_prefix        = var.project_name
  public_subdomain       = trimspace(var.public_subdomain) != "" ? trimspace(var.public_subdomain) : local.resource_prefix
  runtime_name           = local.public_subdomain
  workers_dev_url        = trimspace(var.cloudflare_workers_subdomain) != "" ? "https://${local.public_subdomain}.${trimspace(var.cloudflare_workers_subdomain)}.workers.dev" : null
  public_origin          = trimsuffix(trimspace(var.public_url), "/")
  launch_url             = local.public_origin != "" ? local.public_origin : local.workers_dev_url
  accounts_issuer_url    = trimsuffix(trimspace(var.takosumi_accounts_issuer_url), "/")
  accounts_client_id     = trimspace(var.takosumi_accounts_client_id)
  accounts_client_secret = trimspace(var.takosumi_accounts_client_secret)
  app_session_secret     = trimspace(var.app_session_secret)
  app_workspace_id       = trimspace(lookup(var.env, "APP_WORKSPACE_ID", ""))
  app_capsule_id         = trimspace(lookup(var.env, "APP_CAPSULE_ID", ""))
  browser_auth_requested = local.accounts_client_id != "" || local.accounts_client_secret != "" || local.app_session_secret != ""
  browser_auth_ready     = local.accounts_issuer_url != "" && local.accounts_client_id != "" && local.app_session_secret != "" && local.app_workspace_id != ""
  provided_mcp_token     = trimspace(var.published_mcp_auth_token)
  extra_worker_env       = { for name, value in var.env : name => value if trimspace(value) != "" }
  actions_runner_secret  = trimspace(var.actions_runner_secret)
  actions_secrets_key    = trimspace(var.actions_secrets_key)
  webhook_secret_key     = trimspace(var.webhook_secret_key)
  # Signing key actually available to the Worker: the dedicated secret, or the
  # browser-auth session secret that `webhookEncryptionKey()` falls back to.
  webhook_signing_ready = local.webhook_secret_key != "" || (local.browser_auth_ready && local.app_session_secret != "")

  r2_objects_bucket = "${local.resource_prefix}-objects"
  d1_metadata_name  = local.resource_prefix
  r2_actions_bucket = "${local.resource_prefix}-actions"
  workflow_queue    = "${local.resource_prefix}-workflows"
  workflow_dlq      = "${local.resource_prefix}-workflows-dlq"
}

data "http" "worker_release_manifest" {
  count              = local.worker_bundle_uses_release_pin ? 1 : 0
  url                = local.worker_release_manifest_url
  request_timeout_ms = 30000

  request_headers = {
    Accept = "application/json"
  }

  retry {
    attempts     = 3
    min_delay_ms = 500
    max_delay_ms = 5000
  }
}

data "http" "worker_bundle" {
  count              = local.worker_bundle_uses_url ? 1 : 0
  url                = local.worker_bundle_url
  request_timeout_ms = 120000

  request_headers = {
    Accept = "application/javascript, text/javascript, application/octet-stream"
  }

  retry {
    attempts     = 3
    min_delay_ms = 1000
    max_delay_ms = 10000
  }
}

resource "cloudflare_r2_bucket" "objects" {
  count      = local.cloudflare_resources_enabled ? 1 : 0
  account_id = var.cloudflare_account_id
  name       = local.r2_objects_bucket
}

# --- Metadata plane (gated by enable_metadata) -------------------------------
# D1 is the relational metadata plane only; git objects and refs stay in R2 and
# every git-derived table is rebuildable from R2. The released Worker embeds and
# self-applies its forward-only schema through a schema_migrations ledger.
resource "cloudflare_d1_database" "metadata" {
  count      = local.metadata_enabled ? 1 : 0
  account_id = var.cloudflare_account_id
  name       = local.d1_metadata_name
}

# --- Self-hosted Actions runner backing resources (gated by enable_actions) ---
#
# The self-hosted Actions runner is embedded in takos-git's OWN worker:
#   - the run coordinator DO  (ActionsRunCoordinator, SQLite)         — bound below
#   - the per-job Container DO (ActionsJobRunner)                     — bound below
#   - the run-tick queue + DLQ + consumer                            — resources below
#   - the logs/artifacts R2 bucket (R2_ACTIONS)                      — resource below
# All of the above ARE expressed here and provision zero resources unless
# enable_actions is true.
#
# CONTAINER IMAGE — the one part OpenTofu cannot express. The runner Container
# image (built from `containers/runner/Dockerfile`, entrypoint the in-container
# step server `containers/runner/src/executor-main.ts`) attaches to the
# ActionsJobRunner Durable Object class. The cloudflare provider 5.19.1
# `cloudflare_workers_script` schema has NO `containers` attribute, so the image
# binding + `max_instances` MUST be applied out of band with a wrangler
# `[[containers]]` step in takos-git CI, reading `actions_runner_image` /
# `actions_runner_max_instances` from the module outputs:
#
#   # wrangler.toml (generated from the module outputs)
#   [[containers]]
#   class_name     = "ActionsJobRunner"
#   image          = "<actions_runner_image>"
#   max_instances  = <actions_runner_max_instances>
#
# D1 schema migrations self-apply inside the released Worker. The DO namespace +
# the `new_sqlite_classes` migration for both DO classes ARE declared on the worker
# script below.
#
# NOT YET DEPLOYABLE. Two things are missing, not one: the `[[containers]]` image
# attachment above, AND the `@cloudflare/containers` runtime itself — takos-git
# does not depend on it, and `scripts/build-worker.ts` produces a single bundle,
# so `ActionsJobRunner`'s runtime import can never resolve and every dispatched
# job fails immediately. `enable_actions` is therefore gated on the
# `actions_container_binding_applied` attestation below, so an install cannot
# quietly provision the whole Actions binding set and then red-flag every CI run.
# TODO(runner): add the `@cloudflare/containers` dependency to the worker bundle,
# then apply the `[[containers]]` image binding.
resource "cloudflare_queue" "workflows" {
  count      = local.actions_enabled ? 1 : 0
  account_id = var.cloudflare_account_id
  queue_name = local.workflow_queue
}

resource "cloudflare_queue" "workflows_dlq" {
  count      = local.actions_enabled ? 1 : 0
  account_id = var.cloudflare_account_id
  queue_name = local.workflow_dlq
}

resource "cloudflare_queue_consumer" "workflows" {
  count             = local.actions_enabled && local.cloudflare_worker_enabled ? 1 : 0
  account_id        = var.cloudflare_account_id
  queue_id          = cloudflare_queue.workflows[0].queue_id
  type              = "worker"
  script_name       = cloudflare_workers_script.worker[0].script_name
  dead_letter_queue = cloudflare_queue.workflows_dlq[0].queue_name

  settings = {
    batch_size  = 10
    max_retries = 5
  }
}

resource "cloudflare_r2_bucket" "actions" {
  count      = local.actions_enabled ? 1 : 0
  account_id = var.cloudflare_account_id
  name       = local.r2_actions_bucket
}

resource "cloudflare_workers_script" "worker" {
  count               = local.cloudflare_worker_enabled ? 1 : 0
  account_id          = var.cloudflare_account_id
  script_name         = local.runtime_name
  content             = local.worker_bundle_uses_url || local.worker_release_requested ? sensitive(local.worker_bundle_body) : null
  content_file        = local.worker_bundle_uses_url || local.worker_release_requested ? null : local.worker_bundle_local_path
  content_sha256      = local.worker_bundle_content_sha256
  main_module         = var.worker_main_module
  compatibility_date  = var.worker_compatibility_date
  compatibility_flags = var.worker_compatibility_flags

  # SQLite-backed Durable Object classes for the self-hosted Actions runner. Only
  # declared when Actions is enabled; the Phase-5 worker bundle must export both
  # ActionsRunCoordinator and ActionsJobRunner for the apply to succeed.
  migrations = local.actions_enabled ? {
    new_tag            = "actions-v1"
    new_sqlite_classes = ["ActionsRunCoordinator", "ActionsJobRunner"]
  } : null

  bindings = concat(
    [
      {
        type        = "r2_bucket"
        name        = "BUCKET"
        bucket_name = cloudflare_r2_bucket.objects[0].name
      },
      {
        type = "plain_text"
        name = "APP_URL"
        text = local.launch_url != null ? local.launch_url : ""
      },
    ],
    local.accounts_issuer_url != "" ? [
      {
        type = "plain_text"
        name = "OIDC_ISSUER_URL"
        text = local.accounts_issuer_url
      },
    ] : [],
    local.browser_auth_ready ? [
      {
        type = "plain_text"
        name = "OIDC_CLIENT_ID"
        text = local.accounts_client_id
      },
      {
        type = "secret_text"
        name = "APP_SESSION_SECRET"
        text = local.app_session_secret
      },
    ] : [],
    local.accounts_client_secret != "" ? [
      {
        type = "secret_text"
        name = "OIDC_CLIENT_SECRET"
        text = local.accounts_client_secret
      },
    ] : [],
    local.provided_mcp_token != "" ? [
      {
        type = "secret_text"
        name = "PUBLISHED_MCP_AUTH_TOKEN"
        text = local.provided_mcp_token
      },
    ] : [],
    # Bound independently of browser auth: webhooks are reachable with an
    # Interface OAuth bearer alone, so an automation-only install must be able to
    # seal and sign them.
    local.webhook_secret_key != "" ? [
      {
        type = "secret_text"
        name = "WEBHOOK_SECRET_KEY"
        text = local.webhook_secret_key
      },
    ] : [],
    local.metadata_enabled ? [
      {
        type = "d1"
        name = "DB"
        id   = cloudflare_d1_database.metadata[0].id
      },
    ] : [],
    local.actions_enabled ? [
      {
        # Actions run/job/step/secret state shares the collaboration-core D1.
        type = "d1"
        name = "ACTIONS_DB"
        id   = cloudflare_d1_database.metadata[0].id
      },
      {
        type       = "queue"
        name       = "WORKFLOW_QUEUE"
        queue_name = cloudflare_queue.workflows[0].queue_name
      },
      {
        # Coordinator DO (SQLite). Class exported by the Phase-5 worker bundle.
        type       = "durable_object_namespace"
        name       = "ACTIONS_RUN"
        class_name = "ActionsRunCoordinator"
      },
      {
        # Container-runner DO (the self-hosted Actions runner image).
        type       = "durable_object_namespace"
        name       = "ACTIONS_JOB"
        class_name = "ActionsJobRunner"
      },
      {
        type        = "r2_bucket"
        name        = "R2_ACTIONS"
        bucket_name = cloudflare_r2_bucket.actions[0].name
      },
      {
        type = "secret_text"
        name = "ACTIONS_RUNNER_SECRET"
        text = local.actions_runner_secret
      },
      {
        type = "secret_text"
        name = "ACTIONS_SECRETS_KEY"
        text = local.actions_secrets_key
      },
    ] : [],
    [
      for name, value in local.extra_worker_env : {
        type = "plain_text"
        name = name
        text = value
      }
    ],
  )

  lifecycle {
    precondition {
      condition     = local.accounts_issuer_url == "" || (local.app_workspace_id != "" && local.app_capsule_id != "")
      error_message = "Interface OAuth requires env.APP_WORKSPACE_ID and env.APP_CAPSULE_ID whenever takosumi_accounts_issuer_url is configured."
    }

    precondition {
      condition     = !local.browser_auth_requested || local.browser_auth_ready
      error_message = "Browser auth requires takosumi_accounts_issuer_url, takosumi_accounts_client_id, app_session_secret, and env.APP_WORKSPACE_ID together."
    }

    precondition {
      condition     = !local.metadata_enabled || local.webhook_signing_ready
      error_message = "enable_metadata exposes the webhook API, which only delivers HMAC-signed payloads: set webhook_secret_key (>= 32 chars), or app_session_secret together with the browser-auth variables."
    }

    precondition {
      condition     = !local.actions_enabled || local.metadata_enabled
      error_message = "enable_actions requires enable_metadata (Actions run/job/secret state shares the collaboration-core D1)."
    }

    precondition {
      condition     = !local.actions_enabled || (var.actions_container_binding_applied && trimspace(var.actions_runner_image) != "")
      error_message = "enable_actions requires actions_runner_image and actions_container_binding_applied: without the out-of-band wrangler `[[containers]]` image binding (and a bundle shipping @cloudflare/containers) the ActionsJobRunner Durable Object has no container and every job fails at dispatch."
    }

    precondition {
      condition     = !local.actions_enabled || (local.actions_runner_secret != "" && local.actions_secrets_key != "")
      error_message = "enable_actions requires actions_runner_secret and actions_secrets_key (each >= 32 chars)."
    }

    precondition {
      condition     = try(local.worker_release_lock.kind, "") == "takos.release-artifact-lock@v1" && try(local.worker_release_lock.app, "") == "takos-git"
      error_message = "release.lock.json must be a takos.release-artifact-lock@v1 lock owned by takos-git."
    }

    precondition {
      condition     = !local.worker_release_requested || local.worker_release_pinned
      error_message = "worker_release_tag is not pinned in release.lock.json; add a reviewed append-only release entry before deploying it."
    }

    precondition {
      condition = !local.worker_bundle_uses_release_pin || (
        local.worker_release_artifact_filename != "" &&
        can(regex("^[a-f0-9]{40}$", try(local.worker_release_pin.commit, ""))) &&
        can(regex("^https://[^[:space:]]+$", local.worker_release_artifact_url)) &&
        can(regex("^https://[^[:space:]]+$", local.worker_release_manifest_url)) &&
        can(regex("^[a-f0-9]{64}$", local.worker_release_artifact_expected_sha256)) &&
        can(regex("^[a-f0-9]{64}$", local.worker_release_manifest_expected_sha256))
      )
      error_message = "worker_release_tag has a malformed release.lock.json entry; tag, commit, HTTPS URLs, and both SHA-256 digests must be pinned."
    }

    precondition {
      condition     = !local.worker_bundle_uses_release_pin || local.worker_release_manifest_expected_sha256 == local.worker_release_manifest_digest
      error_message = "The fetched release manifest does not match the SHA-256 pinned in release.lock.json."
    }

    precondition {
      condition = !local.worker_bundle_uses_release_pin || (
        try(local.worker_release_manifest.kind, "") == "takosumi.worker-artifact@v1" &&
        try(local.worker_release_manifest.app, "") == "takos-git" &&
        try(local.worker_release_manifest.releaseTag, "") == local.worker_release_tag &&
        try(local.worker_release_manifest.ref, "") == local.worker_release_tag &&
        try(local.worker_release_manifest.commit, "") == try(local.worker_release_pin.commit, "") &&
        try(local.worker_release_manifest.artifact.filename, "") == local.worker_release_artifact_filename &&
        try(local.worker_release_manifest.artifact.url, "") == local.worker_release_artifact_url &&
        try(local.worker_release_manifest.manifestUrl, "") == local.worker_release_manifest_url
      )
      error_message = "The fetched manifest identity, commit, artifact filename/URL, or manifest URL does not match release.lock.json."
    }

    precondition {
      condition     = !local.worker_bundle_uses_release_pin || local.worker_release_artifact_expected_sha256 == local.worker_bundle_content_sha256
      error_message = "The fetched Worker artifact does not match the SHA-256 pinned in release.lock.json."
    }

    precondition {
      condition     = !local.worker_release_requested || local.worker_bundle_sha256_assertion == "" || local.worker_bundle_sha256_assertion == local.worker_release_artifact_expected_sha256
      error_message = "worker_bundle_sha256 is only an additional release-tag assertion and must equal the artifact digest in release.lock.json."
    }

    precondition {
      condition     = !local.worker_bundle_uses_explicit_url || (local.worker_bundle_sha256_assertion != "" && local.worker_bundle_sha256_assertion == local.worker_bundle_content_sha256)
      error_message = "worker_bundle_sha256 is required for worker_bundle_url and must match the downloaded artifact."
    }

    precondition {
      condition     = local.worker_release_requested || local.worker_bundle_uses_explicit_url || local.worker_bundle_sha256_assertion == "" || local.worker_bundle_sha256_assertion == local.worker_bundle_content_sha256
      error_message = "worker_bundle_sha256 does not match worker_bundle_path."
    }
  }
}

# Durable webhook retry outbox. Fetch requests also drain a bounded batch, but
# the cron is required so an idle Capsule still makes progress after a receiver
# outage or isolate cancellation.
resource "cloudflare_workers_cron_trigger" "webhook_outbox" {
  count       = local.cloudflare_worker_enabled && local.metadata_enabled ? 1 : 0
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_workers_script.worker[0].script_name

  schedules = [
    {
      cron = "* * * * *"
    },
  ]
}

resource "cloudflare_workers_script_subdomain" "worker" {
  count            = local.cloudflare_worker_enabled && var.enable_workers_dev_subdomain ? 1 : 0
  account_id       = var.cloudflare_account_id
  script_name      = cloudflare_workers_script.worker[0].script_name
  enabled          = true
  previews_enabled = false
}

resource "cloudflare_workers_route" "worker" {
  count   = local.cloudflare_route_enabled ? 1 : 0
  zone_id = trimspace(var.cloudflare_route_zone_id)
  pattern = trimspace(var.cloudflare_route_pattern)
  script  = cloudflare_workers_script.worker[0].script_name
}
