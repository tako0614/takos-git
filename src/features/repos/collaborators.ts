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

function parseBindingId(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    /[\x00-\x1f\x7f]/u.test(value)
  ) {
    return null;
  }
  return value;
}

// --- repo collaborators ----------------------------------------------------

const listCollaborators: Route["handler"] = async (ctx) => {
  const access = await requireRepoAccess(ctx, "contents.read", SCOPES.hostingRead);
  if (access instanceof Response) return access;
  const rows = await ctx.db!.query<{
    principal_id: string;
    subject: string;
    binding_id: string;
    display_name: string | null;
    role: string;
  }>(
    `SELECT rc.principal_id, rc.role, p.subject, p.binding_id, p.display_name
       FROM repo_collaborators rc
       JOIN principals p ON p.id = rc.principal_id
      WHERE rc.repo_id = ?
      ORDER BY rc.created_at ASC`,
    [access.repo.id],
  );
  return json({
    collaborators: rows.map((row) => ({
      principalId: row.principal_id,
      principal: { id: row.principal_id, subject: row.subject, displayName: row.display_name },
      bindingId: row.binding_id || null,
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
  const bindingId = parseBindingId(body.bindingId);
  if (bindingId === null) {
    return errorResponse(400, "invalid_binding", "Invalid InterfaceBinding id.");
  }
  const subject = ctx.params.principal;
  const issuer = ctx.env.OIDC_ISSUER_URL ?? "";
  const principal = await ensurePrincipalBySubject(
    ctx.db!,
    issuer,
    subject,
    bindingId,
  );
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
  const principalId = ctx.url.searchParams.get("principalId");
  if (ctx.url.searchParams.getAll("principalId").length > 1 || (principalId !== null && (
    !principalId || principalId.length > 512 || /[\x00-\x20\x7f]/u.test(principalId)
  ))) {
    return errorResponse(400, "invalid_principal", "Invalid collaborator Principal id.");
  }
  await ctx.db!.run(
    `DELETE FROM repo_collaborators
      WHERE repo_id = ?
        AND principal_id IN (
          SELECT id FROM principals WHERE issuer = ? AND subject = ?${principalId === null ? "" : " AND id = ?"}
        )`,
    [access.repo.id, new URL(ctx.env.OIDC_ISSUER_URL ?? "").origin, subject,
      ...(principalId === null ? [] : [principalId])],
  );
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

function validMemberIdentifier(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !/[\s\x00-\x1f\x7f]/u.test(value);
}

async function deniedOrgMembershipWrite(ctx: RouteContext, access: OrgAdminAccess): Promise<Response> {
  if (await orgMembershipRole(ctx.db!, access.ownerId, access.auth.principal.id) !== "admin") {
    return errorResponse(403, "forbidden", "Org admin role required.");
  }
  return errorResponse(409, "last_admin", "An organization must retain an admin.");
}

const putOrgMember: Route["handler"] = async (ctx) => {
  const access = await requireOrgAdmin(ctx, SCOPES.hostingAdmin);
  if (access instanceof Response) return access;
  const body = await readJson(ctx.request);
  if (!body) return errorResponse(400, "invalid_body", "Invalid request body.");
  const role = body.role;
  if (role !== "admin" && role !== "member") {
    return errorResponse(400, "invalid_role", "Expected admin or member.");
  }
  const bindingId = parseBindingId(body.bindingId);
  if (bindingId === null || (bindingId !== undefined && !validMemberIdentifier(bindingId))) {
    return errorResponse(400, "invalid_binding", "Invalid InterfaceBinding id.");
  }
  if (!validMemberIdentifier(ctx.params.principal)) {
    return errorResponse(400, "invalid_principal", "Invalid Accounts subject.");
  }
  const principal = await ensurePrincipalBySubject(
    ctx.db!, ctx.env.OIDC_ISSUER_URL ?? "", ctx.params.principal, bindingId,
  );
  // Fence current caller authority and the last admin in this single write.
  // In particular, two concurrent demotions cannot both remove the final admins.
  const result = await ctx.db!.run(
    `INSERT INTO org_memberships (owner_id, principal_id, role, created_at)
     SELECT ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM org_memberships WHERE owner_id = ? AND principal_id = ? AND role = 'admin')
        AND (? = 'admin'
          OR NOT EXISTS (SELECT 1 FROM org_memberships WHERE owner_id = ? AND principal_id = ? AND role = 'admin')
          OR EXISTS (SELECT 1 FROM org_memberships WHERE owner_id = ? AND principal_id <> ? AND role = 'admin'))
     ON CONFLICT(owner_id, principal_id) DO UPDATE SET role = excluded.role`,
    [access.ownerId, principal.id, role, ctx.db!.now(),
      access.ownerId, access.auth.principal.id, role,
      access.ownerId, principal.id, access.ownerId, principal.id],
  );
  if (!result.success || typeof result.meta.changes !== "number") {
    return errorResponse(503, "membership_write_unconfirmed", "Membership write could not be confirmed.");
  }
  if (result.meta.changes === 0) return deniedOrgMembershipWrite(ctx, access);
  if (result.meta.changes !== 1) {
    return errorResponse(503, "membership_write_unconfirmed", "Membership write could not be confirmed.");
  }
  return json({ member: { principalId: principal.id, subject: principal.subject, bindingId: bindingId ?? null, role } });
};

const listOrgMembers: Route["handler"] = async (ctx) => {
  const identity = await resolveIdentity(ctx, SCOPES.hostingRead);
  if (identity instanceof Response) return identity;
  if (identity.channel === "anonymous") {
    return errorResponse(401, "unauthenticated", "Sign-in required.");
  }
  const org = await resolveOwner(ctx.db!, ctx.params.org);
  if (!org || org.type !== "org" || await orgMembershipRole(ctx.db!, org.id, identity.principal.id) === null) {
    return errorResponse(404, "not_found", "Org not found.");
  }
  const query = ctx.url.searchParams;
  const limit = query.has("limit") ? Number(query.get("limit")) : 100;
  const cursor = query.get("cursor");
  if (query.getAll("limit").length > 1 || query.getAll("cursor").length > 1 ||
      !Number.isInteger(limit) || limit < 1 || limit > 100 ||
      (cursor !== null && !validMemberIdentifier(cursor))) {
    return errorResponse(400, "invalid_pagination", "Invalid membership page.");
  }
  const rows = await ctx.db!.query<{
    principal_id: string; subject: string; binding_id: string;
    display_name: string | null; role: string;
  }>(
    `SELECT m.principal_id, m.role, p.subject, p.binding_id, p.display_name
       FROM org_memberships m JOIN principals p ON p.id = m.principal_id
      WHERE m.owner_id = ? AND p.id > ?
        AND EXISTS (SELECT 1 FROM org_memberships actor
                     WHERE actor.owner_id = m.owner_id AND actor.principal_id = ?)
      ORDER BY p.id ASC LIMIT ?`,
    [org.id, cursor ?? "", identity.principal.id, limit + 1],
  );
  const page = rows.slice(0, limit);
  return json({
    members: page.map(row => ({
      principalId: row.principal_id, subject: row.subject, bindingId: row.binding_id || null,
      principal: { id: row.principal_id, subject: row.subject, displayName: row.display_name }, role: row.role,
    })),
    nextCursor: rows.length > limit ? page.at(-1)!.principal_id : null,
  });
};

const deleteOrgMember: Route["handler"] = async (ctx) => {
  const access = await requireOrgAdmin(ctx, SCOPES.hostingAdmin);
  if (access instanceof Response) return access;
  const principalId = ctx.params.principalId;
  if (!validMemberIdentifier(principalId)) {
    return errorResponse(400, "invalid_principal", "Invalid Principal id.");
  }
  const result = await ctx.db!.run(
    `DELETE FROM org_memberships
      WHERE owner_id = ? AND principal_id = ?
        AND EXISTS (SELECT 1 FROM org_memberships actor
                     WHERE actor.owner_id = ? AND actor.principal_id = ? AND actor.role = 'admin')
        AND (role <> 'admin' OR EXISTS (SELECT 1 FROM org_memberships other
               WHERE other.owner_id = ? AND other.principal_id <> ? AND other.role = 'admin'))`,
    [access.ownerId, principalId, access.ownerId, access.auth.principal.id, access.ownerId, principalId],
  );
  if (!result.success || typeof result.meta.changes !== "number") {
    return errorResponse(503, "membership_write_unconfirmed", "Membership write could not be confirmed.");
  }
  if (result.meta.changes === 0) {
    const role = await orgMembershipRole(ctx.db!, access.ownerId, principalId);
    if (role !== null || await orgMembershipRole(ctx.db!, access.ownerId, access.auth.principal.id) !== "admin") {
      return deniedOrgMembershipWrite(ctx, access);
    }
    // Removing an already absent member is idempotent; guarded existing rows are
    // never reported as removed when the write made no change.
  } else if (result.meta.changes !== 1) {
    return errorResponse(503, "membership_write_unconfirmed", "Membership write could not be confirmed.");
  }
  return json({ removed: true });
};

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
  const bindingId = parseBindingId(body.bindingId);
  if (bindingId === null) {
    return errorResponse(400, "invalid_binding", "Invalid InterfaceBinding id.");
  }
  const principal = await ensurePrincipalBySubject(
    ctx.db!,
    ctx.env.OIDC_ISSUER_URL ?? "",
    ctx.params.principal,
    bindingId,
  );
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
  await ctx.db!.run(
    `DELETE FROM team_members
      WHERE team_id = ?
        AND principal_id IN (
          SELECT id FROM principals WHERE issuer = ? AND subject = ?
        )`,
    [
      team.id,
      new URL(ctx.env.OIDC_ISSUER_URL ?? "").origin,
      ctx.params.principal,
    ],
  );
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
  deleteOrgMember,
  listOrgMembers,
  putOrgMember,
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
