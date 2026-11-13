/**
 * Text diff primitives — LCS line alignment + unified-diff hunks.
 *
 * Ported verbatim (behaviour-preserving) from the takos worker's
 * `shared/utils/lcs-diff.ts` + `shared/utils/unified-diff.ts`. Fully pure: no
 * object store, no D1 — operates on decoded text. Consumed by commit/compare
 * diffs (`tree-diff.ts` feeds file pairs) and by `blame.ts` for per-line
 * attribution.
 */

export type LineDiffOp =
  | { type: "equal"; line: string }
  | { type: "insert"; line: string }
  | { type: "delete"; line: string };

export const DEFAULT_MAX_LCS_CELLS = 4_000_000;
export const DEFAULT_MAX_DIFF_TEXT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_DIFF_INPUT_LINES = 100_000;

/** Internal callers may tighten these request limits, never raise them. */
export interface DiffLcsLimits {
  readonly maxCells?: number;
  readonly maxTextBytes?: number;
  readonly maxInputLines?: number;
}

export class DiffLcsLimitError extends Error {
  constructor() {
    super("Diff request exceeds its computation budget.");
    this.name = "DiffLcsLimitError";
  }
}

function boundedLimit(value: number | undefined, ceiling: number): number {
  if (value === undefined) return ceiling;
  if (!Number.isSafeInteger(value) || value < 0) throw new DiffLcsLimitError();
  return Math.min(value, ceiling);
}

/** No reservation is refunded: both retained input and all LCS work are bounded. */
export class DiffLcsBudget {
  readonly limitCells: number;
  readonly limitInputLines: number;
  private remainingCells: number;
  private remainingTextBytes: number;
  private remainingInputLines: number;

  constructor(limits: DiffLcsLimits = {}) {
    this.limitCells = boundedLimit(limits.maxCells, DEFAULT_MAX_LCS_CELLS);
    this.limitInputLines = boundedLimit(limits.maxInputLines, DEFAULT_MAX_DIFF_INPUT_LINES);
    this.remainingCells = this.limitCells;
    this.remainingTextBytes = boundedLimit(limits.maxTextBytes, DEFAULT_MAX_DIFF_TEXT_BYTES);
    this.remainingInputLines = this.limitInputLines;
  }

  get remaining(): number { return this.remainingCells; }

  reserve(oldLineCount: number, newLineCount: number): number {
    const rows = oldLineCount + 1, columns = newLineCount + 1;
    const cells = rows * columns;
    if (
      !Number.isSafeInteger(oldLineCount) || oldLineCount < 0 ||
      !Number.isSafeInteger(newLineCount) || newLineCount < 0 ||
      !Number.isSafeInteger(rows) || !Number.isSafeInteger(columns) ||
      !Number.isSafeInteger(cells) || cells > this.remainingCells ||
      oldLineCount + newLineCount > this.limitInputLines
    ) throw new DiffLcsLimitError();
    // Combined input lines <=100,000 also keeps every Uint16 LCS value <=50,000.
    this.remainingCells -= cells;
    return cells;
  }

  reserveTextBytes(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.remainingTextBytes) {
      throw new DiffLcsLimitError();
    }
    this.remainingTextBytes -= bytes;
  }

  /** Check before split allocates an input-line array, including blame history. */
  splitLines(content: string): string[] {
    let count = 1;
    if (count > this.remainingInputLines) throw new DiffLcsLimitError();
    for (let at = content.indexOf("\n"); at !== -1; at = content.indexOf("\n", at + 1)) {
      if (++count > this.remainingInputLines) throw new DiffLcsLimitError();
    }
    this.remainingInputLines -= count;
    return content.split("\n");
  }
}

export function createDiffLcsBudget(limits: DiffLcsLimits = {}): DiffLcsBudget {
  return new DiffLcsBudget(limits);
}

/**
 * Line diff based on LCS (O(n*m) time/memory). Intended for small files only.
 * Returns an edit script that transforms oldLines -> newLines.
 */
export function diffLinesLcs(
  oldLines: string[],
  newLines: string[],
  budget = createDiffLcsBudget(),
): LineDiffOp[] {
  const n = oldLines.length;
  const m = newLines.length;

  // dp[(i*(m+1))+j] = LCS length for oldLines[0..i) and newLines[0..j)
  const dp = new Uint16Array(budget.reserve(n, m));
  const width = m + 1;

  for (let i = 1; i <= n; i++) {
    const oldLine = oldLines[i - 1];
    for (let j = 1; j <= m; j++) {
      const idx = i * width + j;
      if (oldLine === newLines[j - 1]) {
        dp[idx] = (dp[(i - 1) * width + (j - 1)] + 1) as number;
      } else {
        const up = dp[(i - 1) * width + j];
        const left = dp[i * width + (j - 1)];
        dp[idx] = up >= left ? up : left;
      }
    }
  }

  const ops: LineDiffOp[] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (oldLines[i - 1] === newLines[j - 1]) {
      ops.push({ type: "equal", line: newLines[j - 1] });
      i--;
      j--;
      continue;
    }
    const up = dp[(i - 1) * width + j];
    const left = dp[i * width + (j - 1)];
    if (up >= left) {
      ops.push({ type: "delete", line: oldLines[i - 1] });
      i--;
    } else {
      ops.push({ type: "insert", line: newLines[j - 1] });
      j--;
    }
  }

  while (i > 0) {
    ops.push({ type: "delete", line: oldLines[i - 1] });
    i--;
  }
  while (j > 0) {
    ops.push({ type: "insert", line: newLines[j - 1] });
    j--;
  }

  ops.reverse();
  return ops;
}

