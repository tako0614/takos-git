output "launch_url" {
  description = "Public URL for the published Git Smart HTTP service, when derivable."
  value       = module.takos_git.launch_url
}

output "api_url" {
  description = "Primary service API URL for Git Smart HTTP clone/fetch/push under /git/<repo>.git."
  value       = module.takos_git.api_url
}

output "hosting_api_url" {
  description = "Authenticated repository and code-browser API for the collaborative hosting surface."
  value       = module.takos_git.hosting_api_url
}

output "mcp_url" {
  description = "Streamable HTTP MCP endpoint for repository management."
  value       = module.takos_git.mcp_url
}

output "service_runtime_name" {
  description = "Implementation runtime name used when enable_cloudflare_worker_script is true."
  value       = module.takos_git.service_runtime_name
}

output "service_runtime_managed_by_opentofu" {
  description = "True when the HTTP runtime and bindings are managed by OpenTofu."
  value       = module.takos_git.service_runtime_managed_by_opentofu
}

output "service_runtime_resource_id" {
  description = "Provider-native runtime resource ID, or null when enable_cloudflare_worker_script is false."
  value       = module.takos_git.service_runtime_resource_id
}

output "object_bucket_name" {
  description = "Backing object bucket name for git objects and per-repo refs."
  value       = module.takos_git.object_bucket_name
}

output "metadata_database_id" {
  description = "D1 metadata database id. The Worker self-applies its forward-only migrations; null when metadata is disabled."
  value       = module.takos_git.metadata_database_id
}

output "metadata_database_name" {
  description = "D1 metadata database name, or null when enable_metadata is false."
  value       = module.takos_git.metadata_database_name
}

output "actions_logs_bucket_name" {
  description = "R2 bucket for Actions logs and artifacts (separate from the authoritative git object bucket), or null when enable_actions is false."
  value       = module.takos_git.actions_logs_bucket_name
}

output "actions_workflow_queue_name" {
  description = "Workflow run-tick queue name, or null when enable_actions is false."
  value       = module.takos_git.actions_workflow_queue_name
}

output "actions_runner_container" {
  description = "Runner Container wiring for the wrangler `[[containers]]` step (image + class + max_instances). Null when enable_actions is false; empty image until actions_runner_image is set."
  value       = module.takos_git.actions_runner_container
}
