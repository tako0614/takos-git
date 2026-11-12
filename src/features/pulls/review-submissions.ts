import type { DbClient } from "../../db/index.ts";
import { submissionHash } from "../../db/submission-hash.ts";
import { buildPrincipalLiteMap, toReviewDto, type PullRequestRow, type ReviewDto } from "./dto.ts";

export interface ReviewSubmissionInput { readonly state: string; readonly body: string | null; readonly commitSha?: string }
export type ReviewSubmissionResult =
  | { readonly outcome: "created" | "replayed"; readonly review: ReviewDto }
  | { readonly outcome: "conflict" }
  | { readonly outcome: "deleted" };
const intent = (input: ReviewSubmissionInput) => JSON.stringify([input.state, input.body]);

/** Replay original content and head, never a later review mutation or new head. */
export async function getReviewSubmission(db: DbClient, pr: PullRequestRow, principalId: string, key: string, input: ReviewSubmissionInput): Promise<ReviewSubmissionResult | null> {
  const receipt = await db.queryOne<{ request_hash: string; pr_id: string; review_id: string; commit_sha: string | null; created_at: number }>(
    `SELECT request_hash,pr_id,review_id,commit_sha,created_at FROM pull_review_submissions
      WHERE issue_id=? AND principal_id=? AND key_hash=?`, [pr.issueId, principalId, await submissionHash(key)],
  );
  if (!receipt) return null;
  if (receipt.request_hash !== await submissionHash(intent(input))) return { outcome: "conflict" };
  if (input.commitSha !== undefined && receipt.commit_sha !== input.commitSha) return { outcome: "conflict" };
  if (receipt.pr_id !== pr.id || !await db.queryOne("SELECT id FROM pr_reviews WHERE id=? AND pr_id=?", [receipt.review_id, pr.id])) return { outcome: "deleted" };
  const people = await buildPrincipalLiteMap(db, [principalId]);
  return { outcome: "replayed", review: toReviewDto({
    id: receipt.review_id, pr_id: pr.id, reviewer_id: principalId,
    state: input.state, body: input.body, commit_sha: receipt.commit_sha,
    submitted_at: receipt.created_at, created_at: receipt.created_at,
  }, people) };
}

/** The review and its immutable receipt share the existing atomic D1 batch. */
export async function createReviewSubmission(db: DbClient, pr: PullRequestRow, principalId: string, key: string, input: ReviewSubmissionInput, commitSha: string | null): Promise<ReviewSubmissionResult> {
  const id = db.id(), now = db.now(), keyHash = await submissionHash(key);
  const scope = [pr.issueId, principalId, keyHash];
  const results = await db.batch([
    { sql: `INSERT INTO pr_reviews (id,pr_id,reviewer_id,state,body,commit_sha,submitted_at,created_at)
        SELECT ?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM pull_review_submissions WHERE issue_id=? AND principal_id=? AND key_hash=?)`,
      params: [id, pr.id, principalId, input.state, input.body, commitSha, now, now, ...scope] },
    { sql: `INSERT INTO pull_review_submissions (issue_id,principal_id,key_hash,request_hash,pr_id,review_id,commit_sha,created_at)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(issue_id,principal_id,key_hash) DO NOTHING`,
      params: [...scope, await submissionHash(intent(input)), pr.id, id, commitSha, now] },
  ]);
  const result = await getReviewSubmission(db, pr, principalId, key, input);
  if (!result) throw new Error("Missing committed review submission receipt");
  return result.outcome === "replayed" && results[0]?.meta.changes === 1 ? { ...result, outcome: "created" } : result;
}
