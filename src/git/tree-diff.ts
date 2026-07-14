/**
 * Path-level tree diff over the R2 object store.
 *
 * Extracts the pure comparison that was inlined in the takos worker's PR diff
 * (`server/routes/pull-requests/diff.ts` — `flattenTree(base)` vs
 * `flattenTree(head)`), backed by takos-git's already-ported `flattenTree`
 * (`tree-ops.ts`). Compares two tree SHAs and reports added / modified /
 * deleted / renamed files at the blob-OID + mode level.
 *
 * Rename detection is exact-content only: a deleted path and an added path that
 * share an identical blob OID are paired as a rename. This is cheap and needs
 * no similarity threshold; near-rename (content-changed) detection is out of
 * scope for M2.
 */

import type { ObjectStoreBinding } from "./types.ts";
import { flattenTree } from "./tree-ops.ts";

export type TreeDiffStatus = "added" | "modified" | "deleted" | "renamed";

export interface TreeDiffEntry {
  /** New path for added/modified/renamed; the removed path for deleted. */
  readonly path: string;
  readonly status: TreeDiffStatus;
  /** Previous path, only for renamed. */
  readonly oldPath?: string;
  /** Blob OID in the base tree (modified/deleted/renamed). */
  readonly oldSha?: string;
  /** Blob OID in the head tree (added/modified/renamed). */
  readonly newSha?: string;
  readonly oldMode?: string;
  readonly newMode?: string;
}

export interface DiffTreesOptions {
  /** Detect exact-content renames (default true). */
  readonly detectRenames?: boolean;
  readonly maxDepth?: number;
  readonly maxEntries?: number;
}

interface FlatEntry {
  path: string;
  sha: string;
  mode: string;
}

async function flatten(
  store: ObjectStoreBinding,
  treeSha: string | null,
  options: DiffTreesOptions,
): Promise<FlatEntry[]> {
  if (!treeSha) return [];
  return flattenTree(store, treeSha, "", {
    // Symlinks are diffable blobs; keep them rather than throwing so browsing a
    // repo that contains symlinks does not hard-fail.
    skipSymlinks: true,
    ...(options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {}),
    ...(options.maxEntries !== undefined
      ? { maxEntries: options.maxEntries }
      : {}),
  });
}

/**
 * Diff two tree SHAs. Pass `baseTreeSha = null` to diff against the empty tree
 * (every head file is "added"), e.g. for a root commit.
 */
export async function diffTrees(
  store: ObjectStoreBinding,
  baseTreeSha: string | null,
  headTreeSha: string | null,
  options: DiffTreesOptions = {},
): Promise<TreeDiffEntry[]> {
  const detectRenames = options.detectRenames ?? true;
  const [baseFiles, headFiles] = await Promise.all([
    flatten(store, baseTreeSha, options),
    flatten(store, headTreeSha, options),
  ]);

  const baseMap = new Map(baseFiles.map((f) => [f.path, f]));
  const headMap = new Map(headFiles.map((f) => [f.path, f]));

  const added: TreeDiffEntry[] = [];
  const modified: TreeDiffEntry[] = [];
  const deleted: TreeDiffEntry[] = [];

  for (const [path, head] of headMap) {
    const base = baseMap.get(path);
    if (!base) {
      added.push({
        path,
        status: "added",
        newSha: head.sha,
        newMode: head.mode,
      });
    } else if (base.sha !== head.sha || base.mode !== head.mode) {
      modified.push({
        path,
        status: "modified",
        oldSha: base.sha,
        newSha: head.sha,
        oldMode: base.mode,
        newMode: head.mode,
      });
    }
  }

  for (const [path, base] of baseMap) {
    if (!headMap.has(path)) {
      deleted.push({
        path,
        status: "deleted",
        oldSha: base.sha,
        oldMode: base.mode,
      });
    }
  }

  const results: TreeDiffEntry[] = [...added, ...modified, ...deleted];

  if (detectRenames && added.length > 0 && deleted.length > 0) {
    const renamed = pairRenames(added, deleted);
    if (renamed.length > 0) {
      const consumedAdd = new Set(renamed.map((r) => r.path));
      const consumedDel = new Set(renamed.map((r) => r.oldPath));
      const kept = results.filter((entry) => {
        if (entry.status === "added") return !consumedAdd.has(entry.path);
        if (entry.status === "deleted") return !consumedDel.has(entry.path);
        return true;
      });
      kept.push(...renamed);
      return sortEntries(kept);
    }
  }

  return sortEntries(results);
}

/**
 * Pair added/deleted entries that share an identical blob OID into renames.
 * A blob OID may appear multiple times; each deleted occurrence is matched to
 * at most one added occurrence (stable by sorted path).
 */
function pairRenames(
  added: TreeDiffEntry[],
  deleted: TreeDiffEntry[],
): TreeDiffEntry[] {
  const addBySha = new Map<string, TreeDiffEntry[]>();
  for (const entry of [...added].sort((a, b) => a.path.localeCompare(b.path))) {
    if (!entry.newSha) continue;
    const bucket = addBySha.get(entry.newSha);
    if (bucket) bucket.push(entry);
    else addBySha.set(entry.newSha, [entry]);
  }

  const renamed: TreeDiffEntry[] = [];
  for (const del of [...deleted].sort((a, b) => a.path.localeCompare(b.path))) {
    if (!del.oldSha) continue;
    const candidates = addBySha.get(del.oldSha);
    const add = candidates?.shift();
    if (!add) continue;
    renamed.push({
      path: add.path,
      status: "renamed",
      oldPath: del.path,
      oldSha: del.oldSha,
      newSha: add.newSha,
      oldMode: del.oldMode,
      newMode: add.newMode,
    });
  }
  return renamed;
}

function sortEntries(entries: TreeDiffEntry[]): TreeDiffEntry[] {
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

export interface TreeDiffStats {
  readonly filesChanged: number;
  readonly added: number;
  readonly modified: number;
  readonly deleted: number;
  readonly renamed: number;
}

export function summarizeTreeDiff(entries: TreeDiffEntry[]): TreeDiffStats {
  let added = 0;
  let modified = 0;
  let deleted = 0;
  let renamed = 0;
  for (const entry of entries) {
    if (entry.status === "added") added++;
    else if (entry.status === "modified") modified++;
    else if (entry.status === "deleted") deleted++;
    else renamed++;
  }
  return { filesChanged: entries.length, added, modified, deleted, renamed };
}
