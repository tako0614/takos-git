terraform {
  required_version = ">= 1.8.0"
  required_providers {
    takoform = {
      source  = "registry.terraform.io/tako0614/takoform"
      version = "= 4.0.0"
    }
  }
}

variable "project_name" {
  description = "Portable resource-name prefix for this new Takos Git instance."
  type        = string
  default     = "takos-git"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,50}[a-z0-9]$", var.project_name))
    error_message = "project_name must be 3-52 lowercase letters, numbers, or hyphens."
  }
}

variable "app_workspace_id" {
  description = "Compatibility coordinate supplied by the selected install context; not authorization."
  type        = string
}

variable "app_capsule_id" {
  description = "Current app supplied by the selected install context; not an owner subject."
  type        = string
}

resource "takoform_edge_object_bucket" "objects" {
  name = "${var.project_name}-objects"
}

resource "takoform_sqlite_database" "metadata" {
  name = "${var.project_name}-metadata"
}

resource "takoform_module_worker" "worker" {
  name = var.project_name
}

resource "takoform_worker_bundle" "worker" {
  revision_owner = takoform_module_worker.worker.name
  main_module    = "git-worker.js"
  modules = [{
    name         = "git-worker.js"
    content_type = "application/javascript+module"
    content_file = "${path.module}/.generated/git-worker.js"
  }]
  lifecycle {
    create_before_destroy = true
  }
}

resource "takoform_worker_version" "worker" {
  revision_owner = takoform_module_worker.worker.name
  worker         = takoform_module_worker.worker.name
  bundle         = takoform_worker_bundle.worker.name
  handlers       = ["fetch", "scheduled"]
  vars_json = jsonencode({
    APP_CAPSULE_ID   = var.app_capsule_id
    APP_WORKSPACE_ID = var.app_workspace_id
  })
  required_sensitive_vars = [
    "APP_SESSION_SECRET",
    "OIDC_ISSUER_URL",
    "OIDC_CLIENT_ID",
    "OIDC_OWNER_SUB",
    "OIDC_REDIRECT_URI",
  ]
  bucket_bindings = [{
    name        = "BUCKET"
    target_name = takoform_edge_object_bucket.objects.name
  }]
  sqlite_bindings = [{
    name        = "DB"
    target_name = takoform_sqlite_database.metadata.name
  }]
  lifecycle {
    create_before_destroy = true
  }
}

resource "takoform_worker_deployment" "worker" {
  name   = "${var.project_name}-deployment"
  worker = takoform_module_worker.worker.name
  versions = [{
    worker_version = takoform_worker_version.worker.name
    weight         = 10000
  }]
}

resource "takoform_worker_endpoint" "worker" {
  name       = "${var.project_name}-endpoint"
  worker     = takoform_module_worker.worker.name
  depends_on = [takoform_worker_deployment.worker]
}

resource "takoform_worker_cron_trigger" "webhook_outbox" {
  name       = "${var.project_name}-webhook-outbox"
  worker     = takoform_module_worker.worker.name
  cron       = "* * * * *"
  depends_on = [takoform_worker_deployment.worker]
}
