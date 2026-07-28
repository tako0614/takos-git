import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

const [
  packageSource,
  moduleSource,
  takoformModuleSource,
  outputsSource,
  mcpSource,
  releaseLockSource,
  ciWorkflowSource,
] = await Promise.all([
  readFile(new URL("../package.json", import.meta.url), "utf8"),
  readFile(new URL("../main.tf", import.meta.url), "utf8"),
  readFile(new URL("../deploy/takoform/main.tf", import.meta.url), "utf8"),
  readFile(new URL("../outputs.tf", import.meta.url), "utf8"),
  readFile(new URL("../src/mcp.ts", import.meta.url), "utf8"),
  readFile(new URL("../release.lock.json", import.meta.url), "utf8"),
  readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
]);

const packageJson = JSON.parse(packageSource) as {
  version: string;
  scripts: Record<string, string>;
};
const packageVersion = packageJson.version;
const releaseLock = JSON.parse(releaseLockSource) as {
  kind: string;
  app: string;
  releases: Record<
    string,
    {
      artifact: { filename: string; url: string; sha256: string };
      manifest: { url: string; sha256: string };
      commit: string;
      seededFrom: string;
    }
  >;
};
const ciWorkflow = parseYaml(ciWorkflowSource) as {
  on: {
    pull_request?: unknown;
    push?: { branches?: string[]; tags?: string[] };
    workflow_dispatch?: unknown;
  };
  permissions: Record<string, string>;
  jobs: Record<
    string,
    {
      steps?: Array<{
        name?: string;
        uses?: string;
        with?: Record<string, unknown>;
        run?: string;
      }>;
    }
  >;
};

describe("release version and Capsule contract", () => {
  test("keeps the module default and embedded MCP version aligned with the published release", () => {
    for (const source of [moduleSource, takoformModuleSource]) {
      const releaseVariable = source.match(
        /variable\s+"worker_release_tag"\s*\{([\s\S]*?)\n\}/,
      )?.[1];
      expect(releaseVariable).toBeDefined();
      const releaseDefault = releaseVariable?.match(
        /^\s*default\s*=\s*"([^"]+)"\s*$/m,
      )?.[1];
      expect(releaseDefault).toBe(`v${packageVersion}`);
    }
    expect(takoformModuleSource).toContain(
      `/releases/download/v${packageVersion}/worker.js`,
    );
    expect(takoformModuleSource).toMatch(/default\s+=\s+"sha256:[a-f0-9]{64}"/);
    expect(mcpSource).toContain(
      `serverInfo: { name: "takos-git", version: "${packageVersion}" }`,
    );
  });

  test("keeps GitHub Actions credentialless and delegates to the owner gate", async () => {
    expect(ciWorkflow.permissions).toEqual({ contents: "read" });
    expect(ciWorkflow.on.pull_request).toBeDefined();
    expect(ciWorkflow.on.push?.branches).toEqual(["main"]);
    expect(ciWorkflow.on.push?.tags).toBeUndefined();
    expect(ciWorkflow.on.workflow_dispatch).toBeUndefined();
    expect(Object.keys(ciWorkflow.jobs)).toEqual(["quality"]);

    const steps = ciWorkflow.jobs.quality?.steps ?? [];
    const checkout = steps.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
    expect(steps.flatMap((step) => step.run ?? [])).toEqual([
      "bun install --frozen-lockfile",
      "cd web && bun install --frozen-lockfile",
      "bun run check",
    ]);
    expect(ciWorkflowSource).not.toMatch(
      /contents:\s*write|GH_TOKEN|github\.token|gh release|wrangler deploy|tofu apply|actions\/upload-artifact/iu,
    );
    expect(
      await Bun.file(
        new URL(
          "../.github/workflows/worker-release-artifact.yml",
          import.meta.url,
        ),
      ).exists(),
    ).toBe(false);
    expect(packageJson.scripts["smoke:postdeploy"]).toBeUndefined();
  });

  test("never interpolates an expression into a run: script", () => {
    const offenders: string[] = [];
    for (const [jobId, job] of Object.entries(ciWorkflow.jobs)) {
      for (const step of job.steps ?? []) {
        if (step.run?.includes("${{")) {
          offenders.push(`${jobId}/${step.name ?? step.run.slice(0, 40)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("never lets fetched release material certify its own bundle", () => {
    // The tag, manifest, and Worker asset are one remote authority. The
    // reviewed in-tree lock independently pins both downloaded byte streams.
    expect(moduleSource).not.toContain(
      "worker_release_manifest.artifact.sha256",
    );
    expect(moduleSource).toContain(
      'jsondecode(file("${path.module}/release.lock.json"))',
    );

    expect(releaseLock.kind).toBe("takos.release-artifact-lock@v1");
    expect(releaseLock.app).toBe("takos-git");
    const pin = releaseLock.releases[`v${packageVersion}`];
    expect(pin).toBeDefined();
    expect(pin?.artifact.filename).toBe("worker.js");
    expect(pin?.artifact.url).toMatch(/^https:\/\//);
    expect(pin?.artifact.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(pin?.manifest.url).toMatch(/^https:\/\//);
    expect(pin?.manifest.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(pin?.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(pin?.seededFrom.trim()).not.toBe("");

    expect(moduleSource).toContain(
      "local.worker_release_manifest_expected_sha256 == local.worker_release_manifest_digest",
    );
    expect(moduleSource).toContain(
      "local.worker_release_artifact_expected_sha256 == local.worker_bundle_content_sha256",
    );
    expect(moduleSource).toContain(
      "try(local.worker_release_manifest.commit, \"\") == try(local.worker_release_pin.commit, \"\")",
    );
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
