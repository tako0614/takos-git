/**
 * Merge-time branch-protection enforcement.
 *
 * The frozen ACL (`authorizeRepo`, `pulls.merge`) already gates repo role + scope
 * and raises the floor to `maintainer` when a rule matches the base ref. The
 * remaining, PR-specific checks — required approving reviews, required status
 * checks, and up-to-date (strict) branches — are the "designated hook" the ACL
 * comment defers to us: they read `pr_reviews` and `commit_statuses` DIRECTLY
 * (the checks feature owns writing statuses). Evaluated BEFORE the R2 refs CAS,
 * so a rejected merge never advances the authoritative ref.
 */

import { roleAtLeast, type Role } from "../../contract/v1.ts";
import type { DbClient } from "../../db/index.ts";

interface ProtectionRuleRow {
  pattern: string;
  required_reviews: number;
  required_status_checks: string | null;
  strict_status_checks: number;
  enforce_admins: number;
}

/** fnmatch-lite: `*` matches any run of non-`/` chars; everything else literal. */
export function matchBranchPattern(pattern: string, branch: string): boolean {
  if (pattern === branch) return true;
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/gu, "\\$&")
    .replace(/\*/gu, "[^/]*");
  return new RegExp(`^${escaped}$`, "u").test(branch);
}

export type MergeProtectionResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly details?: Record<string, unknown>;
    };

/**
 * Verify every protection rule matching `baseRef` permits merging this PR.
 * `behindBy` is the base→head behind count (for strict/up-to-date rules).
 */
export async function evaluateMergeProtection(
  db: DbClient,
  repoId: string,
  prId: string,
  baseRef: string,
  headSha: string,
  role: Role,
  behindBy: number,
): Promise<MergeProtectionResult> {
  let rules: ProtectionRuleRow[];
  try {
    rules = await db.query<ProtectionRuleRow>(
      `SELECT pattern, required_reviews, required_status_checks,
              strict_status_checks, enforce_admins
         FROM branch_protection_rules WHERE repo_id = ?`,
      [repoId],
    );
  } catch {
    return { ok: false, code: "protection_unreadable", message: "Branch protection could not be evaluated." };
  }

  const matching = rules.filter((rule) => matchBranchPattern(rule.pattern, baseRef));
  if (matching.length === 0) return { ok: true };

  // Latest verdict per reviewer (approved / changes_requested) across the PR's
  // reviews for the current head. A single outstanding changes_requested blocks.
  let approvals = 0;
  let hasChangesRequested = false;
  // Load once if any matching rule needs review data.
  const needReviews = matching.some((rule) => rule.required_reviews > 0);
  if (needReviews) {
    const verdicts = await latestReviewVerdicts(db, prId);
    approvals = verdicts.approvals;
    hasChangesRequested = verdicts.changesRequested;
  }

  for (const rule of matching) {
    const adminBypass = rule.enforce_admins === 0 && roleAtLeast(role, "maintainer");
    if (adminBypass) continue;

    if (!roleAtLeast(role, "maintainer")) {
      return {
        ok: false,
        code: "protected_ref",
        message: "A protection rule on the base branch requires the maintainer role to merge.",
      };
    }

    if (rule.required_reviews > 0) {
      if (hasChangesRequested) {
        return {
          ok: false,
          code: "changes_requested",
          message: "A review requested changes; the pull request cannot be merged.",
        };
      }
      if (approvals < rule.required_reviews) {
        return {
          ok: false,
          code: "review_required",
          message: `This branch requires ${rule.required_reviews} approving review(s); it has ${approvals}.`,
          details: { required: rule.required_reviews, approvals },
        };
      }
    }

    const contexts = parseContexts(rule.required_status_checks);
    if (contexts.length > 0) {
      const missing = await unsatisfiedContexts(db, repoId, headSha, contexts);
      if (missing.length > 0) {
        return {
          ok: false,
          code: "required_checks_failing",
          message: "Required status checks have not succeeded.",
          details: { contexts: missing },
        };
      }
    }

    if (rule.strict_status_checks === 1 && behindBy > 0) {
      return {
        ok: false,
        code: "branch_not_up_to_date",
        message: "The base branch is ahead; update the branch before merging.",
        details: { behindBy },
      };
    }
  }

  return { ok: true };
}

interface ReviewVerdictRow {
  reviewer_id: string | null;
  state: string;
  created_at: number;
}

/**
 * Reduce a PR's reviews to the latest verdict per reviewer. `changes_requested`
 * and `approved` are the terminal verdicts; `commented`/`pending` do not count;
 * `dismissed` clears a prior verdict.
 */
async function latestReviewVerdicts(
  db: DbClient,
  prId: string,
): Promise<{ approvals: number; changesRequested: boolean }> {
  const rows = await db.query<ReviewVerdictRow & { reviewer_key: string }>(
    `SELECT rv.reviewer_id, rv.state, rv.created_at,
            COALESCE(rv.reviewer_id, rv.id) AS reviewer_key
       FROM pr_reviews rv
      WHERE rv.pr_id = ?
      ORDER BY rv.created_at ASC`,
    [prId],
  );
  const latest = new Map<string, string>();
  for (const row of rows) {
    if (row.state === "approved" || row.state === "changes_requested") {
      latest.set(row.reviewer_key, row.state);
    } else if (row.state === "dismissed") {
      latest.delete(row.reviewer_key);
    }
  }
  let approvals = 0;
  let changesRequested = false;
  for (const state of latest.values()) {
    if (state === "approved") approvals += 1;
    if (state === "changes_requested") changesRequested = true;
  }
  return { approvals, changesRequested };
}

function parseContexts(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((c): c is string => typeof c === "string");
  } catch {
    return [];
  }
}

interface StatusRow {
  context: string;
  state: string;
}

/** Contexts whose LATEST commit_statuses state for `headSha` is not 'success'. */
async function unsatisfiedContexts(
  db: DbClient,
  repoId: string,
  headSha: string,
  contexts: string[],
): Promise<string[]> {
  const rows = await db.query<StatusRow>(
    `SELECT s.context, s.state
       FROM commit_statuses s
       JOIN (
         SELECT context, MAX(created_at) AS created_at
           FROM commit_statuses
          WHERE repo_id = ? AND sha = ?
          GROUP BY context
       ) latest ON latest.context = s.context AND latest.created_at = s.created_at
      WHERE s.repo_id = ? AND s.sha = ?`,
    [repoId, headSha, repoId, headSha],
  );
  const stateByContext = new Map(rows.map((r) => [r.context, r.state]));
  return contexts.filter((context) => stateByContext.get(context) !== "success");
}
