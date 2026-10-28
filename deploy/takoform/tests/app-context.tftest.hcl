# Plan-only synthetic provider fixtures; no Host, credentials or network calls.
mock_provider "takoform" {}

variables {
  takosumi_accounts_issuer_url = "https://accounts.example.test"
  app_capsule_id               = "capsule-fixture"
}

run "capsule_only_context" {
  command = plan
  assert {
    condition = jsondecode(takoform_worker_version.worker.vars_json) == {
      OIDC_ISSUER_URL = var.takosumi_accounts_issuer_url
      APP_CAPSULE_ID  = var.app_capsule_id
    }
    error_message = "The portable version must bind the expected Capsule without requiring a Workspace."
  }
}

run "legacy_workspace_context" {
  command = plan
  variables {
    app_workspace_id = "workspace-fixture"
  }
  assert {
    condition = jsondecode(takoform_worker_version.worker.vars_json) == {
      OIDC_ISSUER_URL  = var.takosumi_accounts_issuer_url
      APP_CAPSULE_ID   = var.app_capsule_id
      APP_WORKSPACE_ID = var.app_workspace_id
    }
    error_message = "Legacy Workspace context remains an additional binding, not a Capsule substitute."
  }
}

run "missing_expected_capsule_refused" {
  command = plan
  variables {
    app_capsule_id   = ""
    app_workspace_id = "workspace-fixture"
  }
  expect_failures = [takoform_worker_version.worker]
}
