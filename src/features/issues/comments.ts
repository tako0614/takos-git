/**
 * Issue conversation comment handlers (not inline code review comments).
 *
 * List/read authorize `contents.read`. Create authorizes `issues.write` (writer
 * floor). Edit/delete authorize `issues.write` and then additionally require the
 * caller be the comment author OR a maintainer — a writer cannot rewrite another
 * user's comment.
 */

import {
  SCOPES,
  paginatedBody,
  roleAtLeast,
  type Role,
} from "../../contract/v1.ts";
import type { Route } from "../../router.ts";
import { errorResponse, json } from "../repos/http.ts";
import { csrfGuard, requireRepoAccess, type RepoAccess } from "../repos/identity.ts";
import { buildEvent, emitDomainEvent } from "./events.ts";
import {
  createComment,
  deleteComment,
  getCommentInRepo,
  getIssueRowByNumber,
  isValidCommentBody,
  listComments,
  updateComment,
} from "./store.ts";
import {
  decodeOffsetCursor,
  encodeOffsetCursor,
  parseNumberParam,
  readJson,
  readLimit,
  str,
} from "./common.ts";

function isAuthorOrMaintainer(access: RepoAccess, authorId: string | null): boolean {
  return (
    roleAtLeast(access.role as Role, "maintainer") ||
    (authorId !== null && authorId === access.auth.principal.id)
  );
}

/** `GET …/issues/:number/comments` — list comments (paginated). */
const listCommentsHandler: Route["handler"] = async (ctx) => {
  const access = await requireRepoAccess(ctx, "contents.read", SCOPES.hostingRead);
  if (access instanceof Response) return access;
  const number = parseNumberParam(ctx.params.number);
  if (number === null) return errorResponse(404, "not_found", "Not Found");
  const issue = await getIssueRowByNumber(access.db, access.repo.id, number);
  if (!issue) return errorResponse(404, "not_found", "Not Found");
  const limit = readLimit(ctx.url);
  const offset = decodeOffsetCursor(ctx.url.searchParams.get("cursor"));
  const result = await listComments(access.db, issue.id, limit, offset);
  const nextCursor = result.hasMore ? encodeOffsetCursor(offset + limit) : null;
  return json(paginatedBody("comments", result.comments, nextCursor));
};

/** `POST …/issues/:number/comments` — add a comment (writer). */
const createCommentHandler: Route["handler"] = async (ctx) => {
  const access = await requireRepoAccess(ctx, "issues.write", SCOPES.hostingWrite);
  if (access instanceof Response) return access;
  const csrf = csrfGuard(ctx, access.auth);
  if (csrf) return csrf;
  const number = parseNumberParam(ctx.params.number);
  if (number === null) return errorResponse(404, "not_found", "Not Found");
  const issue = await getIssueRowByNumber(access.db, access.repo.id, number);
  if (!issue) return errorResponse(404, "not_found", "Not Found");

  const body = await readJson(ctx.request);
  const text = body ? str(body.body) : null;
  if (!text || !isValidCommentBody(text)) {
    return errorResponse(400, "invalid_body", "A non-empty comment body is required.");
  }
  const comment = await createComment(access.db, issue.id, access.auth.principal.id, text);
  emitDomainEvent(
    buildEvent({
      type: "issue.commented",
      repoId: access.repo.id,
      owner: ctx.params.owner,
      repo: ctx.params.repo,
      issueNumber: number,
      actorSubject: access.auth.principal.subject,
      actorId: access.auth.principal.id,
      at: access.db.now(),
      payload: { commentId: comment.id },
    }),
  );
  return json({ comment }, 201);
};

/** `PATCH …/issues/comments/:id` — edit (author or maintainer). */
const patchCommentHandler: Route["handler"] = async (ctx) => {
  const access = await requireRepoAccess(ctx, "issues.write", SCOPES.hostingWrite);
  if (access instanceof Response) return access;
  const csrf = csrfGuard(ctx, access.auth);
  if (csrf) return csrf;
  const found = await getCommentInRepo(access.db, access.repo.id, ctx.params.id);
  if (!found) return errorResponse(404, "not_found", "Not Found");
  if (!isAuthorOrMaintainer(access, found.comment.author_id)) {
    return errorResponse(403, "forbidden", "Only the author or a maintainer may edit this comment.");
  }
  const body = await readJson(ctx.request);
  const text = body ? str(body.body) : null;
  if (!text || !isValidCommentBody(text)) {
    return errorResponse(400, "invalid_body", "A non-empty comment body is required.");
  }
  const comment = await updateComment(access.db, found.comment.id, text);
  if (!comment) return errorResponse(404, "not_found", "Not Found");
  emitDomainEvent(
    buildEvent({
      type: "issue.comment_edited",
      repoId: access.repo.id,
      owner: ctx.params.owner,
      repo: ctx.params.repo,
      issueNumber: found.issue.number,
      actorSubject: access.auth.principal.subject,
      actorId: access.auth.principal.id,
      at: access.db.now(),
      payload: { commentId: comment.id },
    }),
  );
  return json({ comment });
};

/** `DELETE …/issues/comments/:id` — delete (author or maintainer). */
const deleteCommentHandler: Route["handler"] = async (ctx) => {
  const access = await requireRepoAccess(ctx, "issues.write", SCOPES.hostingWrite);
  if (access instanceof Response) return access;
  const csrf = csrfGuard(ctx, access.auth);
  if (csrf) return csrf;
  const found = await getCommentInRepo(access.db, access.repo.id, ctx.params.id);
  if (!found) return errorResponse(404, "not_found", "Not Found");
  if (!isAuthorOrMaintainer(access, found.comment.author_id)) {
    return errorResponse(403, "forbidden", "Only the author or a maintainer may delete this comment.");
  }
  await deleteComment(access.db, found.comment.id, found.issue.id);
  emitDomainEvent(
    buildEvent({
      type: "issue.comment_deleted",
      repoId: access.repo.id,
      owner: ctx.params.owner,
      repo: ctx.params.repo,
      issueNumber: found.issue.number,
      actorSubject: access.auth.principal.subject,
      actorId: access.auth.principal.id,
      at: access.db.now(),
      payload: { commentId: found.comment.id },
    }),
  );
  return json({ deleted: true });
};

export const commentHandlers = {
  list: listCommentsHandler,
  create: createCommentHandler,
  patch: patchCommentHandler,
  remove: deleteCommentHandler,
} as const;
