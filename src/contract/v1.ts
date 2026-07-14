/**
 * Versioned `/api/v1` contract for takos-git.
 *
 * Shared request/response DTOs, the identity/authorization vocabulary, and the
 * route-declaration types the registry (`src/router.ts`) is built from. Imported
 * by every route handler and (its DTO subset) by the SPA. This is a versioned
 * takos-git surface — NOT GitHub REST/GraphQL wire-compat.
 */

// ============================================================================
// Roles, visibility
// ============================================================================

/** Per-repo role, totally ordered reader < writer < maintainer < owner. */
export type Role = "reader" | "writer" | "maintainer" | "owner";

export const ROLE_ORDER: readonly Role[] = [
  "reader",
  "writer",
  "maintainer",
  "owner",
];

export function roleRank(role: Role): number {
  return ROLE_ORDER.indexOf(role);
}

export function roleAtLeast(role: Role, min: Role): boolean {
  return roleRank(role) >= roleRank(min);
}

/** Max of several role sources; null when every source is null/undefined. */
export function maxRole(...roles: Array<Role | null | undefined>): Role | null {
  let best: Role | null = null;
  for (const role of roles) {
    if (!role) continue;
    if (best === null || roleRank(role) > roleRank(best)) best = role;
  }
  return best;
}

export type Visibility = "public" | "private" | "internal";

// ============================================================================
// Interface OAuth scopes (capability ceilings)
// ============================================================================

export const SCOPES = {
  smartHttpRead: "source.git.smart_http.read",
  smartHttpWrite: "source.git.smart_http.write",
  hostingRead: "source.git.hosting.read",
  hostingWrite: "source.git.hosting.write",
  hostingAdmin: "source.git.hosting.admin",
  mcpInvoke: "mcp.invoke",
} as const;

export type Scope = (typeof SCOPES)[keyof typeof SCOPES];

// ============================================================================
// Identity
// ============================================================================

/** Persisted principal kind (mirrors `principals.kind`) plus the anon sentinel. */
export type PrincipalKind = "user" | "service_account" | "anonymous";

export type AuthChannel = "browser" | "interface" | "capsule" | "anonymous";

/**
 * A resolved actor. Identity is pinned to `(issuer, subject[, bindingId])`, never
 * to a mutable owner slug or a rotatable token, so grants survive rotation.
 */
export interface Principal {
  /** ULID from `principals.id`, or the sentinel `"anon"`. */
  readonly id: string;
  readonly kind: PrincipalKind;
  /** OIDC `sub` / Interface OAuth `sub`, or `"anonymous"`. */
  readonly subject: string;
  /** Interface OAuth `interface_binding_id` (automation identities only). */
  readonly bindingId?: string | null;
  readonly displayName?: string | null;
  readonly email?: string | null;
}

export const ANONYMOUS_PRINCIPAL: Principal = {
  id: "anon",
  kind: "anonymous",
  subject: "anonymous",
};

/** Threads the credential channel, resolved principal, and scope ceiling. */
export interface AuthContext {
  readonly principal: Principal;
  readonly channel: AuthChannel;
  /** Capability ceiling from the credential; empty for anonymous. */
  readonly scopes: ReadonlySet<string>;
}

export type OwnerType = "user" | "org";

export interface OwnerDto {
  readonly login: string;
  readonly type: OwnerType;
}

export interface PrincipalDto {
  readonly id: string;
  readonly kind: PrincipalKind;
  readonly subject: string;
  readonly displayName: string | null;
  readonly email: string | null;
}

// ============================================================================
// Repository DTO
// ============================================================================

export interface RepositoryDto {
  readonly owner: string;
  readonly name: string;
  /** `owner/name`. */
  readonly fullName: string;
  readonly visibility: Visibility;
  readonly defaultBranch: string;
  readonly description: string | null;
  readonly isArchived: boolean;
  readonly isTemplate: boolean;
  /** Parent `owner/name` when this repo is a fork, else null. */
  readonly forkOf: string | null;
  readonly cloneUrl: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly pushedAt: number | null;
}

// ============================================================================
// Authorization decisions
// ============================================================================

