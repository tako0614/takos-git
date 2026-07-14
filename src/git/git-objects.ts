export type GitObjectType = "blob" | "tree" | "commit" | "tag";

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

export interface GitSignature {
  name: string;
  email: string;
  timestamp: number; // unix epoch seconds
  tzOffset: string; // e.g. "+0900"
}

export interface GitCommit {
  sha: string;
  tree: string;
  parents: string[];
  author: GitSignature;
  committer: GitSignature;
  message: string;
}

export type MergeConflictType = "content" | "delete-modify" | "add-add";

export interface MergeConflict {
  path: string;
  type: MergeConflictType;
}

export const FILE_MODES = {
  REGULAR_FILE: "100644",
  EXECUTABLE: "100755",
  SYMLINK: "120000",
  DIRECTORY: "040000",
} as const;

/** SHA-1 hex pattern (40 lowercase hex chars) */
export const SHA1_PATTERN = /^[0-9a-f]{40}$/;

/** Validate a SHA-1 hex string */
export function isValidSha(sha: string): boolean {
  return SHA1_PATTERN.test(sha);
}
