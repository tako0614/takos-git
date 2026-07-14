/** Dependency-free MCP Streamable HTTP surface for repository management. */

import {
  hasValidInterfaceOAuthConfiguration,
  verifyInterfaceOAuthCredential,
} from "./interface-oauth-auth.ts";
import {
  createRepo,
  deleteRepo,
  isValidRepoName,
  listRepos,
  readRepoRefs,
  repoExists,
} from "./git/refs-store.ts";
import type { ObjectStoreBinding } from "./git/types.ts";
import { createDbClient, type D1Binding, type DbClient } from "./db/index.ts";
import { upsertPrincipal } from "./auth/acl.ts";
import { ensureOwnerForNamespace } from "./features/repos/owners.ts";
import { provisionRepo } from "./features/repos/repositories.ts";

const MCP_PROTOCOL_VERSION = "2025-03-26";
const MAX_MCP_BODY_BYTES = 1024 * 1024;

interface McpEnv {
  BUCKET: ObjectStoreBinding;
  /** D1 metadata plane. When present, MCP repo create/delete also writes the row. */
  DB?: D1Binding;
  PUBLISHED_MCP_AUTH_TOKEN?: string;
  APP_URL?: string;
  OIDC_ISSUER_URL?: string;
  APP_WORKSPACE_ID?: string;
  APP_CAPSULE_ID?: string;
}

type McpAuth =
  | { readonly kind: "capsule" }
  | {
      readonly kind: "interface";
      readonly subject: string;
      readonly bindingId: string;
    };

interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations: Record<string, boolean>;
  readonly call: (
    args: Record<string, unknown>,
    context: {
      env: McpEnv;
      auth: McpAuth;
      origin: string;
      db: DbClient | null;
    },
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
  interfaceUserInfoFetch?: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>,
): Promise<McpAuth | Response> {
  const token = bearerToken(request);
  if (!token) return unauthorized();
  if (env.PUBLISHED_MCP_AUTH_TOKEN) {
    if (await secretEquals(token, env.PUBLISHED_MCP_AUTH_TOKEN)) {
      // The explicitly configured standalone secret is scoped to this
      // installed Capsule, whose bucket is already one deployment boundary.
      return { kind: "capsule" };
    }
  }
  const requestUrl = new URL(request.url);
  const base = env.APP_URL?.trim() || requestUrl.origin;
  let audience = "";
  try {
    audience = new URL("/mcp", `${base.replace(/\/$/u, "")}/`).href;
  } catch {
    // Invalid configuration remains a fail-closed empty audience.
  }
  const interfaceOAuthConfigured = hasValidInterfaceOAuthConfiguration({
    issuerUrl: env.OIDC_ISSUER_URL,
    audience,
    workspaceId: env.APP_WORKSPACE_ID,
    capsuleId: env.APP_CAPSULE_ID,
  });
  if (!env.PUBLISHED_MCP_AUTH_TOKEN && !interfaceOAuthConfigured) {
    return new Response(
      JSON.stringify({ error: "mcp_authentication_unconfigured" }),
      {
        status: 503,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    );
  }
  if (interfaceOAuthConfigured) {
    const credential = await verifyInterfaceOAuthCredential(
      request,
      token,
      "mcp.invoke",
      {
        issuerUrl: env.OIDC_ISSUER_URL,
        expectedAudience: audience,
        expectedWorkspaceId: env.APP_WORKSPACE_ID,
        expectedCapsuleId: env.APP_CAPSULE_ID,
        ...(interfaceUserInfoFetch ? { fetchImpl: interfaceUserInfoFetch } : {}),
      },
    );
    if (credential.ok) {
      return {
        kind: "interface",
        subject: credential.subject,
        bindingId: credential.interfaceBindingId,
      };
    }
  }
  return unauthorized();
}

function requireRepo(args: Record<string, unknown>): string {
  const repo = typeof args.repo === "string" ? args.repo.trim() : "";
  if (!isValidRepoName(repo))
    throw new Error("repo must be a valid owner/name path");
  return repo;
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
      description: "Full repository path, for example acme/project.",
    },
  },
  required: ["repo"],
  additionalProperties: false,
};

const TOOLS: readonly ToolDefinition[] = [
  {
    name: "git_repo_list",
    description: "List Git repositories in this installed Capsule.",
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
    async call(args, { env }) {
      const limit =
        typeof args.limit === "number" && Number.isInteger(args.limit)
          ? Math.max(1, Math.min(args.limit, 100))
          : 100;
      const page = await listRepos(env.BUCKET, {
        ...(typeof args.cursor === "string" && args.cursor
          ? { cursor: args.cursor }
          : {}),
        limit,
      });
      return { repos: page.repos, nextCursor: page.cursor };
    },
  },
  {
    name: "git_repo_create",
    description: "Create an empty repository in this installed Capsule.",
    inputSchema: REPO_SCHEMA,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async call(args, { env, origin, auth, db }) {
      const repo = requireRepo(args);
      if (db) {
        // D1 configured → create the metadata row (via the same repos service)
        // so MCP-created repos are ACL-browsable, plus the R2 refs-doc.
        const [ownerLogin, name] = repo.split("/");
        const principal =
          auth.kind === "interface"
            ? await upsertPrincipal(db, {
                subject: auth.subject,
                kind: "service_account",
                bindingId: auth.bindingId,
              })
            : null;
        const owner = await ensureOwnerForNamespace(
          db,
          ownerLogin,
          principal?.id ?? null,
        );
        const result = await provisionRepo(env.BUCKET, db, owner, {
          name: name as string,
        });
        if (!result.ok) throw new Error("repository already exists");
      } else {
        const created = await createRepo(env.BUCKET, repo);
        if (!created) throw new Error("repository already exists");
      }
      return {
        repo,
        url: `${origin}/git/${repo.split("/").map(encodeURIComponent).join("/")}.git`,
      };
    },
  },
  {
    name: "git_repo_info",
    description: "Read repository refs and clone URL.",
    inputSchema: REPO_SCHEMA,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async call(args, { env, origin }) {
      const repo = requireRepo(args);
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
    description: "Delete repository refs from this installed Capsule.",
    inputSchema: REPO_SCHEMA,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    async call(args, { env, db }) {
      const repo = requireRepo(args);
      const deleted = await deleteRepo(env.BUCKET, repo);
      // Remove the D1 metadata row too (cascades collaborators/issues/…). R2 is
      // the authoritative existence signal, so a missing D1 row is not an error.
      if (db) {
        await db.run(`DELETE FROM repositories WHERE storage_key = ?`, [repo]);
      }
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
  interfaceUserInfoFetch?: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>,
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
  const auth = await authorize(request, env, interfaceUserInfoFetch);
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
      serverInfo: { name: "takos-git", version: "0.3.3" },
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
      db: env.DB ? createDbClient(env.DB) : null,
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
