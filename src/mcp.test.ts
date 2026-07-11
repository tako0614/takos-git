import { describe, expect, test } from "bun:test";

import { mintGitToken } from "./git-token.ts";
import { MemoryBucket } from "./test-bucket.ts";
import worker, { type Env } from "./worker.ts";

const SIGNING_KEY = "mcp-test-signing-key";
const MCP_TOKEN = "generated-published-mcp-token";

function env(): Env {
  return {
    BUCKET: new MemoryBucket(),
    GIT_TOKEN_SIGNING_KEY: SIGNING_KEY,
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

  test("generated publication secret can create, inspect, list, and delete repos", async () => {
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

  test("signed grants enforce prefix and read/write capabilities", async () => {
    const target = env();
    const scoped = await mintGitToken(SIGNING_KEY, {
      v: 1,
      ws: "workspace_a",
      sub: "consumer_a",
      pfx: "acme",
      cap: ["r", "w"],
      aud: "source.git.smart_http",
      iat: Math.floor(Date.now() / 1000),
    });
    await call(target, scoped, "git_repo_create", { repo: "acme/allowed" });
    const denied = await call(target, scoped, "git_repo_create", { repo: "other/denied" });
    expect((denied.error as { message: string }).message).toContain("outside the grant scope");

    const listed = await call(target, scoped, "git_repo_list");
    expect((listed.result as { structuredContent: { repos: string[] } }).structuredContent.repos)
      .toEqual(["acme/allowed"]);

    const readOnly = await mintGitToken(SIGNING_KEY, {
      v: 1,
      ws: "workspace_a",
      sub: "consumer_b",
      pfx: "acme",
      cap: ["r"],
      aud: "source.git.smart_http",
      iat: Math.floor(Date.now() / 1000),
    });
    const writeDenied = await call(target, readOnly, "git_repo_delete", { repo: "acme/allowed" });
    expect((writeDenied.error as { message: string }).message).toContain("outside the grant scope");
  });
});
