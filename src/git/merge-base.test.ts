import { describe, expect, test } from "bun:test";

import { MemoryBucket } from "../test-bucket.ts";
import { putBlob, putCommit } from "./object-store.ts";
import { buildTreeFromPaths } from "./tree-ops.ts";
import type { GitSignature } from "./git-objects.ts";
import type { ObjectStoreBinding } from "./types.ts";
import {
  commitReachableFromTips,
  countCommitsBetween,
  findMergeBase,
  isAncestor,
} from "./merge-base.ts";

const SIG: GitSignature = {
  name: "T",
  email: "t@takos.test",
  timestamp: 1_700_000_000,
  tzOffset: "+0000",
};

async function commit(
  store: ObjectStoreBinding,
  files: Record<string, string>,
  parents: string[],
): Promise<string> {
  const entries: Array<{ path: string; sha: string }> = [];
  for (const [path, content] of Object.entries(files)) {
    const sha = await putBlob(store, new TextEncoder().encode(content));
    entries.push({ path, sha });
  }
  const tree = await buildTreeFromPaths(store, entries);
  return putCommit(store, {
    tree,
    parents,
    author: SIG,
    committer: SIG,
    message: "c",
  });
}

// root -> A -> B (main)
//          \-> C (feature)
async function branchingHistory(store: ObjectStoreBinding) {
  const root = await commit(store, { "f.txt": "0" }, []);
  const a = await commit(store, { "f.txt": "1" }, [root]);
  const b = await commit(store, { "f.txt": "2" }, [a]);
  const c = await commit(store, { "f.txt": "1", "g.txt": "x" }, [a]);
  return { root, a, b, c };
}

describe("merge-base commit graph walk", () => {
  test("findMergeBase returns the fork point", async () => {
    const store = new MemoryBucket();
    const { a, b, c } = await branchingHistory(store);
    expect(await findMergeBase(store, b, c)).toBe(a);
    expect(await findMergeBase(store, c, b)).toBe(a);
  });

  test("findMergeBase is null for disjoint histories", async () => {
    const store = new MemoryBucket();
    const x = await commit(store, { "a.txt": "a" }, []);
    const y = await commit(store, { "b.txt": "b" }, []);
    expect(await findMergeBase(store, x, y)).toBeNull();
  });

  test("isAncestor respects direction and reflexivity", async () => {
    const store = new MemoryBucket();
    const { root, a, b, c } = await branchingHistory(store);
    expect(await isAncestor(store, root, b)).toBe(true);
    expect(await isAncestor(store, a, c)).toBe(true);
    expect(await isAncestor(store, b, root)).toBe(false);
    expect(await isAncestor(store, b, c)).toBe(false);
    expect(await isAncestor(store, b, b)).toBe(true);
  });

  test("countCommitsBetween reports ahead/behind from the merge base", async () => {
    const store = new MemoryBucket();
    const { a, b, c } = await branchingHistory(store);
    const result = await countCommitsBetween(store, b, c);
    expect(result).toEqual({
      ahead: 1, // c is 1 commit ahead of the merge base
      behind: 1, // b is 1 commit ahead of the merge base
      hasMergeBase: true,
      mergeBaseSha: a,
    });
  });

  test("commitReachableFromTips gates dangling commits", async () => {
    const store = new MemoryBucket();
    const { a, b, c } = await branchingHistory(store);
    // Only main (b) is advertised; c is a separate tip.
    expect(await commitReachableFromTips(store, [b], a)).toBe(true);
    expect(await commitReachableFromTips(store, [b], c)).toBe(false);
    expect(await commitReachableFromTips(store, [b, c], c)).toBe(true);
  });
});
