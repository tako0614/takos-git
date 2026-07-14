/**
 * Collaborators & teams administration.
 *
 * - Repo collaborators: direct per-repo role grants (owner|maintainer|writer|
 *   reader), managed by a repo owner.
 * - Org teams: created under an `org` owner by an org admin; members are app-local
 *   (never an Accounts group); a team can be granted a role on any repo the org
 *   owns.
 *
 * Effective access is computed by the frozen `effectiveRole` (max of owner / org /
 * collaborator / team / visibility floor); this module only writes the grants.
 */

import { SCOPES, roleAtLeast, type AuthContext, type Role } from "../../contract/v1.ts";
import type { DbClient } from "../../db/index.ts";
import type { Route, RouteContext } from "../../router.ts";
import { json, errorResponse } from "./http.ts";
import { csrfGuard, requireRepoAccess, resolveIdentity } from "./identity.ts";
import {
  ensurePrincipalBySubject,
  orgMembershipRole,
  resolveOwner,
} from "./owners.ts";

const MAX_BODY_BYTES = 16 * 1024;

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
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

function parseRepoRole(value: unknown): Role | null {
  if (value === "admin" || value === "owner") return "owner";
  if (value === "maintainer" || value === "writer" || value === "reader") {
    return value;
  }
  return null;
}

function parseTeamMemberRole(value: unknown): "maintainer" | "member" {
  return value === "maintainer" ? "maintainer" : "member";
}

// --- repo collaborators ----------------------------------------------------

const listCollaborators: Route["handler"] = async (ctx) => {
  const access = await requireRepoAccess(ctx, "contents.read", SCOPES.hostingRead);
  if (access instanceof Response) return access;
  const rows = await ctx.db!.query<{
    principal_id: string;
    subject: string;
    display_name: string | null;
    role: string;
  }>(
    `SELECT rc.principal_id, rc.role, p.subject, p.display_name
       FROM repo_collaborators rc
       JOIN principals p ON p.id = rc.principal_id
      WHERE rc.repo_id = ?
      ORDER BY rc.created_at ASC`,
    [access.repo.id],
  );
  return json({
    collaborators: rows.map((row) => ({
      principalId: row.principal_id,
      subject: row.subject,
      displayName: row.display_name,
      role: row.role,
    })),
  });
};

const putCollaborator: Route["handler"] = async (ctx) => {
  const access = await requireRepoAccess(ctx, "repo.admin", SCOPES.hostingAdmin);
  if (access instanceof Response) return access;
  const csrf = csrfGuard(ctx, access.auth);
  if (csrf) return csrf;
  if (!roleAtLeast(access.role, "owner")) {
    return errorResponse(403, "forbidden", "Owner role required.");
  }
  const body = await readJson(ctx.request);
  if (!body) return errorResponse(400, "invalid_body", "Invalid request body.");
  const role = parseRepoRole(body.role);
  if (!role) return errorResponse(400, "invalid_role", "Invalid role.");
  const subject = ctx.params.principal;
  const principal = await ensurePrincipalBySubject(ctx.db!, subject);
  const now = ctx.db!.now();
  await ctx.db!.run(
    `INSERT INTO repo_collaborators (repo_id, principal_id, role, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(repo_id, principal_id) DO UPDATE SET role = excluded.role`,
    [access.repo.id, principal.id, role, now],
  );
  return json({ principal: subject, principalId: principal.id, role });
};

const deleteCollaborator: Route["handler"] = async (ctx) => {
  const access = await requireRepoAccess(ctx, "repo.admin", SCOPES.hostingAdmin);
  if (access instanceof Response) return access;
  const csrf = csrfGuard(ctx, access.auth);
  if (csrf) return csrf;
  if (!roleAtLeast(access.role, "owner")) {
    return errorResponse(403, "forbidden", "Owner role required.");
  }
  const subject = ctx.params.principal;
  const principal = await ctx.db!.queryOne<{ id: string }>(
    `SELECT id FROM principals WHERE subject = ? LIMIT 1`,
    [subject],
  );
  if (principal) {
    await ctx.db!.run(
      `DELETE FROM repo_collaborators WHERE repo_id = ? AND principal_id = ?`,
      [access.repo.id, principal.id],
    );
  }
  return json({ removed: true });
};

