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

output "metadata_database_id" {
  description = "D1 metadata database id for the post-apply `wrangler d1 migrations apply` step. Null when enable_metadata is false."
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
