/**
 * 3-way tree merge — path-level OID/mode comparison.
 *
 * Ported from the takos worker's `local/core/merge.ts`. Reconciled onto
 * takos-git's local `ObjectStoreBinding` (`./types.ts`) and R2-backed
 * `tree-ops.ts`; otherwise pure.
 *
 * The merge is path/OID/mode-level only: it decides, per path, whether the
 * merged tree takes the base, local, or upstream entry, and reports a conflict
 * when local and upstream both change a path incompatibly. It does NOT
 * content-merge (no diff3) — that is intentionally out of scope. A clean merge
 * returns the built tree SHA; a conflicting one returns `treeSha: null` plus the
 * classified conflict list.
 */

import type { ObjectStoreBinding } from "./types.ts";
import type { MergeConflict, MergeConflictType } from "./git-objects.ts";
import { buildTreeFromPaths, flattenTree } from "./tree-ops.ts";

interface TreeFileEntry {
  sha: string;
  mode: string;
}

export interface MergeResult {
  readonly treeSha: string | null;
  readonly conflicts: MergeConflict[];
}

function entriesEqual(
  a: TreeFileEntry | null,
  b: TreeFileEntry | null,
): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.sha === b.sha && a.mode === b.mode;
}

function classifyConflict(
  base: TreeFileEntry | null,
  local: TreeFileEntry | null,
  upstream: TreeFileEntry | null,
): MergeConflictType {
  if (base === null && local !== null && upstream !== null) return "add-add";

  const localDeleted = base !== null && local === null;
  const upstreamDeleted = base !== null && upstream === null;
  if ((localDeleted && upstream !== null) || (upstreamDeleted && local !== null))
    return "delete-modify";

  return "content";
}

export async function mergeTrees3Way(
  store: ObjectStoreBinding,
  baseTreeSha: string,
  localTreeSha: string,
  upstreamTreeSha: string,
): Promise<MergeResult> {
  const [baseFiles, localFiles, upstreamFiles] = await Promise.all([
    flattenTree(store, baseTreeSha),
    flattenTree(store, localTreeSha),
    flattenTree(store, upstreamTreeSha),
  ]);

  const toMap = (
    files: Array<{ path: string; sha: string; mode: string }>,
  ): Map<string, TreeFileEntry> =>
    new Map(files.map((f) => [f.path, { sha: f.sha, mode: f.mode }]));

  const baseMap = toMap(baseFiles);
  const localMap = toMap(localFiles);
  const upstreamMap = toMap(upstreamFiles);

  const mergedMap = new Map<string, TreeFileEntry>();
  const conflicts: MergeConflict[] = [];

  const allPaths = new Set([
    ...baseMap.keys(),
    ...localMap.keys(),
    ...upstreamMap.keys(),
  ]);

  for (const path of allPaths) {
    const baseEntry = baseMap.get(path) || null;
    const localEntry = localMap.get(path) || null;
    const upstreamEntry = upstreamMap.get(path) || null;

    const localChanged = !entriesEqual(baseEntry, localEntry);
    const upstreamChanged = !entriesEqual(baseEntry, upstreamEntry);

    if (!localChanged && !upstreamChanged) {
      if (baseEntry) mergedMap.set(path, baseEntry);
      continue;
    }

    if (localChanged && !upstreamChanged) {
      if (localEntry) mergedMap.set(path, localEntry);
      continue;
    }

    if (!localChanged && upstreamChanged) {
      if (upstreamEntry) mergedMap.set(path, upstreamEntry);
      continue;
    }

    if (entriesEqual(localEntry, upstreamEntry)) {
      if (localEntry) mergedMap.set(path, localEntry);
      continue;
    }

    conflicts.push({
      path,
      type: classifyConflict(baseEntry, localEntry, upstreamEntry),
    });
  }

  if (conflicts.length > 0) {
    conflicts.sort((a, b) => a.path.localeCompare(b.path));
    return { treeSha: null, conflicts };
  }

  const mergedFiles = Array.from(mergedMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, entry]) => ({ path, sha: entry.sha, mode: entry.mode }));

  const treeSha = await buildTreeFromPaths(store, mergedFiles);
  return { treeSha, conflicts: [] };
}
