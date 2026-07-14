/**
 * Release CRUD handlers (list / latest / get / create / edit / delete).
 *
 * Shared web+automation surface: each route registers `auth:"public"` and gates
 * through `requireRepoAccess`. Reads use `contents.read` (anonymous ok on public
 * repos); draft releases are visible only to writer+. Mutations use
 * `releases.write` (writer floor, `source.git.hosting.write` scope) and browser
 * mutations pass `csrfGuard`. Creating/publishing a non-draft release materializes
 * the tag ref through the two-phase R2 ETag-CAS writer — never a direct D1 ref.
 */

import { SCOPES, roleAtLeast } from "../../contract/v1.ts";
import type { RouteContext } from "../../router.ts";
import { csrfGuard, requireRepoAccess } from "../repos/identity.ts";
import { errorResponse, json } from "../repos/http.ts";
import {
  buildReleaseDeletedEvent,
  buildReleaseEditedEvent,
  buildReleasePublishedEvent,
  emitReleaseEvent,
  type ReleaseEvent,
} from "./events.ts";
import type { ReleaseDto } from "./dto.ts";
import {
  buildReleaseDto,
  createTagRef,
  findTagRef,
  getReleaseByTag,
  isValidTagName,
  latestReleaseRow,
  listReleaseRows,
  objectStoreFor,
  readRefsFor,
  resolveCommitish,
  storageKeyOf,
} from "./service.ts";
import { peelToCommit } from "./git-tags.ts";
import type { RefCasResult } from "../../git/two-phase.ts";

const MAX_TAG_LEN = 255;
const MAX_NAME_LEN = 512;
const MAX_BODY_LEN = 128 * 1024;

