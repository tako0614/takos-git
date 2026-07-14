/**
 * Owner-namespace provisioning — the app-local `owners` table that re-roots
 * ownership off Takos accounts (decision record §5).
 *
 * An Owner is the first `<owner>/<name>` path segment. A `user` owner is backed
 * by exactly one Principal and is JIT-provisioned on first need (browser login or
 * first repo create under that login). An `org` owner is created explicitly by an
 * authenticated principal, who becomes its admin; org membership is app-local and
 * never derived from an Accounts group (no second IdP).
 *
 * Identity is the Principal (`(issuer, subject)`), never the mutable login slug —
 * a login is renameable without re-binding grants.
 */

import type { DbClient } from "../../db/index.ts";
import type { OwnerType, Principal } from "../../contract/v1.ts";

export interface OwnerRow {
  readonly id: string;
  readonly login: string;
  readonly type: OwnerType;
  readonly principalId: string | null;
  readonly displayName: string | null;
  readonly description: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface RawOwnerRow {
  id: string;
  login: string;
  type: string;
  principal_id: string | null;
  display_name: string | null;
  description: string | null;
  created_at: number;
  updated_at: number;
}

/** Thrown when a login is already taken by another principal or an org. */
export class OwnerConflictError extends Error {
  constructor(login: string) {
    super(`owner login already in use: ${login}`);
    this.name = "OwnerConflictError";
  }
}

/** A login is one path segment (mirrors the R2 repo-name segment grammar). */
export function isValidOwnerLogin(login: string): boolean {
  return /^[a-zA-Z0-9._-]+$/u.test(login) && !login.includes("..");
}

function toOwnerRow(row: RawOwnerRow): OwnerRow {
  return {
    id: row.id,
    login: row.login,
    type: row.type === "org" ? "org" : "user",
    principalId: row.principal_id,
    displayName: row.display_name,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const OWNER_COLUMNS = `id, login, type, principal_id, display_name, description, created_at, updated_at`;

/** Load an owner by login (case-insensitive), or null. */
export async function resolveOwner(
  db: DbClient,
  login: string,
): Promise<OwnerRow | null> {
  const row = await db.queryOne<RawOwnerRow>(
    `SELECT ${OWNER_COLUMNS} FROM owners WHERE login = ? COLLATE NOCASE LIMIT 1`,
    [login],
  );
  return row ? toOwnerRow(row) : null;
}

/**
 * Ensure a `user` owner backed by `principal` exists for `login`. Idempotent:
 * returns the existing row when it already belongs to this principal, claims the
 * login when it is free, and throws {@link OwnerConflictError} when it belongs to
 * someone else or an org.
 */
export async function ensureUserOwner(
  db: DbClient,
  principal: Principal,
  login: string,
): Promise<OwnerRow> {
  if (!isValidOwnerLogin(login)) throw new OwnerConflictError(login);
  const existing = await resolveOwner(db, login);
  if (existing) {
    if (existing.type === "user" && existing.principalId === principal.id) {
      return existing;
    }
    throw new OwnerConflictError(login);
  }
  const now = db.now();
  try {
    await db.run(
      `INSERT INTO owners (id, login, type, principal_id, display_name, created_at, updated_at)
       VALUES (?, ?, 'user', ?, ?, ?, ?)`,
      [db.id(), login, principal.id, principal.displayName ?? null, now, now],
    );
  } catch {
    // Lost a race on the unique(login) index — re-read the winner.
    const raced = await resolveOwner(db, login);
    if (raced && raced.type === "user" && raced.principalId === principal.id) {
      return raced;
    }
    throw new OwnerConflictError(login);
  }
  const created = await resolveOwner(db, login);
  if (!created) throw new OwnerConflictError(login);
  return created;
}

/**
 * Create an `org` owner and make `principal` its admin. Fails closed if the login
 * is taken.
 */
export async function createOrgOwner(
  db: DbClient,
  principal: Principal,
  login: string,
  displayName?: string | null,
): Promise<OwnerRow> {
  if (!isValidOwnerLogin(login)) throw new OwnerConflictError(login);
  if (await resolveOwner(db, login)) throw new OwnerConflictError(login);
  const now = db.now();
  const id = db.id();
  try {
    await db.batch([
      {
        sql: `INSERT INTO owners (id, login, type, principal_id, display_name, created_at, updated_at)
              VALUES (?, ?, 'org', NULL, ?, ?, ?)`,
        params: [id, login, displayName ?? login, now, now],
      },
      {
        sql: `INSERT INTO org_memberships (owner_id, principal_id, role, created_at)
              VALUES (?, ?, 'admin', ?)`,
        params: [id, principal.id, now],
      },
    ]);
  } catch {
    throw new OwnerConflictError(login);
  }
  const created = await resolveOwner(db, login);
  if (!created) throw new OwnerConflictError(login);
  return created;
}

/**
 * Ensure ANY owner row exists for `login`, returning the existing one untouched or
 * creating a `user` owner bound to `principalId` (nullable). Unlike
 * {@link ensureUserOwner} this never conflicts on an existing login — it is the
 * trusted-provisioning path (MCP capsule/automation) where namespace ownership is
 * not contested. `principalId` null yields an unowned namespace.
 */
export async function ensureOwnerForNamespace(
  db: DbClient,
  login: string,
  principalId: string | null,
): Promise<OwnerRow> {
  if (!isValidOwnerLogin(login)) throw new OwnerConflictError(login);
  const existing = await resolveOwner(db, login);
  if (existing) return existing;
  const now = db.now();
  try {
    await db.run(
      `INSERT INTO owners (id, login, type, principal_id, created_at, updated_at)
       VALUES (?, ?, 'user', ?, ?, ?)`,
      [db.id(), login, principalId, now, now],
    );
  } catch {
    const raced = await resolveOwner(db, login);
    if (raced) return raced;
    throw new OwnerConflictError(login);
  }
  const created = await resolveOwner(db, login);
  if (!created) throw new OwnerConflictError(login);
  return created;
}

export type OrgRole = "admin" | "member";

/** The principal's org-membership role, or null if not a member. */
export async function orgMembershipRole(
  db: DbClient,
  ownerId: string,
  principalId: string,
): Promise<OrgRole | null> {
  const row = await db.queryOne<{ role: string }>(
    `SELECT role FROM org_memberships WHERE owner_id = ? AND principal_id = ? LIMIT 1`,
    [ownerId, principalId],
  );
  if (!row) return null;
  return row.role === "admin" ? "admin" : "member";
}

/**
 * Ensure a bare principal row exists for an OIDC subject WITHOUT clobbering an
 * existing profile cache (unlike `upsertPrincipal`, which refreshes name/email).
 * Used when granting a collaborator/team-member a subject that has not signed in
 * yet — the grant targets the stable principal id.
 */
export async function ensurePrincipalBySubject(
  db: DbClient,
  subject: string,
): Promise<Principal> {
  const now = db.now();
  await db.run(
    `INSERT INTO principals (id, subject, kind, created_at, updated_at)
     VALUES (?, ?, 'user', ?, ?)
     ON CONFLICT(subject) DO NOTHING`,
    [db.id(), subject, now, now],
  );
  const row = await db.queryOne<{
    id: string;
    subject: string;
    kind: string;
    display_name: string | null;
    email: string | null;
  }>(
    `SELECT id, subject, kind, display_name, email FROM principals WHERE subject = ? LIMIT 1`,
    [subject],
  );
  if (!row) throw new Error("principal ensure returned no row");
  return {
    id: row.id,
    kind: row.kind === "service_account" ? "service_account" : "user",
    subject: row.subject,
    bindingId: null,
    displayName: row.display_name,
    email: row.email,
  };
}