// --- org teams -------------------------------------------------------------

interface OrgAdminAccess {
  readonly ownerId: string;
  readonly auth: AuthContext;
}

async function requireOrgAdmin(
  ctx: RouteContext,
  scope: string,
): Promise<OrgAdminAccess | Response> {
  const identity = await resolveIdentity(ctx, scope);
  if (identity instanceof Response) return identity;
  if (identity.channel === "anonymous") {
    return errorResponse(401, "unauthenticated", "Sign-in required.");
  }
  const csrf = csrfGuard(ctx, identity);
  if (csrf) return csrf;
  const org = await resolveOwner(ctx.db!, ctx.params.org);
  if (!org || org.type !== "org") {
    return errorResponse(404, "not_found", "Org not found.");
  }
  const role = await orgMembershipRole(ctx.db!, org.id, identity.principal.id);
  if (role !== "admin") {
    return errorResponse(403, "forbidden", "Org admin role required.");
  }
  return { ownerId: org.id, auth: identity };
}

const listTeams: Route["handler"] = async (ctx) => {
  const identity = await resolveIdentity(ctx, SCOPES.hostingRead);
  if (identity instanceof Response) return identity;
  const org = await resolveOwner(ctx.db!, ctx.params.org);
  if (!org || org.type !== "org") {
    return errorResponse(404, "not_found", "Org not found.");
  }
  const role = await orgMembershipRole(ctx.db!, org.id, identity.principal.id);
  if (role === null) {
    return errorResponse(404, "not_found", "Org not found.");
  }
  const teams = await ctx.db!.query<{
    id: string;
    slug: string;
    name: string;
    description: string | null;
  }>(
    `SELECT id, slug, name, description FROM teams WHERE owner_id = ? ORDER BY slug ASC`,
    [org.id],
  );
  return json({ teams });
};

