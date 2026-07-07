output "launch_url" {
  description = "Public URL for the published takos-git service, when derivable."
  value       = local.launch_url
}

output "url" {
  description = "Alias for launch_url for generic Takosumi public URL smoke checks."
  value       = local.launch_url
}

output "git_http_base_url" {
  description = "Base URL for git Smart HTTP (clone/fetch under /git/<repo>.git)."
  value       = local.launch_url != null ? "${local.launch_url}/git" : null
}

output "worker_name" {
  description = "Cloudflare Worker name used when enable_cloudflare_worker_script is true."
  value       = local.worker_name
}

output "worker_managed_by_opentofu" {
  description = "True when the Worker script and bindings are managed by OpenTofu."
  value       = local.cloudflare_worker_enabled
}

output "cloudflare_worker_script_id" {
  description = "OpenTofu-managed Cloudflare Worker script ID, or null when enable_cloudflare_worker_script is false."
  value       = try(cloudflare_workers_script.worker[0].id, null)
}

output "cloudflare_r2_bucket_name" {
  description = "R2 bucket name backing the BUCKET binding (git objects + per-repo refs)."
  value       = local.r2_objects_bucket
}

# Sensitive: the shared HMAC key Takosumi reads to mint scoped git tokens.
# Stripped from public projection (only in the encrypted output artifact).
output "takos_git_signing_key" {
  description = "Shared HMAC signing key for scoped git tokens. Consumed by the Takosumi git credential issuer to mint per-consumer tokens."
  value       = local.effective_signing_key
  sensitive   = true
}

output "app_deployment" {
  description = "Installable app declaration consumed from tofu output -json by Takos/Takosumi install flows."
  value = {
    contractVersion = 1
    name            = "takos-git"
    version         = "0.1.0"

    compute = {
      web = {
        kind      = "worker"
        readiness = "/healthz"
      }
    }

    resources = {
      objects = {
        type = "object-store"
        bind = "BUCKET"
        to   = ["web"]
      }
    }

    routes = [
      {
        id     = "root"
        target = "web"
        path   = "/"
      },
    ]

    env = {
      APP_URL = local.launch_url != null ? local.launch_url : ""
    }
  }
}

output "service_exports" {
  description = "Runtime service surface published by takos-git: the git Smart HTTP host consumers bind to."
  value = [
    {
      name         = "takos.git.hosting"
      capabilities = ["source.git.smart_http", "protocol.http.api"]
      endpoints = [
        {
          name       = "default"
          protocol   = "https"
          pathPrefix = "/git"
          url        = local.launch_url != null ? "${local.launch_url}/git" : null
        },
      ]
      # KEYS here must avoid token/secret/password/credential/auth/bearer/
      # session/cookie/key substrings (Takosumi output secret-scan drops the
      # whole output otherwise).
      metadata = {
        title         = "Takos Git Hosting"
        description   = "Read-only git Smart HTTP host for workspace repos, isolated per consumer by scoped clone grants."
        capabilityIds = ["takos.git.hosting.v1"]
      }
      visibility = "space"
    },
  ]
}
