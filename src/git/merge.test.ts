import { describe, expect, test } from "bun:test";

import { MemoryBucket } from "../test-bucket.ts";
import { putBlob } from "./object-store.ts";
import { buildTreeFromPaths, flattenTree, getBlobAtPath } from "./tree-ops.ts";
import { mergeTrees3Way } from "./merge.ts";
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

describe("mergeTrees3Way", () => {
  test("merges non-overlapping changes cleanly", async () => {
    const store = new MemoryBucket();
    const base = await tree(store, {
      "common.txt": "1",
      "a.txt": "a",
      "b.txt": "b",
    });
    const local = await tree(store, {
      "common.txt": "1",
      "a.txt": "a-local",
      "b.txt": "b",
      "l.txt": "L",
    });
    const upstream = await tree(store, {
      "common.txt": "1",
      "a.txt": "a",
      "b.txt": "b-up",
      "u.txt": "U",
    });

    const result = await mergeTrees3Way(store, base, local, upstream);
    expect(result.conflicts).toEqual([]);
    expect(result.treeSha).not.toBeNull();

    const merged = result.treeSha as string;
    const dec = new TextDecoder();
    const read = async (p: string) =>
      dec.decode((await getBlobAtPath(store, merged, p)) as Uint8Array);
    expect(await read("a.txt")).toBe("a-local");
    expect(await read("b.txt")).toBe("b-up");
    expect(await read("l.txt")).toBe("L");
    expect(await read("u.txt")).toBe("U");
    expect(await read("common.txt")).toBe("1");

    const files = await flattenTree(store, merged);
    expect(files.map((f) => f.path).sort()).toEqual([
      "a.txt",
      "b.txt",
      "common.txt",
      "l.txt",
      "u.txt",
    ]);
  });

  test("classifies a content conflict", async () => {
    const store = new MemoryBucket();
    const base = await tree(store, { "c.txt": "base" });
    const local = await tree(store, { "c.txt": "local" });
    const upstream = await tree(store, { "c.txt": "upstream" });

    const result = await mergeTrees3Way(store, base, local, upstream);
    expect(result.treeSha).toBeNull();
    expect(result.conflicts).toEqual([{ path: "c.txt", type: "content" }]);
  });

  test("classifies add-add and delete-modify conflicts", async () => {
    const store = new MemoryBucket();
    const base = await tree(store, { "d.txt": "keep" });
    const local = await tree(store, { "x.txt": "local-x" }); // deletes d.txt, adds x.txt
    const upstream = await tree(store, {
      "d.txt": "changed",
      "x.txt": "up-x",
    });

    const result = await mergeTrees3Way(store, base, local, upstream);
    expect(result.treeSha).toBeNull();
    expect(result.conflicts).toEqual([
      { path: "d.txt", type: "delete-modify" },
      { path: "x.txt", type: "add-add" },
    ]);
  });

  test("takes the identical side when both changed the same way", async () => {
    const store = new MemoryBucket();
    const base = await tree(store, { "f.txt": "0" });
    const same = await tree(store, { "f.txt": "1" });
    const result = await mergeTrees3Way(store, base, same, same);
    expect(result.conflicts).toEqual([]);
    const dec = new TextDecoder();
    expect(
      dec.decode(
        (await getBlobAtPath(store, result.treeSha as string, "f.txt")) as Uint8Array,
      ),
    ).toBe("1");
  });
});
