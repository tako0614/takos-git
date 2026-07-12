/** Dependency-free MCP Streamable HTTP surface for repository management. */

import {
  gitTokenAllows,
  verifyGitToken,
  type GitTokenPayload,
  type GitTokenVerb,
} from "./git-token.ts";
import {
  createRepo,
  deleteRepo,
  isValidRepoName,
  listRepos,
  readRepoRefs,
  repoExists,
} from "./git/refs-store.ts";
import type { ObjectStoreBinding } from "./git/types.ts";

const MCP_PROTOCOL_VERSION = "2025-03-26";
const MAX_MCP_BODY_BYTES = 1024 * 1024;

interface McpEnv {
  BUCKET: ObjectStoreBinding;
  GIT_TOKEN_SIGNING_KEY: string;
  PUBLISHED_MCP_AUTH_TOKEN?: string;
}

type McpAuth =
  | { readonly kind: "capsule" }
  | { readonly kind: "grant"; readonly payload: GitTokenPayload };

interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations: Record<string, boolean>;
  readonly call: (
    args: Record<string, unknown>,
    context: { env: McpEnv; auth: McpAuth; origin: string },
  ) => Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonRpcResult(id: unknown, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, result });
}

function jsonRpcError(id: unknown, code: number, message: string): Response {
  return Response.json({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message },
  });
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "mcp_unauthorized" }), {
    status: 401,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "www-authenticate": 'Bearer realm="Takos Git MCP"',
    },
  });
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() || null;
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

