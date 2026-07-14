/**
 * Fork + upstream-sync route registration (the `forks` feature).
 *
 * Mirrors `src/features/repos/routes.ts`: every route is `auth: "public"` and
 * gates inside the handler through `requireRepoAccess` (the frozen ACL), so a
 * single path serves anonymous, browser-session, and Interface-OAuth callers.
 * Browser mutations pass `csrfGuard`.
 *
 * Action mapping (no new `RepoAction` invented):
 *  - POST   .../forks              → contents.read on the SOURCE (you fork what
 *                                    you can read); the target namespace is
 *                                    authorized separately as a repo create.
 *  - GET    .../forks              → contents.read (list a repo's fork children)
 *  - GET    .../network            → contents.read (the whole fork network)
 *  - POST   .../sync               → contents.write on the FORK (advances a ref;
 *                                    fast-forward only)
 */

import {
  SCOPES,
  type AuthContext,
  type RepositoryDto,
} from "../../contract/v1.ts";
import type { DbClient } from "../../db/index.ts";
import type { Route, RouteContext, RouteRegistry } from "../../router.ts";
import { errorResponse, json } from "../repos/http.ts";
import {
  csrfGuard,
  requireRepoAccess,
} from "../repos/identity.ts";
import {
  ensureUserOwner,
  isValidOwnerLogin,
  isValidRepoNameSegment,
  OwnerConflictError,
  orgMembershipRole,
  resolveOwner,
  type OwnerRow,
} from "../repos/index.ts";
import { effectiveRole } from "../../auth/acl.ts";
import type { Principal } from "../../contract/v1.ts";
import {
  forkNetworkMembers,
  forkNetworkRoot,
  forkRepository,
  getRepoById,
  getRepoByOwnerName,
  listForkChildren,
  syncFork,
  toRepositoryDtoFull,
  type RepoFullRow,
} from "./service.ts";

const RR = "/api/v1/repos/:owner/:repo";
const MAX_BODY_BYTES = 16 * 1024;

function originBase(ctx: RouteContext): string {
  return ctx.env.APP_URL?.trim() || ctx.url.origin;
}

async function readJson(
  request: Request,
): Promise<Record<string, unknown> | null> {
  const length = request.headers.get("content-length");
  if (length && Number(length) > MAX_BODY_BYTES) return null;
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > MAX_BODY_BYTES) return null;
  if (bytes.length === 0) return {};
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function isValidBranchSegment(name: string): boolean {
  return (
    /^[a-zA-Z0-9._/-]+$/u.test(name) &&
    !name.includes("..") &&
    !name.startsWith("/") &&
    !name.endsWith("/") &&
    name.length <= 255
  );
}

type OwnerOutcome =
  | { readonly owner: OwnerRow }
  | { readonly error: { status: number; code: string; message: string } };

/**
 * Authorize the fork TARGET namespace, identical policy to repo-create: an
 * existing user owner must BE the caller; an existing org requires org-admin; an
 * unclaimed login is claimed as the caller's personal owner. When no owner is
 * supplied, default to the caller's existing personal owner if one exists.
 */
async function authorizeTargetOwner(
  db: DbClient,
  auth: AuthContext,
  ownerLogin: string | null,
): Promise<OwnerOutcome> {
  if (!ownerLogin) {
    const own = await db.queryOne<{ login: string }>(
      `SELECT login FROM owners WHERE principal_id = ? AND type = 'user' ORDER BY created_at LIMIT 1`,
      [auth.principal.id],
    );
    if (!own) {
      return {
        error: {
          status: 400,
          code: "owner_required",
          message: "Specify a target owner for the fork.",
        },
      };
    }
    ownerLogin = own.login;
  }
  if (!isValidOwnerLogin(ownerLogin)) {
    return {
      error: { status: 400, code: "invalid_owner", message: "Invalid owner login." },
    };
  }
  const owner = await resolveOwner(db, ownerLogin);
  if (owner) {
    if (owner.type === "user") {
      if (owner.principalId && owner.principalId === auth.principal.id) {
        return { owner };
      }
      return {
        error: { status: 403, code: "forbidden", message: "Not your namespace." },
      };
    }
    const role = await orgMembershipRole(db, owner.id, auth.principal.id);
    if (role === "admin") return { owner };
    return {
      error: { status: 403, code: "forbidden", message: "Org admin role required." },
    };
  }
  try {
    return { owner: await ensureUserOwner(db, auth.principal, ownerLogin) };
  } catch (error) {
    if (error instanceof OwnerConflictError) {
      return {
        error: { status: 409, code: "owner_conflict", message: "Owner login in use." },
      };
    }
    throw error;
  }
}

