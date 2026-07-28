locals {
  launch_url = try(takoform_edge_worker.worker.outputs["url"], null)
}

output "launch_url" {
  description = "Canonical public URL allocated by the selected Takoform host."
  value       = local.launch_url
}

output "api_url" {
  description = "Git Smart HTTP base URL."
  value       = try("${trimsuffix(local.launch_url, "/")}/git", null)
}

output "hosting_api_url" {
  description = "Collaborative hosting API URL."
  value       = try("${trimsuffix(local.launch_url, "/")}/api/v1", null)
}

output "mcp_url" {
  description = "Repository-management MCP URL."
  value       = try("${trimsuffix(local.launch_url, "/")}/mcp", null)
}

output "takoform_resource_ids" {
  description = "Canonical portable Resource identities for this instance."
  value = {
    worker         = takoform_edge_worker.worker.id
    objects        = takoform_object_bucket.objects.id
    metadata       = takoform_sql_database.metadata.id
    webhook_outbox = takoform_schedule.webhook_outbox.id
  }
}
