/**
 * Table-driven route registry — the append-only registration surface that lets
 * feature agents add routes with a single import + register call instead of
 * editing worker.ts control flow.
 *
 * ## Default-deny
 *
 * - A non-public route MUST declare a `requiredRole` (repo-scoped floor); the
 *   registry throws at registration if it does not, so "forgot the auth check" is
 *   a build failure, not a shipped hole.
 * - Dispatch authenticates BEFORE the handler. A matched route always passes
 *   through the auth mechanism it declared; there is no fall-through-open path.
 * - Auth mechanisms stay UNMIXED: a route is browser-session OR interface-oauth,
 *   never both silently.
 * - `handle()` returns `null` only when NO registered route matches the path, so
 *   the worker can continue to the git / forge-api / asset handlers. A matched
 *   path with a wrong method is `405`, never a silent pass-through.
 */

import {
  anonymousContext,
  authorizeRepo,
  upsertPrincipal,
} from "./auth/acl.ts";
import { readBrowserSession, type OAuthFetch } from "./browser-auth.ts";
import {
  ACTION_REQUIRED_SCOPE,
  errorBody,
  roleAtLeast,
  SCOPES,
  type AuthContext,
  type AuthzReason,
  type HttpMethod,
  type RouteDeclaration,
  type RouteDefinition,
} from "./contract/v1.ts";
import { createDbClient, type D1Binding, type DbClient } from "./db/index.ts";
import type { ObjectStoreBinding } from "./git/types.ts";
import {
  hasValidInterfaceOAuthConfiguration,
  interfaceAudience,
  verifyInterfaceOAuthCredential,
} from "./interface-oauth-auth.ts";

// ============================================================================
// Env + context
// ============================================================================

export interface RouterEnv {
  BUCKET: ObjectStoreBinding;
  /** D1 metadata plane. Undefined until the operator enables it (main.tf gate). */
  DB?: D1Binding;
  APP_URL?: string;
  OIDC_ISSUER_URL?: string;
  OIDC_CLIENT_ID?: string;
  OIDC_CLIENT_SECRET?: string;
  APP_SESSION_SECRET?: string;
  APP_WORKSPACE_ID?: string;
  APP_CAPSULE_ID?: string;
}

export interface RouteContext {
  readonly request: Request;
  readonly url: URL;
  readonly env: RouterEnv;
  readonly params: Readonly<Record<string, string>>;
  readonly auth: AuthContext;
  /** A DB client when the metadata plane is configured, else null. */
  readonly db: DbClient | null;
  readonly interfaceUserInfoFetch?: OAuthFetch;
}

export type Route = RouteDefinition<RouteContext>;

export interface DispatchInput {
  readonly request: Request;
  readonly env: RouterEnv;
  readonly url?: URL;
  readonly interfaceUserInfoFetch?: OAuthFetch;
}

// The full ceiling a human browser session carries (bounded only by repo role).
const BROWSER_SCOPES: ReadonlySet<string> = new Set(Object.values(SCOPES));

// ============================================================================
// Helpers
// ============================================================================

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "application/json; charset=utf-8");
  responseHeaders.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  headers?: HeadersInit,
): Response {
  return json(errorBody(code, message), status, headers);
}

const REASON_STATUS: Record<AuthzReason, string> = {
  unauthenticated: "unauthenticated",
  not_found: "not_found",
  forbidden: "forbidden",
  scope_insufficient: "scope_insufficient",
  protected_ref: "protected_ref",
  unconfigured: "unconfigured",
};

function bearerToken(request: Request): string | null {
  const match = /^Bearer\s+(.+)$/iu.exec(
    request.headers.get("authorization") ?? "",
  );
  return match?.[1]?.trim() || null;
}

function hostingAudience(env: RouterEnv): string {
  return interfaceAudience(env.APP_URL, "/api/v1");
}

/** Interface scope ceiling a route enforces: explicit, else derived from action. */
function routeScope(route: RouteDeclaration): string | undefined {
  if (route.scope) return route.scope;
  if (route.action) return ACTION_REQUIRED_SCOPE[route.action];
  return undefined;
}