/** Map a fork-network member to a DTO (its parent is resolved for `forkOf`). */
async function memberDto(
  db: DbClient,
  member: RepoFullRow,
  base: string,
): Promise<RepositoryDto> {
  let parentFullName: string | null = null;
  if (member.forkOfId) {
    const parent = await getRepoById(db, member.forkOfId);
    parentFullName = parent ? `${parent.ownerLogin}/${parent.name}` : null;
  }
  return toRepositoryDtoFull(member, parentFullName, base);
}

async function readable(
  db: DbClient,
  principal: Principal,
  row: RepoFullRow,
): Promise<boolean> {
  const role = await effectiveRole(db, principal, {
    id: row.id,
    ownerId: row.ownerId,
    ownerLogin: row.ownerLogin,
    ownerType: row.ownerType,
    ownerPrincipalId: row.ownerPrincipalId,
    name: row.name,
    visibility: row.visibility,
    defaultBranch: row.defaultBranch,
  });
  return role !== null;
}

// ============================================================================
// Handlers
// ============================================================================

/** `POST /api/v1/repos/:owner/:repo/forks` — fork into the caller's namespace. */
const createForkHandler: Route["handler"] = async (ctx) => {
  // The fork authorizes as a READ of the source (you fork what you can read).
  // The write — creating a new repo — is authorized against the TARGET namespace
  // by `authorizeTargetOwner`, exactly like repo-create, not by a source scope.
  const access = await requireRepoAccess(ctx, "contents.read", SCOPES.hostingRead);
  if (access instanceof Response) return access;
  const csrf = csrfGuard(ctx, access.auth);
  if (csrf) return csrf;
  if (access.auth.channel === "anonymous") {
    return errorResponse(401, "unauthenticated", "Sign-in required.");
  }

  const body = await readJson(ctx.request);
  if (!body) return errorResponse(400, "invalid_body", "Invalid request body.");

  const source = await getRepoByOwnerName(
    ctx.db!,
    access.repo.ownerLogin,
    access.repo.name,
  );
  if (!source) return errorResponse(404, "not_found", "Not Found");

  const forkName = str(body.name) ?? source.name;
  if (!isValidRepoNameSegment(forkName)) {
    return errorResponse(400, "invalid_name", "Invalid repository name.");
  }
  const targetLogin = str(body.owner);
  const ownerOutcome = await authorizeTargetOwner(ctx.db!, access.auth, targetLogin);
  if ("error" in ownerOutcome) {
    const { status, code, message } = ownerOutcome.error;
    return errorResponse(status, code, message);
  }

  const outcome = await forkRepository(
    ctx.env.BUCKET,
    ctx.db!,
    source,
    ownerOutcome.owner,
    forkName,
  );
  if (!outcome.ok) {
    switch (outcome.code) {
      case "self_fork":
        return errorResponse(400, "self_fork", "Cannot fork a repository onto itself.");
      case "name_conflict":
        return errorResponse(409, "repo_exists", "A repository with this name already exists.");
      default:
        return errorResponse(500, "fork_failed", "Failed to fork repository.");
    }
  }

  const base = originBase(ctx);
  return json(
    {
      repository: toRepositoryDtoFull(
        outcome.fork,
        `${source.ownerLogin}/${source.name}`,
        base,
      ),
      forkedFrom: {
        owner: source.ownerLogin,
        name: source.name,
        fullName: `${source.ownerLogin}/${source.name}`,
      },
      objectsCopied: outcome.objectsCopied,
    },
    201,
  );
};

/** `GET /api/v1/repos/:owner/:repo/forks` — this repo's direct fork children. */
const listForksHandler: Route["handler"] = async (ctx) => {
  const access = await requireRepoAccess(ctx, "contents.read", SCOPES.hostingRead);
  if (access instanceof Response) return access;

  const children = await listForkChildren(ctx.db!, access.repo.id, 100);
  const base = originBase(ctx);
  const parentFullName = `${access.repo.ownerLogin}/${access.repo.name}`;
  const forks: RepositoryDto[] = [];
  for (const child of children) {
    if (!(await readable(ctx.db!, access.auth.principal, child))) continue;
    forks.push(toRepositoryDtoFull(child, parentFullName, base));
  }
  return json({ forks });
};

