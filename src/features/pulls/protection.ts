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
import { diffTrees } from "../../git/tree-diff.ts";
import { getBlob, getCommitData } from "../../git/object-store.ts";
import { repositoryObjectStore } from "../../git/repo-object-store.ts";
import { getEntryAtPath } from "../../git/tree-ops.ts";
import type { ObjectStoreBinding } from "../../git/types.ts";
import { matchBranchPattern } from "../repos/branch-pattern.ts";

interface ProtectionRuleRow {
  pattern: string;
  required_reviews: number;
  dismiss_stale_reviews: number;
  require_code_owner: number;
  required_status_checks: string | null;
  strict_status_checks: number;
  enforce_admins: number;
  restrict_push: number;
  push_allowlist: string | null;
}

export type MergeProtectionResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly details?: Record<string, unknown>;
    };

export interface MergeProtectionContext {
  readonly bucket: ObjectStoreBinding;
  readonly repoKey: string;
  readonly baseSha: string;
  readonly mergeBaseSha: string | null;
  readonly authorId: string | null;
  readonly actorId: string;
}

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
  context: MergeProtectionContext,
): Promise<MergeProtectionResult> {
  let rules: ProtectionRuleRow[];
  try {
    rules = await db.query<ProtectionRuleRow>(
      `SELECT pattern, required_reviews, dismiss_stale_reviews,
              require_code_owner, required_status_checks,
              strict_status_checks, enforce_admins, restrict_push,
              push_allowlist
         FROM branch_protection_rules WHERE repo_id = ?`,
      [repoId],
    );
  } catch {
    return { ok: false, code: "protection_unreadable", message: "Branch protection could not be evaluated." };
  }

  const matching = rules.filter((rule) => matchBranchPattern(rule.pattern, baseRef));
  if (matching.length === 0) return { ok: true };

  const needReviews = matching.some(
    (rule) => rule.required_reviews > 0 || rule.require_code_owner === 1,
  );
  let reviewRows: ReviewVerdictRow[] = [];
  if (needReviews) {
    try {
      reviewRows = await loadReviewVerdicts(db, prId);
    } catch {
      return {
        ok: false,
        code: "protection_unreadable",
        message: "Pull-request reviews could not be evaluated.",
      };
    }
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

    if (rule.restrict_push === 1) {
      const allowlist = parseJsonArray(rule.push_allowlist);
      if (
        !(await principalOrTeamAllowed(db, context.actorId, allowlist))
      ) {
        return {
          ok: false,
          code: "protected_ref",
          message: "The acting principal is not allowed to update this branch.",
        };
      }
    }

    if (rule.required_reviews > 0 || rule.require_code_owner === 1) {
      const verdicts = latestReviewVerdicts(
        reviewRows,
        headSha,
        rule.dismiss_stale_reviews === 1,
        context.authorId,
      );
      if (verdicts.changesRequested) {
        return {
          ok: false,
          code: "changes_requested",
          message: "A review requested changes; the pull request cannot be merged.",
        };
      }
      if (verdicts.approvedReviewerIds.size < rule.required_reviews) {
        return {
          ok: false,
          code: "review_required",
          message: `This branch requires ${rule.required_reviews} approving review(s); it has ${verdicts.approvedReviewerIds.size}.`,
          details: {
            required: rule.required_reviews,
            approvals: verdicts.approvedReviewerIds.size,
          },
        };
      }
      if (rule.require_code_owner === 1) {
        const owners = await evaluateCodeOwners(
          db,
          context,
          headSha,
          verdicts.approvedReviewerIds,
        );
        if (!owners.ok) return owners.result;
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
  id: string;
  reviewer_id: string | null;
  state: string;
  commit_sha: string | null;
  created_at: number;
}

async function loadReviewVerdicts(
  db: DbClient,
  prId: string,
): Promise<ReviewVerdictRow[]> {
  return db.query<ReviewVerdictRow>(
    `SELECT id, reviewer_id, state, commit_sha, created_at
       FROM pr_reviews
      WHERE pr_id = ?
      ORDER BY created_at ASC, id ASC`,
    [prId],
  );
}

/**
 * Reduce reviews to the latest verdict per reviewer. Authors never count.
 * When stale dismissal is enabled, only verdicts anchored to the current head
 * participate.
 */
function latestReviewVerdicts(
  rows: readonly ReviewVerdictRow[],
  headSha: string,
  dismissStale: boolean,
  authorId: string | null,
): {
  approvedReviewerIds: ReadonlySet<string>;
  changesRequested: boolean;
} {
  const latest = new Map<string, string>();
  for (const row of rows) {
    if (!row.reviewer_id || row.reviewer_id === authorId) continue;
    if (dismissStale && row.commit_sha !== headSha) continue;
    if (row.state === "approved" || row.state === "changes_requested") {
      latest.set(row.reviewer_id, row.state);
    } else if (row.state === "dismissed") {
      latest.delete(row.reviewer_id);
    }
  }
  const approvedReviewerIds = new Set<string>();
  let changesRequested = false;
  for (const [reviewerId, state] of latest) {
    if (state === "approved") approvedReviewerIds.add(reviewerId);
    if (state === "changes_requested") changesRequested = true;
  }
  return { approvedReviewerIds, changesRequested };
}

async function principalOrTeamAllowed(
  db: DbClient,
  principalId: string,
  allowlist: readonly string[],
): Promise<boolean> {
  if (allowlist.includes(principalId)) return true;
  if (allowlist.length === 0) return false;
  const bounded = allowlist.slice(0, 100);
  const placeholders = bounded.map(() => "?").join(", ");
  return (
    (await db.queryOne<{ allowed: number }>(
      `SELECT 1 AS allowed FROM team_members
        WHERE principal_id = ? AND team_id IN (${placeholders})
        LIMIT 1`,
      [principalId, ...bounded],
    )) !== null
  );
}

const CODEOWNERS_PATHS = [
  ".github/CODEOWNERS",
  "CODEOWNERS",
  "docs/CODEOWNERS",
] as const;
const MAX_CODEOWNERS_BYTES = 256 * 1024;
const MAX_CODEOWNERS_RULES = 2_000;
const MAX_CODEOWNER_DIFF_FILES = 10_000;

interface CodeOwnerRule {
  readonly pattern: string;
  readonly owners: readonly string[];
}

async function readCodeOwnerRules(
  objects: ObjectStoreBinding,
  baseSha: string,
): Promise<CodeOwnerRule[] | null> {
  const commit = await getCommitData(objects, baseSha);
  if (!commit) throw new Error("base commit is unreadable");
  for (const path of CODEOWNERS_PATHS) {
    const entry = await getEntryAtPath(objects, commit.tree, path);
    if (!entry) continue;
    if (entry.type !== "blob" || entry.mode === "120000") {
      throw new Error("CODEOWNERS is not a regular file");
    }
    const bytes = await getBlob(objects, entry.sha, MAX_CODEOWNERS_BYTES);
    if (!bytes) throw new Error("CODEOWNERS blob is unreadable");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const rules: CodeOwnerRule[] = [];
    for (const raw of text.split(/\r?\n/u)) {
      const line = raw.trim();
      if (line === "" || line.startsWith("#")) continue;
      const fields = line.split(/\s+/u);
      const pattern = fields.shift() ?? "";
      if (!pattern || pattern.startsWith("!")) continue;
      const owners = fields
        .filter((field) => field.startsWith("@") && field.length > 1)
        .map((field) => field.slice(1));
      if (owners.length === 0) continue;
      rules.push({ pattern, owners });
      if (rules.length > MAX_CODEOWNERS_RULES) {
        throw new Error("CODEOWNERS has too many rules");
      }
    }
    return rules;
  }
  return null;
}

function codeOwnerGlob(pattern: string, path: string): boolean {
  let normalized = pattern.replace(/^\/+/u, "");
  if (normalized.endsWith("/")) normalized += "**";
  const basenameOnly = !normalized.includes("/");
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === "*" && normalized[index + 1] === "*") {
      if (normalized[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
    }
  }
  const candidate = basenameOnly ? (path.split("/").pop() ?? path) : path;
  return new RegExp(`^${source}$`, "u").test(candidate);
}

function ownersForPath(
  rules: readonly CodeOwnerRule[],
  path: string,
): readonly string[] {
  let owners: readonly string[] = [];
  for (const rule of rules) {
    if (codeOwnerGlob(rule.pattern, path)) owners = rule.owners;
  }
  return owners;
}

async function approvedOwnerAliases(
  db: DbClient,
  reviewerIds: ReadonlySet<string>,
): Promise<{ subjects: ReadonlySet<string>; aliases: ReadonlySet<string> }> {
  if (reviewerIds.size === 0) {
    return { subjects: new Set(), aliases: new Set() };
  }
  const ids = [...reviewerIds];
  const placeholders = ids.map(() => "?").join(", ");
  const principals = await db.query<{
    id: string;
    subject: string;
    login: string | null;
  }>(
    `SELECT p.id, p.subject, o.login
       FROM principals p
       LEFT JOIN owners o ON o.principal_id = p.id AND o.type = 'user'
      WHERE p.id IN (${placeholders})`,
    ids,
  );
  const teams = await db.query<{ principal_id: string; alias: string }>(
    `SELECT tm.principal_id, o.login || '/' || t.slug AS alias
       FROM team_members tm
       JOIN teams t ON t.id = tm.team_id
       JOIN owners o ON o.id = t.owner_id
      WHERE tm.principal_id IN (${placeholders})`,
    ids,
  );
  const subjects = new Set(principals.map((principal) => principal.subject));
  const aliases = new Set<string>();
  for (const principal of principals) {
    if (principal.login) aliases.add(principal.login.toLowerCase());
  }
  for (const team of teams) aliases.add(team.alias.toLowerCase());
  return { subjects, aliases };
}

async function evaluateCodeOwners(
  db: DbClient,
  context: MergeProtectionContext,
  headSha: string,
  approvedReviewerIds: ReadonlySet<string>,
): Promise<
  | { readonly ok: true }
  | { readonly ok: false; readonly result: MergeProtectionResult }
> {
  try {
    const objects = repositoryObjectStore(context.bucket, context.repoKey);
    const rules = await readCodeOwnerRules(objects, context.baseSha);
    if (!rules) {
      return {
        ok: false,
        result: {
          ok: false,
          code: "codeowners_missing",
          message: "This branch requires code-owner review but has no CODEOWNERS file.",
        },
      };
    }
    const [baseCommit, headCommit] = await Promise.all([
      getCommitData(objects, context.mergeBaseSha ?? context.baseSha),
      getCommitData(objects, headSha),
    ]);
    if (!baseCommit || !headCommit) throw new Error("PR commits are unreadable");
    const diff = await diffTrees(objects, baseCommit.tree, headCommit.tree, {
      maxEntries: MAX_CODEOWNER_DIFF_FILES,
      maxDepth: 50,
    });
    const paths = new Set<string>();
    for (const entry of diff) {
      paths.add(entry.path);
      if (entry.oldPath) paths.add(entry.oldPath);
    }
    const identities = await approvedOwnerAliases(db, approvedReviewerIds);
    const missing: string[] = [];
    for (const path of paths) {
      const owners = ownersForPath(rules, path);
      if (owners.length === 0) continue;
      const approved = owners.some(
        (owner) =>
          identities.subjects.has(owner) ||
          identities.aliases.has(owner.toLowerCase()),
      );
      if (!approved && missing.length < 20) missing.push(path);
    }
    if (missing.length > 0) {
      return {
        ok: false,
        result: {
          ok: false,
          code: "code_owner_review_required",
          message: "A code owner must approve every owned changed path.",
          details: { paths: missing },
        },
      };
    }
    return { ok: true };
  } catch {
    return {
      ok: false,
      result: {
        ok: false,
        code: "codeowners_unreadable",
        message: "CODEOWNERS could not be evaluated safely.",
      },
    };
  }
}

function parseJsonArray(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is string => typeof entry === "string",
    );
  } catch {
    return [];
  }
}

function parseContexts(json: string | null): string[] {
  return [...new Set(parseJsonArray(json).map((entry) => entry.trim()))].filter(
    (entry) => entry !== "",
  );
}

/** Contexts whose LATEST commit_statuses state for `headSha` is not 'success'. */
async function unsatisfiedContexts(
  db: DbClient,
  repoId: string,
  headSha: string,
  contexts: string[],
): Promise<string[]> {
  const rows = await db.query<{ context: string; state: string }>(
    `SELECT s.context, s.state
       FROM commit_statuses s
      WHERE s.repo_id = ? AND s.sha = ?
        AND NOT EXISTS (
          SELECT 1 FROM commit_statuses newer
           WHERE newer.repo_id = s.repo_id
             AND newer.sha = s.sha
             AND newer.context = s.context
             AND (
               newer.created_at > s.created_at OR
               (newer.created_at = s.created_at AND newer.id > s.id)
             )
        )`,
    [repoId, headSha],
  );
  const stateByContext = new Map(rows.map((r) => [r.context, r.state]));
  return contexts.filter((context) => stateByContext.get(context) !== "success");
}