interface CompiledRoute {
  readonly def: Route;
  readonly regex: RegExp;
  readonly keys: readonly string[];
}

function compile(path: string): { regex: RegExp; keys: string[] } {
  const keys: string[] = [];
  const pattern = path
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":")) {
        keys.push(segment.slice(1));
        return "([^/]+)";
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    })
    .join("/");
  return { regex: new RegExp(`^${pattern}$`, "u"), keys };
}

type AuthOutcome =
  | { readonly ok: true; readonly ctx: AuthContext; readonly db: DbClient | null }
  | { readonly ok: false; readonly response: Response };

// ============================================================================
// Registry
// ============================================================================

export class RouteRegistry {
  readonly #routes: CompiledRoute[] = [];

  /** Register one route. Throws on a fail-open declaration (default-deny). */
  register(def: Route): this {
    if (
      def.auth !== "public" &&
      def.auth !== "browser" &&
      def.auth !== "interface"
    ) {
      throw new Error(`route ${def.method} ${def.path}: invalid auth mechanism`);
    }
    if (def.auth !== "public" && def.requiredRole === undefined) {
      throw new Error(
        `route ${def.method} ${def.path}: non-public route must declare a requiredRole (default-deny)`,
      );
    }
    if (def.auth === "interface" && routeScope(def) === undefined) {
      throw new Error(
        `route ${def.method} ${def.path}: interface route must declare a scope or action`,
      );
    }
    const { regex, keys } = compile(def.path);
    this.#routes.push({ def, regex, keys });
    return this;
  }

  registerAll(defs: Iterable<Route>): this {
    for (const def of defs) this.register(def);
    return this;
  }

  /** Every registered route declaration (for the meta-test + introspection). */
  list(): readonly RouteDeclaration[] {
    return this.#routes.map((route) => route.def);
  }

  /**
   * Dispatch a request. Returns a Response for a matched route (after auth), a
   * 405 for a matched path with the wrong method, or `null` when no route path
   * matches (so the worker continues to its other handlers).
   */
  async handle(input: DispatchInput): Promise<Response | null> {
    const url = input.url ?? new URL(input.request.url);
    const method = input.request.method.toUpperCase();
    const pathname = url.pathname;

    const pathMatches = this.#routes.filter((route) =>
      route.regex.test(pathname),
    );
    if (pathMatches.length === 0) return null;

    const matched = pathMatches.find((route) => route.def.method === method);
    if (!matched) {
      const allow = [
        ...new Set(pathMatches.map((route) => route.def.method)),
      ].join(", ");
      return errorResponse(405, "method_not_allowed", "Method Not Allowed", {
        allow,
      });
    }

    const params = extractParams(matched, pathname);

    // --- authenticate (mechanism-specific, unmixed) ---
    const auth = await authenticate(matched.def, input);
    if (!auth.ok) return auth.response;

    // --- per-repo authorization for repo-scoped routes ---
    if (matched.def.action && "owner" in params && "repo" in params) {
      if (!auth.db) {
        return errorResponse(
          503,
          "metadata_unconfigured",
          "Repository metadata plane is not configured.",
        );
      }
      const decision = await authorizeRepo(
        auth.db,
        auth.ctx,
        params.owner,
        params.repo,
        matched.def.action,
        params.ref ? { ref: params.ref } : undefined,
      );
      if (!decision.allow) {
        return errorResponse(
          decision.status,
          REASON_STATUS[decision.reason],
          reasonMessage(decision.reason),
        );
      }
      if (
        matched.def.requiredRole &&
        !roleAtLeast(decision.role, matched.def.requiredRole)
      ) {
        return errorResponse(403, "forbidden", "Insufficient repository role.");
      }
    }

    return matched.def.handler({
      request: input.request,
      url,
      env: input.env,
      params,
      auth: auth.ctx,
      db: auth.db,
      ...(input.interfaceUserInfoFetch
        ? { interfaceUserInfoFetch: input.interfaceUserInfoFetch }
        : {}),
    });
  }
}

