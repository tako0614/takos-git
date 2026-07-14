/**
 * Conflict inspection + user-resolved merge.
 *
 * Ported from the takos worker's `services/pull-requests/merge-resolution.ts`.
 * `checkConflicts` reports the base/ours/theirs blob text for each conflicting
 * path; `resolveConflictsAndMerge` applies user-supplied blob resolutions, builds
 * the merged tree, writes a merge commit to R2, and advances the base ref through
 * the same refs-doc ETag CAS the auto-merge path uses. All head I/O is R2; no
 * `branches`/`commits` D1 rows exist.
 */

import type { DbClient } from "../../db/index.ts";
import type { ObjectStoreBinding } from "../../git/types.ts";
import { repositoryObjectStore } from "../../git/repo-object-store.ts";
import { readRepoRefs } from "../../git/refs-store.ts";
import { writeRefsWithMetadata } from "../../git/two-phase.ts";
import { getCommitData, putBlob, putCommit } from "../../git/object-store.ts";
import { buildTreeFromPaths, flattenTree, getBlobAtPath, isValidGitPath } from "../../git/tree-ops.ts";
import { findMergeBase } from "../../git/merge-base.ts";
import { mergeTrees3Way } from "../../git/merge.ts";
import { decodeBlobContent } from "../../git/text-diff.ts";
import type { GitSignature } from "../../git/git-objects.ts";
import type { PullRequestRow } from "./dto.ts";
import { markMerged, type MergeActor, type MergeFailure, type MergeResult } from "./merge.ts";

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

// ============================================================================
// Conflict inspection
// ============================================================================

export interface DetailedConflict {
  readonly path: string;
  readonly type: string;
  readonly base: string | null;
  readonly ours: string | null;
  readonly theirs: string | null;
}

export type ConflictCheck =
  | {
      readonly ok: true;
      readonly mergeable: boolean;
      readonly mergeBase: string | null;
      readonly conflicts: DetailedConflict[];
      readonly message?: string;
    }
  | MergeFailure;

function decode(blob: Uint8Array | null): string | null {
  if (!blob) return null;
  const { text, isBinary } = decodeBlobContent(blob);
  return isBinary ? null : text;
}

export async function checkConflicts(
  bucket: ObjectStoreBinding,
  repoKey: string,
  pr: PullRequestRow,
): Promise<ConflictCheck> {
  const refs = await readRepoRefs(bucket, repoKey);
  const base = refs.refs.find((r) => r.name === `refs/heads/${pr.baseRef}`);
  const head = refs.refs.find((r) => r.name === `refs/heads/${pr.headRef}`);
  if (!base || !head) return fail(404, "branch_not_found", "Head or base branch no longer exists.");

  const objects = repositoryObjectStore(bucket, repoKey);
  const mergeBase = await findMergeBase(objects, base.sha, head.sha);
  if (!mergeBase) {
    return { ok: true, mergeable: false, mergeBase: null, conflicts: [], message: "No common ancestor." };
  }

  const [baseCommit, localCommit, incomingCommit] = await Promise.all([
    getCommitData(objects, mergeBase),
    getCommitData(objects, base.sha),
    getCommitData(objects, head.sha),
  ]);
  if (!baseCommit || !localCommit || !incomingCommit) {
    return fail(500, "commit_unreadable", "Failed to load commits.");
  }

  const merged = await mergeTrees3Way(objects, baseCommit.tree, localCommit.tree, incomingCommit.tree);
  if (merged.conflicts.length === 0) {
    return { ok: true, mergeable: true, mergeBase, conflicts: [] };
  }

  const conflicts = await Promise.all(
    merged.conflicts.map(async (conflict) => {
      const [b, o, t] = await Promise.all([
        getBlobAtPath(objects, baseCommit.tree, conflict.path).catch(() => null),
        getBlobAtPath(objects, localCommit.tree, conflict.path).catch(() => null),
        getBlobAtPath(objects, incomingCommit.tree, conflict.path).catch(() => null),
      ]);
      return {
        path: conflict.path,
        type: conflict.type,
        base: decode(b),
        ours: decode(o),
        theirs: decode(t),
      };
    }),
  );
  return { ok: true, mergeable: false, mergeBase, conflicts };
}

