locals {
  launch_url = takoform_worker_endpoint.worker.url
}

output "launch_url" {
  description = "Canonical public URL allocated by the selected Takoform host."
  value       = local.launch_url
}

output "api_url" {
  description = "Git Smart HTTP base URL."
  value       = "${trimsuffix(local.launch_url, "/")}/git"
}

output "hosting_api_url" {
  description = "Collaborative hosting API URL."
  value       = "${trimsuffix(local.launch_url, "/")}/api/v1"
}

output "mcp_url" {
  description = "Repository-management MCP URL."
  value       = "${trimsuffix(local.launch_url, "/")}/mcp"
}

output "takoform_resource_ids" {
  description = "Canonical portable Resource identities for this instance."
  value = {
    worker         = takoform_module_worker.worker.uid
    bundle         = takoform_worker_bundle.worker.uid
    version        = takoform_worker_version.worker.uid
    deployment     = takoform_worker_deployment.worker.uid
    endpoint       = takoform_worker_endpoint.worker.uid
    objects        = takoform_edge_object_bucket.objects.uid
    metadata       = takoform_sqlite_database.metadata.uid
    webhook_outbox = takoform_worker_cron_trigger.webhook_outbox.uid
  }
}
