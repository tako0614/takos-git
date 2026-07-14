import { describe, expect, test } from "bun:test";

import { MemoryBucket } from "../test-bucket.ts";
import { putBlob } from "./object-store.ts";
import { buildTreeFromPaths } from "./tree-ops.ts";
import { diffTrees, summarizeTreeDiff } from "./tree-diff.ts";
import type { ObjectStoreBinding } from "./types.ts";

async function tree(
  store: ObjectStoreBinding,
  files: Record<string, string>,
): Promise<string> {
  const entries: Array<{ path: string; sha: string }> = [];
  for (const [path, content] of Object.entries(files)) {
    const sha = await putBlob(store, new TextEncoder().encode(content));
    entries.push({ path, sha });
  }
  return buildTreeFromPaths(store, entries);
}

describe("diffTrees", () => {
  test("classifies added / modified / deleted, ignores unchanged", async () => {
    const store = new MemoryBucket();
    const base = await tree(store, {
      "a.txt": "A",
      "b.txt": "B",
      "del.txt": "gone",
    });
    const head = await tree(store, {
      "a.txt": "A2",
      "b.txt": "B",
      "add.txt": "new",
    });

    const entries = await diffTrees(store, base, head);
    const byPath = Object.fromEntries(entries.map((e) => [e.path, e.status]));
    expect(byPath).toEqual({
      "a.txt": "modified",
      "add.txt": "added",
      "del.txt": "deleted",
    });
    // b.txt is unchanged and must not appear.
    expect(entries.find((e) => e.path === "b.txt")).toBeUndefined();

    const stats = summarizeTreeDiff(entries);
    expect(stats).toEqual({
      filesChanged: 3,
      added: 1,
      modified: 1,
      deleted: 1,
      renamed: 0,
    });
  });

  test("detects an exact-content rename", async () => {
    const store = new MemoryBucket();
    const base = await tree(store, { "old/name.txt": "MOVED", "keep.txt": "k" });
    const head = await tree(store, { "new/name.txt": "MOVED", "keep.txt": "k" });

    const entries = await diffTrees(store, base, head);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      status: "renamed",
      path: "new/name.txt",
      oldPath: "old/name.txt",
    });
  });

  test("detectRenames:false leaves the pair as delete + add", async () => {
    const store = new MemoryBucket();
    const base = await tree(store, { "old.txt": "MOVED" });
    const head = await tree(store, { "new.txt": "MOVED" });

    const entries = await diffTrees(store, base, head, {
      detectRenames: false,
    });
    const statuses = entries.map((e) => e.status).sort();
    expect(statuses).toEqual(["added", "deleted"]);
  });

  test("null base treats every head file as added", async () => {
    const store = new MemoryBucket();
    const head = await tree(store, { "x.txt": "x", "dir/y.txt": "y" });
    const entries = await diffTrees(store, null, head);
    expect(entries.every((e) => e.status === "added")).toBe(true);
    expect(entries.map((e) => e.path).sort()).toEqual(["dir/y.txt", "x.txt"]);
  });
});
