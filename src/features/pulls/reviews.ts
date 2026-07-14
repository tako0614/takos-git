/**
 * PR review verdicts (approve / request-changes / comment).
 *
 * Ported from the takos worker's `pull-requests/reviews.ts` with the AI-review
 * path DROPPED per the decision record (`ai-review.ts` not ported, no
 * `POST …/ai-review` route, no `analysis`/`reviewer_type='ai'`). Notifications
 * are reseamed onto `emitRepoEvent`. Any reader may submit a review (GitHub
 * parity); the enforced-approval count lives in branch protection at merge time.
 */

import type { RouteContext } from "../../router.ts";
import { json, errorResponse } from "../repos/http.ts";
import {
  buildPrincipalLiteMap,
  toReviewDto,
  type ReviewRow,
} from "./dto.ts";
import { computeGitState } from "./read-model.ts";
import { emitRepoEvent } from "./events.ts";
import { prReadHandler, prWriteHandler, readJson, type PrHandlerCtx } from "./shared.ts";

const REVIEW_STATES = new Set(["approved", "changes_requested", "commented"]);

interface SubmitBody {
  state?: unknown;
  status?: unknown;
  body?: unknown;
}

async function handleSubmit(ctx: RouteContext, prctx: PrHandlerCtx): Promise<Response> {
  const { access, pr, repo } = prctx;
  if (pr.state !== "open") {
    return errorResponse(409, "not_open", "Cannot review a closed or merged pull request.");
  }
  const body = await readJson<SubmitBody>(ctx);
  if (!body) return errorResponse(400, "invalid_body", "Invalid JSON body.");
  const state = typeof body.state === "string" ? body.state : typeof body.status === "string" ? body.status : "";
  if (!REVIEW_STATES.has(state)) {
    return errorResponse(422, "invalid_state", "state must be approved, changes_requested, or commented.");
  }
  const reviewBody = typeof body.body === "string" ? body.body : null;
  if (state === "commented" && !reviewBody) {
    return errorResponse(422, "body_required", "A commented review requires a body.");
  }

  const db = ctx.db!;
  const now = db.now();
  const id = db.id();
  const reviewerId = access.auth.principal.id === "anon" ? null : access.auth.principal.id;
  // Anchor the verdict to the current head tip (R2-authoritative).
  const gitState = await computeGitState(ctx.env.BUCKET, repo, pr, false);

  await db.run(
    `INSERT INTO pr_reviews (id, pr_id, reviewer_id, state, body, commit_sha, submitted_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, pr.id, reviewerId, state, reviewBody, gitState.headSha, now, now],
  );

  await emitRepoEvent({
    type: "pull_request.review.submitted",
    repo,
    actorId: reviewerId ?? "anon",
    payload: { number: pr.number, state, commitSha: gitState.headSha },
  });

  const map = await buildPrincipalLiteMap(db, [reviewerId]);
  const row: ReviewRow = {
    id,
    pr_id: pr.id,
    reviewer_id: reviewerId,
    state,
    body: reviewBody,
    commit_sha: gitState.headSha,
    submitted_at: now,
    created_at: now,
  };
  return json({ review: toReviewDto(row, map) }, 201);
}

async function handleList(ctx: RouteContext, prctx: PrHandlerCtx): Promise<Response> {
  const db = ctx.db!;
  const rows = await db.query<ReviewRow>(
    `SELECT id, pr_id, reviewer_id, state, body, commit_sha, submitted_at, created_at
       FROM pr_reviews WHERE pr_id = ? ORDER BY created_at ASC`,
    [prctx.pr.id],
  );
  const map = await buildPrincipalLiteMap(db, rows.map((r) => r.reviewer_id));
  return json({ reviews: rows.map((row) => toReviewDto(row, map)) });
}

export const reviewHandlers = {
  submit: prWriteHandler("pulls.write", handleSubmit),
  list: prReadHandler(handleList),
} as const;
