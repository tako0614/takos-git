/**
 * Inline review comments (file + line), optionally threaded and grouped under a
 * review. Ported from the takos worker's `pull-requests/comments.ts`, reshaped
 * onto `pr_review_comments` (side/line/commit_sha anchor) and reseamed off
 * notifications. Create/list are reader+; edit/delete are author-or-maintainer.
 */

import type { RouteContext } from "../../router.ts";
import { isValidGitPath } from "../../git/tree-ops.ts";
import { json, errorResponse } from "../repos/http.ts";
import {
  buildPrincipalLiteMap,
  toReviewCommentDto,
  type ReviewCommentRow,
} from "./dto.ts";
import { computeGitState } from "./read-model.ts";
import {
  csrfGuard,
  requireRepoAccess,
} from "../repos/identity.ts";
import { SCOPES } from "../../contract/v1.ts";
import type { Route } from "../../router.ts";
import { isAuthorOrMaintainer, prReadHandler, prWriteHandler, readJson, type PrHandlerCtx } from "./shared.ts";

const COMMENT_SELECT = `
  SELECT id, pr_id, review_id, in_reply_to_id, author_id, file_path, side, line,
         start_line, commit_sha, diff_hunk, body, outdated, created_at, updated_at
    FROM pr_review_comments`;

interface CreateBody {
  body?: unknown;
  content?: unknown;
  file_path?: unknown;
  path?: unknown;
  line?: unknown;
  line_number?: unknown;
  start_line?: unknown;
  side?: unknown;
  in_reply_to_id?: unknown;
  review_id?: unknown;
}

async function handleCreate(ctx: RouteContext, prctx: PrHandlerCtx): Promise<Response> {
  const { access, pr, repo } = prctx;
  const raw = await readJson<CreateBody>(ctx);
  if (!raw) return errorResponse(400, "invalid_body", "Invalid JSON body.");
  const body = typeof raw.body === "string" ? raw.body : typeof raw.content === "string" ? raw.content : "";
  const text = body.trim();
  if (!text) return errorResponse(422, "body_required", "Comment body is required.");

  const filePath = typeof raw.file_path === "string" ? raw.file_path : typeof raw.path === "string" ? raw.path : "";
  if (!filePath || !isValidGitPath(filePath.trim())) {
    return errorResponse(422, "invalid_path", "A valid file_path is required for an inline comment.");
  }
  const side = raw.side === "LEFT" ? "LEFT" : "RIGHT";
  const lineRaw = typeof raw.line === "number" ? raw.line : typeof raw.line_number === "number" ? raw.line_number : null;
  const line = lineRaw !== null && Number.isSafeInteger(lineRaw) && lineRaw > 0 ? lineRaw : null;
  const startLine =
    typeof raw.start_line === "number" && Number.isSafeInteger(raw.start_line) && raw.start_line > 0
      ? raw.start_line
      : null;

  const db = ctx.db!;
  // Validate an in-reply-to / review parent belongs to THIS PR (no cross-PR leak).
  let inReplyToId: string | null = null;
  if (typeof raw.in_reply_to_id === "string" && raw.in_reply_to_id) {
    const parent = await db.queryOne<{ id: string }>(
      `SELECT id FROM pr_review_comments WHERE id = ? AND pr_id = ? LIMIT 1`,
      [raw.in_reply_to_id, pr.id],
    );
    if (!parent) return errorResponse(422, "invalid_reply", "in_reply_to_id does not belong to this pull request.");
    inReplyToId = parent.id;
  }
  let reviewId: string | null = null;
  if (typeof raw.review_id === "string" && raw.review_id) {
    const review = await db.queryOne<{ id: string }>(
      `SELECT id FROM pr_reviews WHERE id = ? AND pr_id = ? LIMIT 1`,
      [raw.review_id, pr.id],
    );
    if (!review) return errorResponse(422, "invalid_review", "review_id does not belong to this pull request.");
    reviewId = review.id;
  }

  const now = db.now();
  const id = db.id();
  const authorId = access.auth.principal.id === "anon" ? null : access.auth.principal.id;
  const gitState = await computeGitState(ctx.env.BUCKET, repo, pr, false);

  await db.run(
    `INSERT INTO pr_review_comments
       (id, pr_id, review_id, in_reply_to_id, author_id, file_path, side, line, start_line,
        commit_sha, diff_hunk, body, outdated, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, ?, ?)`,
    [id, pr.id, reviewId, inReplyToId, authorId, filePath.trim(), side, line, startLine, gitState.headSha, text, now, now],
  );

  const map = await buildPrincipalLiteMap(db, [authorId]);
  const row = await db.queryOne<ReviewCommentRow>(`${COMMENT_SELECT} WHERE id = ? LIMIT 1`, [id]);
  return json({ comment: toReviewCommentDto(row!, map) }, 201);
}

