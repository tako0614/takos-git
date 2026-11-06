terraform {
  required_providers {
    cloudflare = {
      source = "cloudflare/cloudflare"
    }
    http = {
      source = "hashicorp/http"
    }
    random = {
      source = "hashicorp/random"
    }
  }
}

variable "manage_browser_session" {
  type    = bool
  default = true
}

# Builtin local-only producer IDs are genuinely unknown during the first plan.
# No external service or authority is represented by these fixture resources.
resource "terraform_data" "context" {}
resource "terraform_data" "client" {}
resource "terraform_data" "manual_key" {}

module "git" {
  source = "../../.."

  enable_cloudflare_resources     = true
  enable_cloudflare_worker_script = true
  cloudflare_account_id           = "00000000000000000000000000000000"
  worker_release_tag              = ""
  worker_bundle_url               = "https://fixture.example.test/worker.js"
  worker_bundle_sha256            = sha256("// synthetic Git Worker fixture")
  public_url                      = "https://git.example.test"
  takosumi_accounts_issuer_url    = "https://accounts.example.test"
  takosumi_accounts_client_id     = terraform_data.client.id
  takosumi_accounts_redirect_uri  = "https://git.example.test/api/auth/callback"
  app_capsule_id                  = terraform_data.context.id
  manage_browser_session          = var.manage_browser_session
  app_session_secret              = var.manage_browser_session ? "" : terraform_data.manual_key.id
}

output "launch_url" {
  value = module.git.launch_url
}
