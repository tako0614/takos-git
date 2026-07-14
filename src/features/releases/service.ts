/**
 * Releases / assets / tags D1 service + R2 ref resolution.
 *
 * D1 holds release/asset METADATA; the authoritative store for the tag ref and
 * the target commit stays R2. `target_sha` on a release and every SHA here is an
 * advisory projection re-derived from the R2 refs doc. All ref mutation (tag
 * create/delete, tag ref on publish) goes through the two-phase ETag-CAS writer —
 * never a direct D1 ref write.
 */

import type { PrincipalDto } from "../../contract/v1.ts";
import type { DbClient } from "../../db/index.ts";
import { objectExists } from "../../git/object-store.ts";
import { repositoryObjectStore } from "../../git/repo-object-store.ts";
import { isValidRefName, readRepoRefs, type RefsDoc } from "../../git/refs-store.ts";
import { writeRefsWithMetadata, type RefCasResult } from "../../git/two-phase.ts";
import type { ObjectStoreBinding } from "../../git/types.ts";
import type { RepoAclRow } from "../../auth/acl.ts";
import {
  toReleaseDto,
  type GitTagRow,
  type ReleaseAssetRow,
  type ReleaseDto,
  type ReleaseRow,
} from "./dto.ts";
import { peelToCommit } from "./git-tags.ts";

export function storageKeyOf(repo: RepoAclRow): string {
  return `${repo.ownerLogin}/${repo.name}`;
}

// --- principal (author) ------------------------------------------------------

export async function loadPrincipalDto(
  db: DbClient,
  id: string | null,
): Promise<PrincipalDto | null> {
  if (!id) return null;
  const row = await db.queryOne<{
    id: string;
    kind: string;
    subject: string;
    display_name: string | null;
    email: string | null;
  }>(
    `SELECT id, kind, subject, display_name, email FROM principals WHERE id = ?`,
    [id],
  );
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind as PrincipalDto["kind"],
    subject: row.subject,
    displayName: row.display_name,
    email: row.email,
  };
}

// --- release rows ------------------------------------------------------------

export async function getReleaseByTag(
  db: DbClient,
  repoId: string,
  tag: string,
): Promise<ReleaseRow | null> {
  return db.queryOne<ReleaseRow>(
    `SELECT * FROM releases WHERE repo_id = ? AND tag_name = ?`,
    [repoId, tag],
  );
}

export async function getReleaseById(
  db: DbClient,
  repoId: string,
  id: string,
): Promise<ReleaseRow | null> {
  return db.queryOne<ReleaseRow>(
    `SELECT * FROM releases WHERE repo_id = ? AND id = ?`,
    [repoId, id],
  );
}

export interface ListReleasesOpts {
  readonly includeDrafts: boolean;
  readonly limit: number;
  readonly cursor: string | null;
}

export async function listReleaseRows(
  db: DbClient,
  repoId: string,
  opts: ListReleasesOpts,
): Promise<{ rows: ReleaseRow[]; nextCursor: string | null }> {
  const clauses = ["repo_id = ?"];
  const params: unknown[] = [repoId];
  if (!opts.includeDrafts) clauses.push("is_draft = 0");
  if (opts.cursor) {
    clauses.push("id < ?");
    params.push(opts.cursor);
  }
  params.push(opts.limit + 1);
  const rows = await db.query<ReleaseRow>(
    `SELECT * FROM releases WHERE ${clauses.join(" AND ")} ORDER BY id DESC LIMIT ?`,
    params,
  );
  let nextCursor: string | null = null;
  if (rows.length > opts.limit) {
    rows.pop();
    nextCursor = rows[rows.length - 1]?.id ?? null;
  }
  return { rows, nextCursor };
}

export async function latestReleaseRow(
  db: DbClient,
  repoId: string,
): Promise<ReleaseRow | null> {
  return db.queryOne<ReleaseRow>(
    `SELECT * FROM releases
     WHERE repo_id = ? AND is_draft = 0 AND is_prerelease = 0
     ORDER BY published_at DESC, id DESC LIMIT 1`,
    [repoId],
  );
}

// --- assets ------------------------------------------------------------------

export async function listAssetRows(
  db: DbClient,
  releaseId: string,
): Promise<ReleaseAssetRow[]> {
  return db.query<ReleaseAssetRow>(
    `SELECT * FROM release_assets WHERE release_id = ? ORDER BY created_at ASC, id ASC`,
    [releaseId],
  );
}

