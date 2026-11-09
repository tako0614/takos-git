/** A merge's receipt and ref advance share one R2 CAS. Recovery projects that
 * exact receipt; it never repeats a merge algorithm or writes Git objects. */
import type { DbClient } from "../../db/index.ts";
import type { ObjectStoreBinding } from "../../git/types.ts";
import { readRepoRefs, readRepoRefsSnapshot, writeRepoRefsSnapshot, type PendingMerge, type RefsDoc } from "../../git/refs-store.ts";
import { writeRefsWithMetadata } from "../../git/two-phase.ts";
import type { PullRequestRow } from "./dto.ts";
import type { MergeResult, MergeSuccess } from "./merge.ts";

export function pendingMerge(refs: RefsDoc, pr: PullRequestRow): PendingMerge | undefined {
  const receipt = refs.pendingMerges?.[pr.id];
  if (!receipt) return undefined;
  if (receipt.repoId !== pr.repoId || receipt.issueId !== pr.issueId || receipt.headRef !== pr.headRef) {
    throw new Error("pending merge does not match pull request");
  }
  return receipt;
}

export function projectionComplete(pr: PullRequestRow, receipt: PendingMerge): boolean {
  return pr.merged !== 0 && pr.state === "closed" && pr.mergeCommitSha === receipt.commitSha;
}

export function pendingResult(receipt: PendingMerge, complete = false): MergeSuccess {
  return {
    ok: true, mergeCommitSha: receipt.commitSha, newBaseSha: receipt.commitSha,
    headSha: receipt.headSha, previousBaseSha: null, method: receipt.method,
    ...(!complete ? { metadataDeferred: true as const } : {}), metadataOnly: true,
  };
}

async function project(db: DbClient, pr: PullRequestRow, r: PendingMerge): Promise<void> {
  // D1 batch is transactional. Preserve the actual action's time/actor/commit,
  // including when the original actor was subsequently removed (nullable FK).
  await db.batch([
    { sql: `UPDATE pull_requests
        SET merged = 1, merged_at = ?, merged_by_id = (SELECT id FROM principals WHERE id = ?), merge_commit_sha = ?,
            merge_method = ?, base_ref = ?, base_sha = ?, head_sha = ?, mergeable = 'clean', updated_at = MAX(updated_at, ?)
      WHERE id = ?`,
      params: [r.at, r.actorId, r.commitSha, r.method, r.baseRef, r.commitSha, r.headSha, r.at, pr.id] },
    { sql: `UPDATE issues SET state = 'closed', state_reason = 'completed', closed_at = ?, updated_at = MAX(updated_at, ?) WHERE id = ?`,
      params: [r.at, r.at, pr.issueId] },
  ]);
}

async function clearReceipt(bucket: ObjectStoreBinding, repo: string, pr: PullRequestRow, receipt: PendingMerge): Promise<void> {
  try {
    const snapshot = await readRepoRefsSnapshot(bucket, repo);
    if (!snapshot || JSON.stringify(snapshot.doc.pendingMerges?.[pr.id]) !== JSON.stringify(receipt)) return;
    const pendingMerges = { ...snapshot.doc.pendingMerges };
    delete pendingMerges[pr.id];
    // One CAS only: a concurrent push must win over this bookkeeping cleanup.
    const written = await writeRepoRefsSnapshot(bucket, repo, { ...snapshot.doc, pendingMerges }, snapshot.etag);
    if (!written) console.warn("PR merge receipt cleanup deferred: concurrent refs update");
  } catch {
    // D1 is already acknowledged. Retaining the receipt is safe and a later
    // explicit reconcile retries cleanup; never turn this into a failed merge.
    console.warn("PR merge receipt cleanup deferred: storage unavailable");
  }
}

export async function reconcileMerge(db: DbClient, bucket: ObjectStoreBinding, repo: string, pr: PullRequestRow): Promise<MergeResult> {
  const receipt = pendingMerge(await readRepoRefs(bucket, repo), pr);
  if (!receipt) {
    if (pr.merged && pr.state === "closed" && pr.mergeCommitSha) {
      return { ok: true, mergeCommitSha: pr.mergeCommitSha, newBaseSha: pr.mergeCommitSha,
        headSha: pr.headSha, previousBaseSha: null, method: pr.mergeMethod as PendingMerge["method"], metadataOnly: true };
    }
    return { ok: false, status: 409, code: "no_pending_merge", message: "No committed merge is awaiting a status update." };
  }
  if (pr.merged && pr.mergeCommitSha !== receipt.commitSha) {
    return { ok: false, status: 409, code: "merge_receipt_conflict", message: "Merge status differs from the retained commit receipt." };
  }
  if (!projectionComplete(pr, receipt)) {
    try { await project(db, pr, receipt); }
    catch { return pendingResult(receipt); }
  }
  await clearReceipt(bucket, repo, pr, receipt);
  return pendingResult(receipt, true);
}

export async function commitMerge(input: {
  db: DbClient; bucket: ObjectStoreBinding; repo: string; pr: PullRequestRow; receipt: PendingMerge;
}): Promise<MergeResult> {
  const { db, bucket, repo, pr, receipt } = input;
  const cas = await writeRefsWithMetadata(bucket, {
    repo,
    mutateRefs(current) {
      if (current.pendingMerges?.[pr.id] || Object.keys(current.pendingMerges ?? {}).length >= 128) return null;
      if (current.refs.find(r => r.name === `refs/heads/${receipt.baseRef}`)?.sha !== receipt.baseSha) return null;
      if (current.refs.find(r => r.name === `refs/heads/${receipt.headRef}`)?.sha !== receipt.headSha) return null;
      return { ...current,
        refs: current.refs.map(r => r.name === `refs/heads/${receipt.baseRef}` ? { ...r, sha: receipt.commitSha } : r),
        pendingMerges: { ...current.pendingMerges, [pr.id]: receipt },
      };
    },
    projectMetadata: () => project(db, pr, receipt),
  });
  if (cas.status !== "committed") {
    return { ok: false, status: cas.status === "absent" ? 500 : 409,
      code: cas.status === "absent" ? "repo_missing" : "ref_conflict",
      message: "Refs changed or another committed merge requires a status update. Reload before continuing." };
  }
  const deferred = "metadataDeferred" in cas;
  if (!deferred) await clearReceipt(bucket, repo, pr, receipt);
  return { ok: true, mergeCommitSha: receipt.commitSha, newBaseSha: receipt.commitSha, headSha: receipt.headSha,
    previousBaseSha: receipt.advanced ? receipt.baseSha : null, method: receipt.method,
    ...(deferred ? { metadataDeferred: true as const } : {}),
  };
}
