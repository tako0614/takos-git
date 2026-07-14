/**
 * The ONLY sanctioned cross-store writer (R2 refs + D1 metadata).
 *
 * ## Contract
 *
 * R2 is AUTHORITATIVE for git objects and refs. D1 metadata pointers (any row
 * carrying a commit/tree SHA or ref tip) are ADVISORY projections that must be
 * re-validated against R2 on read (see {@link revalidateRefPointer}).
 *
 * Every head advance (push, PR merge, web edit, tag create) goes through here so
 * the ordering is fixed and never reinvented per feature:
 *
 *   1. Read the current authoritative refs doc + its ETag.
 *   2. Derive the next refs doc; write it with the per-repo refs-doc **ETag CAS**
 *      (`writeRepoRefs(..., expectedEtag)` in `src/git/refs-store.ts`). This CAS
 *      is the single ATOMIC COMMIT POINT — the same boundary receive-pack uses.
 *      A lost race returns `conflict` (retryable), never a silent overwrite.
 *   3. Only after R2 commits, project the D1 metadata follow-up. This step MUST
 *      be idempotent/retryable: R2 has already committed, so a D1 failure never
 *      rolls the ref back — it is reported (`metadataDeferred`) for reconcile.
 *
 * Direct `env.DB` ref writes outside this helper are banned; D1 must never become
 * a second source of truth for a ref tip.
 */

import {
  readRepoRefs,
  readRepoRefsSnapshot,
  writeRepoRefs,
  type RefsDoc,
} from "./refs-store.ts";
import type { ObjectStoreBinding } from "./types.ts";

export interface CommittedRefs {
  readonly refs: RefsDoc;
  readonly etag: string;
}

export type RefCasResult =
  /** R2 committed. `metadataDeferred` is set iff the D1 projection threw. */
  | {
      readonly status: "committed";
      readonly refs: RefsDoc;
      readonly etag: string;
      readonly metadataDeferred?: unknown;
    }
  /** ETag CAS lost the race against a concurrent writer — retryable. */
  | { readonly status: "conflict"; readonly current: RefsDoc }
  /** `mutateRefs` returned null (e.g. branch protection rejected). */
  | { readonly status: "aborted" }
  /** The repo's refs doc does not exist (create the repo first). */
  | { readonly status: "absent" };

export interface TwoPhaseWrite {
  readonly repo: string;
  /**
   * Phase 1 — derive the next refs doc from the CURRENT authoritative one. Return
   * `null` to abort without writing (rejected by policy, no-op update, etc.).
   */
  readonly mutateRefs: (
    current: RefsDoc,
  ) => RefsDoc | null | Promise<RefsDoc | null>;
  /**
   * Phase 2 — advisory D1 projection keyed to the just-committed refs. MUST be
   * idempotent/retryable; a throw is reported, not rolled back.
   */
  readonly projectMetadata?: (committed: CommittedRefs) => Promise<void>;
}

/**
 * Advance an existing repo's refs through the ETag CAS, then project D1 metadata.
 * R2 is the commit point; D1 is a retryable follow-up.
 */
export async function writeRefsWithMetadata(
  bucket: ObjectStoreBinding,
  write: TwoPhaseWrite,
): Promise<RefCasResult> {
  const snapshot = await readRepoRefsSnapshot(bucket, write.repo);
  if (!snapshot) return { status: "absent" };

  const next = await write.mutateRefs(snapshot.doc);
  if (next === null) return { status: "aborted" };

  // --- ATOMIC COMMIT POINT: R2 refs-doc ETag CAS ---
  const written = await writeRepoRefs(bucket, write.repo, next, snapshot.etag);
  if (!written) {
    // Lost the race; re-read the authoritative doc so the caller can retry.
    return { status: "conflict", current: await readRepoRefs(bucket, write.repo) };
  }

  // R2 has committed and is now authoritative. Capture the new ETag.
  const after = await readRepoRefsSnapshot(bucket, write.repo);
  const committed: CommittedRefs = {
    refs: after?.doc ?? next,
    etag: after?.etag ?? snapshot.etag,
  };

  if (write.projectMetadata) {
    try {
      await write.projectMetadata(committed);
    } catch (error) {
      // The authoritative write landed; the D1 projection is stale until a retry
      // reconciles it from R2. Never roll the ref back.
      return {
        status: "committed",
        refs: committed.refs,
        etag: committed.etag,
        metadataDeferred: error,
      };
    }
  }

  return { status: "committed", refs: committed.refs, etag: committed.etag };
}

export interface RefRevalidation {
  readonly refName: string;
  /** The SHA a D1 row claims for this ref. */
  readonly d1Sha: string;
  /** The AUTHORITATIVE tip from R2 (null if the ref no longer exists). */
  readonly r2Sha: string | null;
  /** True iff the advisory D1 pointer still matches R2 — trust it only then. */
  readonly fresh: boolean;
}

/**
 * Re-validate an advisory D1 ref pointer against the authoritative R2 refs doc.
 * A disagreement (e.g. after a force-push the D1 projection missed) is DETECTED,
 * never trusted — callers must re-derive from `r2Sha`, the source of truth.
 */
export async function revalidateRefPointer(
  bucket: ObjectStoreBinding,
  repo: string,
  refName: string,
  d1Sha: string,
): Promise<RefRevalidation> {
  const doc = await readRepoRefs(bucket, repo);
  const record = doc.refs.find((ref) => ref.name === refName);
  const r2Sha = record ? record.sha : null;
  return { refName, d1Sha, r2Sha, fresh: r2Sha !== null && r2Sha === d1Sha };
}
