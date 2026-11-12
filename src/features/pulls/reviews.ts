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
import { submissionContextError, type SubmissionContextInput } from "../submission-context.ts";
import { createReviewSubmission, getReviewSubmission, type ReviewSubmissionResult } from "./review-submissions.ts";

const REVIEW_STATES = new Set(["approved", "changes_requested", "commented"]);

interface SubmitBody extends SubmissionContextInput {
  state?: unknown;
  status?: unknown;
  body?: unknown;
  commitSha?: unknown;
}

async function handleSubmit(ctx: RouteContext, prctx: PrHandlerCtx): Promise<Response> {
  const { access, pr, repo } = prctx;
  if (ctx.request.headers.get("Idempotency-Key") === null && pr.state !== "open") {
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
  const contextError = await submissionContextError(ctx, access.auth, access.repo.id, body, pr.issueId);
  if (contextError) return contextError;
  const key = ctx.request.headers.get("Idempotency-Key");
  const commitSha = body.commitSha;
  if (commitSha !== undefined && (typeof commitSha !== "string" || !/^[a-f0-9]{40}$/u.test(commitSha))) {
    return errorResponse(422, "invalid_commit", "commitSha must identify the reviewed head.");
  }
  if (key !== null && !/^[\x21-\x7e]{1,255}$/u.test(key)) return errorResponse(400, "invalid_idempotency_key", "Idempotency-Key must contain 1–255 visible ASCII characters.");
  if (key !== null) {
    if (!reviewerId) return errorResponse(401, "unauthenticated", "Sign in to recover a review.");
    const original = await getReviewSubmission(db, pr, reviewerId, key, { state, body: reviewBody, commitSha });
    if (original) return submissionResponse(original);
  }
  if (pr.state !== "open") {
    return errorResponse(409, "not_open", "Cannot review a closed or merged pull request.");
  }
  if (
    reviewerId !== null &&
    reviewerId === pr.authorId &&
    (state === "approved" || state === "changes_requested")
  ) {
    return errorResponse(
      422,
      "self_review",
      "A pull-request author cannot approve or request changes on their own pull request.",
    );
  }
  // An old journal may recover an existing receipt without this field; it may
  // never create a new verdict against a head the caller did not review.
  if (commitSha === undefined) return errorResponse(422, "invalid_commit", "A new review requires its reviewed commitSha.");
  const gitState = await computeGitState(ctx.env.BUCKET, repo, pr, false);
  if (!gitState.headExists || gitState.headSha !== commitSha) {
    return errorResponse(409, "head_changed", "The pull-request head changed. Review the current version before submitting.");
  }

  const submission = key === null ? null : await createReviewSubmission(db, pr, reviewerId!, key, { state, body: reviewBody, commitSha }, gitState.headSha);
  if (submission && submission.outcome !== "created") return submissionResponse(submission);
  if (!submission) await db.run(
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

  if (submission) return submissionResponse(submission);
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

function submissionResponse(result: ReviewSubmissionResult): Response {
  if (result.outcome === "conflict") return errorResponse(409, "idempotency_conflict", "This submission key belongs to a different review.");
  if (result.outcome === "deleted") return errorResponse(410, "submission_deleted", "The original review no longer exists.");
  return json({ review: result.review }, 201, result.outcome === "replayed" ? { "Idempotency-Replayed": "true" } : undefined);
}

async function handleRecoverableSubmit(ctx: RouteContext, prctx: PrHandlerCtx): Promise<Response> {
  if (ctx.request.headers.get("Idempotency-Key") === null) return errorResponse(400, "missing_idempotency_key", "A recoverable review requires its original Idempotency-Key.");
  return handleSubmit(ctx, prctx);
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
  submitRecoverable: prWriteHandler("pulls.write", handleRecoverableSubmit),
  list: prReadHandler(handleList),
} as const;