// ============================================================================
// Resolve + merge
// ============================================================================

export interface Resolution {
  readonly path: string;
  readonly content: string;
  readonly delete: boolean;
}

/** Validate/normalize the resolutions body; returns null on the first bad entry. */
export function normalizeResolutions(
  input: unknown,
): { ok: true; resolutions: Resolution[] } | { ok: false; message: string } {
  if (!Array.isArray(input)) return { ok: false, message: "resolutions array is required." };
  const out: Resolution[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (!raw || typeof raw !== "object") return { ok: false, message: "Invalid resolution entry." };
    const entry = raw as { path?: unknown; content?: unknown; delete?: unknown };
    if (typeof entry.path !== "string" || !isValidGitPath(entry.path.trim())) {
      return { ok: false, message: "Invalid resolution path." };
    }
    const path = entry.path.trim();
    if (seen.has(path)) return { ok: false, message: `Duplicate resolution path: ${path}` };
    seen.add(path);
    const isDelete = entry.delete === true;
    if (!isDelete && typeof entry.content !== "string") {
      return { ok: false, message: `Resolution content must be a string for path: ${path}` };
    }
    out.push({ path, content: isDelete ? "" : (entry.content as string), delete: isDelete });
  }
  return { ok: true, resolutions: out };
}

type FileEntry = { path: string; sha: string; mode: string };

function buildMergedFileMap(
  baseFiles: FileEntry[],
  localFiles: FileEntry[],
  incomingFiles: FileEntry[],
  conflictPaths: Set<string>,
): Map<string, { sha: string; mode: string }> {
  const baseMap = new Map(baseFiles.map((f) => [f.path, f]));
  const localMap = new Map(localFiles.map((f) => [f.path, f]));
  const incomingMap = new Map(incomingFiles.map((f) => [f.path, f]));
  const allPaths = new Set([...baseMap.keys(), ...localMap.keys(), ...incomingMap.keys()]);
  const merged = new Map<string, { sha: string; mode: string }>();

  for (const path of allPaths) {
    if (conflictPaths.has(path)) continue;
    const baseEntry = baseMap.get(path);
    const localEntry = localMap.get(path);
    const incomingEntry = incomingMap.get(path);
    const localChanged =
      !baseEntry || !localEntry || baseEntry.sha !== localEntry.sha || baseEntry.mode !== localEntry.mode;
    const incomingChanged =
      !baseEntry || !incomingEntry || baseEntry.sha !== incomingEntry.sha || baseEntry.mode !== incomingEntry.mode;

    if (!localChanged && !incomingChanged) {
      if (baseEntry) merged.set(path, { sha: baseEntry.sha, mode: baseEntry.mode });
    } else if (localChanged && !incomingChanged) {
      if (localEntry) merged.set(path, { sha: localEntry.sha, mode: localEntry.mode });
    } else if (!localChanged && incomingChanged) {
      if (incomingEntry) merged.set(path, { sha: incomingEntry.sha, mode: incomingEntry.mode });
    } else if (localEntry && incomingEntry && localEntry.sha === incomingEntry.sha) {
      merged.set(path, { sha: localEntry.sha, mode: localEntry.mode });
    }
  }
  return merged;
}

export interface ResolveParams {
  readonly db: DbClient;
  readonly bucket: ObjectStoreBinding;
  readonly repoKey: string;
  readonly pr: PullRequestRow;
  readonly resolutions: Resolution[];
  readonly commitMessage: string;
  readonly actor: MergeActor;
}

