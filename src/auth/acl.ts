/**
 * Fail-closed, per-repo authorization for takos-git.
 *
 * This is the security core the whole product codes against. It resolves an
 * already-authenticated identity (browser session OR Interface OAuth — the router
 * decides WHICH; the mechanisms stay unmixed) into an effective per-repo role and
 * a single yes/no decision. Default is DENY: any path that cannot prove access
 * returns 401/403/404, never elevated access.
 *
 * It does NOT weaken the coarse gates that run before it: the browser
 * APP_WORKSPACE_ID membership check (`src/browser-auth.ts`) and the smart-HTTP
 * exact-scope check (`src/worker.ts`) still run first; per-repo ACL can only
 * NARROW an already-admitted principal.
 */

import type { DbClient } from "../db/index.ts";
import {
  ACTION_REQUIRED_ROLE,
  ACTION_REQUIRED_SCOPE,
  ANONYMOUS_PRINCIPAL,
  maxRole,
  roleAtLeast,
  type AuthContext,
  type AuthzDecision,
  type AuthzReason,
  type OwnerType,
  type Principal,
  type PrincipalKind,
  type RepoAction,
  type Role,
  type Visibility,
} from "../contract/v1.ts";

// ============================================================================
// Repo resolution
// ============================================================================

export interface RepoAclRow {
  readonly id: string;
  readonly ownerId: string;
  readonly ownerLogin: string;
  readonly ownerType: OwnerType;
  readonly ownerPrincipalId: string | null;
  readonly name: string;
  readonly visibility: Visibility;
  readonly defaultBranch: string;
}

interface RawRepoRow {
  id: string;
  owner_id: string;
  owner_login: string;
  owner_type: string;
  owner_principal_id: string | null;
  name: string;
  visibility: string;
  default_branch: string;
}

/** Load the ACL-relevant repo row by `owner/name`, or null if absent. */
export async function resolveRepoRow(
  db: DbClient,
  owner: string,
  name: string,
): Promise<RepoAclRow | null> {
  const row = await db.queryOne<RawRepoRow>(
    `SELECT r.id, r.owner_id, r.name, r.visibility, r.default_branch,
            o.login AS owner_login, o.type AS owner_type,
            o.principal_id AS owner_principal_id
       FROM repositories r
       JOIN owners o ON o.id = r.owner_id
      WHERE o.login = ? COLLATE NOCASE AND r.name = ? COLLATE NOCASE
      LIMIT 1`,
    [owner, name],
  );
  if (!row) return null;
  return {
    id: row.id,
    ownerId: row.owner_id,
    ownerLogin: row.owner_login,
    ownerType: row.owner_type === "org" ? "org" : "user",
    ownerPrincipalId: row.owner_principal_id,
    name: row.name,
    visibility: normalizeVisibility(row.visibility),
    defaultBranch: row.default_branch,
  };
}

function normalizeVisibility(value: string): Visibility {
  return value === "public" || value === "internal" ? value : "private";
}

// ============================================================================
// Effective role
// ============================================================================

/** Org base role: admins administer the org's repos; members get no base grant. */
async function orgRole(
  db: DbClient,
  ownerId: string,
  principalId: string,
): Promise<Role | null> {
  const row = await db.queryOne<{ role: string }>(
    `SELECT role FROM org_memberships WHERE owner_id = ? AND principal_id = ? LIMIT 1`,
    [ownerId, principalId],
  );
  if (!row) return null;
  // 'admin' administers every repo the org owns; plain members rely on explicit
  // collaborator/team grants (and the visibility floor) — a fail-closed default.
  return row.role === "admin" ? "owner" : null;
}

async function collaboratorRole(
  db: DbClient,
  repoId: string,
  principalId: string,
): Promise<Role | null> {
  const row = await db.queryOne<{ role: string }>(
    `SELECT role FROM repo_collaborators WHERE repo_id = ? AND principal_id = ? LIMIT 1`,
    [repoId, principalId],
  );
  return row ? asRole(row.role) : null;
}

async function teamRole(
  db: DbClient,
  repoId: string,
  principalId: string,
): Promise<Role | null> {
  const rows = await db.query<{ role: string }>(
    `SELECT tra.role AS role
       FROM team_repo_access tra
       JOIN team_members tm ON tm.team_id = tra.team_id
      WHERE tra.repo_id = ? AND tm.principal_id = ?`,
    [repoId, principalId],
  );
  return maxRole(...rows.map((row) => asRole(row.role)));
}

