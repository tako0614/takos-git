import type { DbClient } from "../../db/index.ts";
import { submissionHash } from "../../db/submission-hash.ts";
import type { ObjectStoreBinding } from "../../git/types.ts";
import { repositoryObjectStore } from "../../git/repo-object-store.ts";
import { countCommitsBetween } from "../../git/merge-base.ts";
import { buildPrincipalLiteMap, principalLite, type PullRequestDto } from "./dto.ts";
import { findPullRequestById, shapePullRequest } from "./read-model.ts";

export interface PullSubmissionInput {
  readonly title: string;
  readonly body: string | null;
  readonly head: string;
  /** null preserves omission, so a later default-branch change cannot change intent. */
  readonly base: string | null;
  readonly draft: boolean;
}
interface ResolvedBranches { readonly headRef: string; readonly headSha: string; readonly baseRef: string; readonly baseSha: string }
type CreationMetadata = Omit<PullRequestDto, "number" | "title" | "body" | "createdAt" | "updatedAt">;
export type PullSubmissionResult =
  | { readonly outcome: "created" | "replayed"; readonly pull: PullRequestDto }
  | { readonly outcome: "conflict" }
  | { readonly outcome: "deleted" };

function intent(input: PullSubmissionInput): string {
  return JSON.stringify({ title: input.title, body: input.body, head: input.head, base: input.base, draft: input.draft });
}

/** Recover before checking branch references that may have moved or disappeared. */
export async function getPullRequestSubmission(db: DbClient, repoId: string, authorId: string, key: string, input: PullSubmissionInput): Promise<PullSubmissionResult | null> {
  const keyHash = await submissionHash(key), requestHash = await submissionHash(intent(input));
  const receipt = await db.queryOne<{ request_hash: string; pr_id: string; issue_id: string; pr_number: number; created_at: number; creation_metadata: string }>(
    `SELECT request_hash,pr_id,issue_id,pr_number,created_at,creation_metadata FROM pull_request_submissions
      WHERE repo_id=? AND principal_id=? AND key_hash=?`, [repoId, authorId, keyHash],
  );
  if (!receipt) return null;
  if (receipt.request_hash !== requestHash) return { outcome: "conflict" };
  const current = await findPullRequestById(db, receipt.pr_id);
  if (!current || current.repoId !== repoId || current.issueId !== receipt.issue_id || current.number !== receipt.pr_number) return { outcome: "deleted" };
  const metadata: CreationMetadata = JSON.parse(receipt.creation_metadata);
  return { outcome: "replayed", pull: { ...metadata, number: receipt.pr_number, title: input.title, body: input.body, createdAt: receipt.created_at, updatedAt: receipt.created_at } };
}

async function creationMetadata(db: DbClient, bucket: ObjectStoreBinding, repo: string, repoId: string, authorId: string, input: PullSubmissionInput, branches: ResolvedBranches): Promise<CreationMetadata> {
  const people = await buildPrincipalLiteMap(db, [authorId]);
  let ahead = 0, behind = 0, mergeBaseSha: string | null = null;
  try {
    const counts = await countCommitsBetween(repositoryObjectStore(bucket, repo), branches.baseSha, branches.headSha);
    ahead = counts.ahead; behind = counts.behind; mergeBaseSha = counts.mergeBaseSha;
  } catch { /* Same unknown-graph projection as the existing cheap PR read. */ }
  return {
    state: "open", draft: input.draft, merged: false,
    author: principalLite(authorId, people), head: { ref: branches.headRef, sha: branches.headSha, repo: repoId },
    base: { ref: branches.baseRef, sha: branches.baseSha },
    mergeable: mergeBaseSha && ahead === 0 ? "clean" : "unknown", mergeBaseSha,
    mergeCommitSha: null, mergeMethod: null, mergedAt: null, mergedBy: null,
    commitsCount: ahead, aheadBy: ahead, behindBy: behind,
    commentsCount: 0, reviewCommentsCount: 0, reviewsCount: 0, closedAt: null,
  };
}

/** The shared number, Issue, PR and optional receipt commit in one D1 batch. */
export async function createPullRequestSubmission(db: DbClient, bucket: ObjectStoreBinding, repo: string, repoId: string, authorId: string, key: string | null, input: PullSubmissionInput, branches: ResolvedBranches): Promise<PullSubmissionResult> {
  const issueId = db.id(), prId = db.id(), now = db.now();
  const keyHash = key === null ? null : await submissionHash(key);
  const scope = keyHash === null ? [] : [repoId, authorId, keyHash];
  const absent = keyHash === null ? "1" : "NOT EXISTS (SELECT 1 FROM pull_request_submissions WHERE repo_id=? AND principal_id=? AND key_hash=?)";
  const metadata = key === null ? null : JSON.stringify(await creationMetadata(db, bucket, repo, repoId, authorId, input, branches));
  const results = await db.batch([
    { sql: `INSERT INTO repo_counters (repo_id,scope,next_value) SELECT ?,'issue',2 WHERE ${absent}
        ON CONFLICT(repo_id,scope) DO UPDATE SET next_value=next_value+1`, params: [repoId, ...scope] },
    { sql: `INSERT INTO issues (id,repo_id,number,title,body,state,author_id,is_pull_request,comment_count,created_at,updated_at)
        SELECT ?,?,(SELECT next_value-1 FROM repo_counters WHERE repo_id=? AND scope='issue'),?,?,'open',?,1,0,?,? WHERE ${absent}`,
      params: [issueId, repoId, repoId, input.title, input.body, authorId, now, now, ...scope] },
    { sql: `INSERT INTO pull_requests (id,issue_id,repo_id,head_repo_id,head_ref,head_sha,base_repo_id,base_ref,base_sha,merge_base_sha,mergeable,draft,merged,created_at,updated_at)
        SELECT ?,?,?,?,?,?,?,?,?,NULL,'unknown',?,0,?,? WHERE ${absent}`,
      params: [prId, issueId, repoId, repoId, branches.headRef, branches.headSha, repoId, branches.baseRef, branches.baseSha, input.draft ? 1 : 0, now, now, ...scope] },
    ...(keyHash === null ? [] : [{
      sql: `INSERT INTO pull_request_submissions (repo_id,principal_id,key_hash,request_hash,pr_id,issue_id,pr_number,created_at,creation_metadata)
        SELECT ?,?,?,?,?,?,number,?,? FROM issues WHERE id=? AND repo_id=?
        ON CONFLICT(repo_id,principal_id,key_hash) DO NOTHING`,
      params: [repoId, authorId, keyHash, await submissionHash(intent(input)), prId, issueId, now, metadata, issueId, repoId],
    }]),
  ]);
  if (key !== null) {
    const result = await getPullRequestSubmission(db, repoId, authorId, key, input);
    if (!result) throw new Error("Missing committed PR submission receipt");
    return result.outcome === "replayed" && results[1]?.meta.changes === 1 ? { ...result, outcome: "created" } : result;
  }
  const row = await findPullRequestById(db, prId);
  if (!row) throw new Error("Missing committed pull request");
  return { outcome: "created", pull: await shapePullRequest(db, bucket, repo, row, false) };
}
