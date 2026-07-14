/**
 * LCS-based per-line blame over the R2 object store.
 *
 * Extracts the pure core of the takos worker's blame handler
 * (`server/routes/repos/git-advanced.ts:handleBlameRequest`), reworked R2-only:
 * `getCommit(DB,repoId,…)` → `getCommitData(store,…)`,
 * `resolveReadableCommitFromRef` → a resolved start commit passed in by the
 * caller, `getBlobOidAtPath` → `getEntryAtPath` (`tree-ops.ts`). Attribution
 * uses the same first-parent walk + `diffLinesLcs` line matching.
 */

import type { ObjectStoreBinding } from "./types.ts";
import type { GitCommit } from "./git-objects.ts";
import { getBlob, getCommitData, GitObjectTooLargeError } from "./object-store.ts";
import { getEntryAtPath } from "./tree-ops.ts";
import { decodeBlobContent, diffLinesLcs } from "./text-diff.ts";

export interface BlameLimits {
  readonly maxFileBytes?: number;
  readonly maxLines?: number;
  readonly maxCommits?: number;
}

const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_MAX_LINES = 50_000;
const DEFAULT_MAX_COMMITS = 500;

export interface BlameLine {
  readonly line: number; // 1-based
  readonly content: string;
  readonly commitSha: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly date: string | null; // ISO 8601
  readonly message: string;
}

export type BlameResult =
  | {
      readonly ok: true;
      readonly resolvedCommitSha: string;
      readonly truncated: boolean;
      readonly lines: BlameLine[];
    }
  | {
      readonly ok: false;
      readonly reason:
        | "commit_not_found"
        | "file_not_found"
        | "too_large"
        | "binary";
    };

async function blobOidAtPath(
  store: ObjectStoreBinding,
  treeSha: string,
  path: string,
): Promise<string | null> {
  const entry = await getEntryAtPath(store, treeSha, path);
  if (!entry || entry.type !== "blob") return null;
  return entry.sha;
}

function commitDate(commit: GitCommit): string | null {
  const seconds = commit.committer.timestamp;
  if (!Number.isSafeInteger(seconds)) return null;
  try {
    return new Date(seconds * 1000).toISOString();
  } catch {
    return null;
  }
}

/**
 * Blame `path` as of the already-resolved commit `startCommitSha`. The caller
 * is responsible for resolving a ref name → commit SHA (and for enforcing the
 * "browse by branch/tag name, not arbitrary SHA" rule); this stays pure.
 */
export async function blameFile(
  store: ObjectStoreBinding,
  startCommitSha: string,
  path: string,
  limits: BlameLimits = {},
): Promise<BlameResult> {
  const maxFileBytes = limits.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxLines = limits.maxLines ?? DEFAULT_MAX_LINES;
  const maxCommits = limits.maxCommits ?? DEFAULT_MAX_COMMITS;

  const headCommit = await getCommitData(store, startCommitSha);
  if (!headCommit) return { ok: false, reason: "commit_not_found" };

  const headOid = await blobOidAtPath(store, headCommit.tree, path);
  if (!headOid) return { ok: false, reason: "file_not_found" };

  const changeCommits: Array<{ commit: GitCommit; lines: string[] }> = [];
  let cursorCommit: GitCommit | null = headCommit;
  let cursorOid: string | null = headOid;
  let truncated = false;

  while (cursorCommit && cursorOid) {
    const parentSha: string | null = cursorCommit.parents[0] || null;
    const parentCommit: GitCommit | null = parentSha
      ? await getCommitData(store, parentSha)
      : null;
    const parentOid = parentCommit
      ? await blobOidAtPath(store, parentCommit.tree, path)
      : null;

    if (cursorOid !== parentOid) {
      let blob: Uint8Array | null;
      try {
        blob = await getBlob(store, cursorOid, maxFileBytes);
      } catch (error) {
        if (error instanceof GitObjectTooLargeError) {
          return { ok: false, reason: "too_large" };
        }
        throw error;
      }
      if (!blob) return { ok: false, reason: "file_not_found" };
      const decoded = decodeBlobContent(blob);
      if (decoded.isBinary) return { ok: false, reason: "binary" };
      const lines = decoded.text.split("\n");
      if (lines.length > maxLines) return { ok: false, reason: "too_large" };
      changeCommits.push({ commit: cursorCommit, lines });
    }

    if (!parentCommit || parentOid === null) break;

    cursorCommit = parentCommit;
    cursorOid = parentOid;

    if (changeCommits.length > maxCommits) {
      truncated = true;
      break;
    }
  }

  changeCommits.reverse(); // oldest -> newest

  const commitBySha = new Map(
    changeCommits.map(({ commit }) => [commit.sha, commit]),
  );

  let currentLines: string[] = [];
  let attributions: string[] = [];
  for (const { commit, lines } of changeCommits) {
    const ops = diffLinesLcs(currentLines, lines);
    const nextAttrib: string[] = [];
    let oldIdx = 0;
    for (const op of ops) {
      if (op.type === "equal") {
        nextAttrib.push(attributions[oldIdx]);
        oldIdx++;
        continue;
      }
      if (op.type === "delete") {
        oldIdx++;
        continue;
      }
      nextAttrib.push(commit.sha);
    }
    currentLines = lines;
    attributions = nextAttrib;
  }

  const lines: BlameLine[] = currentLines.map((content, idx) => {
    const sha = attributions[idx] || startCommitSha;
    const commit = commitBySha.get(sha) || headCommit;
    return {
      line: idx + 1,
      content,
      commitSha: sha,
      authorName: commit.author.name,
      authorEmail: commit.author.email,
      date: commitDate(commit),
      message: commit.message,
    };
  });

  return { ok: true, resolvedCommitSha: startCommitSha, truncated, lines };
}
