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
import { matchBranchPattern } from "../features/repos/branch-pattern.ts";
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
        AND r.lifecycle_state = 'active'
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
  allow_force_push: number;
  allow_deletions: number;
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

async function principalIsPushAllowed(
  db: DbClient,
  principalId: string,
  allowlist: readonly string[],
): Promise<boolean> {
  if (allowlist.includes(principalId)) return true;
  if (allowlist.length === 0) return false;
  const bounded = allowlist.slice(0, 100);
  const placeholders = bounded.map(() => "?").join(", ");
  const membership = await db.queryOne<{ allowed: number }>(
    `SELECT 1 AS allowed
       FROM team_members
      WHERE principal_id = ? AND team_id IN (${placeholders})
      LIMIT 1`,
    [principalId, ...bounded],
  );
  return membership !== null;
}

interface BranchProtectionDecision {
  readonly allow: boolean;
  readonly allowNonFastForward: boolean;
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
  update?: { readonly oldSha: string; readonly newSha: string },
): Promise<BranchProtectionDecision> {
  // No concrete ref (e.g. the smart-HTTP repo-level edge check passes ref "*"):
  // per-ref protection is enforced where the old→new update is known.
  if (!ref || ref === "*") {
    return { allow: true, allowNonFastForward: false };
  }
  if (ref.startsWith("refs/") && !ref.startsWith("refs/heads/")) {
    return { allow: true, allowNonFastForward: false };
  }
  const branch = ref.startsWith("refs/heads/")
    ? ref.slice("refs/heads/".length)
    : ref;
  if (branch === "" || branch === "*") {
    return { allow: true, allowNonFastForward: false };
  }

  let rules: ProtectionRuleRow[];
  try {
    rules = await db.query<ProtectionRuleRow>(
      `SELECT pattern, required_reviews, restrict_push, push_allowlist,
              enforce_admins, allow_force_push, allow_deletions
         FROM branch_protection_rules WHERE repo_id = ?`,
      [repo.id],
    );
  } catch {
    return { allow: false, allowNonFastForward: false }; // fail closed
  }

  let effectiveRules = 0;
  let everyRuleAllowsForcePush = true;
  const deleting = update?.newSha === "0".repeat(40);
  for (const rule of rules) {
    if (!matchBranchPattern(rule.pattern, branch)) continue;
    const adminBypass =
      rule.enforce_admins === 0 && roleAtLeast(role, "maintainer");
    if (adminBypass) continue;
    effectiveRules += 1;
    if (rule.allow_force_push !== 1) everyRuleAllowsForcePush = false;
    if (deleting && rule.allow_deletions !== 1) {
      return { allow: false, allowNonFastForward: false };
    }
    if (rule.restrict_push === 1) {
      const allow = parseIdAllowlist(rule.push_allowlist);
      if (!(await principalIsPushAllowed(db, principal.id, allow))) {
        return { allow: false, allowNonFastForward: false };
      }
    }
    if (action === "contents.write" && !deleting) {
      if (rule.required_reviews > 0) {
        return { allow: false, allowNonFastForward: false };
      }
    } else if (action === "pulls.merge") {
      if (!roleAtLeast(role, "maintainer")) {
        return { allow: false, allowNonFastForward: false };
      }
    }
  }
  return {
    allow: true,
    allowNonFastForward:
      effectiveRules > 0 && everyRuleAllowsForcePush && !deleting,
  };
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
  opts?: { ref?: string; oldSha?: string; newSha?: string },
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
    const protection = await checkBranchProtection(
      db,
      repo,
      ctx.principal,
      role,
      action,
      opts?.ref,
      opts?.oldSha && opts?.newSha
        ? { oldSha: opts.oldSha, newSha: opts.newSha }
        : undefined,
    );
    if (!protection.allow) return deny(403, "protected_ref");
    return {
      allow: true,
      role,
      ...(protection.allowNonFastForward
        ? { allowNonFastForward: true }
        : {}),
    };
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
// Principal resolution (JIT upsert keyed on issuer + subject + binding)
// ============================================================================

interface PrincipalRow {
  id: string;
  issuer: string;
  subject: string;
  binding_id: string;
  kind: string;
  display_name: string | null;
  email: string | null;
}

export interface PrincipalClaims {
  readonly issuer: string;
  readonly subject: string;
  readonly kind: "user" | "service_account";
  readonly displayName?: string | null;
  readonly email?: string | null;
  /** Interface OAuth binding id, carried at runtime (not a persisted column). */
  readonly bindingId?: string | null;
}

function canonicalIssuer(value: string): string {
  const issuer = new URL(value);
  if (
    issuer.protocol !== "https:" ||
    issuer.username !== "" ||
    issuer.password !== "" ||
    issuer.pathname !== "/" ||
    issuer.search !== "" ||
    issuer.hash !== ""
  ) {
    throw new Error("principal issuer must be an HTTPS origin");
  }
  return issuer.origin;
}

/**
 * JIT-upsert a principal keyed on canonical `(issuer, subject, binding_id)`.
 * Human principals use an empty binding id; Interface automation requires its
 * exact binding. Profile caches refresh but are never trusted for authorization.
 */
export async function upsertPrincipal(
  db: DbClient,
  claims: PrincipalClaims,
): Promise<Principal> {
  const issuer = canonicalIssuer(claims.issuer);
  const subject = claims.subject.trim();
  if (subject === "") throw new Error("principal subject is required");
  const bindingId =
    claims.kind === "service_account" ? claims.bindingId?.trim() ?? "" : "";
  if (claims.kind === "service_account" && bindingId === "") {
    throw new Error("service-account principal requires an InterfaceBinding id");
  }
  const now = db.now();

  // 0001 principals did not persist issuer/binding. Adopt at most one matching
  // legacy row on its first authenticated use so grants survive the additive
  // migration. A later issuer/binding gets a distinct row and no inherited ACL.
  try {
    await db.run(
      `UPDATE principals
          SET issuer = ?, binding_id = ?, display_name = COALESCE(?, display_name),
              email = COALESCE(?, email), updated_at = ?
        WHERE id = (
          SELECT id FROM principals
           WHERE issuer = '' AND subject = ? AND binding_id = '' AND kind = ?
           LIMIT 1
        )
          AND NOT EXISTS (
            SELECT 1 FROM principals
             WHERE issuer = ? AND subject = ? AND binding_id = ?
          )`,
      [
        issuer,
        bindingId,
        claims.displayName ?? null,
        claims.email ?? null,
        now,
        subject,
        claims.kind,
        issuer,
        subject,
        bindingId,
      ],
    );
  } catch {
    // A concurrent request may have adopted/inserted the same identity. The
    // conflict-safe UPSERT below resolves the winner.
  }

  const row = await db.queryOne<PrincipalRow>(
    `INSERT INTO principals
          (id, issuer, subject, binding_id, kind, display_name, email, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(issuer, subject, binding_id) DO UPDATE SET
          display_name = COALESCE(excluded.display_name, principals.display_name),
          email = COALESCE(excluded.email, principals.email),
          updated_at = excluded.updated_at
       RETURNING id, issuer, subject, binding_id, kind, display_name, email`,
    [
      db.id(),
      issuer,
      subject,
      bindingId,
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
    issuer: row.issuer,
    subject: row.subject,
    bindingId: row.binding_id || null,
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
