import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const text = await readFile(new URL(".well-known/takosumi.json", root), "utf8");
const manifest = JSON.parse(text) as RepositoryManifest;
const moduleSources: Record<string, string> = {
  ".": await readFile(new URL("main.tf", root), "utf8"),
  "deploy/takoform": await readFile(
    new URL("deploy/takoform/main.tf", root),
    "utf8",
  ),
};

test("Takos Git publishes repository input and service hints", () => {
  expect(Object.keys(manifest).sort()).toEqual([
    "apiVersion",
    "install",
    "kind",
  ]);
  expect(manifest.apiVersion).toBe("takosumi.com/v2.3");
  expect(manifest.kind).toBe("Repository");
  expect(Object.keys(manifest.install)).toEqual(["modules"]);
  expect(Object.keys(manifest.install.modules)).toEqual([
    ".",
    "deploy/takoform",
  ]);
  for (const path of Object.keys(manifest.install.modules)) {
    expect(moduleSources[path]).toBeDefined();
  }
});

test("portable service declarations advertise Git and agent MCP Interfaces", () => {
  const interfaces =
    manifest.install.modules["deploy/takoform"]?.interfaces ?? [];
  expect(interfaces.map((entry) => entry.spec.type)).toEqual([
    "source.git.smart_http",
    "mcp.server",
  ]);
  const mcp = interfaces.find((entry) => entry.spec.type === "mcp.server");
  expect(mcp?.spec.version).toBe("2025-11-25");
  expect(mcp?.spec.inputs.endpoint?.outputName).toBe("mcp_url");
  expect(mcp?.bindingRequests).toEqual([
    {
      key: "installer",
      subject: { source: "installing_principal" },
      permissions: ["mcp.invoke"],
      delivery: { type: "oauth2" },
    },
  ]);
});

test("repository install hints reference real variables and carry no secret or host authority", () => {
  for (const [path, module] of Object.entries(manifest.install.modules)) {
    const source = moduleSources[path];
    expect(source).toBeDefined();
    const variables = new Set(
      Array.from(
        source.matchAll(/variable\s+"([^"]+)"\s*\{/g),
        (match) => match[1],
      ),
    );
    for (const name of referencedVariables(module)) {
      expect(variables.has(name)).toBe(true);
    }
    for (const input of module.inputs) {
      expect(input.secret).toBeUndefined();
      if (input.source.kind === "module_default") {
        expect(variableBlock(source, input.name)).toMatch(/\n\s+default\s+=/);
      }
      expect(input.name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
      expect(typeof input.label.ja).toBe("string");
      expect(typeof input.label.en).toBe("string");
    }
    for (const requirement of module.requires ?? []) {
      expect(["http.endpoint", "identity.oidc", "interface.consume"]).toContain(
        requirement.kind,
      );
      if (requirement.deliver) {
        expect(Object.keys(requirement.deliver)).toHaveLength(1);
      }
    }
  }
  for (const forbidden of [
    "cloudflare_account_id",
    "enable_cloudflare_resources",
    "enable_cloudflare_worker_script",
    "app_session_secret",
    "webhook_secret_key",
    "published_mcp_auth_token",
    "actions_runner_secret",
    "actions_secrets_key",
    '"env"',
    "credential",
  ]) {
    expect(text).not.toContain(forbidden);
  }
});

function variableBlock(source: string, name: string): string {
  const start = source.indexOf(`variable "${name}" {`);
  const next = source.indexOf("\nvariable ", start + 1);
  return source.slice(start, next < 0 ? undefined : next);
}

function referencedVariables(module: RepositoryModule): Set<string> {
  const names = new Set(module.inputs.map((input) => input.name));
  for (const projection of module.installExperience?.projections ?? []) {
    if (projection.variable) names.add(projection.variable);
    for (const value of Object.values(projection.variables ?? {})) {
      names.add(value);
    }
  }
  return names;
}

interface RepositoryManifest {
  apiVersion: string;
  kind: string;
  install: {
    modules: Record<string, RepositoryModule>;
  };
}

interface RepositoryModule {
  inputs: Array<{
    name: string;
    source: { kind: string };
    label: { ja: string; en: string };
    secret?: boolean;
  }>;
  requires?: Array<{
    kind: string;
    deliver?: Record<string, unknown>;
  }>;
  installExperience?: {
    projections: Array<{
      variable?: string;
      variables?: Record<string, string>;
    }>;
  };
  interfaces?: Array<{
    name: string;
    spec: {
      type: string;
      version: string;
      inputs: Record<string, { outputName?: string }>;
      access?: Record<string, unknown>;
    };
    bindingRequests?: Array<Record<string, unknown>>;
  }>;
}