export async function resolveConflictsAndMerge(params: ResolveParams): Promise<MergeResult> {
  const { db, bucket, repoKey, pr, resolutions, commitMessage, actor } = params;
  const objects = repositoryObjectStore(bucket, repoKey);
  const refs = await readRepoRefs(bucket, repoKey);
  const baseRecord = refs.refs.find((r) => r.name === `refs/heads/${pr.baseRef}`);
  const headRecord = refs.refs.find((r) => r.name === `refs/heads/${pr.headRef}`);
  if (!baseRecord || !headRecord) return fail(404, "branch_not_found", "Head or base branch no longer exists.");
  const baseSha = baseRecord.sha;
  const headSha = headRecord.sha;

  const mergeBase = await findMergeBase(objects, baseSha, headSha);
  if (!mergeBase) return fail(409, "no_merge_base", "No common ancestor found.");

  const [baseCommit, localCommit, incomingCommit] = await Promise.all([
    getCommitData(objects, mergeBase),
    getCommitData(objects, baseSha),
    getCommitData(objects, headSha),
  ]);
  if (!baseCommit || !localCommit || !incomingCommit) {
    return fail(500, "commit_unreadable", "Failed to load commits.");
  }

  // Materialize user resolutions as blobs.
  const changes: Array<{ path: string; sha: string | null; mode: string }> = [];
  for (const resolution of resolutions) {
    if (resolution.delete) {
      changes.push({ path: resolution.path, sha: null, mode: "100644" });
    } else {
      const sha = await putBlob(objects, new TextEncoder().encode(resolution.content));
      changes.push({ path: resolution.path, sha, mode: "100644" });
    }
  }

  const merged = await mergeTrees3Way(objects, baseCommit.tree, localCommit.tree, incomingCommit.tree);
  const [baseFiles, localFiles, incomingFiles] = await Promise.all([
    flattenTree(objects, baseCommit.tree),
    flattenTree(objects, localCommit.tree),
    flattenTree(objects, incomingCommit.tree),
  ]);
  const conflictPaths = new Set(merged.conflicts.map((c) => c.path));
  const mergedFiles = buildMergedFileMap(baseFiles, localFiles, incomingFiles, conflictPaths);

  for (const change of changes) {
    if (change.sha === null) mergedFiles.delete(change.path);
    else mergedFiles.set(change.path, { sha: change.sha, mode: change.mode });
  }

  const resolvedPaths = new Set(resolutions.map((r) => r.path));
  for (const conflict of merged.conflicts) {
    if (!resolvedPaths.has(conflict.path) && !mergedFiles.has(conflict.path)) {
      return fail(400, "conflict_unresolved", `Conflict not resolved for path: ${conflict.path}`, {
        path: conflict.path,
      });
    }
  }

  const fileList = [...mergedFiles.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, entry]) => ({ path, sha: entry.sha, mode: entry.mode }));
  const treeSha = await buildTreeFromPaths(objects, fileList);

  const signature = signatureFor(actor);
  const message = commitMessage || `Merge branch '${pr.headRef}' into ${pr.baseRef} (conflicts resolved)`;
  const mergeCommitSha = await putCommit(objects, {
    tree: treeSha,
    parents: [baseSha, headSha],
    message,
    author: signature,
    committer: signature,
  });

  const baseRefName = `refs/heads/${pr.baseRef}`;
  const cas = await writeRefsWithMetadata(bucket, {
    repo: repoKey,
    mutateRefs: (current) => {
      const record = current.refs.find((r) => r.name === baseRefName);
      if (!record || record.sha !== baseSha) return null;
      return {
        ...current,
        refs: current.refs.map((r) =>
          r.name === baseRefName ? { name: r.name, sha: mergeCommitSha } : r,
        ),
      };
    },
    projectMetadata: async () => {
      await markMerged(db, pr, mergeCommitSha, "merge", actor.id, mergeCommitSha, headSha);
    },
  });

  switch (cas.status) {
    case "committed":
      return {
        ok: true,
        mergeCommitSha,
        newBaseSha: mergeCommitSha,
        headSha,
        previousBaseSha: baseSha,
        method: "merge",
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