async function handleList(ctx: RouteContext, prctx: PrHandlerCtx): Promise<Response> {
  const db = ctx.db!;
  const rows = await db.query<ReviewCommentRow>(
    `${COMMENT_SELECT} WHERE pr_id = ? ORDER BY created_at ASC`,
    [prctx.pr.id],
  );
  const map = await buildPrincipalLiteMap(db, rows.map((r) => r.author_id));
  return json({ comments: rows.map((row) => toReviewCommentDto(row, map)) });
}

// --- edit / delete a single comment by id (not PR-number scoped) ------------

async function loadComment(
  ctx: RouteContext,
  repoId: string,
): Promise<ReviewCommentRow | Response> {
  const id = ctx.params.id;
  const row = await ctx.db!.queryOne<ReviewCommentRow>(
    `${COMMENT_SELECT} c WHERE c.id = ? AND c.pr_id IN (SELECT id FROM pull_requests WHERE repo_id = ?) LIMIT 1`,
    [id, repoId],
  );
  return row ?? errorResponse(404, "not_found", "Not Found");
}

const editComment: Route["handler"] = async (ctx) => {
  const access = await requireRepoAccess(ctx, "pulls.write", SCOPES.hostingWrite);
  if (access instanceof Response) return access;
  const csrf = csrfGuard(ctx, access.auth);
  if (csrf) return csrf;
  const found = await loadComment(ctx, access.repo.id);
  if (found instanceof Response) return found;
  if (!isAuthorOrMaintainer(access, found.author_id)) {
    return errorResponse(403, "forbidden", "Only the author or a maintainer may edit this comment.");
  }
  const raw = await readJson<{ body?: unknown }>(ctx);
  const text = typeof raw?.body === "string" ? raw.body.trim() : "";
  if (!text) return errorResponse(422, "body_required", "Comment body is required.");
  const now = ctx.db!.now();
  await ctx.db!.run(`UPDATE pr_review_comments SET body = ?, updated_at = ? WHERE id = ?`, [text, now, found.id]);
  const map = await buildPrincipalLiteMap(ctx.db!, [found.author_id]);
  const updated = await ctx.db!.queryOne<ReviewCommentRow>(`${COMMENT_SELECT} WHERE id = ? LIMIT 1`, [found.id]);
  return json({ comment: toReviewCommentDto(updated!, map) });
};

const deleteComment: Route["handler"] = async (ctx) => {
  const access = await requireRepoAccess(ctx, "pulls.write", SCOPES.hostingWrite);
  if (access instanceof Response) return access;
  const csrf = csrfGuard(ctx, access.auth);
  if (csrf) return csrf;
  const found = await loadComment(ctx, access.repo.id);
  if (found instanceof Response) return found;
  if (!isAuthorOrMaintainer(access, found.author_id)) {
    return errorResponse(403, "forbidden", "Only the author or a maintainer may delete this comment.");
  }
  await ctx.db!.run(`DELETE FROM pr_review_comments WHERE id = ?`, [found.id]);
  return json({ deleted: true });
};

export const commentHandlers = {
  create: prWriteHandler("pulls.write", handleCreate),
  list: prReadHandler(handleList),
  edit: editComment,
  remove: deleteComment,
} as const;
