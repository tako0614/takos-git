/**
 * Repository & org administration write handlers: create / patch / delete repo,
 * and org creation. Web (browser session) and automation (Interface OAuth) share
 * every handler through the best-effort identity resolver; anonymous is rejected.
 */

import {
  SCOPES,
  roleAtLeast,
  type AuthContext,
  type Visibility,
} from "../../contract/v1.ts";
import type { RouteContext, Route } from "../../router.ts";
import type { DbClient } from "../../db/index.ts";
import { json, errorResponse } from "./http.ts";
import { csrfGuard, requireRepoAccess, resolveIdentity } from "./identity.ts";
import {
  createOrgOwner,
  ensureUserOwner,
  isValidOwnerLogin,
  orgMembershipRole,
  OwnerConflictError,
  resolveOwner,
  type OwnerRow,
} from "./owners.ts";
import {
  deleteRepository,
  getRepoRow,
  isValidRepoNameSegment,
  isValidVisibility,
  provisionRepo,
  toRepositoryDto,
  updateRepo,
} from "./repositories.ts";

const MAX_BODY_BYTES = 64 * 1024;

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
    const value = JSON.parse(new TextDecoder().decode(bytes));
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

function isValidBranchName(name: string): boolean {
  return (
    /^[a-zA-Z0-9._/-]+$/u.test(name) &&
    !name.includes("..") &&
    !name.startsWith("/") &&
    !name.endsWith("/") &&
    name.length <= 255
  );
}

type OwnerCreateOutcome =
  | { readonly owner: OwnerRow }
  | { readonly error: { status: number; code: string; message: string } };

/**
 * Authorize creating a repo under `ownerLogin`. An existing user owner requires
 * the caller BE that principal; an existing org requires org-admin; an unclaimed
 * login is claimed as the caller's personal owner (first-use, bounded by the
 * install Workspace membership gate).
 */
async function authorizeOwnerForCreate(
  db: DbClient,
  auth: AuthContext,
  ownerLogin: string,
): Promise<OwnerCreateOutcome> {
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
      error: {
        status: 403,
        code: "forbidden",
        message: "Org admin role required.",
      },
    };
  }
  try {
    const created = await ensureUserOwner(db, auth.principal, ownerLogin);
    return { owner: created };
  } catch (error) {
    if (error instanceof OwnerConflictError) {
      return {
        error: { status: 409, code: "owner_conflict", message: "Owner login in use." },
      };
    }
    throw error;
  }
}

/** `POST /api/v1/repos` — create a repository (D1 row + R2 refs-doc). */
const createRepoHandler: Route["handler"] = async (ctx) => {
  const identity = await resolveIdentity(ctx, SCOPES.hostingWrite);
  if (identity instanceof Response) return identity;
  if (identity.channel === "anonymous") {
    return errorResponse(401, "unauthenticated", "Sign-in required.");
  }
  const csrf = csrfGuard(ctx, identity);
  if (csrf) return csrf;

  const body = await readJson(ctx.request);
  if (!body) return errorResponse(400, "invalid_body", "Invalid request body.");
  const ownerLogin = str(body.owner);
  const name = str(body.name);
  if (!ownerLogin || !isValidOwnerLogin(ownerLogin)) {
    return errorResponse(400, "invalid_owner", "Invalid owner login.");
  }
  if (!name || !isValidRepoNameSegment(name)) {
    return errorResponse(400, "invalid_name", "Invalid repository name.");
  }
  const visibilityRaw = body.visibility;
  const visibility: Visibility = isValidVisibility(visibilityRaw)
    ? visibilityRaw
    : "private";
  if (visibilityRaw !== undefined && !isValidVisibility(visibilityRaw)) {
    return errorResponse(400, "invalid_visibility", "Invalid visibility.");
  }
  const defaultBranch = str(body.defaultBranch) ?? "main";
  if (!isValidBranchName(defaultBranch)) {
    return errorResponse(400, "invalid_default_branch", "Invalid default branch.");
  }
  const description = typeof body.description === "string" ? body.description : null;

  const ownerOutcome = await authorizeOwnerForCreate(ctx.db!, identity, ownerLogin);
  if ("error" in ownerOutcome) {
    const { status, code, message } = ownerOutcome.error;
    return errorResponse(status, code, message);
  }
  const result = await provisionRepo(ctx.env.BUCKET, ctx.db!, ownerOutcome.owner, {
    name,
    visibility,
    defaultBranch,
    description,
  });
  if (!result.ok) {
    return errorResponse(409, result.code, "Repository already exists.");
  }
  return json({ repository: toRepositoryDto(result.repo, originBase(ctx)) }, 201);
};