export type DiffLine = {
  type: "context" | "add" | "delete";
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
};

export type DiffHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
};

/**
 * Build aligned diff hunks from two text blobs using the LCS aligner
 * ({@link diffLinesLcs}). Unchanged lines are kept as context and only
 * genuinely inserted/removed lines emit add/delete, so mid-file edits do not
 * show spurious churn. The single returned hunk (when there is any change)
 * carries the whole-file extent; lines carry 1-based old/new line numbers.
 */
export function buildHunks(
  oldContent: string,
  newContent: string,
  budget = createDiffLcsBudget(),
): DiffHunk[] {
  const oldLines = budget.splitLines(oldContent);
  const newLines = budget.splitLines(newContent);
  const ops = diffLinesLcs(oldLines, newLines, budget);

  const lines: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const op of ops) {
    if (op.type === "equal") {
      oldNo++;
      newNo++;
      lines.push({
        type: "context",
        content: op.line,
        oldLineNumber: oldNo,
        newLineNumber: newNo,
      });
    } else if (op.type === "delete") {
      oldNo++;
      lines.push({ type: "delete", content: op.line, oldLineNumber: oldNo });
    } else {
      newNo++;
      lines.push({ type: "add", content: op.line, newLineNumber: newNo });
    }
  }

  if (lines.length === 0) return [];

  return [
    {
      oldStart: oldLines.length > 0 ? 1 : 0,
      oldLines: oldLines.length,
      newStart: newLines.length > 0 ? 1 : 0,
      newLines: newLines.length,
      lines,
    },
  ];
}

/** Exact LCS counts with two short rows; no edit script or hunks are retained. */
export function countLineChanges(
  oldContent: string,
  newContent: string,
  budget = createDiffLcsBudget(),
): { additions: number; deletions: number } {
  let oldLines = budget.splitLines(oldContent);
  let newLines = budget.splitLines(newContent);
  const oldCount = oldLines.length, newCount = newLines.length;
  budget.reserve(oldCount, newCount);
  if (newCount > oldCount) [oldLines, newLines] = [newLines, oldLines];
  let previous = new Uint16Array(newLines.length + 1);
  let current = new Uint16Array(newLines.length + 1);
  for (const oldLine of oldLines) {
    for (let j = 1; j <= newLines.length; j++) {
      current[j] = oldLine === newLines[j - 1]
        ? previous[j - 1] + 1
        : Math.max(previous[j], current[j - 1]);
    }
    [previous, current] = [current, previous];
    current.fill(0);
  }
  const lcs = previous[newLines.length];
  return { additions: newCount - lcs, deletions: oldCount - lcs };
}

/** Count additions/deletions across hunks (context lines excluded). */
export function countHunkChanges(hunks: DiffHunk[]): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.type === "add") additions++;
      else if (line.type === "delete") deletions++;
    }
  }
  return { additions, deletions };
}

export function formatUnifiedDiff(
  path: string,
  oldContent: string,
  newContent: string,
  status: "added" | "modified" | "deleted",
): string {
  const hunks = buildHunks(oldContent, newContent);
  const header = [
    `diff --git a/${path} b/${path}`,
    status === "added" ? "new file mode 100644" : "",
    status === "deleted" ? "deleted file mode 100644" : "",
    `--- ${status === "added" ? "/dev/null" : `a/${path}`}`,
    `+++ ${status === "deleted" ? "/dev/null" : `b/${path}`}`,
  ]
    .filter(Boolean)
    .join("\n");

  if (hunks.length === 0) return `${header}\n`;

  const body = hunks
    .map((hunk) => {
      const lines = hunk.lines
        .map((line) => {
          const prefix =
            line.type === "add" ? "+" : line.type === "delete" ? "-" : " ";
          return `${prefix}${line.content}`;
        })
        .join("\n");
      return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${lines}`;
    })
    .join("\n");

  return `${header}\n${body}\n`;
}

/** Number of bytes sampled from the start of a blob to detect binary content. */
const BINARY_DETECTION_SAMPLE_SIZE = 1024;

export function decodeBlobContent(blob: Uint8Array): {
  text: string;
  isBinary: boolean;
} {
  let binaryScore = 0;
  for (let i = 0; i < Math.min(blob.length, BINARY_DETECTION_SAMPLE_SIZE); i++) {
    if (blob[i] === 0) binaryScore++;
  }
  if (binaryScore > 0) return { text: "", isBinary: true };
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(blob);
    return { text, isBinary: false };
  } catch {
    return { text: "", isBinary: true };
  }
}
