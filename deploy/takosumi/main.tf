# Takosumi-managed entry root for takos-git.
#
# The repository root stays a plain OpenTofu module with no Takosumi
# dependency, so direct self-hosters keep running `tofu init && tofu apply`
# against it unchanged. This wrapper is the managed install path
# (modulePath = deploy/takosumi): it composes the plain module as a child and
# additionally declares this Capsule's runtime Interfaces in-run through the
# optional takosumi provider (the runner injects TAKOSUMI_ENDPOINT /
# TAKOSUMI_TOKEN / TAKOSUMI_WORKSPACE_ID / TAKOSUMI_CAPSULE_ID, so the
# provider block needs no static configuration).
#
# Interface names match the reference InstallConfig blueprints; when this
# root is active the blueprints contribute only their InterfaceBinding
# proposals (install-time authorization defaults) while the spec below is
# authoritative. Consumer authorization always stays service-side.

terraform {
  required_version = ">= 1.5"

  required_providers {
    takosumi = {
      source  = "takosjp/takosumi"
      version = ">= 1.0.0"
    }
  }
}

provider "takosumi" {}

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
  description = "Canonical public URL for the git service. When empty, launch_url is derived from public_subdomain and cloudflare_workers_subdomain."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.public_url) == "" || can(regex("^https://[^[:space:]]+$", var.public_url))
    error_message = "public_url must be empty or an https URL."
  }
}

variable "takosumi_accounts_issuer_url" {
  description = "Takosumi Accounts OIDC issuer used for browser sign-in and to validate opaque Interface OAuth bearer tokens."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.takosumi_accounts_issuer_url) == "" || can(regex("^https://[^[:space:]]+$", trimspace(var.takosumi_accounts_issuer_url)))
    error_message = "takosumi_accounts_issuer_url must be empty or an https URL."
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
  description = "Provision the self-hosted Actions runner backing resources (Workflow Queue + Dead-Letter Queue, the runner-coordinator and job-runner Durable Object namespaces, and the Actions logs/artifacts R2 bucket) and bind them to the Worker. Requires enable_metadata and enable_cloudflare_worker_script. Off by default keeps takos-git a single-file, R2-only Worker with no Container/DO/Queue bindings."
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
  description = "GitHub release tag whose takosumi-artifact.json selects the default Worker bundle and SHA-256. Set empty to use worker_bundle_path."
  type        = string
  default     = "v0.4.1"

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
  description = "Expected SHA-256 of the Worker module JS. Accepts lowercase hex or sha256:<hex>. Required when worker_bundle_url is set."
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

  validation {
    condition     = contains(var.worker_compatibility_flags, "global_fetch_strictly_public")
    error_message = "worker_compatibility_flags must include global_fetch_strictly_public so webhook fetches cannot reach private origins."
  }
}
module "takos_git" {
  source = "../.."

  enable_cloudflare_resources     = var.enable_cloudflare_resources
  cloudflare_account_id           = var.cloudflare_account_id
  project_name                    = var.project_name
  public_subdomain                = var.public_subdomain
  public_url                      = var.public_url
  takosumi_accounts_issuer_url    = var.takosumi_accounts_issuer_url
  takosumi_accounts_client_id     = var.takosumi_accounts_client_id
  takosumi_accounts_client_secret = var.takosumi_accounts_client_secret
  app_session_secret              = var.app_session_secret
  published_mcp_auth_token        = var.published_mcp_auth_token
  env                             = var.env
  cloudflare_workers_subdomain    = var.cloudflare_workers_subdomain
  enable_cloudflare_worker_script = var.enable_cloudflare_worker_script
  enable_metadata                 = var.enable_metadata
  enable_actions                  = var.enable_actions
  actions_runner_secret           = var.actions_runner_secret
  actions_secrets_key             = var.actions_secrets_key
  actions_runner_image            = var.actions_runner_image
  actions_runner_max_instances    = var.actions_runner_max_instances
  worker_bundle_path              = var.worker_bundle_path
  worker_release_tag              = var.worker_release_tag
  worker_bundle_url               = var.worker_bundle_url
  worker_bundle_sha256            = var.worker_bundle_sha256
  worker_main_module              = var.worker_main_module
  enable_workers_dev_subdomain    = var.enable_workers_dev_subdomain
  cloudflare_route_zone_id        = var.cloudflare_route_zone_id
  cloudflare_route_pattern        = var.cloudflare_route_pattern
  worker_compatibility_date       = var.worker_compatibility_date
  worker_compatibility_flags      = var.worker_compatibility_flags
}

resource "takosumi_interface" "launcher" {
  name    = "takos-git.launcher"
  type    = "interface.ui.surface"
  version = "1"

  document_json = jsonencode({
    launcher = true
    display = {
      title = "Takos Git"
      icon  = "/icons/takos-git.svg"
    }
  })

  inputs = {
    url = {
      source      = "capsule_output"
      output_name = "launch_url"
    }
  }

  visibility = "workspace"

  depends_on = [module.takos_git]
}

resource "takosumi_interface" "mcp" {
  name    = "takos-git.mcp"
  type    = "mcp.server"
  version = "2025-11-25"

  document_json = jsonencode({
    transport = "streamable-http"
    display = {
      title = "Takos Git"
    }
  })

  inputs = {
    endpoint = {
      source      = "capsule_output"
      output_name = "mcp_url"
    }
  }

  visibility         = "workspace"
  resource_uri_input = "endpoint"

  depends_on = [module.takos_git]
}
