import { describe, expect, test } from "bun:test";

import { cleanupBeforeDestroy } from "./cleanup-before-destroy.ts";

interface McpRequest {
  readonly params?: {
    readonly name?: string;
    readonly arguments?: Record<string, unknown>;
  };
}

function mcpResponse(structuredContent: Record<string, unknown>): Response {
  return Response.json({
    jsonrpc: "2.0",
    id: "test",
    result: { structuredContent },
  });
}

describe("pre-destroy cleanup", () => {
  test("deletes every repository in first-page batches and verifies empty", async () => {
    const remaining = Array.from(
      { length: 205 },
      (_, index) => `owner/repo-${String(index).padStart(3, "0")}`,
    );
    const requests: Array<{ name: string; authorization: string | null }> = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as McpRequest;
      const name = body.params?.name ?? "";
      requests.push({
        name,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      if (name === "git_repo_list") {
        return mcpResponse({
          repos: remaining.slice(0, 100),
          nextCursor: null,
        });
      }
      if (name === "git_repo_delete") {
        const repo = body.params?.arguments?.repo;
        const index = remaining.indexOf(String(repo));
        if (index < 0) return Response.json({ error: { message: "missing" } });
        remaining.splice(index, 1);
        return mcpResponse({ repo, deleted: true });
      }
      return new Response("not found", { status: 404 });
    };

    const result = await cleanupBeforeDestroy(
      {
        TAKOS_GIT_URL: "https://git.example/",
        TAKOS_GIT_ACCESS_TOKEN: "cleanup-secret",
      },
      fetchImpl,
    );

    expect(result).toEqual({
      kind: "takos-git.pre-destroy@v1",
      status: "succeeded",
      deletedRepositories: 205,
      cleanupVerified: true,
    });
    expect(remaining).toEqual([]);
    expect(
      requests.filter(({ name }) => name === "git_repo_list"),
    ).toHaveLength(4);
    expect(
      requests.every(
        ({ authorization }) => authorization === "Bearer cleanup-secret",
      ),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain("cleanup-secret");
  });

  test("fails closed when a delete call fails", async () => {
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as McpRequest;
      return body.params?.name === "git_repo_list"
        ? mcpResponse({ repos: ["owner/repo"], nextCursor: null })
        : Response.json({
            jsonrpc: "2.0",
            id: "test",
            error: { code: -32603, message: "repository delete failed" },
          });
    };

    expect(
      cleanupBeforeDestroy(
        {
          TAKOS_GIT_URL: "https://git.example/",
          TAKOS_GIT_ACCESS_TOKEN: "cleanup-secret",
        },
        fetchImpl,
      ),
    ).rejects.toThrow("repository delete failed");
  });
});
