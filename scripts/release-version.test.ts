import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const [
  packageSource,
  moduleSource,
  outputsSource,
  mcpSource,
  releaseWorkflow,
] = await Promise.all([
  readFile(new URL("../package.json", import.meta.url), "utf8"),
  readFile(new URL("../main.tf", import.meta.url), "utf8"),
  readFile(new URL("../outputs.tf", import.meta.url), "utf8"),
  readFile(new URL("../src/mcp.ts", import.meta.url), "utf8"),
  readFile(
    new URL(
      "../.github/workflows/worker-release-artifact.yml",
      import.meta.url,
    ),
    "utf8",
  ),
]);

const packageJson = JSON.parse(packageSource) as {
  version: string;
  scripts: Record<string, string>;
};
const packageVersion = packageJson.version;

describe("release version and Capsule contract", () => {
  test("keeps the embedded MCP version aligned without selecting an unpublished artifact", () => {
    const releaseVariable = moduleSource.match(
      /variable\s+"worker_release_tag"\s*\{([\s\S]*?)\n\}/,
    )?.[1];
    expect(releaseVariable).toBeDefined();
    const releaseDefault = releaseVariable?.match(
      /^\s*default\s*=\s*"([^"]+)"\s*$/m,
    )?.[1];
    expect(releaseDefault).toBe("v0.4.1");
    expect(releaseDefault).not.toBe(`v${packageVersion}`);
    expect(mcpSource).toContain(
      `serverInfo: { name: "takos-git", version: "${packageVersion}" }`,
    );
  });

  test("matches the Git tag when the release workflow runs", () => {
    const gitRef = process.env.GITHUB_REF_NAME;
    if (!gitRef?.startsWith("v")) return;
    expect(gitRef).toBe(`v${packageVersion}`);
  });

  test("manual publication refuses a tag that differs from package version", () => {
    expect(releaseWorkflow).toContain(
      'if [[ "${release_tag}" != "v${package_version}" ]]',
    );
    expect(releaseWorkflow).toContain("refusing to mutate existing release asset");
    expect(releaseWorkflow).toContain("bun install --frozen-lockfile");
    expect(releaseWorkflow).toContain("tofu init -backend=false -lockfile=readonly");
  });

  test("keeps runtime declarations and credentials out of ordinary outputs", () => {
    expect(outputsSource).not.toContain("app_deployment");
    expect(outputsSource).not.toContain("service_exports");
    expect(outputsSource).not.toContain('output "published_mcp_auth_token"');
    expect(outputsSource).not.toContain("sensitive   = true");
    expect(outputsSource).toContain('output "cloudflare_account_id"');
    expect(moduleSource).not.toContain('resource "takosumi_interface"');
    expect(moduleSource).not.toContain('source  = "takosjp/takosumi"');
    expect(moduleSource).not.toContain("INTERFACE_ID");
    expect(moduleSource).not.toContain("INTERFACE_BINDING_ID");
    expect(moduleSource).not.toContain("INTERFACE_RESOLVED_REVISION");
  });

  test("pins mirrored providers and retains only the legacy random destroy bridge", () => {
    expect(moduleSource).toContain('version = "= 5.19.1"');
    expect(moduleSource).toContain('version = "= 3.6.0"');
    expect(moduleSource).toContain('version = "= 3.9.0"');
    expect(moduleSource).not.toContain('resource "random_id"');
  });

  test("canonicalizes explicit public and issuer origins", () => {
    expect(moduleSource).toMatch(
      /public_origin\s+= trimsuffix\(trimspace\(var\.public_url\), "\/"\)/,
    );
    expect(moduleSource).toMatch(
      /accounts_issuer_url\s+= trimsuffix\(trimspace\(var\.takosumi_accounts_issuer_url\), "\/"\)/,
    );
  });

  test("registers the service-owned pre-destroy action command", () => {
    expect(packageJson.scripts["git:pre-destroy"]).toBe(
      "bun run scripts/purge-r2-before-destroy.ts",
    );
  });
});
