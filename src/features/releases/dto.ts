/**
 * Releases / assets / tags DTOs and row→DTO mappers.
 *
 * The wire surface is a versioned takos-git shape (not GitHub REST wire-compat).
 * SHAs (`targetSha`) are advisory projections of the authoritative R2 refs doc.
 */

import type { PrincipalDto } from "../../contract/v1.ts";

// --- persisted row shapes (mirror migrations/0001_init.sql) ------------------

export interface ReleaseRow {
  readonly id: string;
  readonly repo_id: string;
  readonly tag_name: string;
  readonly target_sha: string | null;
  readonly name: string | null;
  readonly body: string | null;
  readonly is_draft: number;
  readonly is_prerelease: number;
  readonly author_id: string | null;
  readonly created_at: number;
  readonly published_at: number | null;
}

export interface ReleaseAssetRow {
  readonly id: string;
  readonly release_id: string;
  readonly name: string;
  readonly r2_key: string;
  readonly content_type: string | null;
  readonly size_bytes: number | null;
  readonly checksum_sha256: string | null;
  readonly download_count: number;
  readonly state: string;
  readonly created_at: number;
}

export interface GitTagRow {
  readonly repo_id: string;
  readonly name: string;
  readonly tag_sha: string;
  readonly target_sha: string;
  readonly tagger_name: string | null;
  readonly tagger_email: string | null;
  readonly tagged_at: number | null;
  readonly message: string | null;
}

// --- DTOs --------------------------------------------------------------------

export interface ReleaseAssetDto {
  readonly id: string;
  readonly name: string;
  readonly contentType: string | null;
  readonly size: number | null;
  readonly checksumSha256: string | null;
  readonly downloadCount: number;
  readonly state: string;
  readonly createdAt: number;
}

export interface ReleaseDto {
  readonly id: string;
  readonly tag: string;
  readonly name: string | null;
  readonly body: string | null;
  readonly targetSha: string | null;
  readonly isDraft: boolean;
  readonly isPrerelease: boolean;
  readonly author: PrincipalDto | null;
  readonly createdAt: number;
  readonly publishedAt: number | null;
  readonly assets: readonly ReleaseAssetDto[];
}

export interface TagDto {
  readonly name: string;
  /** The ref target SHA (tag object for annotated, commit for lightweight). */
  readonly sha: string;
  /** The underlying commit SHA (peeled), when resolvable. */
  readonly commitSha: string | null;
  readonly annotated: boolean;
  readonly tagger: { readonly name: string | null; readonly email: string | null } | null;
  readonly taggedAt: number | null;
  readonly message: string | null;
}

export function toAssetDto(row: ReleaseAssetRow): ReleaseAssetDto {
  return {
    id: row.id,
    name: row.name,
    contentType: row.content_type,
    size: row.size_bytes,
    checksumSha256: row.checksum_sha256,
    downloadCount: row.download_count,
    state: row.state,
    createdAt: row.created_at,
  };
}

export function toReleaseDto(
  row: ReleaseRow,
  assets: readonly ReleaseAssetRow[],
  author: PrincipalDto | null,
): ReleaseDto {
  return {
    id: row.id,
    tag: row.tag_name,
    name: row.name,
    body: row.body,
    targetSha: row.target_sha,
    isDraft: row.is_draft !== 0,
    isPrerelease: row.is_prerelease !== 0,
    author,
    createdAt: row.created_at,
    publishedAt: row.published_at,
    assets: assets.map(toAssetDto),
  };
}
