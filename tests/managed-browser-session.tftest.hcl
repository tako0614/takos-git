# Source-only regression: every external provider is mocked. No credential,
# Cloudflare request or real resource is created by these tests.
mock_provider "cloudflare" {}
mock_provider "http" {
  mock_data "http" {
    defaults = {
      response_body = "// synthetic Git Worker fixture"
      status_code   = 200
    }
  }
}
mock_provider "random" {
  mock_resource "random_password" {
    defaults = {
      id     = "fixture-only-browser-key-resource"
      result = "fixture-only-browser-session-key-never-issued-00000000000000000000"
    }
  }
}

variables {
  enable_cloudflare_resources     = true
  enable_cloudflare_worker_script = true
  cloudflare_account_id           = "00000000000000000000000000000000"
  worker_release_tag              = ""
  worker_bundle_url               = "https://fixture.example.test/worker.js"
  worker_bundle_sha256            = sha256("// synthetic Git Worker fixture")
  public_url                      = "https://git.example.test"
  takosumi_accounts_url           = "https://accounts.example.test"
  takosumi_accounts_issuer_url    = "https://accounts.example.test"
  takosumi_accounts_client_id     = "fixture-client"
  takosumi_accounts_redirect_uri  = "https://git.example.test/api/auth/callback"
  app_capsule_id                  = "capsule-fixture"
  app_session_secret              = ""
  manage_browser_session          = true
}

run "explicit_managed_browser_mode_is_plannable" {
  command = plan
  assert {
    condition = length([
      for binding in cloudflare_workers_script.worker[0].bindings : binding
      if binding.name == "APP_SESSION_SECRET" && binding.type == "secret_text"
    ]) == 1
    error_message = "Explicit managed mode must supply the existing private browser binding."
  }
}

run "managed_key_is_private" {
  # Only mocked provider state is applied. The random provider never generates
  # a real key and Cloudflare/http never receive an external request.
  command = apply
  assert {
    condition     = length(random_password.browser_session) == 1 && random_password.browser_session[0].length == 64 && !random_password.browser_session[0].special
    error_message = "Manage exactly one strong app-owned browser key."
  }
  assert {
    condition     = issensitive(random_password.browser_session[0].result)
    error_message = "The generated result must remain sensitive."
  }
  assert {
    condition = length([
      for binding in cloudflare_workers_script.worker[0].bindings : binding
      if binding.name == "APP_SESSION_SECRET" && binding.type == "secret_text" && binding.text == random_password.browser_session[0].result
    ]) == 1
    error_message = "Deliver exactly the sensitive generated result as secret_text."
  }
  assert {
    condition = issensitive(one([
      for binding in cloudflare_workers_script.worker[0].bindings : binding
      if binding.name == "APP_SESSION_SECRET"
    ]).text)
    error_message = "The delivered binding must preserve sensitivity."
  }
  assert {
    condition = length([
      for binding in cloudflare_workers_script.worker[0].bindings : binding
      if binding.name == "APP_SESSION_SECRET" && binding.type == "plain_text"
    ]) == 0
    error_message = "Never expose the browser key as a plaintext binding."
  }
}

run "worker_update_retains_key_state" {
  command = plan
  variables {
    worker_compatibility_date = "2026-10-20"
  }
  assert {
    condition     = random_password.browser_session[0].id == "fixture-only-browser-key-resource"
    error_message = "An ordinary Worker update must retain the existing key resource identity."
  }
  assert {
    condition     = nonsensitive(random_password.browser_session[0].result) == "fixture-only-browser-session-key-never-issued-00000000000000000000"
    error_message = "An ordinary Worker update must retain the private key bytes."
  }
}

run "browser_repository_management_has_its_database" {
  command = plan
  variables {
    enable_metadata = true
  }
  assert {
    condition     = length(cloudflare_d1_database.metadata) == 1
    error_message = "Explicit repository management must plan its real D1 resource."
  }
  assert {
    condition = length([
      for binding in cloudflare_workers_script.worker[0].bindings : binding
      if binding.name == "DB" && binding.type == "d1" && binding.id == cloudflare_d1_database.metadata[0].id
    ]) == 1
    error_message = "Bind the same planned database to the hosting API Worker."
  }
}

run "manual_mode_is_unchanged" {
  command = plan
  variables {
    manage_browser_session = false
    app_session_secret     = "fixture-only-manual-session-key-never-issued"
  }
  assert {
    condition     = length(random_password.browser_session) == 0
    error_message = "Manual mode must not create a new key."
  }
  assert {
    condition = length([
      for binding in cloudflare_workers_script.worker[0].bindings : binding
      if binding.name == "APP_SESSION_SECRET" && binding.type == "secret_text" && binding.text == var.app_session_secret
    ]) == 1
    error_message = "Preserve the explicitly supplied manual key."
  }
}

run "managed_and_manual_refused" {
  command = plan
  variables {
    app_session_secret = "fixture-only-manual-session-key-never-issued"
  }
  expect_failures = [random_password.browser_session]
}

run "missing_issuer_refused" {
  command = plan
  variables {
    takosumi_accounts_issuer_url = ""
  }
  expect_failures = [random_password.browser_session]
}

run "missing_context_refused" {
  command = plan
  variables {
    app_capsule_id = ""
  }
  expect_failures = [random_password.browser_session]
}

run "missing_public_url_refused" {
  command = plan
  variables {
    public_url                     = ""
    takosumi_accounts_redirect_uri = ""
  }
  expect_failures = [random_password.browser_session]
}

run "mismatched_callback_refused" {
  command = plan
  variables {
    takosumi_accounts_redirect_uri = "https://other.example.test/api/auth/callback"
  }
  expect_failures = [random_password.browser_session]
}

run "disabled_worker_has_no_key_resource" {
  command = plan
  variables {
    enable_cloudflare_resources     = false
    enable_cloudflare_worker_script = false
  }
  assert {
    condition     = length(random_password.browser_session) == 0 && length(cloudflare_workers_script.worker) == 0
    error_message = "An inactive deployment must create neither a browser key nor a Worker."
  }
}

run "managed_plaintext_session_binding_refused" {
  command = plan
  variables {
    env = { APP_SESSION_SECRET = "fixture-only-legacy-value-never-issued" }
  }
  expect_failures = [var.env]
}

run "disabling_management_without_replacement_refused" {
  command = plan
  variables {
    manage_browser_session = false
  }
  expect_failures = [cloudflare_workers_script.worker]
}