function asRole(value: string): Role | null {
  return value === "reader" ||
    value === "writer" ||
    value === "maintainer" ||
    value === "owner"
    ? value
    : null;
}

/** Visibility floor: the lowest role a repo grants without an explicit grant. */
function visibilityFloor(
  visibility: Visibility,
  kind: PrincipalKind,
): Role | null {
  if (visibility === "public") return "reader";
  // internal → any authenticated workspace member (they passed the membership
  // gate); never anonymous. private → no floor.
  if (visibility === "internal" && kind !== "anonymous") return "reader";
  return null;
}

/**
 * Effective role = max(owner-entity ownership, org base, direct collaborator,
 * team grant, visibility floor); null (no access) otherwise.
 */
export async function effectiveRole(
  db: DbClient,
  principal: Principal,
  repo: RepoAclRow,
): Promise<Role | null> {
  const floor = visibilityFloor(repo.visibility, principal.kind);
  if (principal.kind === "anonymous") return floor;

  if (repo.ownerType === "user" && repo.ownerPrincipalId === principal.id) {
    return "owner";
  }
  const org =
    repo.ownerType === "org"
      ? await orgRole(db, repo.ownerId, principal.id)
      : null;
  const grant = await collaboratorRole(db, repo.id, principal.id);
  const team = await teamRole(db, repo.id, principal.id);
  return maxRole(org, grant, team, floor);
}

// ============================================================================
// Branch protection gate (Phase 3 rule engine)
// ============================================================================

interface ProtectionRuleRow {
  pattern: string;
  required_reviews: number;
  restrict_push: number;
  push_allowlist: string | null;
  enforce_admins: number;
}

/** fnmatch-style branch glob: `*` within a segment, `**` across segments. */
function matchBranchPattern(pattern: string, branch: string): boolean {
  if (pattern === branch) return true;
  let out = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        out += ".*";
        index += 1;
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
    }
  }
  out += "$";
  try {
    return new RegExp(out, "u").test(branch);
  } catch {
    return false;
  }
}

