/**
 * Detailed file diffs between two trees — the read-side payload that commit
 * detail and ref compare return.
 *
 * Combines the pure `tree-diff.ts` path comparison with `text-diff.ts` LCS
 * hunks and blob loads from the R2 object store, mirroring the takos worker's
 * `buildDetailedRepoDiffPayload` but reworked onto takos-git's R2-only stores.
 * Bounded by file-count / per-file-byte / per-file-line caps so a browse
 * request can never fan out unbounded work.
 */

import type { ObjectStoreBinding } from "./types.ts";
import { getBlob, GitObjectTooLargeError } from "./object-store.ts";
import {
  diffTrees,
  summarizeTreeDiff,
  type TreeDiffEntry,
  type TreeDiffStatus,
} from "./tree-diff.ts";
import {
  buildHunks,
  countHunkChanges,
  countLineChanges,
  createDiffLcsBudget,
  decodeBlobContent,
  type DiffLcsBudget,
  type DiffLcsLimits,
  type DiffHunk,
} from "./text-diff.ts";

export interface FileDiff {
  readonly path: string;
  readonly status: TreeDiffStatus;
  readonly oldPath?: string;
  readonly additions: number;
  readonly deletions: number;
  readonly binary: boolean;
  /** Present for text files when `includeHunks` is set. */
  readonly hunks?: DiffHunk[];
}

export interface DiffPayload {
  readonly files: FileDiff[];
  readonly stats: {
    readonly filesChanged: number;
    readonly additions: number;
    readonly deletions: number;
  };
  readonly truncated: boolean;
}

export interface DiffPayloadOptions {
  readonly includeHunks?: boolean;
  readonly maxFiles?: number;
  readonly maxFileBytes?: number;
  readonly detectRenames?: boolean;
  readonly lcsLimits?: DiffLcsLimits;
}

const DEFAULT_MAX_FILES = 300;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;

async function loadText(
  store: ObjectStoreBinding,
  sha: string | undefined,
  maxBytes: number,
): Promise<{ text: string; binary: boolean; bytes: number } | "too_large"> {
  if (!sha) return { text: "", binary: false, bytes: 0 };
  let blob: Uint8Array | null;
  try {
    blob = await getBlob(store, sha, maxBytes);
  } catch (error) {
    if (error instanceof GitObjectTooLargeError) return "too_large";
    throw error;
  }
  if (!blob) return { text: "", binary: false, bytes: 0 };
  const decoded = decodeBlobContent(blob);
  return { text: decoded.text, binary: decoded.isBinary, bytes: blob.byteLength };
}

async function fileDiff(
  store: ObjectStoreBinding,
  entry: TreeDiffEntry,
  options: Required<Pick<DiffPayloadOptions, "includeHunks" | "maxFileBytes">>,
  budget: DiffLcsBudget,
): Promise<FileDiff> {
  const base = {
    path: entry.path,
    status: entry.status,
    ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
  };

  // A pure rename (identical OID) has no content change.
  if (entry.status === "renamed" && entry.oldSha === entry.newSha) {
    return { ...base, additions: 0, deletions: 0, binary: false };
  }

  const [oldSide, newSide] = await Promise.all([
    loadText(store, entry.oldSha, options.maxFileBytes),
    loadText(store, entry.newSha, options.maxFileBytes),
  ]);

  if (
    oldSide === "too_large" ||
    newSide === "too_large" ||
    oldSide.binary ||
    newSide.binary
  ) {
    return { ...base, additions: 0, deletions: 0, binary: true };
  }

  budget.reserveTextBytes(oldSide.bytes + newSide.bytes);
  const hunks = options.includeHunks
    ? buildHunks(oldSide.text, newSide.text, budget)
    : undefined;
  const { additions, deletions } = hunks
    ? countHunkChanges(hunks)
    : countLineChanges(oldSide.text, newSide.text, budget);
  return {
    ...base,
    additions,
    deletions,
    binary: false,
    ...(hunks ? { hunks } : {}),
  };
}

/**
 * Build the detailed diff between two trees. `baseTreeSha = null` diffs against
 * the empty tree (root commit).
 */
export async function buildDiffPayload(
  store: ObjectStoreBinding,
  baseTreeSha: string | null,
  headTreeSha: string | null,
  options: DiffPayloadOptions = {},
): Promise<DiffPayload> {
  const includeHunks = options.includeHunks ?? false;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const budget = createDiffLcsBudget(options.lcsLimits);

  const entries = await diffTrees(store, baseTreeSha, headTreeSha, {
    ...(options.detectRenames !== undefined
      ? { detectRenames: options.detectRenames }
      : {}),
  });

  const truncated = entries.length > maxFiles;
  const limited = truncated ? entries.slice(0, maxFiles) : entries;

  // Retain only one pair of decoded blobs at a time. On a limit error no later
  // file is started, and summary reads never create edit scripts or hunks.
  const files: FileDiff[] = [];
  for (const entry of limited) {
    files.push(await fileDiff(store, entry, { includeHunks, maxFileBytes }, budget));
  }

  const summary = summarizeTreeDiff(limited);
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    additions += file.additions;
    deletions += file.deletions;
  }

  return {
    files,
    stats: { filesChanged: summary.filesChanged, additions, deletions },
    truncated,
  };
}