export type RepoAction =
  | "contents.read"
  | "contents.write"
  | "issues.write"
  | "pulls.write"
  | "pulls.merge"
  | "releases.write"
  | "repo.admin";

export type AuthzReason =
  | "unauthenticated"
  | "not_found"
  | "forbidden"
  | "scope_insufficient"
  | "protected_ref"
  | "unconfigured";

export type AuthzDecision =
  | { readonly allow: true; readonly role: Role }
  | {
      readonly allow: false;
      readonly status: 401 | 403 | 404 | 503;
      readonly reason: AuthzReason;
    };

/** Minimum per-repo role each action requires (the identity floor). */
export const ACTION_REQUIRED_ROLE: Record<RepoAction, Role> = {
  "contents.read": "reader",
  "contents.write": "writer",
  "issues.write": "writer",
  "pulls.write": "reader",
  "pulls.merge": "writer",
  "releases.write": "writer",
  "repo.admin": "maintainer",
};

/** Interface-channel scope ceiling each action requires. */
export const ACTION_REQUIRED_SCOPE: Record<RepoAction, string> = {
  "contents.read": SCOPES.hostingRead,
  "contents.write": SCOPES.smartHttpWrite,
  "issues.write": SCOPES.hostingWrite,
  "pulls.write": SCOPES.hostingWrite,
  "pulls.merge": SCOPES.hostingWrite,
  "releases.write": SCOPES.hostingWrite,
  "repo.admin": SCOPES.hostingAdmin,
};

// ============================================================================
// Pagination + error envelope
// ============================================================================

export const DEFAULT_PAGE_LIMIT = 30;
export const MAX_PAGE_LIMIT = 100;

export interface PaginationParams {
  readonly limit: number;
  readonly cursor: string | null;
}

/** One pagination convention everywhere: `?limit=<1..100,default 30>&cursor=`. */
export function parsePagination(url: URL): PaginationParams {
  const requested = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Number.isSafeInteger(requested)
    ? Math.max(1, Math.min(requested, MAX_PAGE_LIMIT))
    : DEFAULT_PAGE_LIMIT;
  const cursor = url.searchParams.get("cursor");
  return { limit, cursor: cursor && cursor.length <= 4096 ? cursor : null };
}

/** Standard list envelope `{ <resourceKey>: [...], nextCursor }`. */
export function paginatedBody<T>(
  resourceKey: string,
  items: readonly T[],
  nextCursor: string | null,
): Record<string, unknown> {
  return { [resourceKey]: items, nextCursor };
}

export interface ApiError {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: Record<string, unknown>;
  };
}

/** Standard error envelope `{ error: { code, message, details? } }`. */
export function errorBody(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): ApiError {
  return {
    error: { code, message, ...(details ? { details } : {}) },
  };
}

// ============================================================================
// Route declaration (the append-only registration surface)
// ============================================================================

export type HttpMethod =
  | "GET"
  | "HEAD"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE";

/**
 * How a route authenticates. Exactly one mechanism per route — browser-session
 * and Interface-OAuth paths stay UNMIXED (a route never silently accepts both).
 */
export type AuthMechanism = "public" | "browser" | "interface";

/** The metadata half of a route — what the default-deny meta-test enumerates. */
export interface RouteDeclaration {
  readonly method: HttpMethod;
  /** Pattern with `:name` params, e.g. `/api/v1/repos/:owner/:repo`. */
  readonly path: string;
  readonly auth: AuthMechanism;
  /** Per-repo role floor for repo-scoped routes. Required for non-public routes. */
  readonly requiredRole?: Role;
  /** The repo action authorized (drives scope ceiling + branch protection). */
  readonly action?: RepoAction;
  /**
   * Interface-OAuth scope ceiling. Derived from `action` when omitted; declare it
   * explicitly for non-repo-scoped interface routes.
   */
  readonly scope?: string;
}

/** A registered route: declaration + its handler. `Ctx` supplied by the router. */
export interface RouteDefinition<Ctx = unknown> extends RouteDeclaration {
  readonly handler: (ctx: Ctx) => Promise<Response> | Response;
}
