/**
 * Git tag handlers (list / create / delete).
 *
 * Tags are refs in the authoritative R2 refs doc. Listing reads that doc directly
 * (`contents.read`); creating/deleting a tag is a ref write done through the
 * two-phase ETag-CAS writer (`releases.write` — writer floor,
 * `source.git.hosting.write` scope; note in the feature report). An ANNOTATED tag
 * additionally writes a git `tag` object to R2 and caches its metadata in the D1
 * `git_tags` projection.
 */

import { SCOPES } from "../../contract/v1.ts";
import type { RouteContext } from "../../router.ts";
import { csrfGuard, requireRepoAccess } from "../repos/identity.ts";
import { errorResponse, json } from "../repos/http.ts";
import type { TagDto } from "./dto.ts";
import {
  createTagRef,
  deleteTagRef,
  findTagRef,
  getGitTagRow,
  isValidTagName,
  objectStoreFor,
  readRefsFor,
  resolveCommitish,
  storageKeyOf,
  tagRefs,
} from "./service.ts";
import { peelToCommit, writeAnnotatedTag } from "./git-tags.ts";
import type { RefCasResult } from "../../git/two-phase.ts";

const MAX_TAG_LEN = 255;
const MAX_TAG_MESSAGE = 16 * 1024;

async function readJson(ctx: RouteContext): Promise<Record<string, unknown> | null> {
  try {
    const parsed = await ctx.request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function tagRefError(result: RefCasResult): Response | null {
  switch (result.status) {
    case "committed":
      return null;
    case "aborted":
      return errorResponse(409, "tag_exists", "The tag already exists.");
    case "conflict":
      return errorResponse(409, "ref_update_conflict", "Tag refs changed concurrently; retry.");
    case "absent":
      return errorResponse(409, "repo_refs_absent", "Repository has no refs document.");
    default:
      return errorResponse(500, "ref_write_failed", "Tag ref write failed.");
  }
}

export async function listTagsHandler(ctx: RouteContext): Promise<Response> {
  const access = await requireRepoAccess(ctx, "contents.read", SCOPES.hostingRead);
  if (access instanceof Response) return access;
  const { db, repo } = access;
  const storageKey = storageKeyOf(repo);
  const store = objectStoreFor(ctx.env.BUCKET, storageKey);
  const refs = await readRefsFor(ctx.env.BUCKET, storageKey);
  const entries = tagRefs(refs).sort((left, right) => left.name.localeCompare(right.name));

  const tags: TagDto[] = [];
  for (const entry of entries) {
    const annotation = await getGitTagRow(db, repo.id, entry.name);
    const commitSha = await peelToCommit(store, entry.sha);
    tags.push({
      name: entry.name,
      sha: entry.sha,
      commitSha,
      annotated: annotation !== null || commitSha !== entry.sha,
      tagger: annotation
        ? { name: annotation.tagger_name, email: annotation.tagger_email }
        : null,
      taggedAt: annotation?.tagged_at ?? null,
      message: annotation?.message ?? null,
    });
  }
  return json({ tags });
}

export async function createTagHandler(ctx: RouteContext): Promise<Response> {
  const access = await requireRepoAccess(ctx, "releases.write", SCOPES.hostingWrite);
  if (access instanceof Response) return access;
  const csrf = csrfGuard(ctx, access.auth);
  if (csrf) return csrf;
  const { db, repo, auth } = access;

  const body = await readJson(ctx);
  if (!body) return errorResponse(400, "invalid_body", "Expected a JSON object.");
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > MAX_TAG_LEN || !isValidTagName(name)) {
    return errorResponse(422, "invalid_tag", "A valid tag name is required.");
  }
  const target = typeof body.target === "string" ? body.target : "";
  if (!target) return errorResponse(422, "target_required", "A `target` commitish is required.");
  const message = typeof body.message === "string" ? body.message : null;
  if (message && message.length > MAX_TAG_MESSAGE) {
    return errorResponse(422, "invalid_message", "Tag message is too long.");
  }
  const annotated = body.annotated === true || message !== null;

  const storageKey = storageKeyOf(repo);
  const store = objectStoreFor(ctx.env.BUCKET, storageKey);
  const refs = await readRefsFor(ctx.env.BUCKET, storageKey);
  if (findTagRef(refs, name)) {
    return errorResponse(409, "tag_exists", "The tag already exists.");
  }
  const commitSha = await resolveCommitish(store, refs, target);
  if (!commitSha) {
    return errorResponse(422, "invalid_target", "target does not resolve to a reachable commit.");
  }

  const now = db.now();
  let refTarget = commitSha;
  let tagObjectSha: string | null = null;
  if (annotated) {
    const tagger = readTagger(body, auth);
    tagObjectSha = await writeAnnotatedTag(store, {
      targetSha: commitSha,
      targetType: "commit",
      tagName: name,
      tagger: { ...tagger, timestamp: Math.floor(now / 1000), tzOffset: "+0000" },
      message: message ?? name,
    });
    refTarget = tagObjectSha;
  }

  const refResult = await createTagRef(ctx.env.BUCKET, storageKey, name, refTarget);
  const refErr = tagRefError(refResult);
  if (refErr) return refErr;

  if (annotated && tagObjectSha) {
    const tagger = readTagger(body, auth);
    await db.run(
      `INSERT OR REPLACE INTO git_tags
         (repo_id, name, tag_sha, target_sha, tagger_name, tagger_email, tagged_at, message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [repo.id, name, tagObjectSha, commitSha, tagger.name, tagger.email, now, message],
    );
  }

  const dto: TagDto = {
    name,
    sha: refTarget,
    commitSha,
    annotated,
    tagger: annotated ? pickTagger(body, auth) : null,
    taggedAt: annotated ? now : null,
    message: annotated ? message : null,
  };
  return json({ tag: dto }, 201);
}

export async function deleteTagHandler(ctx: RouteContext): Promise<Response> {
  const access = await requireRepoAccess(ctx, "releases.write", SCOPES.hostingWrite);
  if (access instanceof Response) return access;
  const csrf = csrfGuard(ctx, access.auth);
  if (csrf) return csrf;
  const { db, repo } = access;
  const name = ctx.params.name;
  const storageKey = storageKeyOf(repo);
  const result = await deleteTagRef(ctx.env.BUCKET, storageKey, name);
  if (result.status === "aborted") {
    return errorResponse(404, "not_found", "Tag not found.");
  }
  if (result.status !== "committed") {
    const refErr = tagRefError(result);
    if (refErr) return refErr;
  }
  await db.run(`DELETE FROM git_tags WHERE repo_id = ? AND name = ?`, [repo.id, name]);
  return json({ deleted: true });
}

function readTagger(
  body: Record<string, unknown>,
  auth: { principal: { displayName?: string | null; email?: string | null; subject: string } },
): { name: string; email: string } {
  const raw = body.tagger;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : null;
    const email = typeof record.email === "string" ? record.email : null;
    if (name && email) return { name, email };
  }
  return {
    name: auth.principal.displayName || auth.principal.subject || "Takos Git",
    email: auth.principal.email || "git@takos.test",
  };
}

function pickTagger(
  body: Record<string, unknown>,
  auth: { principal: { displayName?: string | null; email?: string | null; subject: string } },
): { name: string | null; email: string | null } {
  const tagger = readTagger(body, auth);
  return { name: tagger.name, email: tagger.email };
}

export const tagHandlers = {
  list: listTagsHandler,
  create: createTagHandler,
  remove: deleteTagHandler,
};