export async function getAssetRow(
  db: DbClient,
  releaseId: string,
  assetId: string,
): Promise<ReleaseAssetRow | null> {
  return db.queryOne<ReleaseAssetRow>(
    `SELECT * FROM release_assets WHERE id = ? AND release_id = ?`,
    [assetId, releaseId],
  );
}

// --- DTO assembly ------------------------------------------------------------

export async function buildReleaseDto(
  db: DbClient,
  row: ReleaseRow,
): Promise<ReleaseDto> {
  const [assets, author] = await Promise.all([
    listAssetRows(db, row.id),
    loadPrincipalDto(db, row.author_id),
  ]);
  return toReleaseDto(row, assets, author);
}

// --- git tag metadata --------------------------------------------------------

export async function getGitTagRow(
  db: DbClient,
  repoId: string,
  name: string,
): Promise<GitTagRow | null> {
  return db.queryOne<GitTagRow>(
    `SELECT * FROM git_tags WHERE repo_id = ? AND name = ?`,
    [repoId, name],
  );
}

// --- R2 ref resolution -------------------------------------------------------

/** The tag refs (`refs/tags/*`) currently present in the authoritative refs doc. */
export function tagRefs(refs: RefsDoc): { name: string; sha: string }[] {
  return refs.refs
    .filter((ref) => ref.name.startsWith("refs/tags/"))
    .map((ref) => ({ name: ref.name.slice("refs/tags/".length), sha: ref.sha }));
}

export function findTagRef(refs: RefsDoc, name: string): string | null {
  return refs.refs.find((ref) => ref.name === `refs/tags/${name}`)?.sha ?? null;
}

/**
 * Resolve a target-commitish (branch name, tag name, or full commit SHA) to an
 * underlying commit SHA that exists in R2. Returns null when unresolvable.
 */
export async function resolveCommitish(
  store: ObjectStoreBinding,
  refs: RefsDoc,
  target: string,
): Promise<string | null> {
  const trimmed = target.trim();
  if (!trimmed) return null;
  const branch = refs.refs.find((ref) => ref.name === `refs/heads/${trimmed}`);
  if (branch) return peelToCommit(store, branch.sha);
  const tag = refs.refs.find((ref) => ref.name === `refs/tags/${trimmed}`);
  if (tag) return peelToCommit(store, tag.sha);
  if (/^[0-9a-f]{40}$/u.test(trimmed) && (await objectExists(store, trimmed))) {
    return peelToCommit(store, trimmed);
  }
  return null;
}

/** Validate a tag short name is a legal ref path component set. */
export function isValidTagName(name: string): boolean {
  return isValidRefName(`refs/tags/${name}`);
}

// --- two-phase tag ref mutation ---------------------------------------------

/**
 * Create `refs/tags/<name>` pointing at `targetSha` (a commit for lightweight, a
 * tag object for annotated). Fails (`aborted`) if the tag already exists. R2 is
 * the atomic commit point.
 */
export async function createTagRef(
  bucket: ObjectStoreBinding,
  storageKey: string,
  name: string,
  targetSha: string,
): Promise<RefCasResult> {
  const refName = `refs/tags/${name}`;
  return writeRefsWithMetadata(bucket, {
    repo: storageKey,
    mutateRefs: (current) => {
      if (current.refs.some((ref) => ref.name === refName)) return null;
      return {
        ...current,
        refs: [...current.refs, { name: refName, sha: targetSha }],
      };
    },
  });
}

/** Remove `refs/tags/<name>`. `aborted` when the tag is absent. */
export async function deleteTagRef(
  bucket: ObjectStoreBinding,
  storageKey: string,
  name: string,
): Promise<RefCasResult> {
  const refName = `refs/tags/${name}`;
  return writeRefsWithMetadata(bucket, {
    repo: storageKey,
    mutateRefs: (current) => {
      if (!current.refs.some((ref) => ref.name === refName)) return null;
      return {
        ...current,
        refs: current.refs.filter((ref) => ref.name !== refName),
      };
    },
  });
}

export async function readRefsFor(
  bucket: ObjectStoreBinding,
  storageKey: string,
): Promise<RefsDoc> {
  return readRepoRefs(bucket, storageKey);
}

export function objectStoreFor(
  bucket: ObjectStoreBinding,
  storageKey: string,
): ObjectStoreBinding {
  return repositoryObjectStore(bucket, storageKey);
}
