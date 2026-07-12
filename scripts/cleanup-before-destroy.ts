export interface CleanupEnvironment {
  readonly TAKOS_GIT_URL?: string;
  readonly TAKOS_GIT_ACCESS_TOKEN?: string;
}

export interface CleanupResult {
  readonly kind: "takos-git.pre-destroy@v1";
  readonly status: "succeeded";
  readonly deletedRepositories: number;
  readonly cleanupVerified: true;
}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function callMcp(
  fetchImpl: typeof fetch,
  endpoint: URL,
  accessToken: string,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: name,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Takos Git MCP ${name} failed with status ${response.status}`,
    );
  }
  const payload: unknown = await response.json();
  if (!isRecord(payload))
    throw new Error(`Takos Git MCP ${name} returned invalid JSON`);
  if (isRecord(payload.error)) {
    const message =
      typeof payload.error.message === "string"
        ? payload.error.message
        : "tool call failed";
    throw new Error(`Takos Git MCP ${name} failed: ${message}`);
  }
  const result = isRecord(payload.result) ? payload.result : undefined;
  const structuredContent =
    result && isRecord(result.structuredContent)
      ? result.structuredContent
      : undefined;
  if (!structuredContent) {
    throw new Error(`Takos Git MCP ${name} returned no structured result`);
  }
  return structuredContent;
}

function repositories(value: Record<string, unknown>): readonly string[] {
  if (!Array.isArray(value.repos)) {
    throw new Error(
      "Takos Git MCP git_repo_list returned invalid repositories",
    );
  }
  const repos = value.repos.filter(
    (repo): repo is string => typeof repo === "string" && repo.length > 0,
  );
  if (repos.length !== value.repos.length) {
    throw new Error(
      "Takos Git MCP git_repo_list returned an invalid repository name",
    );
  }
  return repos;
}

export async function cleanupBeforeDestroy(
  env: CleanupEnvironment,
  fetchImpl: typeof fetch = fetch,
): Promise<CleanupResult> {
  const serviceUrl = new URL(required(env.TAKOS_GIT_URL, "TAKOS_GIT_URL"));
  const accessToken = required(
    env.TAKOS_GIT_ACCESS_TOKEN,
    "TAKOS_GIT_ACCESS_TOKEN",
  );
  const endpoint = new URL("/mcp", serviceUrl);
  let deletedRepositories = 0;

  // Always read the first page again after deleting it. R2 list cursors are
  // offsets, so reusing a cursor after deletion could skip remaining repos.
  for (let batch = 0; batch < 10_000; batch += 1) {
    const listed = await callMcp(
      fetchImpl,
      endpoint,
      accessToken,
      "git_repo_list",
      { limit: 100 },
    );
    const repos = repositories(listed);
    if (repos.length === 0) {
      return {
        kind: "takos-git.pre-destroy@v1",
        status: "succeeded",
        deletedRepositories,
        cleanupVerified: true,
      };
    }
    for (const repo of repos) {
      await callMcp(fetchImpl, endpoint, accessToken, "git_repo_delete", {
        repo,
      });
      deletedRepositories += 1;
    }
  }
  throw new Error("Takos Git cleanup exceeded the repository batch limit");
}

if (import.meta.main) {
  const result = await cleanupBeforeDestroy(process.env);
  console.log(JSON.stringify(result));
}
