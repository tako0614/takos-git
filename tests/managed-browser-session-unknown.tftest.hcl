# All external providers are mocked; only the actual root module and local
# terraform_data producers determine the plan's dependency/unknown behavior.
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

run "manual_key_may_be_unknown_with_managed_mode_off" {
  command = plan
  module {
    source = "./tests/fixtures/managed-browser-session-unknown"
  }
  variables {
    manage_browser_session = false
  }
  assert {
    condition     = output.launch_url == "https://git.example.test"
    error_message = "Existing manual mode must plan even when its private input is unknown."
  }
}

run "first_managed_plan_allows_unknown_context_and_client" {
  command = plan
  module {
    source = "./tests/fixtures/managed-browser-session-unknown"
  }
  assert {
    condition     = output.launch_url == "https://git.example.test"
    error_message = "An initial managed plan must not use unknown context/identity values in count."
  }
}

run "mocked_apply_resolves_prerequisites" {
  command = apply
  module {
    source = "./tests/fixtures/managed-browser-session-unknown"
  }
  assert {
    condition     = output.launch_url == "https://git.example.test"
    error_message = "Resolved fixture prerequisites must permit the real root graph's mocked apply."
  }
}
