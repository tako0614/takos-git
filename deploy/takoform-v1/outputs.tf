output "launch_url" {
  description = "Host-allocated public URL; not fed back into the Worker configuration."
  value       = takoform_worker_endpoint.worker.url
}

output "api_url" {
  value = "${trimsuffix(takoform_worker_endpoint.worker.url, "/")}/git"
}

output "hosting_api_url" {
  value = "${trimsuffix(takoform_worker_endpoint.worker.url, "/")}/api/v1"
}

output "mcp_url" {
  value = "${trimsuffix(takoform_worker_endpoint.worker.url, "/")}/mcp"
}

output "takoform_resource_ids" {
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
