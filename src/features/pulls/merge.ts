/**
 * PR merge — the ref-advancing write, concentrated here.
 *
 * Ported from the takos worker's `pull-requests/merge.ts`. The merge ALGORITHM
 * (fast-forward detection, `findMergeBase`, `mergeTrees3Way`, rebase replay,
 * squash/merge-commit construction) is pure object-store work and carries over
 * unchanged onto the R2-scoped store. The head I/O is reworked wholesale: base/
 * head tips come from the R2 refs doc, and the base-branch advance goes through
 * `writeRefsWithMetadata` — the per-repo refs-doc ETag CAS is the single atomic
 * commit point (two racing merges → one 409). The D1 `pull_requests`/`issues`
 * update is the retryable metadata follow-up. No `commits`/`branches` D1 rows are
 * written; commits land only in R2 via `putCommit`.
 */

import type { DbClient } from "../../db/index.ts";
import type { ObjectStoreBinding } from "../../git/types.ts";
import { repositoryObjectStore } from "../../git/repo-object-store.ts";
import { readRepoRefs } from "../../git/refs-store.ts";
import { writeRefsWithMetadata } from "../../git/two-phase.ts";
import { getCommitData, putCommit } from "../../git/object-store.ts";
import { findMergeBase, isAncestor } from "../../git/merge-base.ts";
import { mergeTrees3Way } from "../../git/merge.ts";
import type { GitCommit, GitSignature, MergeConflict } from "../../git/git-objects.ts";
import type { PullRequestRow } from "./dto.ts";

export type MergeMethod = "merge" | "squash" | "rebase";

const REBASE_MAX_COMMITS = 1000;

export interface MergeActor {
  readonly id: string;
  readonly displayName: string | null;
  readonly email: string | null;
  readonly subject: string;
}

export type MergeFailure = {
  readonly ok: false;
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
};

export type MergeSuccess = {
  readonly ok: true;
  readonly mergeCommitSha: string;
  readonly newBaseSha: string;
  readonly headSha: string;
  readonly previousBaseSha: string | null;
  readonly method: MergeMethod;
};

export type MergeResult = MergeSuccess | MergeFailure;

function fail(
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): MergeFailure {
  return { ok: false, status, code, message, ...(details ? { details } : {}) };
}

function signatureFor(actor: MergeActor): GitSignature {
  return {
    name: actor.displayName?.trim() || actor.subject || "Takos Git",
    email: actor.email?.trim() || `${actor.subject}@users.noreply.takos.git`,
    timestamp: Math.floor(Date.now() / 1000),
    tzOffset: "+0000",
  };
}

type TargetResult =
  | { ok: true; newBaseSha: string }
  | MergeFailure
  | { ok: false; conflict: true; conflicts: MergeConflict[]; mergeBase: string | null };

function conflictTarget(
  conflicts: MergeConflict[],
  mergeBase: string | null,
): { ok: false; conflict: true; conflicts: MergeConflict[]; mergeBase: string | null } {
  return { ok: false, conflict: true, conflicts, mergeBase };
}

async function createRebaseTarget(
  objects: ObjectStoreBinding,
  baseSha: string,
  headSha: string,
  actor: MergeActor,
): Promise<TargetResult> {
  const mergeBase = await findMergeBase(objects, baseSha, headSha);
  if (!mergeBase) return conflictTarget([], null);

  const toReplay: GitCommit[] = [];
  let cursor = headSha;
  while (cursor !== mergeBase) {
    const commit = await getCommitData(objects, cursor);
    if (!commit) return fail(500, "commit_unreadable", "Failed to load commits for rebase.");
    if (commit.parents.length !== 1) {
      return fail(501, "rebase_merge_commit", "Rebase merge does not support merge commits.");
    }
    toReplay.push(commit);
    cursor = commit.parents[0];
    if (toReplay.length > REBASE_MAX_COMMITS) {
      return fail(413, "rebase_too_large", "Rebase merge is too large.");
    }
  }
  toReplay.reverse();

  const baseCommit = await getCommitData(objects, baseSha);
  if (!baseCommit) return fail(500, "commit_unreadable", "Failed to load base commit for rebase.");

  let parentSha = baseSha;
  let parentTree = baseCommit.tree;
  for (const original of toReplay) {
    const originalParent = await getCommitData(objects, original.parents[0]);
    if (!originalParent) return fail(500, "commit_unreadable", "Failed to load commits for rebase.");
    const merged = await mergeTrees3Way(objects, originalParent.tree, parentTree, original.tree);
    if (!merged.treeSha || merged.conflicts.length > 0) {
      return conflictTarget(merged.conflicts, mergeBase);
    }
    const sha = await putCommit(objects, {
      tree: merged.treeSha,
      parents: [parentSha],
      message: original.message,
      author: original.author,
      committer: signatureFor(actor),
    });
    parentSha = sha;
    parentTree = merged.treeSha;
  }
  return { ok: true, newBaseSha: parentSha };
}

