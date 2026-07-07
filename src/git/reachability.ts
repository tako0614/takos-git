/**
 * Pure-R2 object reachability for upload-pack.
 *
 * Lifted from the takos worker's `commit-index.ts` walk, but with the D1
 * commit-index lookup dropped: commits and trees are parsed straight from the
 * R2 loose-object store (`getCommitData` / `getTreeEntries`). Given a set of
 * `wants` (already constrained to advertised tips) it returns every object SHA
 * reachable from them that the client does not already `have`.
 */

import type { ObjectStoreBinding } from "./types.ts";
import { getCommitData, getTreeEntries } from "./object-store.ts";

// Tree entries with these modes are subtrees to recurse into; `160000` is a
// gitlink (submodule commit) we neither host nor pack.
const TREE_MODES = new Set(["040000", "40000"]);
const GITLINK_MODE = "160000";

async function collectTreeObjects(
  bucket: ObjectStoreBinding,
  treeSha: string,
  out: Set<string>,
): Promise<void> {
  if (out.has(treeSha)) return;
  out.add(treeSha);
  const entries = await getTreeEntries(bucket, treeSha);
  if (!entries) return;
  for (const entry of entries) {
    if (out.has(entry.sha)) continue;
    if (TREE_MODES.has(entry.mode)) {
      await collectTreeObjects(bucket, entry.sha, out);
    } else if (entry.mode !== GITLINK_MODE) {
      out.add(entry.sha);
    }
  }
}

export async function collectReachableObjects(
  bucket: ObjectStoreBinding,
  wants: readonly string[],
  haves: ReadonlySet<string>,
): Promise<string[]> {
  const objects = new Set<string>();
  const visitedCommits = new Set<string>();
  const queue = [...wants];
  while (queue.length > 0) {
    const sha = queue.pop() as string;
    if (visitedCommits.has(sha) || haves.has(sha)) continue;
    visitedCommits.add(sha);
    const commit = await getCommitData(bucket, sha);
    if (!commit) continue;
    objects.add(sha);
    await collectTreeObjects(bucket, commit.tree, objects);
    for (const parent of commit.parents) {
      if (!visitedCommits.has(parent) && !haves.has(parent)) queue.push(parent);
    }
  }
  return [...objects];
}