function parseIdAllowlist(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * Evaluate `branch_protection_rules` for a ref-advancing action, BEFORE the R2
 * refs-doc CAS. Fail-closed: a query error or a matched rule the principal cannot
 * satisfy returns `false` (→ `protected_ref`). It only ever ADDS denials, never
 * grants access (repo role + scope already gate the write).
 *
 * - `contents.write` (direct push): restrict-push allowlist is enforced; a rule
 *   that requires reviews refuses the direct push (changes must land via a PR).
 * - `pulls.merge`: restrict-push allowlist is enforced and a matched rule raises
 *   the floor to `maintainer`; required approvals/status checks are verified by
 *   the merge handler (Phase 3b) against `pr_reviews`/`commit_statuses` before the
 *   CAS — that is the designated hook.
 *
 * Admins (role ≥ maintainer) bypass a rule unless it sets `enforce_admins`.
 */
async function checkBranchProtection(
  db: DbClient,
  repo: RepoAclRow,
  principal: Principal,
  role: Role,
  action: RepoAction,
  ref: string | undefined,
): Promise<boolean> {
  // No concrete ref (e.g. the smart-HTTP repo-level edge check passes ref "*"):
  // per-ref protection is enforced where the old→new update is known.
  if (!ref || ref === "*") return true;
  const branch = ref.startsWith("refs/heads/")
    ? ref.slice("refs/heads/".length)
    : ref;
  if (branch === "" || branch === "*") return true;

  let rules: ProtectionRuleRow[];
  try {
    rules = await db.query<ProtectionRuleRow>(
      `SELECT pattern, required_reviews, restrict_push, push_allowlist, enforce_admins
         FROM branch_protection_rules WHERE repo_id = ?`,
      [repo.id],
    );
  } catch {
    return false; // fail closed
  }

  for (const rule of rules) {
    if (!matchBranchPattern(rule.pattern, branch)) continue;
    const adminBypass =
      rule.enforce_admins === 0 && roleAtLeast(role, "maintainer");
    if (adminBypass) continue;
    if (rule.restrict_push === 1) {
      const allow = parseIdAllowlist(rule.push_allowlist);
      if (!allow.includes(principal.id)) return false;
    }
    if (action === "contents.write") {
      if (rule.required_reviews > 0) return false;
    } else if (action === "pulls.merge") {
      if (!roleAtLeast(role, "maintainer")) return false;
    }
  }
  return true;
}

// ============================================================================
// The one authorization function
// ============================================================================

const WRITE_ACTIONS: ReadonlySet<RepoAction> = new Set([
  "contents.write",
  "pulls.merge",
]);

/**
 * The single fail-closed authorization decision, called at every enforcement
 * point. Order: repo existence → effective role → required role → scope ceiling →
 * branch protection. Private repos return 404 (existence non-disclosure), never
 * 403, to a principal with no access.
 */
export async function authorizeRepo(
  db: DbClient,
  ctx: AuthContext,
  owner: string,
  name: string,
  action: RepoAction,
  opts?: { ref?: string },
): Promise<AuthzDecision> {
  // (a) repo must exist.
  const repo = await resolveRepoRow(db, owner, name);
  if (!repo) return deny(404, "not_found");

  // (b) effective role. null ⇒ private/internal-anon return 404 (non-disclosure).
  const role = await effectiveRole(db, ctx.principal, repo);
  if (role === null) return deny(404, "not_found");

  // (c) required role floor. Private repos hide insufficiency behind 404.
  if (!roleAtLeast(role, ACTION_REQUIRED_ROLE[action])) {
    return repo.visibility === "private"
      ? deny(404, "not_found")
      : deny(403, "forbidden");
  }

  // (d) scope ceiling — only the automation (interface) credential is capped;
  // browser and instance-admin carry the full ceiling.
  if (
    ctx.channel === "interface" &&
    !ctx.scopes.has(ACTION_REQUIRED_SCOPE[action])
  ) {
    return deny(403, "scope_insufficient");
  }

  // (e) branch protection on ref-advancing actions.
  if (WRITE_ACTIONS.has(action)) {
    const ok = await checkBranchProtection(
      db,
      repo,
      ctx.principal,
      role,
      action,
      opts?.ref,
    );
    if (!ok) return deny(403, "protected_ref");
  }

  return { allow: true, role };
}

function deny(
  status: 401 | 403 | 404 | 503,
  reason: AuthzReason,
): AuthzDecision {
  return { allow: false, status, reason };
}

/**
 * A role predicate factory. `requireRepoRole('writer')(role)` is true iff the
 * resolved role meets the floor. Kept for call sites that already hold the role.
 */
export function requireRepoRole(min: Role): (role: Role | null) => boolean {
  return (role) => role !== null && roleAtLeast(role, min);
}

// ============================================================================
// Principal resolution (JIT upsert keyed on OIDC subject)
// ============================================================================

interface PrincipalRow {
  id: string;
  subject: string;
  kind: string;
  display_name: string | null;
  email: string | null;
}

export interface PrincipalClaims {
  readonly subject: string;
  readonly kind: "user" | "service_account";
  readonly displayName?: string | null;
  readonly email?: string | null;
  /** Interface OAuth binding id, carried at runtime (not a persisted column). */
  readonly bindingId?: string | null;
}

/**
 * JIT-upsert a principal keyed on its OIDC subject. Identity is the subject; the
 * display_name/email caches refresh but are never trusted for authorization. The
 * stored `kind` is never downgraded on conflict.
 */
export async function upsertPrincipal(
  db: DbClient,
  claims: PrincipalClaims,
): Promise<Principal> {
  const now = db.now();
  const row = await db.queryOne<PrincipalRow>(
    `INSERT INTO principals (id, subject, kind, display_name, email, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(subject) DO UPDATE SET
          display_name = excluded.display_name,
          email = excluded.email,
          updated_at = excluded.updated_at
       RETURNING id, subject, kind, display_name, email`,
    [
      db.id(),
      claims.subject,
      claims.kind,
      claims.displayName ?? null,
      claims.email ?? null,
      now,
      now,
    ],
  );
  if (!row) {
    // RETURNING is supported by D1 and bun:sqlite; a null here is unexpected.
    throw new Error("principal upsert returned no row");
  }
  return {
    id: row.id,
    kind: row.kind === "service_account" ? "service_account" : "user",
    subject: row.subject,
    bindingId: claims.bindingId ?? null,
    displayName: row.display_name,
    email: row.email,
  };
}

// ============================================================================
// AuthContext builders
// ============================================================================

/** The anonymous context: eligible only for reads on public repos. */
export function anonymousContext(): AuthContext {
  return {
    principal: ANONYMOUS_PRINCIPAL,
    channel: "anonymous",
    scopes: new Set<string>(),
  };
}
