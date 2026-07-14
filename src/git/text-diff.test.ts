import { describe, expect, test } from "bun:test";

import {
  buildHunks,
  countHunkChanges,
  decodeBlobContent,
  diffLinesLcs,
} from "./text-diff.ts";

describe("text-diff", () => {
  test("diffLinesLcs keeps unchanged lines as equal", () => {
    const ops = diffLinesLcs(["a", "b", "c"], ["a", "B", "c"]);
    expect(ops).toEqual([
      { type: "equal", line: "a" },
      { type: "insert", line: "B" },
      { type: "delete", line: "b" },
      { type: "equal", line: "c" },
    ]);
  });

  test("buildHunks emits context plus add/delete with line numbers", () => {
    const hunks = buildHunks("a\nb\nc", "a\nb2\nc\nd");
    expect(hunks).toHaveLength(1);
    const { additions, deletions } = countHunkChanges(hunks);
    expect(additions).toBe(2); // b2, d
    expect(deletions).toBe(1); // b
    const contextA = hunks[0].lines.find(
      (l) => l.type === "context" && l.content === "a",
    );
    expect(contextA).toMatchObject({ oldLineNumber: 1, newLineNumber: 1 });
  });

  test("identical content yields a context-only hunk with no changes", () => {
    const hunks = buildHunks("same\ntext", "same\ntext");
    expect(countHunkChanges(hunks)).toEqual({ additions: 0, deletions: 0 });
    expect(hunks[0]?.lines.every((l) => l.type === "context")).toBe(true);
  });

  test("decodeBlobContent flags NUL-containing blobs as binary", () => {
    expect(decodeBlobContent(new Uint8Array([1, 0, 2]))).toEqual({
      text: "",
      isBinary: true,
    });
    expect(decodeBlobContent(new TextEncoder().encode("hi"))).toEqual({
      text: "hi",
      isBinary: false,
    });
  });
});
