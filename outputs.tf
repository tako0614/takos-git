output "launch_url" {
  description = "Public URL for the published Git Smart HTTP service, when derivable."
  value       = local.launch_url
}

output "url" {
  description = "Alias for launch_url for generic Takosumi public URL smoke checks."
  value       = local.launch_url
}

output "public_url" {
  description = "Canonical public URL for the published Git Smart HTTP service."
  value       = local.launch_url
}

output "api_url" {
  description = "Primary service API URL for Git Smart HTTP clone/fetch under /git/<repo>.git."
  value       = local.launch_url != null ? "${local.launch_url}/git" : null
}

output "service_runtime_name" {
  description = "Implementation runtime name used when enable_cloudflare_worker_script is true."
  value       = local.runtime_name
}

output "service_runtime_managed_by_opentofu" {
  description = "True when the HTTP runtime and bindings are managed by OpenTofu."
  value       = local.cloudflare_worker_enabled
}

output "service_runtime_resource_id" {
  description = "Provider-native runtime resource ID, or null when enable_cloudflare_worker_script is false."
  value       = try(cloudflare_workers_script.worker[0].id, null)
}

output "object_bucket_name" {
  description = "Backing object bucket name for git objects and per-repo refs."
  value       = local.r2_objects_bucket
}

# Sensitive: the shared HMAC key Takosumi reads to mint scoped service grants.
# Stripped from public projection (only in the encrypted output artifact).
output "service_grant_signing_key" {
  description = "Shared HMAC signing key for scoped service grants. Consumed by the grant issuer to mint per-consumer access material for the service_exports capability."
  value       = local.effective_signing_key
  sensitive   = true
}

output "app_deployment" {
  description = "Installable app declaration consumed from tofu output -json by Capsule projection flows."
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

    publish = [
      {
        name      = "launcher"
        publisher = "web"
        type      = "interface.ui.surface"
        outputs = {
          url = {
            kind     = "url"
            routeRef = "root"
          }
        }
        display = {
          title       = "Takos Git"
          description = "Read-only Git Smart HTTP hosting for workspace repositories."
          icon        = "/icons/takos-git.svg"
          category    = "developer"
        }
        spec = {
          launcher = true
        }
      },
    ]

    env = merge(
      local.extra_worker_env,
      {
        APP_URL = local.launch_url != null ? local.launch_url : ""
      },
    )
  }
}

output "service_exports" {
  description = "Runtime service surface published by this Capsule: Git Smart HTTP consumers bind to it through the source.git.smart_http capability."
  value = [
    {
      name         = "source.git.smart_http"
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
        title         = "Git Smart HTTP"
        description   = "Read-only git Smart HTTP host for workspace repos, isolated per consumer by scoped clone grants."
        capabilityIds = ["source.git.smart_http.v1"]
      }
      visibility = "space"
    },
    {
      name         = "launcher"
      capabilities = ["interface.ui.surface"]
      endpoints = [
        {
          name       = "default"
          protocol   = "https"
          pathPrefix = "/"
          url        = local.launch_url
        },
      ]
      metadata = {
        title       = "Takos Git"
        description = "Open the Git hosting console for this Capsule."
        icon        = "/icons/takos-git.svg"
        category    = "developer"
      }
      visibility = "space"
    },
  ]
}
