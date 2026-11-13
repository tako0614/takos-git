import { describe, expect, spyOn, test } from "bun:test";

import { MemoryBucket } from "../test-bucket.ts";
import { blameFile } from "./blame.ts";
import { buildDiffPayload } from "./commit-diff.ts";
import { getCommitData, putBlob, putCommit } from "./object-store.ts";
import * as objectStore from "./object-store.ts";
import { buildTreeFromPaths } from "./tree-ops.ts";
import * as textDiff from "./text-diff.ts";
import type { ObjectStoreBinding } from "./types.ts";

const signature = { name: "Fixture", email: "fixture@example.test", timestamp: 1_700_000_000, tzOffset: "+0000" };

async function commit(store: ObjectStoreBinding, files: Record<string, string>, parents: string[] = []) {
  const entries = [];
  for (const [path, content] of Object.entries(files)) {
    entries.push({ path, sha: await putBlob(store, new TextEncoder().encode(content)) });
  }
  const tree = await buildTreeFromPaths(store, entries);
  const sha = await putCommit(store, { tree, parents, author: signature, committer: signature, message: "fixture" });
  return { sha, tree };
}

describe("request-scoped LCS work", () => {
  test("rejects the aggregate of two tiny file comparisons", async () => {
    const store = new MemoryBucket();
    const before = await commit(store, { "a.txt": "a\nb", "b.txt": "c\nd" });
    const after = await commit(store, { "a.txt": "a\nx", "b.txt": "c\ny" }, [before.sha]);
    const limits = { includeHunks: true, lcsLimits: { maxCells: 17 } };
    await expect(buildDiffPayload(store, before.tree, after.tree, limits)).rejects.toThrow();
  });

  test("summary does not materialize full hunks", async () => {
    const store = new MemoryBucket();
    const before = await commit(store, { "a.txt": "a\nb" });
    const after = await commit(store, { "a.txt": "a\nx" }, [before.sha]);
    const hunks = spyOn(textDiff, "buildHunks");
    try {
      const summary = await buildDiffPayload(store, before.tree, after.tree, { includeHunks: false });
      expect(summary.stats).toEqual({ filesChanged: 1, additions: 1, deletions: 1 });
      expect(summary.files[0].hunks).toBeUndefined();
      expect(hunks).not.toHaveBeenCalled();
    } finally {
      hunks.mockRestore();
    }
  });

  test("blame shares its cell budget across changed versions", async () => {
    const store = new MemoryBucket();
    const first = await commit(store, { "f.txt": "a\nb" });
    const second = await commit(store, { "f.txt": "a\nc" }, [first.sha]);
    const third = await commit(store, { "f.txt": "d\nc" }, [second.sha]);
    const limits = { maxFileBytes: 1024, lcsLimits: { maxCells: 20 } };
    expect(await blameFile(store, third.sha, "f.txt", limits)).toEqual({ ok: false, reason: "diff_too_large" });
  });
});

async function matrixAllocations<T>(operation: () => T | Promise<T>) {
  const original = globalThis.Uint16Array;
  const sizes: number[] = [];
  globalThis.Uint16Array = new Proxy(original, {
    construct(target, args, newTarget) {
      if (typeof args[0] === "number") sizes.push(args[0]);
      return Reflect.construct(target, args, newTarget);
    },
  });
  try {
    return { value: await operation(), sizes };
  } finally {
    globalThis.Uint16Array = original;
  }
}

