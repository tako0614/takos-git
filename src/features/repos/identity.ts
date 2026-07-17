/**
 * Best-effort identity resolution for the shared web+automation route surface.
 *
 * The frozen router (`src/router.ts`) declares exactly ONE auth mechanism per
 * route, but the forge surface must serve a request from any of three channels on
 * the SAME path (anonymous read of a public repo, a browser session, an Interface
 * OAuth bearer). So these routes register as `auth: "public"` and resolve the
 * richest available credential here, then gate every access through the frozen
 * `authorizeRepo` ACL. This is the pattern Phase-3b feature agents reuse.
 *
 * Mechanisms stay UNMIXED at resolution: a browser session is tried first, else an
 * Interface bearer, else anonymous. A presented-but-invalid credential fails
 * closed (401/503) — it never silently degrades to anonymous elevation.
 */

import {
  authorizeRepo,
  resolveRepoRow,
  upsertPrincipal,
  type RepoAclRow,
} from "../../auth/acl.ts";
import { readBrowserSession } from "../../browser-auth.ts";
import {
  ANONYMOUS_PRINCIPAL,
  SCOPES,
  type AuthContext,
  type AuthzReason,
  type RepoAction,
  type Role,
} from "../../contract/v1.ts";
import type { DbClient } from "../../db/index.ts";
import {
  hasValidInterfaceOAuthConfiguration,
  interfaceAudience,
  verifyInterfaceOAuthCredential,
} from "../../interface-oauth-auth.ts";
import type { RouteContext } from "../../router.ts";
import { errorResponse } from "./http.ts";

const BROWSER_SCOPES: ReadonlySet<string> = new Set(Object.values(SCOPES));

const REASON_CODE: Record<AuthzReason, string> = {
  unauthenticated: "unauthenticated",
  not_found: "not_found",
  forbidden: "forbidden",
  scope_insufficient: "scope_insufficient",
  protected_ref: "protected_ref",
  unconfigured: "unconfigured",
};

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

function bearerToken(request: Request): string | null {
  const match = /^Bearer\s+(.+)$/iu.exec(
    request.headers.get("authorization") ?? "",
  );
  return match?.[1]?.trim() || null;
}

function hostingAudience(env: RouteContext["env"]): string {
  return interfaceAudience(env.APP_URL, "/api/v1");
}

/** The anonymous read-only context. */
function anonymousContext(): AuthContext {
  return {
    principal: ANONYMOUS_PRINCIPAL,
    channel: "anonymous",
    scopes: new Set<string>(),
  };
}

/**
 * Resolve the request into an {@link AuthContext}, or a fail-closed error
 * Response. `interfaceScope` is the exact Interface-OAuth permission an
 * automation bearer must present for this route (the credential carries exactly
 * one scope, verified against this value).
 */
export async function resolveIdentity(
  ctx: RouteContext,
  interfaceScope: string,
): Promise<AuthContext | Response> {
  const { request, env, db } = ctx;
  if (!db) {
    return errorResponse(
      503,
      "metadata_unconfigured",
      "Repository metadata plane is not configured.",
    );
  }

  // 1. Browser OIDC session (carries the full human scope ceiling).
  const session = await readBrowserSession(request, env);
  if (session) {
    const principal = await upsertPrincipal(db, {
      subject: session.subject,
      kind: "user",
      displayName: session.name,
      email: session.email,
    });
    return { principal, channel: "browser", scopes: BROWSER_SCOPES };
  }

  // 2. Interface OAuth bearer (automation; scope-capped).
  const token = bearerToken(request);
  if (token) {
    const audience = hostingAudience(env);
    if (
      !hasValidInterfaceOAuthConfiguration({
        issuerUrl: env.OIDC_ISSUER_URL,
        audience,
        workspaceId: env.APP_WORKSPACE_ID,
        capsuleId: env.APP_CAPSULE_ID,
      })
    ) {
      return errorResponse(
        503,
        "interface_oauth_unconfigured",
        "Interface OAuth is not configured.",
      );
    }
    const credential = await verifyInterfaceOAuthCredential(
      request,
      token,
      interfaceScope,
      {
        issuerUrl: env.OIDC_ISSUER_URL,
        expectedAudience: audience,
        expectedWorkspaceId: env.APP_WORKSPACE_ID,
        expectedCapsuleId: env.APP_CAPSULE_ID,
        ...(ctx.interfaceUserInfoFetch
          ? { fetchImpl: ctx.interfaceUserInfoFetch }
          : {}),
      },
    );
    if (!credential.ok) {
      return errorResponse(401, "unauthorized", "Invalid credential.", undefined, {
        "www-authenticate": 'Bearer realm="Takos Git Hosting"',
      });
    }
    const principal = await upsertPrincipal(db, {
      subject: credential.subject,
      kind: "service_account",
      bindingId: credential.interfaceBindingId,
    });
    return {
      principal,
      channel: "interface",
      scopes: new Set([credential.scope]),
    };
  }

  // 3. Anonymous — eligible only for reads on public repos (gated downstream).
  return anonymousContext();
}

export interface RepoAccess {
  readonly repo: RepoAclRow;
  readonly role: Role;
  readonly auth: AuthContext;
  readonly db: DbClient;
}

/**
 * Resolve identity and authorize `action` on `:owner/:repo`. Returns a
 * {@link RepoAccess} on success, else a fail-closed Response. Anonymous is
 * admitted only for `contents.read`; every other action demands a resolved
 * principal.
 */
export async function requireRepoAccess(
  ctx: RouteContext,
  action: RepoAction,
  interfaceScope: string,
  opts?: { ref?: string },
): Promise<RepoAccess | Response> {
  const identity = await resolveIdentity(ctx, interfaceScope);
  if (identity instanceof Response) return identity;
  if (identity.channel === "anonymous" && action !== "contents.read") {
    return errorResponse(401, "unauthenticated", "Sign-in required.");
  }
  const db = ctx.db as DbClient;
  const owner = ctx.params.owner;
  const name = ctx.params.repo;
  const row = await resolveRepoRow(db, owner, name);
  const decision = await authorizeRepo(db, identity, owner, name, action, opts);
  if (!decision.allow) {
    return errorResponse(
      decision.status,
      REASON_CODE[decision.reason],
      reasonMessage(decision.reason),
    );
  }
  // decision.allow ⇒ the repo row exists.
  return { repo: row as RepoAclRow, role: decision.role, auth: identity, db };
}

/**
 * Same-origin CSRF guard for browser (cookie) mutations. Bearer callers carry no
 * ambient cookie and are exempt. Returns an error Response when the check fails,
 * else null.
 */
export function csrfGuard(ctx: RouteContext, auth: AuthContext): Response | null {
  if (auth.channel !== "browser") return null;
  const method = ctx.request.method.toUpperCase();
  if (method === "GET" || method === "HEAD") return null;
  const origin = ctx.request.headers.get("origin");
  if (origin) {
    if (origin === ctx.url.origin) return null;
    return errorResponse(403, "csrf_failed", "Cross-origin request rejected.");
  }
  const site = ctx.request.headers.get("sec-fetch-site");
  if (site === "same-origin" || site === "none") return null;
  return errorResponse(403, "csrf_failed", "Same-origin proof required.");
}

export { REASON_CODE, reasonMessage };