function extractParams(
  route: CompiledRoute,
  pathname: string,
): Record<string, string> {
  const match = route.regex.exec(pathname);
  const params: Record<string, string> = {};
  if (!match) return params;
  route.keys.forEach((key, index) => {
    try {
      params[key] = decodeURIComponent(match[index + 1]);
    } catch {
      params[key] = match[index + 1];
    }
  });
  return params;
}

function reasonMessage(reason: AuthzReason): string {
  switch (reason) {
    case "not_found":
      return "Not Found";
    case "forbidden":
      return "Forbidden";
    case "scope_insufficient":
      return "The credential scope does not permit this action.";
    case "protected_ref":
      return "Branch protection rejected this update.";
    case "unconfigured":
      return "Authorization is not configured.";
    default:
      return "Unauthorized";
  }
}

// ============================================================================
// Authentication (one mechanism per route; never mixed)
// ============================================================================

async function authenticate(
  def: Route,
  input: DispatchInput,
): Promise<AuthOutcome> {
  const { request, env } = input;
  const db = env.DB ? createDbClient(env.DB) : null;

  if (def.auth === "public") {
    return { ok: true, ctx: anonymousContext(), db };
  }

  if (def.auth === "browser") {
    const session = await readBrowserSession(request, env);
    if (!session) {
      return {
        ok: false,
        response: errorResponse(401, "unauthenticated", "Sign-in required."),
      };
    }
    if (!db) {
      return {
        ok: false,
        response: errorResponse(
          503,
          "metadata_unconfigured",
          "Repository metadata plane is not configured.",
        ),
      };
    }
    const principal = await upsertPrincipal(db, {
      subject: session.subject,
      kind: "user",
      displayName: session.name,
      email: session.email,
    });
    return {
      ok: true,
      db,
      ctx: { principal, channel: "browser", scopes: BROWSER_SCOPES },
    };
  }

  // interface
  const token = bearerToken(request);
  if (!token) {
    return {
      ok: false,
      response: errorResponse(401, "unauthenticated", "Bearer token required.", {
        "www-authenticate": 'Bearer realm="Takos Git Hosting"',
      }),
    };
  }
  const audience = hostingAudience(env);
  if (
    !hasValidInterfaceOAuthConfiguration({
      issuerUrl: env.OIDC_ISSUER_URL,
      audience,
      workspaceId: env.APP_WORKSPACE_ID,
      capsuleId: env.APP_CAPSULE_ID,
    })
  ) {
    return {
      ok: false,
      response: errorResponse(
        503,
        "interface_oauth_unconfigured",
        "Interface OAuth is not configured.",
      ),
    };
  }
  const scope = routeScope(def) as string;
  const credential = await verifyInterfaceOAuthCredential(
    request,
    token,
    scope,
    {
      issuerUrl: env.OIDC_ISSUER_URL,
      expectedAudience: audience,
      expectedWorkspaceId: env.APP_WORKSPACE_ID,
      expectedCapsuleId: env.APP_CAPSULE_ID,
      ...(input.interfaceUserInfoFetch
        ? { fetchImpl: input.interfaceUserInfoFetch }
        : {}),
    },
  );
  if (!credential.ok) {
    return {
      ok: false,
      response: errorResponse(401, "unauthorized", "Invalid credential.", {
        "www-authenticate": 'Bearer realm="Takos Git Hosting"',
      }),
    };
  }
  if (!db) {
    return {
      ok: false,
      response: errorResponse(
        503,
        "metadata_unconfigured",
        "Repository metadata plane is not configured.",
      ),
    };
  }
  const principal = await upsertPrincipal(db, {
    subject: credential.subject,
    kind: "service_account",
    bindingId: credential.interfaceBindingId,
  });
  return {
    ok: true,
    db,
    ctx: {
      principal,
      channel: "interface",
      scopes: new Set([credential.scope]),
    },
  };
}

/** The default global registry the worker dispatches through. */
export const routes = new RouteRegistry();
