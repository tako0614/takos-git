run "canonicalizes_public_and_issuer_origins" {
  command = plan

  variables {
    public_url                   = "https://git.example/"
    takosumi_accounts_issuer_url = "https://accounts.example/"
    cloudflare_account_id        = "account-123"
  }

  assert {
    condition     = output.launch_url == "https://git.example"
    error_message = "launch_url must be the canonical public origin."
  }

  assert {
    condition     = output.api_url == "https://git.example/git"
    error_message = "api_url must match the APP_URL-derived Smart HTTP audience."
  }

  assert {
    condition     = output.hosting_api_url == "https://git.example/api/v1"
    error_message = "hosting_api_url must match the APP_URL-derived hosting audience."
  }

  assert {
    condition     = output.mcp_url == "https://git.example/mcp"
    error_message = "mcp_url must match the APP_URL-derived MCP audience."
  }

  assert {
    condition     = output.cloudflare_account_id == "account-123"
    error_message = "lifecycle actions require the non-secret provider account identifier."
  }
}

run "rejects_public_url_path" {
  command = plan

  variables {
    public_url = "https://git.example/nested"
  }

  expect_failures = [var.public_url]
}

run "rejects_public_url_query" {
  command = plan

  variables {
    public_url = "https://git.example/?tenant=a"
  }

  expect_failures = [var.public_url]
}

run "rejects_issuer_path" {
  command = plan

  variables {
    takosumi_accounts_issuer_url = "https://accounts.example/tenant"
  }

  expect_failures = [var.takosumi_accounts_issuer_url]
}

run "rejects_issuer_userinfo" {
  command = plan

  variables {
    takosumi_accounts_issuer_url = "https://user@accounts.example"
  }

  expect_failures = [var.takosumi_accounts_issuer_url]
}
