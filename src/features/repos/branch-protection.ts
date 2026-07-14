/**
 * Branch-protection rule administration (`branch_protection_rules`).
 *
 * These routes only manage the rule set; ENFORCEMENT lives in the frozen ACL's
 * `checkBranchProtection` (Phase-3 hook), read on every ref-advancing write
 * (`contents.write` / `pulls.merge`) before the R2 refs-doc CAS. Listing requires
 * maintainer; mutating a rule requires owner.
 */

import { SCOPES, roleAtLeast } from "../../contract/v1.ts";
import type { Route, RouteContext } from "../../router.ts";
import { json, errorResponse } from "./http.ts";
import { csrfGuard, requireRepoAccess } from "./identity.ts";

const MAX_BODY_BYTES = 32 * 1024;

interface RuleRow {
  id: string;
  pattern: string;
  required_reviews: number;
  dismiss_stale_reviews: number;
  require_code_owner: number;
  required_status_checks: string | null;
  strict_status_checks: number;
  enforce_admins: number;
  restrict_push: number;
  push_allowlist: string | null;
  allow_force_push: number;
  allow_deletions: number;
  created_at: number;
  updated_at: number;
}

function ruleDto(row: RuleRow): Record<string, unknown> {
  return {
    pattern: row.pattern,
    requiredReviews: row.required_reviews,
    dismissStaleReviews: row.dismiss_stale_reviews !== 0,
    requireCodeOwner: row.require_code_owner !== 0,
    requiredStatusChecks: parseJsonArray(row.required_status_checks),
    strictStatusChecks: row.strict_status_checks !== 0,
    enforceAdmins: row.enforce_admins !== 0,
    restrictPush: row.restrict_push !== 0,
    pushAllowlist: parseJsonArray(row.push_allowlist),
    allowForcePush: row.allow_force_push !== 0,
    allowDeletions: row.allow_deletions !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

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

function bool01(value: unknown): number {
  return value === true ? 1 : 0;
}

function nonNegInt(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function stringArrayJson(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const list = value.filter((entry): entry is string => typeof entry === "string");
  return list.length > 0 ? JSON.stringify(list) : null;
}

function isValidPattern(pattern: string): boolean {
  return (
    pattern.length > 0 &&
    pattern.length <= 255 &&
    !pattern.includes("..") &&
    // eslint-disable-next-line no-control-regex
    !/[\x00-\x1f\x7f]/u.test(pattern)
  );
}

const listRules: Route["handler"] = async (ctx) => {
  const access = await requireRepoAccess(ctx, "repo.admin", SCOPES.hostingAdmin);
  if (access instanceof Response) return access;
  // repo.admin floor is maintainer — sufficient for listing rules.
  const rows = await ctx.db!.query<RuleRow>(
    `SELECT * FROM branch_protection_rules WHERE repo_id = ? ORDER BY pattern ASC`,
    [access.repo.id],
  );
  return json({ rules: rows.map(ruleDto) });
};

const getRule: Route["handler"] = async (ctx) => {
  const access = await requireRepoAccess(ctx, "repo.admin", SCOPES.hostingAdmin);
  if (access instanceof Response) return access;
  const row = await ctx.db!.queryOne<RuleRow>(
    `SELECT * FROM branch_protection_rules WHERE repo_id = ? AND pattern = ? LIMIT 1`,
    [access.repo.id, ctx.params.pattern],
  );
  if (!row) return errorResponse(404, "not_found", "Rule not found.");
  return json({ rule: ruleDto(row) });
};

const putRule: Route["handler"] = async (ctx) => {
  const access = await requireRepoAccess(ctx, "repo.admin", SCOPES.hostingAdmin);
  if (access instanceof Response) return access;
  const csrf = csrfGuard(ctx, access.auth);
  if (csrf) return csrf;
  if (!roleAtLeast(access.role, "owner")) {
    return errorResponse(403, "forbidden", "Owner role required.");
  }
  const pattern = ctx.params.pattern;
  if (!isValidPattern(pattern)) {
    return errorResponse(400, "invalid_pattern", "Invalid branch pattern.");
  }
  const body = await readJson(ctx.request);
  if (!body) return errorResponse(400, "invalid_body", "Invalid request body.");
  const now = ctx.db!.now();
  await ctx.db!.run(
    `INSERT INTO branch_protection_rules
       (id, repo_id, pattern, required_reviews, dismiss_stale_reviews, require_code_owner,
        required_status_checks, strict_status_checks, enforce_admins, restrict_push,
        push_allowlist, allow_force_push, allow_deletions, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo_id, pattern) DO UPDATE SET
        required_reviews = excluded.required_reviews,
        dismiss_stale_reviews = excluded.dismiss_stale_reviews,
        require_code_owner = excluded.require_code_owner,
        required_status_checks = excluded.required_status_checks,
        strict_status_checks = excluded.strict_status_checks,
        enforce_admins = excluded.enforce_admins,
        restrict_push = excluded.restrict_push,
        push_allowlist = excluded.push_allowlist,
        allow_force_push = excluded.allow_force_push,
        allow_deletions = excluded.allow_deletions,
        updated_at = excluded.updated_at`,
    [
      ctx.db!.id(),
      access.repo.id,
      pattern,
      nonNegInt(body.requiredReviews),
      bool01(body.dismissStaleReviews),
      bool01(body.requireCodeOwner),
      stringArrayJson(body.requiredStatusChecks),
      bool01(body.strictStatusChecks),
      bool01(body.enforceAdmins),
      bool01(body.restrictPush),
      stringArrayJson(body.pushAllowlist),
      bool01(body.allowForcePush),
      bool01(body.allowDeletions),
      now,
      now,
    ],
  );
  const row = await ctx.db!.queryOne<RuleRow>(
    `SELECT * FROM branch_protection_rules WHERE repo_id = ? AND pattern = ? LIMIT 1`,
    [access.repo.id, pattern],
  );
  return json({ rule: row ? ruleDto(row) : null }, 200);
};

const deleteRule: Route["handler"] = async (ctx) => {
  const access = await requireRepoAccess(ctx, "repo.admin", SCOPES.hostingAdmin);
  if (access instanceof Response) return access;
  const csrf = csrfGuard(ctx, access.auth);
  if (csrf) return csrf;
  if (!roleAtLeast(access.role, "owner")) {
    return errorResponse(403, "forbidden", "Owner role required.");
  }
  await ctx.db!.run(
    `DELETE FROM branch_protection_rules WHERE repo_id = ? AND pattern = ?`,
    [access.repo.id, ctx.params.pattern],
  );
  return json({ removed: true });
};

export const branchProtectionHandlers = {
  listRules,
  getRule,
  putRule,
  deleteRule,
} as const;

export type { RouteContext };
