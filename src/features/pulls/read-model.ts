/**
 * PR data access + the R2-authoritative git-state projection.
 *
 * Ported from the takos worker's `pull-requests/read-model.ts`, reworked so that
 * head/base tips and mergeability are re-derived from the R2 refs doc + object
 * store on every read (advisory D1 pointers are never trusted as truth). PR
 * numbers share the per-repo `issue` counter (GitHub parity), allocated here.
 */

import type { DbClient } from "../../db/index.ts";
import type { ObjectStoreBinding } from "../../git/types.ts";
import { readRepoRefs, type RefsDoc } from "../../git/refs-store.ts";
import { repositoryObjectStore } from "../../git/repo-object-store.ts";
import { countCommitsBetween } from "../../git/merge-base.ts";
import { mergeTrees3Way } from "../../git/merge.ts";
import { getCommitData } from "../../git/object-store.ts";
import {
  buildPrincipalLiteMap,
  principalLite,
  PR_SELECT,
  toPullRequestDto,
  toPullRequestRow,
  type PullRequestDto,
  type PullRequestMetrics,
  type PullRequestRow,
  type RawPrRow,
} from "./dto.ts";

// ============================================================================
// Number allocation (shared issue+PR counter)
// ============================================================================

/**
 * Atomically allocate the next per-repo `issue`-scope number (shared by issues
 * and PRs). Uses an UPSERT+RETURNING so concurrent allocations never collide —
 * the same allocator the issues feature must use.
 */
export async function allocateSharedNumber(
  db: DbClient,
  repoId: string,
): Promise<number> {
  const rows = await db.query<{ next_value: number }>(
    `INSERT INTO repo_counters (repo_id, scope, next_value) VALUES (?, 'issue', 2)
     ON CONFLICT(repo_id, scope) DO UPDATE SET next_value = next_value + 1
     RETURNING next_value`,
    [repoId],
  );
  const next = rows[0]?.next_value ?? 2;
  return next - 1;
}

// ============================================================================
// Lookups
// ============================================================================

export async function findPullRequest(
  db: DbClient,
  repoId: string,
  number: number,
): Promise<PullRequestRow | null> {
  const raw = await db.queryOne<RawPrRow>(
    `${PR_SELECT} WHERE pr.repo_id = ? AND i.number = ? LIMIT 1`,
    [repoId, number],
  );
  return raw ? toPullRequestRow(raw) : null;
}

export async function findPullRequestById(
  db: DbClient,
  id: string,
): Promise<PullRequestRow | null> {
  const raw = await db.queryOne<RawPrRow>(
    `${PR_SELECT} WHERE pr.id = ? LIMIT 1`,
    [id],
  );
  return raw ? toPullRequestRow(raw) : null;
}

export interface ListPullRequestsOptions {
  readonly state?: "open" | "closed" | "all";
  readonly limit: number;
  readonly offset: number;
}

export async function listPullRequests(
  db: DbClient,
  repoId: string,
  options: ListPullRequestsOptions,
): Promise<PullRequestRow[]> {
  const params: unknown[] = [repoId];
  let where = "pr.repo_id = ?";
  if (options.state && options.state !== "all") {
    where += " AND i.state = ?";
    params.push(options.state);
  }
  params.push(options.limit, options.offset);
  const rows = await db.query<RawPrRow>(
    `${PR_SELECT} WHERE ${where} ORDER BY i.created_at DESC LIMIT ? OFFSET ?`,
    params,
  );
  return rows.map(toPullRequestRow);
}

// ============================================================================
// R2 git-state projection (head/base tips, ahead/behind, mergeability)
// ============================================================================

export interface GitState {
  readonly headSha: string;
  readonly baseSha: string;
  readonly headExists: boolean;
  readonly baseExists: boolean;
  readonly aheadBy: number;
  readonly behindBy: number;
  readonly mergeBaseSha: string | null;
  /** 'clean' | 'dirty' | 'unknown'. 'unknown' when a tip is missing. */
  readonly mergeable: string;
}

function refSha(refs: RefsDoc, ref: string): string | null {
  const record = refs.refs.find((r) => r.name === `refs/heads/${ref}`);
  return record ? record.sha : null;
}

/**
 * Re-derive the PR's git state from R2. `deep` also runs the 3-way tree merge to
 * classify mergeable clean/dirty (skipped for cheap list rendering).
 */
