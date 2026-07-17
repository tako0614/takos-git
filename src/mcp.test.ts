import { describe, expect, test } from "bun:test";

import { MemoryBucket } from "./test-bucket.ts";
import worker, { createGitWorker, type Env } from "./worker.ts";
import { createDbClient } from "./db/client.ts";
import { createFakeD1 } from "./db/fake.ts";
import { migrationSql } from "./db/migration-sql.ts";

const MCP_TOKEN = "generated-published-mcp-token";

function env(): Env {
  return {
    BUCKET: new MemoryBucket(),
    PUBLISHED_MCP_AUTH_TOKEN: MCP_TOKEN,
  };
}

function mcpRequest(
  token: string | null,
  method: string,
  params?: Record<string, unknown>,
): Request {
  return new Request("https://git.example/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
  });
}

async function call(
  target: Env,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const response = await worker.fetch(
    mcpRequest(token, "tools/call", { name, arguments: args }),
    target,
  );
  expect(response.status).toBe(200);
  return response.json() as Promise<Record<string, unknown>>;
}

describe("takos-git MCP", () => {
  test("rejects cross-origin browser requests before authentication", async () => {
    const request = mcpRequest(MCP_TOKEN, "tools/list");
    request.headers.set("origin", "https://attacker.example");
    const response = await worker.fetch(request, env());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "mcp_origin_forbidden" });
  });

  test("requires bearer authentication and lists exactly four repository tools", async () => {
    const target = env();
    expect((await worker.fetch(mcpRequest(null, "tools/list"), target)).status).toBe(401);

    const response = await worker.fetch(mcpRequest(MCP_TOKEN, "tools/list"), target);
    expect(response.status).toBe(200);
    const body = await response.json() as {
      result: { tools: Array<{ name: string; annotations: Record<string, boolean> }> };
    };
    expect(body.result.tools.map((tool) => tool.name)).toEqual([
      "git_repo_list",
      "git_repo_create",
      "git_repo_info",
      "git_repo_delete",
    ]);
    expect(body.result.tools[0]?.annotations.readOnlyHint).toBe(true);
    expect(body.result.tools[3]?.annotations.destructiveHint).toBe(true);
    expect(body.result.tools.every((tool) => tool.annotations.openWorldHint === false))
      .toBe(true);
  });

  test("explicit standalone publication secret can create, inspect, list, and delete repos", async () => {
    const target = env();
    const created = await call(target, MCP_TOKEN, "git_repo_create", { repo: "acme/widgets" });
    expect((created.result as { structuredContent: { repo: string } }).structuredContent.repo)
      .toBe("acme/widgets");

    const info = await call(target, MCP_TOKEN, "git_repo_info", { repo: "acme/widgets" });
    expect((info.result as { structuredContent: { defaultBranch: null } }).structuredContent.defaultBranch)
      .toBeNull();

    const listed = await call(target, MCP_TOKEN, "git_repo_list");
    expect((listed.result as { structuredContent: { repos: string[] } }).structuredContent.repos)
      .toEqual(["acme/widgets"]);

    const deleted = await call(target, MCP_TOKEN, "git_repo_delete", { repo: "acme/widgets" });
    expect((deleted.result as { structuredContent: { deleted: boolean } }).structuredContent.deleted)
      .toBe(true);
  });

  test("with the metadata plane, git_repo_create/delete write and remove the D1 row", async () => {
    const fake = createFakeD1(migrationSql);
    const target: Env = {
      BUCKET: new MemoryBucket(),
      PUBLISHED_MCP_AUTH_TOKEN: MCP_TOKEN,
      DB: fake,
    };
    await call(target, MCP_TOKEN, "git_repo_create", { repo: "acme/widgets" });
    const db = createDbClient(fake);
    const created = await db.queryOne<{ storage_key: string }>(
      `SELECT storage_key FROM repositories WHERE storage_key = 'acme/widgets'`,
    );
    expect(created?.storage_key).toBe("acme/widgets");

    await call(target, MCP_TOKEN, "git_repo_delete", { repo: "acme/widgets" });
    const gone = await db.queryOne(
      `SELECT storage_key FROM repositories WHERE storage_key = 'acme/widgets'`,
    );
    expect(gone).toBeNull();
  });

  test("Interface OAuth accepts only the exact mcp.invoke audience and owner evidence", async () => {
    const interfaceWorker = createGitWorker(async () =>
      Response.json({
        token_use: "interface_oauth",
        sub: "principal_git",
        aud: "https://git.example/mcp",
        scope: "mcp.invoke",
        takosumi: {
          workspace_id: "workspace_a",
          capsule_id: "capsule_git",
          interface_id: "interface_git_mcp",
          interface_binding_id: "binding_mcp",
          interface_resolved_revision: 2,
        },
      }),
    );
    const target: Env = {
      BUCKET: new MemoryBucket(),
      APP_URL: "https://git.example",
      OIDC_ISSUER_URL: "https://accounts.example",
      APP_WORKSPACE_ID: "workspace_a",
      APP_CAPSULE_ID: "capsule_git",
    };
    const response = await interfaceWorker.fetch(
      mcpRequest("taksrv_git_mcp", "tools/list"),
      target,
    );
    expect(response.status).toBe(200);

    const wrongScopeWorker = createGitWorker(async () =>
      Response.json({
        token_use: "interface_oauth",
        sub: "principal_git",
        aud: "https://git.example/mcp",
        scope: "source.git.smart_http.read",
        takosumi: {
          workspace_id: "workspace_a",
          capsule_id: "capsule_git",
          interface_id: "interface_git_mcp",
          interface_binding_id: "binding_mcp",
          interface_resolved_revision: 2,
        },
      }),
    );
    expect(
      (
        await wrongScopeWorker.fetch(
          mcpRequest("taksrv_git_wrong_scope", "tools/list"),
          target,
        )
      ).status,
    ).toBe(401);

    const invalidRevisionWorker = createGitWorker(async () =>
      Response.json({
        token_use: "interface_oauth",
        sub: "principal_git",
        aud: "https://git.example/mcp",
        scope: "mcp.invoke",
        takosumi: {
          workspace_id: "workspace_a",
          capsule_id: "capsule_git",
          interface_id: "interface_git_mcp",
          interface_binding_id: "binding_mcp",
          interface_resolved_revision: 0,
        },
      }),
    );
    expect(
      (
        await invalidRevisionWorker.fetch(
          mcpRequest("taksrv_git_invalid_revision", "tools/list"),
          target,
        )
      ).status,
    ).toBe(401);
  });
});
