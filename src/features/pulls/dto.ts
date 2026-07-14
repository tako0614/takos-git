/**
 * DTO shaping for pull requests, reviews, and inline review comments.
 *
 * A PR row EXTENDS an `issues` row (shared number/title/body/state/author), so
 * every read joins `pull_requests` onto `issues`. Author/reviewer identity is a
 * `principal_id` (severed from Takos `accounts`); we resolve a small principal
 * "lite" projection for rendering. All timestamps are epoch-ms integers.
 */

import type { DbClient } from "../../db/index.ts";

// ============================================================================
// Row shapes (joined pull_requests + issues)
// ============================================================================

export interface PullRequestRow {
  readonly id: string;
  readonly issueId: string;
  readonly repoId: string;
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly state: string; // 'open' | 'closed'
  readonly stateReason: string | null;
  readonly authorId: string | null;
  readonly commentCount: number;
  readonly headRepoId: string | null;
  readonly headRef: string;
  readonly headSha: string;
  readonly baseRepoId: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly mergeBaseSha: string | null;
  readonly mergeable: string; // 'clean' | 'dirty' | 'unknown'
  readonly draft: number;
  readonly merged: number;
  readonly mergedAt: number | null;
  readonly mergedById: string | null;
  readonly mergeCommitSha: string | null;
  readonly mergeMethod: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly closedAt: number | null;
}

interface RawPrRow {
  id: string;
  issue_id: string;
  repo_id: string;
  number: number;
  title: string;
  body: string | null;
  state: string;
  state_reason: string | null;
  author_id: string | null;
  comment_count: number;
  head_repo_id: string | null;
  head_ref: string;
  head_sha: string;
  base_repo_id: string;
  base_ref: string;
  base_sha: string;
  merge_base_sha: string | null;
  mergeable: string;
  draft: number;
  merged: number;
  merged_at: number | null;
  merged_by_id: string | null;
  merge_commit_sha: string | null;
  merge_method: string | null;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
}

export const PR_SELECT = `
  SELECT pr.id, pr.issue_id, pr.repo_id, i.number, i.title, i.body, i.state,
         i.state_reason, i.author_id, i.comment_count,
         pr.head_repo_id, pr.head_ref, pr.head_sha,
         pr.base_repo_id, pr.base_ref, pr.base_sha, pr.merge_base_sha,
         pr.mergeable, pr.draft, pr.merged, pr.merged_at, pr.merged_by_id,
         pr.merge_commit_sha, pr.merge_method,
         i.created_at AS created_at, i.updated_at AS updated_at, i.closed_at AS closed_at
    FROM pull_requests pr
    JOIN issues i ON i.id = pr.issue_id`;

export function toPullRequestRow(raw: RawPrRow): PullRequestRow {
  return {
    id: raw.id,
    issueId: raw.issue_id,
    repoId: raw.repo_id,
    number: raw.number,
    title: raw.title,
    body: raw.body,
    state: raw.state,
    stateReason: raw.state_reason,
    authorId: raw.author_id,
    commentCount: raw.comment_count,
    headRepoId: raw.head_repo_id,
    headRef: raw.head_ref,
    headSha: raw.head_sha,
    baseRepoId: raw.base_repo_id,
    baseRef: raw.base_ref,
    baseSha: raw.base_sha,
    mergeBaseSha: raw.merge_base_sha,
    mergeable: raw.mergeable,
    draft: raw.draft,
    merged: raw.merged,
    mergedAt: raw.merged_at,
    mergedById: raw.merged_by_id,
    mergeCommitSha: raw.merge_commit_sha,
    mergeMethod: raw.merge_method,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    closedAt: raw.closed_at,
  };
}

export type { RawPrRow };

// ============================================================================
// Principal lite
// ============================================================================

export interface PrincipalLite {
  readonly id: string;
  readonly subject: string;
  readonly kind: string;
  readonly displayName: string | null;
  readonly email: string | null;
}

/** Resolve a set of principal ids into a lite projection map (skips nulls). */
export async function buildPrincipalLiteMap(
  db: DbClient,
  ids: ReadonlyArray<string | null>,
): Promise<Map<string, PrincipalLite>> {
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  const map = new Map<string, PrincipalLite>();
  if (unique.length === 0) return map;
  const placeholders = unique.map(() => "?").join(", ");
  const rows = await db.query<{
    id: string;
    subject: string;
    kind: string;
    display_name: string | null;
    email: string | null;
  }>(
    `SELECT id, subject, kind, display_name, email FROM principals WHERE id IN (${placeholders})`,
    unique,
  );
  for (const row of rows) {
    map.set(row.id, {
      id: row.id,
      subject: row.subject,
      kind: row.kind,
      displayName: row.display_name,
      email: row.email,
    });
  }
  return map;
}

