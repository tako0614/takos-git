import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const [packageSource, moduleSource] = await Promise.all([
  readFile(new URL("../package.json", import.meta.url), "utf8"),
  readFile(new URL("../main.tf", import.meta.url), "utf8"),
]);

const packageVersion = (JSON.parse(packageSource) as { version: string })
  .version;

describe("release version", () => {
  test("keeps the OpenTofu artifact default aligned", () => {
    const releaseVariable = moduleSource.match(
      /variable\s+"worker_release_tag"\s*\{([\s\S]*?)\n\}/,
    )?.[1];
    expect(releaseVariable).toBeDefined();
    expect(releaseVariable).toContain(`default     = "v${packageVersion}"`);
  });

  test("matches the Git tag when the release workflow runs", () => {
    const gitRef = process.env.GITHUB_REF_NAME;
    if (!gitRef?.startsWith("v")) return;
    expect(gitRef).toBe(`v${packageVersion}`);
  });

  test("projects the Accounts issuer as a non-secret Worker binding", () => {
    expect(moduleSource).toContain('variable "takosumi_accounts_issuer_url"');
    expect(moduleSource).toMatch(
      /type = "plain_text"\s+name = "OIDC_ISSUER_URL"\s+text = local\.accounts_issuer_url/,
    );
  });

  test("keeps browser session secrets in secret Worker bindings", () => {
    expect(moduleSource).toContain('variable "app_session_secret"');
    expect(moduleSource).toMatch(
      /type = "secret_text"\s+name = "APP_SESSION_SECRET"\s+text = local\.app_session_secret/,
    );
    expect(moduleSource).toMatch(
      /type = "secret_text"\s+name = "OIDC_CLIENT_SECRET"\s+text = local\.accounts_client_secret/,
    );
  });

  test("does not provision an app-local runtime grant signer", () => {
    expect(moduleSource).not.toContain(
      ["service", "grant", "signing", "key"].join("_"),
    );
    expect(moduleSource).not.toContain(
      ["GIT", "TOKEN", "SIGNING", "KEY"].join("_"),
    );
  });
});
