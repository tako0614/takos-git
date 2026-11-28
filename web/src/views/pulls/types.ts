/**
 * View-local wire shapes for the conflict inspection payload, which is not
 * modelled in the shared api/types mirror. These MIRROR the server
 * `features/pulls/merge-resolution.ts` `ConflictCheck`/`DetailedConflict` shapes.
 */
import type { DiffPayload } from "../../api/types.ts";

export interface DetailedConflict {
  readonly path: string;
  readonly type: string;
  readonly base: string | null;
  readonly ours: string | null;
  readonly theirs: string | null;
}

export interface ConflictsResponse {
  readonly mergeable: boolean;
  readonly mergeBase: string | null;
  readonly conflicts: readonly DetailedConflict[];
  readonly message?: string;
}

/** A single changed file inside a `DiffPayload` (PR diff / files list). */
export type PrFile = DiffPayload["files"][number];

/** A user's chosen resolution for one conflicting path. */
export interface Resolution {
  readonly path: string;
  readonly content: string;
  readonly delete: boolean;
  readonly source: "ours" | "theirs" | "manual" | "delete";
}

/**
 * Report whether the conflict editor textarea has unapplied edits relative to
 * the currently selected file's recorded resolution. When a file is marked for
 * deletion, any subsequent edit to the textarea (`dirty === true`) surfaces as
 * unapplied so the user can apply their edited content instead of deleting.
 */
export function hasUnappliedConflictEdit(
  resolution: Resolution | undefined,
  draft: string,
  dirty: boolean,
): boolean {
  if (!resolution) return true;
  return resolution.delete ? dirty : draft !== resolution.content;
}