async function readJson(ctx: RouteContext): Promise<Record<string, unknown> | null> {
  try {
    const parsed = await ctx.request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function optionalString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

/** Map a two-phase ref result to an error Response, or null on success. */
function tagRefError(result: RefCasResult): Response | null {
  switch (result.status) {
    case "committed":
    case "aborted": // ref already present — idempotent for our purposes
      return null;
    case "conflict":
      return errorResponse(
        409,
        "ref_update_conflict",
        "The tag ref changed concurrently; retry.",
      );
    case "absent":
      return errorResponse(409, "repo_refs_absent", "Repository has no refs document.");
    default:
      return errorResponse(500, "ref_write_failed", "Tag ref write failed.");
  }
}

export async function listReleasesHandler(ctx: RouteContext): Promise<Response> {
  const access = await requireRepoAccess(ctx, "contents.read", SCOPES.hostingRead);
  if (access instanceof Response) return access;
  const { db, repo, role } = access;
  const canSeeDrafts = roleAtLeast(role, "writer");
  const includeDrafts = ctx.url.searchParams.get("include_drafts") === "true" && canSeeDrafts;
  const requested = Number.parseInt(ctx.url.searchParams.get("limit") ?? "", 10);
  const limit = Number.isSafeInteger(requested)
    ? Math.max(1, Math.min(requested, 100))
    : 30;
  const cursor = ctx.url.searchParams.get("cursor");
  const { rows, nextCursor } = await listReleaseRows(db, repo.id, {
    includeDrafts,
    limit,
    cursor: cursor && cursor.length <= 64 ? cursor : null,
  });
  const releases = await Promise.all(rows.map((row) => buildReleaseDto(db, row)));
  return json({ releases, nextCursor });
}

export async function latestReleaseHandler(ctx: RouteContext): Promise<Response> {
  const access = await requireRepoAccess(ctx, "contents.read", SCOPES.hostingRead);
  if (access instanceof Response) return access;
  const { db, repo } = access;
  const row = await latestReleaseRow(db, repo.id);
  if (!row) return errorResponse(404, "not_found", "No published release.");
  return json({ release: await buildReleaseDto(db, row) });
}

export async function getReleaseHandler(ctx: RouteContext): Promise<Response> {
  const access = await requireRepoAccess(ctx, "contents.read", SCOPES.hostingRead);
  if (access instanceof Response) return access;
  const { db, repo, role } = access;
  const row = await getReleaseByTag(db, repo.id, ctx.params.tag);
  if (!row) return errorResponse(404, "not_found", "Release not found.");
  if (row.is_draft !== 0 && !roleAtLeast(role, "writer")) {
    return errorResponse(404, "not_found", "Release not found.");
  }
  return json({ release: await buildReleaseDto(db, row) });
}

export async function createReleaseHandler(ctx: RouteContext): Promise<Response> {
  const access = await requireRepoAccess(ctx, "releases.write", SCOPES.hostingWrite);
  if (access instanceof Response) return access;
  const csrf = csrfGuard(ctx, access.auth);
  if (csrf) return csrf;
  const { db, repo, auth } = access;

  const body = await readJson(ctx);
  if (!body) return errorResponse(400, "invalid_body", "Expected a JSON object.");
  const tag = typeof body.tag === "string" ? body.tag.trim() : "";
  if (!tag || tag.length > MAX_TAG_LEN || !isValidTagName(tag)) {
    return errorResponse(422, "invalid_tag", "A valid tag name is required.");
  }
  const name = optionalString(body.name);
  const releaseBody = optionalString(body.body ?? body.description);
  if (name && name.length > MAX_NAME_LEN) {
    return errorResponse(422, "invalid_name", "Release name is too long.");
  }
  if (releaseBody && releaseBody.length > MAX_BODY_LEN) {
    return errorResponse(422, "invalid_body", "Release body is too long.");
  }
  const target = typeof body.target === "string" ? body.target : (typeof body.target_commitish === "string" ? body.target_commitish : null);
  const isDraft = body.is_draft === true;
  const isPrerelease = body.is_prerelease === true;

  if (await getReleaseByTag(db, repo.id, tag)) {
    return errorResponse(409, "release_exists", "A release with this tag already exists.");
  }

  const storageKey = storageKeyOf(repo);
  const store = objectStoreFor(ctx.env.BUCKET, storageKey);
  const refs = await readRefsFor(ctx.env.BUCKET, storageKey);

  // Resolve the target commit: existing tag ref wins; else the given commitish.
  let targetSha: string | null = null;
  const existingTagSha = findTagRef(refs, tag);
  if (existingTagSha) {
    targetSha = await peelToCommit(store, existingTagSha);
    if (!targetSha) return errorResponse(422, "invalid_tag_target", "Tag ref does not resolve to a commit.");
  } else if (target) {
    targetSha = await resolveCommitish(store, refs, target);
    if (!targetSha) return errorResponse(422, "invalid_target", "target does not resolve to a reachable commit.");
  } else if (!isDraft) {
    return errorResponse(422, "target_required", "A published release needs an existing tag or a target.");
  }

  // A non-draft release materializes the tag ref if it is not already present.
  if (!isDraft && targetSha && !existingTagSha) {
    const refResult = await createTagRef(ctx.env.BUCKET, storageKey, tag, targetSha);
    const refErr = tagRefError(refResult);
    if (refErr) return refErr;
  }

  const id = db.id();
  const now = db.now();
  const publishedAt = isDraft ? null : now;
  await db.run(
    `INSERT INTO releases
       (id, repo_id, tag_name, target_sha, name, body, is_draft, is_prerelease, author_id, created_at, published_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      repo.id,
      tag,
      targetSha,
      name ?? tag,
      releaseBody ?? null,
      isDraft ? 1 : 0,
      isPrerelease ? 1 : 0,
      auth.principal.id === "anon" ? null : auth.principal.id,
      now,
      publishedAt,
    ],
  );

  const row = (await getReleaseByTag(db, repo.id, tag))!;
  const dto = await buildReleaseDto(db, row);
  const event = isDraft ? undefined : buildReleasePublishedEvent(storageKey, dto, now);
  if (event) await emitReleaseEvent(event);
  return json(publishedEnvelope(dto, event), 201);
}

export async function patchReleaseHandler(ctx: RouteContext): Promise<Response> {
  const access = await requireRepoAccess(ctx, "releases.write", SCOPES.hostingWrite);
  if (access instanceof Response) return access;
  const csrf = csrfGuard(ctx, access.auth);
  if (csrf) return csrf;
  const { db, repo } = access;

  const existing = await getReleaseByTag(db, repo.id, ctx.params.tag);
  if (!existing) return errorResponse(404, "not_found", "Release not found.");

  const body = await readJson(ctx);
  if (!body) return errorResponse(400, "invalid_body", "Expected a JSON object.");

  const sets: string[] = [];
  const params: unknown[] = [];
  const name = optionalString(body.name);
  const releaseBody = optionalString(body.body ?? body.description);
  if (name !== undefined) {
    if (name && name.length > MAX_NAME_LEN) {
      return errorResponse(422, "invalid_name", "Release name is too long.");
    }
    sets.push("name = ?");
    params.push(name);
  }
  if (releaseBody !== undefined) {
    if (releaseBody && releaseBody.length > MAX_BODY_LEN) {
      return errorResponse(422, "invalid_body", "Release body is too long.");
    }
    sets.push("body = ?");
    params.push(releaseBody);
  }
  if (typeof body.is_prerelease === "boolean") {
    sets.push("is_prerelease = ?");
    params.push(body.is_prerelease ? 1 : 0);
  }

  const now = db.now();
  let publishing = false;
  if (typeof body.is_draft === "boolean") {
    sets.push("is_draft = ?");
    params.push(body.is_draft ? 1 : 0);
    if (existing.is_draft !== 0 && !body.is_draft) {
      publishing = true;
      sets.push("published_at = ?");
      params.push(now);
    }
  }

  if (sets.length === 0) {
    return errorResponse(422, "no_updates", "No updatable fields provided.");
  }

  // Publishing a previously-draft release materializes its tag ref.
  if (publishing) {
    const storageKey = storageKeyOf(repo);
    if (!existing.target_sha) {
      return errorResponse(422, "target_required", "Cannot publish a draft with no target commit.");
    }
    const refs = await readRefsFor(ctx.env.BUCKET, storageKey);
    if (!findTagRef(refs, existing.tag_name)) {
      const refResult = await createTagRef(
        ctx.env.BUCKET,
        storageKey,
        existing.tag_name,
        existing.target_sha,
      );
      const refErr = tagRefError(refResult);
      if (refErr) return refErr;
    }
  }

  params.push(repo.id, ctx.params.tag);
  await db.run(
    `UPDATE releases SET ${sets.join(", ")} WHERE repo_id = ? AND tag_name = ?`,
    params,
  );

  const row = (await getReleaseByTag(db, repo.id, ctx.params.tag))!;
  const dto = await buildReleaseDto(db, row);
  const storageKey = storageKeyOf(repo);
  // Publishing (draft→non-draft) fans out `release.published`; every other edit
  // that changed a field fans out `release.edited`. Both go to the sink; only the
  // published descriptor is echoed in the HTTP envelope (unchanged wire shape).
  const event = publishing
    ? buildReleasePublishedEvent(storageKey, dto, now)
    : undefined;
  await emitReleaseEvent(event ?? buildReleaseEditedEvent(storageKey, dto, now));
  return json(publishedEnvelope(dto, event));
}

export async function deleteReleaseHandler(ctx: RouteContext): Promise<Response> {
  const access = await requireRepoAccess(ctx, "releases.write", SCOPES.hostingWrite);
  if (access instanceof Response) return access;
  const csrf = csrfGuard(ctx, access.auth);
  if (csrf) return csrf;
  const { db, repo } = access;
  const existing = await getReleaseByTag(db, repo.id, ctx.params.tag);
  if (!existing) return errorResponse(404, "not_found", "Release not found.");
  // Snapshot the DTO before the row (and its assets) vanish so the deleted event
  // carries the release that was removed.
  const dto = await buildReleaseDto(db, existing);
  // The tag ref is intentionally left in place (GitHub parity: deleting a release
  // does not delete its git tag). Assets cascade-delete with the release row; R2
  // asset bytes are swept by the reconcile job keyed off the dropped rows.
  await db.run(`DELETE FROM releases WHERE repo_id = ? AND tag_name = ?`, [
    repo.id,
    ctx.params.tag,
  ]);
  await emitReleaseEvent(buildReleaseDeletedEvent(storageKeyOf(repo), dto, db.now()));
  return json({ deleted: true });
}

/** `{ release }` plus a non-persisted `event` descriptor when one fired. */
function publishedEnvelope(
  release: ReleaseDto,
  event: ReleaseEvent | undefined,
): Record<string, unknown> {
  return event ? { release, event } : { release };
}

export const releaseHandlers = {
  list: listReleasesHandler,
  latest: latestReleaseHandler,
  get: getReleaseHandler,
  create: createReleaseHandler,
  patch: patchReleaseHandler,
  remove: deleteReleaseHandler,
};
