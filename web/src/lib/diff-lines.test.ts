import { expect, test } from "bun:test";
import { buildHunks } from "../../../src/git/text-diff.ts";
import type { DiffHunk, DiffLine } from "../api/types.ts";
import { diffHunkHeader, reviewLineTarget } from "./diff-lines.ts";

test("actual Worker hunks retain their text, extents and review line anchors", () => {
  const hunks: readonly DiffHunk[] = buildHunks("alpha\nold\nomega", "alpha\nnew\nomega");
  const hunk = hunks[0]!;
  expect(diffHunkHeader(hunk)).toBe("@@ -1,3 +1,3 @@");
  const deleted = hunk.lines.find(line => line.type === "delete")!;
  const added = hunk.lines.find(line => line.type === "add")!;
  const context = hunk.lines.find(line => line.type === "context")!;
  expect(deleted.content).toBe("old");
  expect(reviewLineTarget(deleted)).toEqual({ side: "LEFT", line: 2 });
  expect(added.content).toBe("new");
  expect(reviewLineTarget(added)).toEqual({ side: "RIGHT", line: 2 });
  expect(context.content).toBe("alpha");
  expect(reviewLineTarget(context)).toEqual({ side: "RIGHT", line: 1 });
});

test("actual insertion and deletion preserve the empty side and Unicode text", () => {
  const inserted: readonly DiffHunk[] = buildHunks("", "日本語");
  const deleted: readonly DiffHunk[] = buildHunks("日本語", "");
  expect(inserted[0]!.lines.find(line => line.type === "add")?.content).toBe("日本語");
  expect(reviewLineTarget(inserted[0]!.lines.find(line => line.type === "add")!)).toEqual({ side: "RIGHT", line: 1 });
  expect(deleted[0]!.lines.find(line => line.type === "delete")?.content).toBe("日本語");
  expect(reviewLineTarget(deleted[0]!.lines.find(line => line.type === "delete")!)).toEqual({ side: "LEFT", line: 1 });
});

test("JSON transport preserves the actual producer contract without another line schema", () => {
  const actual = buildHunks("a\nb", "a\nc");
  const transported: readonly DiffHunk[] = JSON.parse(JSON.stringify(actual));
  expect(transported).toEqual(actual);
  expect(transported[0]!.lines.map(reviewLineTarget)).toEqual(actual[0]!.lines.map(reviewLineTarget));
  expect(diffHunkHeader(transported[0]!)).toBe("@@ -1,2 +1,2 @@");
});

test("a missing anchor is never replaced with an invented line number", () => {
  const lines: readonly DiffLine[] = [{ type: "delete", content: "old" }, { type: "add", content: "new" }, { type: "context", content: "same" }];
  expect(lines.map(reviewLineTarget)).toEqual([null, null, null]);
});