describe("LCS allocation and input boundaries", () => {
  test("exact cells allocate once; one fewer and unsafe dimensions allocate nothing", async () => {
    const exact = await matrixAllocations(() => textDiff.diffLinesLcs(
      ["old"], ["new"], new textDiff.DiffLcsBudget({ maxCells: 4 }),
    ));
    expect(exact.sizes).toEqual([4]);
    expect(exact.value.filter(op => op.type === "insert")).toHaveLength(1);
    expect(exact.value.filter(op => op.type === "delete")).toHaveLength(1);
    const refused = await matrixAllocations(() => {
      expect(() => textDiff.diffLinesLcs(["a"], ["b"], new textDiff.DiffLcsBudget({ maxCells: 3 })))
        .toThrow(textDiff.DiffLcsLimitError);
      const budget = new textDiff.DiffLcsBudget({ maxCells: 9 });
      expect(budget.reserve(1, 1)).toBe(4);
      for (const count of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
        expect(() => budget.reserve(count, 0)).toThrow(textDiff.DiffLcsLimitError);
        expect(budget.remaining).toBe(5);
      }
      expect(budget.reserve(0, 4)).toBe(5);
      expect(() => budget.reserve(0, 0)).toThrow(textDiff.DiffLcsLimitError);
      expect(budget.remaining).toBe(0);
    });
    expect(refused.sizes).toEqual([]);
    expect(new textDiff.DiffLcsBudget({ maxCells: Number.MAX_SAFE_INTEGER }).limitCells)
      .toBe(textDiff.DEFAULT_MAX_LCS_CELLS);
  });

  test("count-only results exactly match full hunks, including ties and empty text", () => {
    const pairs = [["", ""], ["", "a\n"], ["a\n", ""], ["a\nb", "a\nx"],
      ["a\nb\na", "b\na\nb"], ["\n\n", "\n"], ["same", "same"]];
    const expected = pairs.map(([a, b]) => textDiff.countHunkChanges(textDiff.buildHunks(a, b)));
    const hunks = spyOn(textDiff, "buildHunks"), script = spyOn(textDiff, "diffLinesLcs");
    try {
      pairs.forEach(([a, b], index) => expect(textDiff.countLineChanges(a, b)).toEqual(expected[index]));
      expect(hunks).not.toHaveBeenCalled();
      expect(script).not.toHaveBeenCalled();
    } finally {
      hunks.mockRestore(); script.mockRestore();
    }
  });

  test("text bytes and input lines reject before any DP allocation", async () => {
    const store = new MemoryBucket();
    const before = await commit(store, { "f.txt": "a\nb" });
    const after = await commit(store, { "f.txt": "a\nx" }, [before.sha]);
    const exact = { includeHunks: true, lcsLimits: { maxCells: 9, maxTextBytes: 6, maxInputLines: 4 } };
    expect((await buildDiffPayload(store, before.tree, after.tree, exact)).stats)
      .toEqual({ filesChanged: 1, additions: 1, deletions: 1 });
    for (const lcsLimits of [{ maxTextBytes: 5 }, { maxInputLines: 3 }]) {
      const refused = await matrixAllocations(async () => {
        await expect(buildDiffPayload(store, before.tree, after.tree, { lcsLimits }))
          .rejects.toBeInstanceOf(textDiff.DiffLcsLimitError);
      });
      expect(refused.sizes).toEqual([]);
    }
  });

  test("aggregate exact cells succeed and refusal starts no later file reads", async () => {
    const store = new MemoryBucket();
    const before = await commit(store, { "a.txt": "a\nb", "b.txt": "c\nd" });
    const after = await commit(store, { "a.txt": "a\nx", "b.txt": "c\ny" }, [before.sha]);
    const exact = { maxCells: 18, maxTextBytes: 12, maxInputLines: 8 };
    const full = await buildDiffPayload(store, before.tree, after.tree, { includeHunks: true, lcsLimits: exact });
    const summary = await buildDiffPayload(store, before.tree, after.tree, { lcsLimits: exact });
    expect(full.stats).toEqual({ filesChanged: 2, additions: 2, deletions: 2 });
    expect(summary.stats).toEqual(full.stats);
    expect(summary.files.every(file => file.hunks === undefined)).toBe(true);
    for (const lcsLimits of [{ ...exact, maxTextBytes: 11 }, { ...exact, maxInputLines: 7 }]) {
      const refused = await matrixAllocations(async () => {
        await expect(buildDiffPayload(store, before.tree, after.tree, { includeHunks: true, lcsLimits }))
          .rejects.toBeInstanceOf(textDiff.DiffLcsLimitError);
      });
      expect(refused.sizes).toEqual([9]);
    }
    const reads = spyOn(objectStore, "getBlob");
    try {
      const refused = await matrixAllocations(async () => {
        await expect(buildDiffPayload(store, before.tree, after.tree, { lcsLimits: { maxCells: 8 } }))
          .rejects.toBeInstanceOf(textDiff.DiffLcsLimitError);
      });
      expect(refused.sizes).toEqual([]);
      expect(reads).toHaveBeenCalledTimes(2);
    } finally { reads.mockRestore(); }
  });

  test("blame exact aggregate preserves attribution and refuses the next alignment", async () => {
    const store = new MemoryBucket();
    const first = await commit(store, { "f.txt": "a\nb" });
    const second = await commit(store, { "f.txt": "a\nc" }, [first.sha]);
    const third = await commit(store, { "f.txt": "d\nc" }, [second.sha]);
    const exact = await blameFile(store, third.sha, "f.txt", { lcsLimits: { maxCells: 21 } });
    expect(exact.ok).toBe(true);
    if (!exact.ok) throw Error("missing exact-budget blame");
    expect(exact.resolvedCommitSha).toBe((await getCommitData(store, third.sha))!.sha);
    expect(exact.lines.map(line => [line.content, line.commitSha])).toEqual([["d", third.sha], ["c", second.sha]]);
    const refused = await matrixAllocations(() => blameFile(store, third.sha, "f.txt", { lcsLimits: { maxCells: 20 } }));
    expect(refused.value).toEqual({ ok: false, reason: "diff_too_large" });
    expect(refused.sizes).toEqual([3, 9]);
    for (const lcsLimits of [{ maxInputLines: 4 }, { maxTextBytes: 5 }]) {
      const input = await matrixAllocations(() => blameFile(store, third.sha, "f.txt", { lcsLimits }));
      expect(input.value).toEqual({ ok: false, reason: "diff_too_large" });
      expect(input.sizes).toEqual([]);
    }
  });

  test("blame per-file line refusal precedes request input budgets without allocation", async () => {
    const store = new MemoryBucket();
    const root = await commit(store, { "f.txt": "a\nb\nc\nd" });
    const refused = await matrixAllocations(() => blameFile(store, root.sha, "f.txt", {
      maxLines: 2, lcsLimits: { maxInputLines: 3, maxTextBytes: 1 },
    }));
    expect(refused.value).toEqual({ ok: false, reason: "too_large" });
    expect(refused.sizes).toEqual([]);
  });

  test("root, binary, per-file oversize and file-count truncation retain their contracts", async () => {
    const store = new MemoryBucket();
    const root = await commit(store, { "a.txt": "root\n", "b.txt": "other\n" });
    const truncated = await buildDiffPayload(store, null, root.tree, {
      includeHunks: true, maxFiles: 1, lcsLimits: { maxCells: 6 },
    });
    expect(truncated.truncated).toBe(true);
    expect(truncated.stats).toEqual({ filesChanged: 1, additions: 1, deletions: 0 });
    const large = await buildDiffPayload(store, null, root.tree, { maxFiles: 1, maxFileBytes: 2 });
    expect(large.files[0]).toMatchObject({ binary: true, additions: 0, deletions: 0 });
    const binary = await putBlob(store, new Uint8Array([0, 1]));
    const tree = await buildTreeFromPaths(store, [{ path: "binary", sha: binary }]);
    const unsupported = await buildDiffPayload(store, null, tree, { lcsLimits: { maxCells: 0 } });
    expect(unsupported.files[0]).toMatchObject({ binary: true, additions: 0, deletions: 0 });
  });
});
