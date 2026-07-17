output "launch_url" {
  description = "Public URL for the published Git Smart HTTP service, when derivable."
  value       = local.launch_url
}

output "api_url" {
  description = "Primary service API URL for Git Smart HTTP clone/fetch/push under /git/<repo>.git."
  value       = local.launch_url != null ? "${local.launch_url}/git" : null
}

output "hosting_api_url" {
  description = "Authenticated repository and code-browser API for the collaborative hosting surface."
  value       = local.launch_url != null ? "${local.launch_url}/api/v1" : null
}

output "mcp_url" {
  description = "Streamable HTTP MCP endpoint for repository management."
  value       = local.launch_url != null ? "${local.launch_url}/mcp" : null
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

output "cloudflare_account_id" {
  description = "Non-secret Cloudflare account identifier used by service-owned lifecycle actions."
  value       = trimspace(var.cloudflare_account_id)
}

output "metadata_database_id" {
  description = "D1 metadata database id. The Worker self-applies forward-only migrations; null when enable_metadata is false."
  value       = try(cloudflare_d1_database.metadata[0].id, null)
}

output "metadata_database_name" {
  description = "D1 metadata database name, or null when enable_metadata is false."
  value       = local.metadata_enabled ? local.d1_metadata_name : null
}

output "actions_logs_bucket_name" {
  description = "R2 bucket for Actions logs and artifacts (separate from the authoritative git object bucket), or null when enable_actions is false."
  value       = local.actions_enabled ? local.r2_actions_bucket : null
}

output "actions_workflow_queue_name" {
  description = "Workflow run-tick queue name, or null when enable_actions is false."
  value       = local.actions_enabled ? local.workflow_queue : null
}

# The runner Container image cannot be bound by the cloudflare provider 5.19.1;
# these outputs feed the out-of-band wrangler `[[containers]]` step in CI that
# attaches the image to the ActionsJobRunner Durable Object class.
output "actions_runner_container" {
  description = "Runner Container wiring for the wrangler `[[containers]]` step (image + class + max_instances). Null when enable_actions is false; empty image until actions_runner_image is set."
  value = local.actions_enabled ? {
    class_name    = "ActionsJobRunner"
    image         = trimspace(var.actions_runner_image)
    max_instances = var.actions_runner_max_instances
  } : null
}