export function principalLite(
  id: string | null,
  map: Map<string, PrincipalLite>,
): PrincipalLite | null {
  if (!id) return null;
  return map.get(id) ?? null;
}

// ============================================================================
// DTOs
// ============================================================================

export interface PullRequestDto {
  readonly number: number;
  readonly state: "open" | "closed";
  readonly title: string;
  readonly body: string | null;
  readonly draft: boolean;
  readonly merged: boolean;
  readonly mergeable: string;
  readonly author: PrincipalLite | null;
  readonly head: { readonly ref: string; readonly sha: string; readonly repo: string | null };
  readonly base: { readonly ref: string; readonly sha: string };
  readonly mergeBaseSha: string | null;
  readonly mergeCommitSha: string | null;
  readonly mergeMethod: string | null;
  readonly mergedAt: number | null;
  readonly mergedBy: PrincipalLite | null;
  readonly commitsCount: number;
  readonly aheadBy: number;
  readonly behindBy: number;
  readonly commentsCount: number;
  readonly reviewCommentsCount: number;
  readonly reviewsCount: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly closedAt: number | null;
}

export interface PullRequestMetrics {
  readonly author: PrincipalLite | null;
  readonly mergedBy: PrincipalLite | null;
  readonly commitsCount: number;
  readonly aheadBy: number;
  readonly behindBy: number;
  readonly mergeable: string;
  readonly mergeBaseSha: string | null;
  readonly headSha: string;
  readonly baseSha: string;
  readonly commentsCount: number;
  readonly reviewCommentsCount: number;
  readonly reviewsCount: number;
}

export function toPullRequestDto(
  row: PullRequestRow,
  metrics: PullRequestMetrics,
): PullRequestDto {
  return {
    number: row.number,
    state: row.state === "closed" ? "closed" : "open",
    title: row.title,
    body: row.body,
    draft: row.draft !== 0,
    merged: row.merged !== 0,
    mergeable: metrics.mergeable,
    author: metrics.author,
    head: { ref: row.headRef, sha: metrics.headSha, repo: row.headRepoId },
    base: { ref: row.baseRef, sha: metrics.baseSha },
    mergeBaseSha: metrics.mergeBaseSha,
    mergeCommitSha: row.mergeCommitSha,
    mergeMethod: row.mergeMethod,
    mergedAt: row.mergedAt,
    mergedBy: metrics.mergedBy,
    commitsCount: metrics.commitsCount,
    aheadBy: metrics.aheadBy,
    behindBy: metrics.behindBy,
    commentsCount: metrics.commentsCount,
    reviewCommentsCount: metrics.reviewCommentsCount,
    reviewsCount: metrics.reviewsCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    closedAt: row.closedAt,
  };
}

// --- reviews ---------------------------------------------------------------

export interface ReviewRow {
  id: string;
  pr_id: string;
  reviewer_id: string | null;
  state: string;
  body: string | null;
  commit_sha: string | null;
  submitted_at: number | null;
  created_at: number;
}

export interface ReviewDto {
  readonly id: string;
  readonly state: string;
  readonly body: string | null;
  readonly commitSha: string | null;
  readonly reviewer: PrincipalLite | null;
  readonly submittedAt: number | null;
  readonly createdAt: number;
}

export function toReviewDto(
  row: ReviewRow,
  map: Map<string, PrincipalLite>,
): ReviewDto {
  return {
    id: row.id,
    state: row.state,
    body: row.body,
    commitSha: row.commit_sha,
    reviewer: principalLite(row.reviewer_id, map),
    submittedAt: row.submitted_at,
    createdAt: row.created_at,
  };
}

// --- inline review comments ------------------------------------------------

export interface ReviewCommentRow {
  id: string;
  pr_id: string;
  review_id: string | null;
  in_reply_to_id: string | null;
  author_id: string | null;
  file_path: string;
  side: string;
  line: number | null;
  start_line: number | null;
  commit_sha: string;
  diff_hunk: string | null;
  body: string;
  outdated: number;
  created_at: number;
  updated_at: number;
}

export interface ReviewCommentDto {
  readonly id: string;
  readonly reviewId: string | null;
  readonly inReplyToId: string | null;
  readonly author: PrincipalLite | null;
  readonly path: string;
  readonly side: string;
  readonly line: number | null;
  readonly startLine: number | null;
  readonly commitSha: string;
  readonly diffHunk: string | null;
  readonly body: string;
  readonly outdated: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export function toReviewCommentDto(
  row: ReviewCommentRow,
  map: Map<string, PrincipalLite>,
): ReviewCommentDto {
  return {
    id: row.id,
    reviewId: row.review_id,
    inReplyToId: row.in_reply_to_id,
    author: principalLite(row.author_id, map),
    path: row.file_path,
    side: row.side,
    line: row.line,
    startLine: row.start_line,
    commitSha: row.commit_sha,
    diffHunk: row.diff_hunk,
    body: row.body,
    outdated: row.outdated !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
