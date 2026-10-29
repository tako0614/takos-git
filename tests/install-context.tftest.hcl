# Synthetic, plan-only data. Both providers are mocked; no cloud credentials,
# external HTTP calls or deployed resources are used by these regressions.
mock_provider "cloudflare" {}
mock_provider "http" {
  mock_data "http" {
    defaults = {
      response_body = "// synthetic Git Worker fixture"
      status_code   = 200
    }
  }
}

variables {
  enable_cloudflare_resources     = true
  enable_cloudflare_worker_script = true
  enable_metadata                 = false
  enable_actions                  = false
  cloudflare_account_id           = "00000000000000000000000000000000"
  worker_release_tag              = ""
  worker_bundle_url               = "https://fixture.example.test/worker.js"
  worker_bundle_sha256            = sha256("// synthetic Git Worker fixture")
  public_url                      = "https://git.example.test"
  takosumi_accounts_issuer_url    = "https://accounts.example.test"
  takosumi_accounts_client_id     = "fixture-client"
  app_session_secret              = "fixture-only-session-secret-0000000000"
  env                             = { LOG_LEVEL = "debug" }
}

run "root_context_receivers" {
  command = plan
  variables {
    app_workspace_id = "workspace-fixture"
    app_capsule_id   = "capsule-fixture"
  }
  assert {
    condition = alltrue([
      for name, value in {
        APP_WORKSPACE_ID = var.app_workspace_id
        APP_CAPSULE_ID   = var.app_capsule_id
        LOG_LEVEL        = "debug"
        } : length([
          for binding in cloudflare_workers_script.worker[0].bindings : binding
          if binding.name == name && binding.type == "plain_text" && binding.text == value
      ]) == 1
    ])
    error_message = "Each typed context value and unrelated env value must reach one binding."
  }
}

run "legacy_env_only_is_preserved" {
  command = plan
  variables {
    env = {
      APP_WORKSPACE_ID = " workspace-fixture "
      APP_CAPSULE_ID   = " capsule-fixture "
      LOG_LEVEL        = "trace"
    }
  }
  assert {
    condition = alltrue([
      for name, value in var.env : length([
        for binding in cloudflare_workers_script.worker[0].bindings : binding
        if binding.name == name && binding.type == "plain_text" && binding.text == value
      ]) == 1
    ])
    error_message = "The legacy env-only route must preserve exact binding bytes."
  }
}

run "identical_routes_do_not_duplicate_bindings" {
  command = plan
  variables {
    app_workspace_id = "workspace-fixture"
    app_capsule_id   = "capsule-fixture"
    env = {
      APP_WORKSPACE_ID = "workspace-fixture"
      APP_CAPSULE_ID   = "capsule-fixture"
    }
  }
  assert {
    condition = alltrue([
      for name in ["APP_WORKSPACE_ID", "APP_CAPSULE_ID"] : length([
        for binding in cloudflare_workers_script.worker[0].bindings : binding
        if binding.name == name
      ]) == 1
    ])
    error_message = "Agreeing typed and legacy context routes must produce no duplicate names."
  }
}

run "conflicting_workspace_routes_refused" {
  command = plan
  variables {
    app_workspace_id = "workspace-fixture"
    app_capsule_id   = "capsule-fixture"
    env              = { APP_WORKSPACE_ID = "other-workspace-fixture" }
  }
  expect_failures = [cloudflare_workers_script.worker]
}

run "conflicting_capsule_routes_refused" {
  command = plan
  variables {
    app_workspace_id = "workspace-fixture"
    app_capsule_id   = "capsule-fixture"
    env              = { APP_CAPSULE_ID = "other-capsule-fixture" }
  }
  expect_failures = [cloudflare_workers_script.worker]
}

run "legacy_workspace_without_capsule" {
  command = plan
  variables {
    app_workspace_id = "workspace-fixture"
  }
  assert {
    condition = length([
      for binding in cloudflare_workers_script.worker[0].bindings : binding
      if binding.name == "APP_WORKSPACE_ID" && binding.text == var.app_workspace_id
    ]) == 1
    error_message = "Legacy Workspace-only installs must remain plannable until v2.5 context mapping is adopted."
  }
}

run "missing_browser_secret_still_refused" {
  command = plan
  variables {
    app_workspace_id   = "workspace-fixture"
    app_capsule_id     = "capsule-fixture"
    app_session_secret = ""
  }
  expect_failures = [cloudflare_workers_script.worker]
}

run "capsule_only_browser_context" {
  command = plan
  variables {
    app_capsule_id = "capsule-fixture"
  }
  assert {
    condition = alltrue([
      for name, value in {
        APP_CAPSULE_ID = var.app_capsule_id
        OIDC_CLIENT_ID = var.takosumi_accounts_client_id
        } : length([
          for binding in cloudflare_workers_script.worker[0].bindings : binding
          if binding.name == name && binding.text == value
      ]) == 1
      ]) && length([
      for binding in cloudflare_workers_script.worker[0].bindings : binding
      if binding.name == "APP_WORKSPACE_ID"
    ]) == 0
    error_message = "Browser OIDC must receive the Capsule context and client without a Workspace binding."
  }
}

run "capsule_only_interface_context" {
  command = plan
  variables {
    app_capsule_id              = "capsule-fixture"
    takosumi_accounts_client_id = ""
    app_session_secret          = ""
  }
  assert {
    condition = length([
      for binding in cloudflare_workers_script.worker[0].bindings : binding
      if binding.name == "APP_CAPSULE_ID" && binding.text == var.app_capsule_id
      ]) == 1 && length([
      for binding in cloudflare_workers_script.worker[0].bindings : binding
      if binding.name == "OIDC_ISSUER_URL" && binding.text == var.takosumi_accounts_issuer_url
    ]) == 1
    error_message = "Machine Interface OAuth needs the issuer and expected Capsule, without a Workspace or browser session."
  }
}