const createTeam: Route["handler"] = async (ctx) => {
  const admin = await requireOrgAdmin(ctx, SCOPES.hostingAdmin);
  if (admin instanceof Response) return admin;
  const body = await readJson(ctx.request);
  if (!body) return errorResponse(400, "invalid_body", "Invalid request body.");
  const slug = typeof body.slug === "string" ? body.slug.trim() : "";
  if (!/^[a-zA-Z0-9._-]+$/u.test(slug)) {
    return errorResponse(400, "invalid_slug", "Invalid team slug.");
  }
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : slug;
  const now = ctx.db!.now();
  const id = ctx.db!.id();
  try {
    await ctx.db!.run(
      `INSERT INTO teams (id, owner_id, slug, name, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        admin.ownerId,
        slug,
        name,
        typeof body.description === "string" ? body.description : null,
        now,
        now,
      ],
    );
  } catch {
    return errorResponse(409, "team_exists", "Team slug already in use.");
  }
  return json({ team: { id, slug, name } }, 201);
};

async function resolveTeam(
  db: DbClient,
  ownerId: string,
  slug: string,
): Promise<{ id: string } | null> {
  return db.queryOne<{ id: string }>(
    `SELECT id FROM teams WHERE owner_id = ? AND slug = ? COLLATE NOCASE LIMIT 1`,
    [ownerId, slug],
  );
}

const putTeamMember: Route["handler"] = async (ctx) => {
  const admin = await requireOrgAdmin(ctx, SCOPES.hostingAdmin);
  if (admin instanceof Response) return admin;
  const team = await resolveTeam(ctx.db!, admin.ownerId, ctx.params.team);
  if (!team) return errorResponse(404, "not_found", "Team not found.");
  const body = await readJson(ctx.request);
  if (!body) return errorResponse(400, "invalid_body", "Invalid request body.");
  const role = parseTeamMemberRole(body.role);
  const principal = await ensurePrincipalBySubject(ctx.db!, ctx.params.principal);
  const now = ctx.db!.now();
  await ctx.db!.run(
    `INSERT INTO team_members (team_id, principal_id, role, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(team_id, principal_id) DO UPDATE SET role = excluded.role`,
    [team.id, principal.id, role, now],
  );
  return json({ team: ctx.params.team, principal: ctx.params.principal, role });
};

const deleteTeamMember: Route["handler"] = async (ctx) => {
  const admin = await requireOrgAdmin(ctx, SCOPES.hostingAdmin);
  if (admin instanceof Response) return admin;
  const team = await resolveTeam(ctx.db!, admin.ownerId, ctx.params.team);
  if (!team) return errorResponse(404, "not_found", "Team not found.");
  const principal = await ctx.db!.queryOne<{ id: string }>(
    `SELECT id FROM principals WHERE subject = ? LIMIT 1`,
    [ctx.params.principal],
  );
  if (principal) {
    await ctx.db!.run(
      `DELETE FROM team_members WHERE team_id = ? AND principal_id = ?`,
      [team.id, principal.id],
    );
  }
  return json({ removed: true });
};

// --- team access on a repo -------------------------------------------------

const putTeamRepoAccess: Route["handler"] = async (ctx) => {
  const access = await requireRepoAccess(ctx, "repo.admin", SCOPES.hostingAdmin);
  if (access instanceof Response) return access;
  const csrf = csrfGuard(ctx, access.auth);
  if (csrf) return csrf;
  if (!roleAtLeast(access.role, "owner")) {
    return errorResponse(403, "forbidden", "Owner role required.");
  }
  if (access.repo.ownerType !== "org") {
    return errorResponse(400, "not_an_org", "Teams exist only under org owners.");
  }
  const body = await readJson(ctx.request);
  if (!body) return errorResponse(400, "invalid_body", "Invalid request body.");
  const role = parseRepoRole(body.role);
  if (!role) return errorResponse(400, "invalid_role", "Invalid role.");
  const team = await resolveTeam(ctx.db!, access.repo.ownerId, ctx.params.team);
  if (!team) return errorResponse(404, "not_found", "Team not found.");
  const now = ctx.db!.now();
  await ctx.db!.run(
    `INSERT INTO team_repo_access (team_id, repo_id, role, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(team_id, repo_id) DO UPDATE SET role = excluded.role`,
    [team.id, access.repo.id, role, now],
  );
  return json({ team: ctx.params.team, role });
};

const deleteTeamRepoAccess: Route["handler"] = async (ctx) => {
  const access = await requireRepoAccess(ctx, "repo.admin", SCOPES.hostingAdmin);
  if (access instanceof Response) return access;
  const csrf = csrfGuard(ctx, access.auth);
  if (csrf) return csrf;
  if (!roleAtLeast(access.role, "owner")) {
    return errorResponse(403, "forbidden", "Owner role required.");
  }
  if (access.repo.ownerType !== "org") {
    return errorResponse(400, "not_an_org", "Teams exist only under org owners.");
  }
  const team = await resolveTeam(ctx.db!, access.repo.ownerId, ctx.params.team);
  if (team) {
    await ctx.db!.run(
      `DELETE FROM team_repo_access WHERE team_id = ? AND repo_id = ?`,
      [team.id, access.repo.id],
    );
  }
  return json({ removed: true });
};

export const collaboratorHandlers = {
  listCollaborators,
  putCollaborator,
  deleteCollaborator,
  listTeams,
  createTeam,
  putTeamMember,
  deleteTeamMember,
  putTeamRepoAccess,
  deleteTeamRepoAccess,
} as const;
