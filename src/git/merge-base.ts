/**
 * Commit-graph ancestry over the R2 loose-object store.
 *
 * Ported from the takos worker's `commit-index.ts`
 * (`findMergeBase`/`isAncestor`/`countCommitsBetween`/`countCommitsTo`), but
 * rewritten R2-only: the `dbBinding`+`repoId` params and the `getCommit` D1
 * indirection are dropped — commits are read straight from the repo-scoped
 * object store via `getCommitData`, exactly as `reachability.ts` already does.
 *
 * The object store handed in is expected to be the per-repo scoped store
 * (`repositoryObjectStore(bucket, repo)`), so a bare SHA can only ever resolve
 * inside its own repository prefix — that prefix-scoping is the isolation
 * invariant that replaces the old D1 cross-tenant index check.
 */

import type { ObjectStoreBinding } from "./types.ts";
import { getCommitData } from "./object-store.ts";

/** Hard ceiling on commits visited by a single walk, guarding runaway graphs. */
const DEFAULT_MAX_WALK = 100_000;

export interface WalkLimits {
  readonly maxWalk?: number;
}

/**
 * True when `ancestorSha` is reachable from `descendantSha` by walking parent
 * edges (a commit is its own ancestor). Bounded by `maxWalk`.
 */
export async function isAncestor(
  store: ObjectStoreBinding,
  ancestorSha: string,
  descendantSha: string,
  limits: WalkLimits = {},
): Promise<boolean> {
  if (ancestorSha === descendantSha) return true;
  const maxWalk = limits.maxWalk ?? DEFAULT_MAX_WALK;

  const visited = new Set<string>();
  const queue: string[] = [descendantSha];
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    if (visited.has(sha)) continue;
    visited.add(sha);
    if (visited.size > maxWalk) throw new Error("commit graph too large");
    if (sha === ancestorSha) return true;
    const commit = await getCommitData(store, sha);
    if (!commit) continue;
    for (const parent of commit.parents) {
      if (!visited.has(parent)) queue.push(parent);
    }
  }
  return false;
}

/**
 * The first common ancestor of `shaA` and `shaB` found by breadth-first walk
 * (best-effort lowest common ancestor). Returns null when the histories are
 * disjoint or either tip is unreadable.
 */
export async function findMergeBase(
  store: ObjectStoreBinding,
  shaA: string,
  shaB: string,
  limits: WalkLimits = {},
): Promise<string | null> {
  const maxWalk = limits.maxWalk ?? DEFAULT_MAX_WALK;

  const ancestorsA = new Set<string>();
  const queueA: string[] = [shaA];
  while (queueA.length > 0) {
    const sha = queueA.shift() as string;
    if (ancestorsA.has(sha)) continue;
    ancestorsA.add(sha);
    if (ancestorsA.size > maxWalk) throw new Error("commit graph too large");
    const commit = await getCommitData(store, sha);
    if (commit) for (const parent of commit.parents) queueA.push(parent);
  }

  const visitedB = new Set<string>();
  const queueB: string[] = [shaB];
  while (queueB.length > 0) {
    const sha = queueB.shift() as string;
    if (visitedB.has(sha)) continue;
    visitedB.add(sha);
    if (visitedB.size > maxWalk) throw new Error("commit graph too large");
    if (ancestorsA.has(sha)) return sha;
    const commit = await getCommitData(store, sha);
    if (commit) for (const parent of commit.parents) queueB.push(parent);
  }

  return null;
}

/** Number of commits reachable from `fromSha` but not from/through `stopAtSha`. */
async function countCommitsTo(
  store: ObjectStoreBinding,
  fromSha: string,
  stopAtSha: string,
  maxWalk: number,
): Promise<number> {
  let count = 0;
  const visited = new Set<string>();
  const queue: string[] = [fromSha];
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    if (visited.has(sha) || sha === stopAtSha) continue;
    visited.add(sha);
    if (visited.size > maxWalk) throw new Error("commit graph too large");
    count++;
    const commit = await getCommitData(store, sha);
    if (commit) for (const parent of commit.parents) queue.push(parent);
  }
  return count;
}

export interface AheadBehind {
  readonly ahead: number;
  readonly behind: number;
  readonly hasMergeBase: boolean;
  readonly mergeBaseSha: string | null;
}

/**
 * Ahead/behind counts of `headSha` relative to `baseSha`, measured from their
 * merge base: `ahead` = commits on head not on base, `behind` = commits on base
 * not on head.
 */
export async function countCommitsBetween(
  store: ObjectStoreBinding,
  baseSha: string,
  headSha: string,
  limits: WalkLimits = {},
): Promise<AheadBehind> {
  const maxWalk = limits.maxWalk ?? DEFAULT_MAX_WALK;
  const mergeBaseSha = await findMergeBase(store, baseSha, headSha, limits);
  if (!mergeBaseSha) {
    return { ahead: 0, behind: 0, hasMergeBase: false, mergeBaseSha: null };
  }
  const ahead = await countCommitsTo(store, headSha, mergeBaseSha, maxWalk);
  const behind = await countCommitsTo(store, baseSha, mergeBaseSha, maxWalk);
  return { ahead, behind, hasMergeBase: true, mergeBaseSha };
}

/**
 * True when `targetSha` is reachable from any of `tips` by walking parent
 * edges. Used to gate commit-by-SHA browsing so only commits reachable from an
 * advertised ref are viewable (dangling objects from rejected pushes stay
 * unbrowsable — the M1 "branch-name-only browse" invariant).
 */
export async function commitReachableFromTips(
  store: ObjectStoreBinding,
  tips: Iterable<string>,
  targetSha: string,
  limits: WalkLimits = {},
): Promise<boolean> {
  const maxWalk = limits.maxWalk ?? DEFAULT_MAX_WALK;
  const visited = new Set<string>();
  const queue: string[] = [...tips];
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    if (visited.has(sha)) continue;
    visited.add(sha);
    if (visited.size > maxWalk) throw new Error("commit graph too large");
    if (sha === targetSha) return true;
    const commit = await getCommitData(store, sha);
    if (!commit) continue;
    for (const parent of commit.parents) {
      if (!visited.has(parent)) queue.push(parent);
    }
  }
  return false;
}