export async function computeGitState(
  bucket: ObjectStoreBinding,
  repoKey: string,
  pr: PullRequestRow,
  deep: boolean,
): Promise<GitState> {
  const refs = await readRepoRefs(bucket, repoKey);
  const headSha = refSha(refs, pr.headRef);
  const baseSha = refSha(refs, pr.baseRef);
  if (!headSha || !baseSha) {
    return {
      headSha: headSha ?? pr.headSha,
      baseSha: baseSha ?? pr.baseSha,
      headExists: headSha !== null,
      baseExists: baseSha !== null,
      aheadBy: 0,
      behindBy: 0,
      mergeBaseSha: null,
      mergeable: "unknown",
    };
  }
  const objects = repositoryObjectStore(bucket, repoKey);
  let aheadBy = 0;
  let behindBy = 0;
  let mergeBaseSha: string | null = null;
  try {
    const counts = await countCommitsBetween(objects, baseSha, headSha);
    aheadBy = counts.ahead;
    behindBy = counts.behind;
    mergeBaseSha = counts.mergeBaseSha;
  } catch {
    // Orphaned/oversized graph: leave counts at 0, mergeable unknown.
    return {
      headSha,
      baseSha,
      headExists: true,
      baseExists: true,
      aheadBy: 0,
      behindBy: 0,
      mergeBaseSha: null,
      mergeable: "unknown",
    };
  }

  let mergeable = "unknown";
  if (deep && mergeBaseSha) {
    try {
      const [baseCommit, headCommit, mbCommit] = await Promise.all([
        getCommitData(objects, baseSha),
        getCommitData(objects, headSha),
        getCommitData(objects, mergeBaseSha),
      ]);
      if (baseCommit && headCommit && mbCommit) {
        const result = await mergeTrees3Way(
          objects,
          mbCommit.tree,
          baseCommit.tree,
          headCommit.tree,
        );
        mergeable = result.conflicts.length === 0 ? "clean" : "dirty";
      }
    } catch {
      mergeable = "unknown";
    }
  } else if (mergeBaseSha) {
    // Cheap heuristic for list views: already merged / no divergence => clean.
    mergeable = aheadBy === 0 ? "clean" : "unknown";
  }

  return {
    headSha,
    baseSha,
    headExists: true,
    baseExists: true,
    aheadBy,
    behindBy,
    mergeBaseSha,
    mergeable,
  };
}

// ============================================================================
// Metrics assembly
// ============================================================================

async function countRows(
  db: DbClient,
  sql: string,
  params: unknown[],
): Promise<number> {
  const row = await db.queryOne<{ n: number }>(sql, params);
  return row?.n ?? 0;
}

/**
 * Build the full metrics needed to shape one PR DTO: author/mergedBy principals,
 * commit/comment/review counts, and the R2-derived git state.
 */
export async function buildMetrics(
  db: DbClient,
  bucket: ObjectStoreBinding,
  repoKey: string,
  pr: PullRequestRow,
  deep: boolean,
): Promise<PullRequestMetrics> {
  const [gitState, principals, reviewsCount, reviewCommentsCount] =
    await Promise.all([
      computeGitState(bucket, repoKey, pr, deep),
      buildPrincipalLiteMap(db, [pr.authorId, pr.mergedById]),
      countRows(db, `SELECT COUNT(*) AS n FROM pr_reviews WHERE pr_id = ? AND state != 'pending'`, [pr.id]),
      countRows(db, `SELECT COUNT(*) AS n FROM pr_review_comments WHERE pr_id = ?`, [pr.id]),
    ]);

  return {
    author: principalLite(pr.authorId, principals),
    mergedBy: principalLite(pr.mergedById, principals),
    commitsCount: gitState.aheadBy,
    aheadBy: gitState.aheadBy,
    behindBy: gitState.behindBy,
    mergeable: gitState.mergeable,
    mergeBaseSha: gitState.mergeBaseSha,
    headSha: gitState.headSha,
    baseSha: gitState.baseSha,
    commentsCount: pr.commentCount,
    reviewCommentsCount,
    reviewsCount,
  };
}

/** Assemble one PR DTO (metrics + shape). `deep` runs the 3-way mergeability check. */
export async function shapePullRequest(
  db: DbClient,
  bucket: ObjectStoreBinding,
  repoKey: string,
  pr: PullRequestRow,
  deep: boolean,
): Promise<PullRequestDto> {
  const metrics = await buildMetrics(db, bucket, repoKey, pr, deep);
  return toPullRequestDto(pr, metrics);
}
