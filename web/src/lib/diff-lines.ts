import type { DiffHunk, DiffLine } from "../api/types.ts";

export function diffHunkHeader(hunk: DiffHunk): string {
  return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
}

/** Keep deleted-line comments on the original side of the actual Worker diff. */
export function reviewLineTarget(line: DiffLine): { side: "LEFT" | "RIGHT"; line: number } | null {
  if (line.type === "delete") {
    return line.oldLineNumber != null ? { side: "LEFT", line: line.oldLineNumber } : null;
  }
  return line.newLineNumber != null ? { side: "RIGHT", line: line.newLineNumber } : null;
}
