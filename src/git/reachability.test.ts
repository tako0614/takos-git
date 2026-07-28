import { expect, test } from "bun:test";

import { MemoryBucket } from "../test-bucket.ts";
import { putBlob, putCommit, putTree } from "./object-store.ts";
import { collectReachableObjects } from "./reachability.ts";

test("reachability rejects trees nested deeper than 256 levels", async () => {
  const bucket = new MemoryBucket();
  const blob = await putBlob(bucket, new TextEncoder().encode("leaf"));
  let tree = await putTree(bucket, [
    { mode: "100644", name: "leaf.txt", sha: blob },
  ]);
  for (let depth = 0; depth < 257; depth += 1) {
    tree = await putTree(bucket, [
      { mode: "040000", name: `d${depth}`, sha: tree },
    ]);
  }
  const signature = {
    name: "Takos Git",
    email: "git@takos.test",
    timestamp: 1_700_000_000,
    tzOffset: "+0000",
  };
  const commit = await putCommit(bucket, {
    tree,
    parents: [],
    author: signature,
    committer: signature,
    message: "deep tree\n",
  });

  await expect(
    collectReachableObjects(bucket, [commit], new Set()),
  ).rejects.toThrow("tree depth exceeds the 256-level limit");
});
