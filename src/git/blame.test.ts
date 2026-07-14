import { describe, expect, test } from "bun:test";

import { MemoryBucket } from "../test-bucket.ts";
import { putBlob, putCommit } from "./object-store.ts";
import { buildTreeFromPaths } from "./tree-ops.ts";
import { blameFile } from "./blame.ts";
import type { GitSignature } from "./git-objects.ts";
import type { ObjectStoreBinding } from "./types.ts";

const SIG: GitSignature = {
  name: "T",
  email: "t@takos.test",
  timestamp: 1_700_000_000,
  tzOffset: "+0000",
};

async function commit(
  store: ObjectStoreBinding,
  files: Record<string, string | Uint8Array>,
  parents: string[],
): Promise<string> {
  const entries: Array<{ path: string; sha: string }> = [];
  for (const [path, content] of Object.entries(files)) {
    const bytes =
      typeof content === "string" ? new TextEncoder().encode(content) : content;
    const sha = await putBlob(store, bytes);
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

describe("blameFile", () => {
  test("attributes each line to the commit that introduced it", async () => {
    const store = new MemoryBucket();
    const c1 = await commit(store, { "f.txt": "l1\nl2\nl3" }, []);
    const c2 = await commit(store, { "f.txt": "l1\nl2-changed\nl3" }, [c1]);
    const c3 = await commit(store, { "f.txt": "l1\nl2-changed\nl3\nl4" }, [c2]);

    const result = await blameFile(store, c3, "f.txt");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lines.map((l) => [l.content, l.commitSha])).toEqual([
      ["l1", c1],
      ["l2-changed", c2],
      ["l3", c1],
      ["l4", c3],
    ]);
    expect(result.resolvedCommitSha).toBe(c3);
  });

  test("reports file_not_found for an absent path", async () => {
    const store = new MemoryBucket();
    const c1 = await commit(store, { "f.txt": "x" }, []);
    const result = await blameFile(store, c1, "missing.txt");
    expect(result).toEqual({ ok: false, reason: "file_not_found" });
  });

  test("reports binary for a blob with NUL bytes", async () => {
    const store = new MemoryBucket();
    const bin = new Uint8Array([0x61, 0x00, 0x62]);
    const c1 = await commit(store, { "f.bin": bin }, []);
    const result = await blameFile(store, c1, "f.bin");
    expect(result).toEqual({ ok: false, reason: "binary" });
  });

  test("enforces the max-file-bytes cap", async () => {
    const store = new MemoryBucket();
    const big = "a".repeat(2048);
    const c1 = await commit(store, { "f.txt": big }, []);
    const result = await blameFile(store, c1, "f.txt", { maxFileBytes: 1024 });
    expect(result).toEqual({ ok: false, reason: "too_large" });
  });
});