/** `PATCH /api/v1/repos/:owner/:repo` — settings (maintainer+). */
const patchRepoHandler: Route["handler"] = async (ctx) => {
  const access = await requireRepoAccess(ctx, "repo.admin", SCOPES.hostingAdmin);
  if (access instanceof Response) return access;
  const csrf = csrfGuard(ctx, access.auth);
  if (csrf) return csrf;

  const body = await readJson(ctx.request);
  if (!body) return errorResponse(400, "invalid_body", "Invalid request body.");
  const input: {
    description?: string | null;
    visibility?: Visibility;
    defaultBranch?: string;
    isArchived?: boolean;
  } = {};
  if ("description" in body) {
    input.description =
      typeof body.description === "string" ? body.description : null;
  }
  if (body.visibility !== undefined) {
    if (!isValidVisibility(body.visibility)) {
      return errorResponse(400, "invalid_visibility", "Invalid visibility.");
    }
    input.visibility = body.visibility;
  }
  if (body.defaultBranch !== undefined) {
    const branch = str(body.defaultBranch);
    if (!branch || !isValidBranchName(branch)) {
      return errorResponse(400, "invalid_default_branch", "Invalid default branch.");
    }
    input.defaultBranch = branch;
  }
  if (body.archived !== undefined) {
    if (typeof body.archived !== "boolean") {
      return errorResponse(400, "invalid_archived", "archived must be boolean.");
    }
    input.isArchived = body.archived;
  }
  const updated = await updateRepo(ctx.db!, access.repo.id, input);
  if (!updated) return errorResponse(404, "not_found", "Not Found");
  return json({ repository: toRepositoryDto(updated, originBase(ctx)) });
};

/** `DELETE /api/v1/repos/:owner/:repo` — remove D1 row + R2 objects (owner). */
const deleteRepoHandler: Route["handler"] = async (ctx) => {
  const access = await requireRepoAccess(ctx, "repo.admin", SCOPES.hostingAdmin);
  if (access instanceof Response) return access;
  const csrf = csrfGuard(ctx, access.auth);
  if (csrf) return csrf;
  if (!roleAtLeast(access.role, "owner")) {
    return errorResponse(403, "forbidden", "Owner role required to delete.");
  }
  const row = await getRepoRow(ctx.db!, access.repo.ownerLogin, access.repo.name);
  if (!row) return errorResponse(404, "not_found", "Not Found");
  await deleteRepository(ctx.env.BUCKET, ctx.db!, row);
  return json({ deleted: true });
};

/** `POST /api/v1/orgs` — create an org owner; the caller becomes its admin. */
const createOrgHandler: Route["handler"] = async (ctx) => {
  const identity = await resolveIdentity(ctx, SCOPES.hostingAdmin);
  if (identity instanceof Response) return identity;
  if (identity.channel === "anonymous") {
    return errorResponse(401, "unauthenticated", "Sign-in required.");
  }
  const csrf = csrfGuard(ctx, identity);
  if (csrf) return csrf;

  const body = await readJson(ctx.request);
  if (!body) return errorResponse(400, "invalid_body", "Invalid request body.");
  const login = str(body.login);
  if (!login || !isValidOwnerLogin(login)) {
    return errorResponse(400, "invalid_owner", "Invalid org login.");
  }
  try {
    const org = await createOrgOwner(
      ctx.db!,
      identity.principal,
      login,
      typeof body.name === "string" ? body.name : null,
    );
    return json({ org: { login: org.login, type: org.type } }, 201);
  } catch (error) {
    if (error instanceof OwnerConflictError) {
      return errorResponse(409, "owner_conflict", "Org login already in use.");
    }
    throw error;
  }
};

export const repoAdminHandlers = {
  create: createRepoHandler,
  patch: patchRepoHandler,
  remove: deleteRepoHandler,
  createOrg: createOrgHandler,
} as const;