async function secretEquals(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([digest(left), digest(right)]);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

async function authorize(
  request: Request,
  env: McpEnv,
): Promise<McpAuth | Response> {
  const token = bearerToken(request);
  if (!token) return unauthorized();
  if (env.PUBLISHED_MCP_AUTH_TOKEN) {
    if (await secretEquals(token, env.PUBLISHED_MCP_AUTH_TOKEN)) {
      // The generated publication secret is scoped to this installed Capsule,
      // whose bucket is already a single-Workspace boundary.
      return { kind: "capsule" };
    }
  }
  if (!env.GIT_TOKEN_SIGNING_KEY) {
    return new Response(
      JSON.stringify({ error: "git_signing_key_unconfigured" }),
      {
        status: 503,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    );
  }
  const verified = await verifyGitToken(env.GIT_TOKEN_SIGNING_KEY, token);
  return verified.ok
    ? { kind: "grant", payload: verified.payload }
    : unauthorized();
}

function can(auth: McpAuth, verb: GitTokenVerb, repo: string): boolean {
  return auth.kind === "capsule" || gitTokenAllows(auth.payload, verb, repo);
}

function requireRepo(args: Record<string, unknown>): string {
  const repo = typeof args.repo === "string" ? args.repo.trim() : "";
  if (!isValidRepoName(repo))
    throw new Error("repo must be a valid owner/name path");
  return repo;
}

function requireAccess(auth: McpAuth, verb: GitTokenVerb, repo: string): void {
  if (!can(auth, verb, repo))
    throw new Error("repository is outside the grant scope");
}

function mcpResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

const REPO_SCHEMA = {
  type: "object",
  properties: {
    repo: {
      type: "string",
      description:
        "Full repository path under the authenticated Workspace prefix, for example space_x/project.",
    },
  },
  required: ["repo"],
  additionalProperties: false,
};

const TOOLS: readonly ToolDefinition[] = [
  {
    name: "git_repo_list",
    description:
      "List Git repositories visible inside the authenticated Workspace/prefix scope.",
    inputSchema: {
      type: "object",
      properties: {
        cursor: {
          type: "string",
          description: "Opaque cursor from a previous result.",
        },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 100 },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async call(args, { env, auth }) {
      if (auth.kind === "grant" && !auth.payload.cap.includes("r")) {
        throw new Error("read capability required");
      }
      const limit =
        typeof args.limit === "number" && Number.isInteger(args.limit)
          ? Math.max(1, Math.min(args.limit, 100))
          : 100;
      const page = await listRepos(env.BUCKET, {
        ...(auth.kind === "grant" ? { prefix: auth.payload.pfx } : {}),
        ...(typeof args.cursor === "string" && args.cursor
          ? { cursor: args.cursor }
          : {}),
        limit,
      });
      const repos = page.repos.filter((repo) => can(auth, "r", repo));
      return { repos, nextCursor: page.cursor };
    },
  },
  {
    name: "git_repo_create",
    description:
      "Create an empty repository inside the authenticated Workspace/prefix scope.",
    inputSchema: REPO_SCHEMA,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async call(args, { env, auth, origin }) {
      const repo = requireRepo(args);
      requireAccess(auth, "w", repo);
      const created = await createRepo(env.BUCKET, repo);
      if (!created) throw new Error("repository already exists");
      return {
        repo,
        url: `${origin}/git/${repo.split("/").map(encodeURIComponent).join("/")}.git`,
      };
    },
  },
  {
    name: "git_repo_info",
    description:
      "Read repository refs and clone URL inside the authenticated Workspace/prefix scope.",
    inputSchema: REPO_SCHEMA,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async call(args, { env, auth, origin }) {
      const repo = requireRepo(args);
      requireAccess(auth, "r", repo);
      if (!(await repoExists(env.BUCKET, repo)))
        throw new Error("repository not found");
      const refs = await readRepoRefs(env.BUCKET, repo);
      return {
        repo,
        url: `${origin}/git/${repo.split("/").map(encodeURIComponent).join("/")}.git`,
        defaultBranch: refs.defaultBranch,
        refs: refs.refs,
      };
    },
  },
  {
    name: "git_repo_delete",
    description:
      "Delete repository refs inside the authenticated Workspace/prefix scope.",
    inputSchema: REPO_SCHEMA,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    async call(args, { env, auth }) {
      const repo = requireRepo(args);
      requireAccess(auth, "w", repo);
      const deleted = await deleteRepo(env.BUCKET, repo);
      if (!deleted) throw new Error("repository not found");
      return { repo, deleted: true };
    },
  },
];

const TOOL_MAP = new Map(TOOLS.map((tool) => [tool.name, tool]));

async function readBody(request: Request): Promise<string | null> {
  const length = request.headers.get("content-length");
  if (length && Number(length) > MAX_MCP_BODY_BYTES) return null;
  const bytes = new Uint8Array(await request.arrayBuffer());
  return bytes.length > MAX_MCP_BODY_BYTES
    ? null
    : new TextDecoder().decode(bytes);
}

export async function handleMcp(
  request: Request,
  env: McpEnv,
): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return new Response(JSON.stringify({ error: "mcp_origin_forbidden" }), {
      status: 403,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { allow: "POST, OPTIONS" },
    });
  }
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { "content-type": "application/json", allow: "POST, OPTIONS" },
    });
  }
  const auth = await authorize(request, env);
  if (auth instanceof Response) return auth;

  const bodyText = await readBody(request);
  if (bodyText === null)
    return jsonRpcError(null, -32600, "Request body too large");
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return jsonRpcError(null, -32700, "Parse error");
  }
  if (
    !isRecord(body) ||
    body.jsonrpc !== "2.0" ||
    typeof body.method !== "string"
  ) {
    return jsonRpcError(
      isRecord(body) ? body.id : null,
      -32600,
      "Invalid Request",
    );
  }

  if (body.method === "initialize") {
    return jsonRpcResult(body.id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "takos-git", version: "0.3.2" },
    });
  }
  if (body.method === "notifications/initialized")
    return new Response(null, { status: 202 });
  if (body.method === "tools/list") {
    return jsonRpcResult(body.id, {
      tools: TOOLS.map(({ name, description, inputSchema, annotations }) => ({
        name,
        description,
        inputSchema,
        annotations,
      })),
    });
  }
  if (body.method !== "tools/call")
    return jsonRpcError(body.id, -32601, "Method not found");
  if (!isRecord(body.params) || typeof body.params.name !== "string") {
    return jsonRpcError(body.id, -32602, "Invalid params");
  }
  const tool = TOOL_MAP.get(body.params.name);
  if (!tool)
    return jsonRpcError(body.id, -32602, `Unknown tool: ${body.params.name}`);
  const args = isRecord(body.params.arguments) ? body.params.arguments : {};
  try {
    const result = await tool.call(args, {
      env,
      auth,
      origin: new URL(request.url).origin,
    });
    return jsonRpcResult(body.id, mcpResult(result));
  } catch (error) {
    return jsonRpcError(
      body.id,
      -32603,
      error instanceof Error ? error.message : "tool call failed",
    );
  }
}
