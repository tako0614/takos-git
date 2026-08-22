terraform {
  required_version = ">= 1.8.0"

  required_providers {
    takoform = {
      source  = "registry.terraform.io/tako0614/takoform"
      version = "= 2.1.1"
    }
  }
}

variable "project_name" {
  description = "Portable resource-name prefix for this Takos Git instance."
  type        = string
  default     = "takos-git"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,50}[a-z0-9]$", var.project_name))
    error_message = "project_name must be 3-52 lowercase letters, numbers, or hyphens, and start/end with an alphanumeric character."
  }
}

variable "worker_bundle_manifest_digest" {
  description = "Content-addressed reviewed WorkerBundle manifest committed to the selected Takoform Host for Takos Git."
  type        = string
  default     = "sha256:faeef72b6550823b44b2f521889885864e90fadd85257fe53909013c8fd1e914"

  validation {
    condition     = can(regex("^sha256:[a-f0-9]{64}$", trimspace(var.worker_bundle_manifest_digest)))
    error_message = "worker_bundle_manifest_digest must be a canonical sha256:<hex> manifest digest."
  }
}

variable "takosumi_accounts_issuer_url" {
  description = "Takosumi Accounts issuer used to validate short-lived Interface OAuth credentials."
  type        = string
  default     = ""
}

variable "takosumi_accounts_client_id" {
  description = "Public PKCE client id allocated to this installed Capsule."
  type        = string
  default     = ""
}

locals {
  runtime_vars = merge(
    trimspace(var.takosumi_accounts_issuer_url) == "" ? {} : {
      OIDC_ISSUER_URL = trimspace(var.takosumi_accounts_issuer_url)
    },
    trimspace(var.takosumi_accounts_client_id) == "" ? {} : {
      OIDC_CLIENT_ID = trimspace(var.takosumi_accounts_client_id)
    },
  )
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
  revision_owner  = var.project_name
  manifest_digest = trimspace(var.worker_bundle_manifest_digest)

  lifecycle {
    create_before_destroy = true
  }
}

resource "takoform_worker_version" "worker" {
  revision_owner = var.project_name
  worker         = takoform_module_worker.worker.name
  bundle         = takoform_worker_bundle.worker.name
  handlers       = ["fetch", "scheduled"]
  vars_json      = jsonencode(local.runtime_vars)

  bucket_bindings = [
    {
      name        = "BUCKET"
      target_name = takoform_edge_object_bucket.objects.name
    },
  ]
  sqlite_bindings = [
    {
      name        = "DB"
      target_name = takoform_sqlite_database.metadata.name
    },
  ]

  lifecycle {
    create_before_destroy = true
  }
}

resource "takoform_worker_deployment" "worker" {
  name   = "${var.project_name}-deployment"
  worker = takoform_module_worker.worker.name
  versions = [
    {
      worker_version = takoform_worker_version.worker.name
      weight         = 10000
    },
  ]
}

resource "takoform_worker_endpoint" "worker" {
  name   = "${var.project_name}-endpoint"
  worker = takoform_module_worker.worker.name

  depends_on = [takoform_worker_deployment.worker]
}

# Durable webhook retries. The Worker also opportunistically drains due rows
# on ordinary requests, while this portable attachment guarantees progress
# during idle periods.
resource "takoform_worker_cron_trigger" "webhook_outbox" {
  name   = "${var.project_name}-webhook-outbox"
  worker = takoform_module_worker.worker.name
  cron   = "* * * * *"

  depends_on = [takoform_worker_deployment.worker]
}