async function createMergeOrSquashTarget(
  objects: ObjectStoreBinding,
  pr: PullRequestRow,
  method: "merge" | "squash",
  commitMessage: string,
  baseSha: string,
  headSha: string,
  canFastForward: boolean,
  actor: MergeActor,
): Promise<TargetResult> {
  let treeSha: string;
  if (canFastForward) {
    const headCommit = await getCommitData(objects, headSha);
    if (!headCommit) return fail(500, "commit_unreadable", "Failed to load head commit for merge.");
    treeSha = headCommit.tree;
  } else {
    const mergeBase = await findMergeBase(objects, baseSha, headSha);
    if (!mergeBase) return conflictTarget([], null);
    const [baseCommit, localCommit, incomingCommit] = await Promise.all([
      getCommitData(objects, mergeBase),
      getCommitData(objects, baseSha),
      getCommitData(objects, headSha),
    ]);
    if (!baseCommit || !localCommit || !incomingCommit) {
      return fail(500, "commit_unreadable", "Failed to load commits for merge.");
    }
    const merged = await mergeTrees3Way(objects, baseCommit.tree, localCommit.tree, incomingCommit.tree);
    if (!merged.treeSha || merged.conflicts.length > 0) {
      return conflictTarget(merged.conflicts, mergeBase);
    }
    treeSha = merged.treeSha;
  }

  const signature = signatureFor(actor);
  const message =
    commitMessage ||
    (method === "squash"
      ? `Squash merge ${pr.headRef} into ${pr.baseRef}`
      : `Merge ${pr.headRef} into ${pr.baseRef}`);
  const sha = await putCommit(objects, {
    tree: treeSha,
    parents: method === "squash" ? [baseSha] : [baseSha, headSha],
    message,
    author: signature,
    committer: signature,
  });
  return { ok: true, newBaseSha: sha };
}

export interface PerformMergeParams {
  readonly db: DbClient;
  readonly bucket: ObjectStoreBinding;
  readonly repoKey: string;
  readonly pr: PullRequestRow;
  readonly method: MergeMethod;
  readonly commitMessage: string;
  readonly actor: MergeActor;
}

/**
 * Compute the merge target off R2, then advance the base ref via the refs-doc
 * ETag CAS and mark the PR merged. Idempotent D1 projection; R2 is the commit
 * point.
 */
export async function performMerge(params: PerformMergeParams): Promise<MergeResult> {
  const { db, bucket, repoKey, pr, method, commitMessage, actor } = params;
  const objects = repositoryObjectStore(bucket, repoKey);
  const refs = await readRepoRefs(bucket, repoKey);
  const baseRecord = refs.refs.find((r) => r.name === `refs/heads/${pr.baseRef}`);
  const headRecord = refs.refs.find((r) => r.name === `refs/heads/${pr.headRef}`);
  if (!baseRecord || !headRecord) return fail(404, "branch_not_found", "Head or base branch no longer exists.");
  const baseSha = baseRecord.sha;
  const headSha = headRecord.sha;

  // Already merged: head is an ancestor of base — no ref change, mark merged.
  if (await isAncestor(objects, headSha, baseSha)) {
    await markMerged(db, pr, baseSha, method, actor.id, baseSha, headSha);
    return {
      ok: true,
      mergeCommitSha: baseSha,
      newBaseSha: baseSha,
      headSha,
      previousBaseSha: null,
      method,
    };
  }

  const canFastForward = await isAncestor(objects, baseSha, headSha);

  let target: TargetResult;
  if (canFastForward && method !== "squash") {
    target = { ok: true, newBaseSha: headSha };
  } else if (method === "rebase") {
    target = await createRebaseTarget(objects, baseSha, headSha, actor);
  } else {
    target = await createMergeOrSquashTarget(
      objects,
      pr,
      method === "squash" ? "squash" : "merge",
      commitMessage,
      baseSha,
      headSha,
      canFastForward,
      actor,
    );
  }

  if ("conflict" in target) {
    return fail(409, "merge_conflict", "Automatic merge failed; conflicts must be resolved.", {
      conflicts: target.conflicts,
      mergeBase: target.mergeBase,
    });
  }
  if (!target.ok) return target;

  const newBaseSha = target.newBaseSha;
  const baseRefName = `refs/heads/${pr.baseRef}`;

  const cas = await writeRefsWithMetadata(bucket, {
    repo: repoKey,
    mutateRefs: (current) => {
      const record = current.refs.find((r) => r.name === baseRefName);
      // Base moved since we resolved it — abort so the caller reports a conflict
      // instead of clobbering a concurrent advance. (The ETag CAS is the backstop.)
      if (!record || record.sha !== baseSha) return null;
      return {
        ...current,
        refs: current.refs.map((r) =>
          r.name === baseRefName ? { name: r.name, sha: newBaseSha } : r,
        ),
      };
    },
    projectMetadata: async () => {
      await markMerged(db, pr, newBaseSha, method, actor.id, newBaseSha, headSha);
    },
  });

  switch (cas.status) {
    case "committed":
      return {
        ok: true,
        mergeCommitSha: newBaseSha,
        newBaseSha,
        headSha,
        previousBaseSha: baseSha,
        method,
      };
    case "conflict": {
      const current = cas.current.refs.find((r) => r.name === baseRefName);
      return fail(409, "ref_conflict", "The base branch was modified by another process.", {
        current: current?.sha ?? null,
      });
    }
    case "aborted":
      return fail(409, "ref_conflict", "The base branch was modified by another process.");
    case "absent":
      return fail(500, "repo_missing", "Repository refs document is missing.");
  }
}

/** Mark a PR merged + close its issue. Idempotent (safe to retry after R2 commit). */
export async function markMerged(
  db: DbClient,
  pr: PullRequestRow,
  mergeCommitSha: string,
  method: MergeMethod,
  mergedById: string,
  newBaseSha: string,
  headSha: string,
): Promise<void> {
  const now = db.now();
  await db.run(
    `UPDATE pull_requests
        SET merged = 1, merged_at = ?, merged_by_id = ?, merge_commit_sha = ?,
            merge_method = ?, base_sha = ?, head_sha = ?, mergeable = 'clean', updated_at = ?
      WHERE id = ?`,
    [now, mergedById, mergeCommitSha, method, newBaseSha, headSha, now, pr.id],
  );
  await db.run(
    `UPDATE issues SET state = 'closed', state_reason = 'completed', closed_at = ?, updated_at = ?
      WHERE id = ?`,
    [now, now, pr.issueId],
  );
}
