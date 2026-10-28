import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const text = await readFile(
  new URL(".well-known/takosumi.json", root),
  "utf8",
);
const manifest = JSON.parse(text) as RepositoryManifest;
const options = JSON.parse(
  await readFile(new URL("install-options.json", root), "utf8"),
) as { options: Array<{ source: { path: string } }> };
const moduleSources: Record<string, string> = {
  ".": await readFile(new URL("main.tf", root), "utf8"),
  "deploy/takoform": await readFile(
    new URL("deploy/takoform/main.tf", root),
    "utf8",
  ),
};

test("Takos Git publishes a closed Repository manifest", () => {
  expect(Object.keys(manifest).sort()).toEqual([
    "apiVersion",
    "install",
    "kind",
  ]);
  expect(manifest.apiVersion).toBe("takosumi.com/v2.5");
  expect(manifest.kind).toBe("Repository");
  expect(Object.keys(manifest.install)).toEqual(["modules"]);
  expect(manifest.install.defaultModule).toBeUndefined();
  expect(options.options.some((option) => option.source.path === ".")).toBe(true);
  expect(Object.keys(manifest.install.modules)).toEqual([
    ".",
    "deploy/takoform",
  ]);
  for (const option of options.options) {
    expect(manifest.install.modules[option.source.path]).toBeDefined();
  }
});

test("root context IDs use noneditable data declarations for the current install", () => {
  const module = manifest.install.modules["."]!;
  const contextInputs = module.inputs.filter((input) =>
    input.source.kind === "workspace_id" || input.source.kind === "capsule_id"
  );
  expect(contextInputs.map((input) => [input.name, input.source.kind, input.type]))
    .toEqual([
      ["app_workspace_id", "workspace_id", "string"],
      ["app_capsule_id", "capsule_id", "string"],
    ]);
  for (const input of contextInputs) {
    expect(Object.keys(input).sort()).toEqual(["label", "name", "source", "type"]);
    expect(Object.keys(input.source)).toEqual(["kind"]);
    expect(variableBlock(moduleSources["."]!, input.name)).toMatch(
      /\n\s+type\s+=\s+string\b/,
    );
    expect(module.inputs.filter((entry) => entry.source.kind === "user")
      .map((entry) => entry.name)).not.toContain(input.name);
  }
  expect(manifest.install.modules["deploy/takoform"]!.inputs.filter((input) =>
    input.source.kind === "workspace_id" || input.source.kind === "capsule_id"
  )).toEqual([]);
});

test("portable install declares Git and agent MCP Interfaces", () => {
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

test("advertised direct module delivers the complete public OIDC grant", () => {
  const module = manifest.install.modules["."]!;
  const oidc = module.requires?.find((entry) => entry.kind === "identity.oidc");
  expect(oidc?.deliver.variables).toEqual({
    accountsUrl: "takosumi_accounts_url",
    issuerUrl: "takosumi_accounts_issuer_url",
    clientId: "takosumi_accounts_client_id",
    redirectUri: "takosumi_accounts_redirect_uri",
  });
  expect(oidc?.callbackPath).toBe("/api/auth/callback");
  expect(new Set(Object.values(oidc?.deliver.variables ?? {})).size).toBe(4);
  const endpoint = module.requires?.find((entry) =>
    entry.kind === "http.endpoint"
  );
  expect(endpoint?.deliver.variables?.url).toBe("public_url");
});

test("declared modules reference real variables and no secret or host authority", () => {
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
  for (const requirement of module.requires ?? []) {
    for (const name of Object.values(requirement.deliver.variables ?? {})) {
      names.add(name);
    }
  }
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
    defaultModule?: string;
    modules: Record<string, RepositoryModule>;
  };
}

interface RepositoryModule {
  requires?: Array<{
    kind: string;
    callbackPath?: string;
    deliver: { variables?: Record<string, string> };
  }>;
  inputs: Array<{
    name: string;
    source: { kind: string };
    type?: string;
    secret?: boolean;
  }>;
  installExperience?: {
    projections: Array<{
      variable?: string;
      variables?: Record<string, string>;
    }>;
  };
  interfaces?: Array<{
    spec: {
      type: string;
      version: string;
      inputs: Record<string, { outputName?: string }>;
    };
    bindingRequests?: Array<Record<string, unknown>>;
  }>;
}