/** `GET /api/v1/repos/:owner/:repo/network` — the whole fork network. */
const networkHandler: Route["handler"] = async (ctx) => {
  const access = await requireRepoAccess(ctx, "contents.read", SCOPES.hostingRead);
  if (access instanceof Response) return access;

  const self = await getRepoByOwnerName(
    ctx.db!,
    access.repo.ownerLogin,
    access.repo.name,
  );
  if (!self) return errorResponse(404, "not_found", "Not Found");

  const root = await forkNetworkRoot(ctx.db!, self);
  const members = await forkNetworkMembers(ctx.db!, root);
  const base = originBase(ctx);

  const nodes: RepositoryDto[] = [];
  for (const member of members) {
    if (!(await readable(ctx.db!, access.auth.principal, member))) continue;
    nodes.push(await memberDto(ctx.db!, member, base));
  }
  const rootReadable = await readable(ctx.db!, access.auth.principal, root);
  return json({
    root: rootReadable ? await memberDto(ctx.db!, root, base) : null,
    repositories: nodes,
  });
};

/** `POST /api/v1/repos/:owner/:repo/sync` — fast-forward the fork from upstream. */
const syncHandler: Route["handler"] = async (ctx) => {
  // First pass (no ref) resolves the fork row + role; second pass enforces
  // branch protection on the concrete branch.
  const first = await requireRepoAccess(ctx, "contents.write", SCOPES.smartHttpWrite);
  if (first instanceof Response) return first;
  const csrf = csrfGuard(ctx, first.auth);
  if (csrf) return csrf;

  const body = await readJson(ctx.request);
  if (!body) return errorResponse(400, "invalid_body", "Invalid request body.");
  const requested = str(body.branch) ?? str(body.ref);
  const branch = requested ?? first.repo.defaultBranch;
  if (!isValidBranchSegment(branch)) {
    return errorResponse(400, "invalid_branch", "Invalid branch name.");
  }

  const access = await requireRepoAccess(
    ctx,
    "contents.write",
    SCOPES.smartHttpWrite,
    { ref: `refs/heads/${branch}` },
  );
  if (access instanceof Response) return access;

  const fork = await getRepoByOwnerName(
    ctx.db!,
    access.repo.ownerLogin,
    access.repo.name,
  );
  if (!fork) return errorResponse(404, "not_found", "Not Found");

  const outcome = await syncFork(ctx.env.BUCKET, ctx.db!, fork, branch);
  if (!outcome.ok) {
    switch (outcome.code) {
      case "not_a_fork":
        return errorResponse(400, "not_a_fork", "This repository is not a fork.");
      case "upstream_gone":
        return errorResponse(409, "upstream_gone", "The upstream repository is no longer available.");
      case "upstream_branch_missing":
        return errorResponse(404, "upstream_branch_missing", "Upstream branch not found.");
      case "diverged":
        return errorResponse(409, "diverged", "Fork has diverged; fast-forward is not possible.");
      case "conflict":
        return errorResponse(409, "conflict", "Concurrent update; retry the sync.");
      default:
        return errorResponse(500, "sync_failed", "Failed to sync with upstream.");
    }
  }

  return json({
    synced: true,
    branch: outcome.branch,
    previousHead: outcome.previousHead,
    newHead: outcome.newHead,
    commitsSynced: outcome.commitsSynced,
    alreadyUpToDate: outcome.alreadyUpToDate,
  });
};

export const forkHandlers = {
  create: createForkHandler,
  list: listForksHandler,
  network: networkHandler,
  sync: syncHandler,
} as const;

const forkRoutes: readonly Route[] = [
  { method: "POST", path: `${RR}/forks`, auth: "public", handler: forkHandlers.create },
  { method: "GET", path: `${RR}/forks`, auth: "public", handler: forkHandlers.list },
  { method: "GET", path: `${RR}/network`, auth: "public", handler: forkHandlers.network },
  { method: "POST", path: `${RR}/sync`, auth: "public", handler: forkHandlers.sync },
];

const registered = new WeakSet<object>();

/** Register every forks-feature route into `registry`. Idempotent per registry. */
export function registerForkRoutes(registry: RouteRegistry): void {
  if (registered.has(registry)) return;
  registered.add(registry);
  registry.registerAll(forkRoutes);
}

export { forkRoutes };
