/**
 * Merge / conflicts / resolve HTTP handlers.
 *
 * Ported from the takos worker's `pull-requests/merge-handlers.ts`. The merge and
 * resolve handlers enforce branch-protection required approvals/status-checks
 * (reading `pr_reviews`/`commit_statuses` directly) BEFORE delegating to the
 * two-phase R2-CAS writers in `merge.ts`/`merge-resolution.ts`. Push/merge events
 * are emitted for the integrator (webhooks + Actions) to consume.
 */

import type { RouteContext } from "../../router.ts";
import { json, errorResponse } from "../repos/http.ts";
import { computeGitState, findPullRequest, shapePullRequest } from "./read-model.ts";
import { performMerge, type MergeMethod } from "./merge.ts";
import { checkConflicts, normalizeResolutions, resolveConflictsAndMerge } from "./merge-resolution.ts";
import { evaluateMergeProtection } from "./protection.ts";
import { emitRepoEvent } from "./events.ts";
import { mergeActor, prReadHandler, prWriteHandler, readJson, type PrHandlerCtx } from "./shared.ts";

interface MergeBody {
  merge_method?: unknown;
  method?: unknown;
  commit_message?: unknown;
}

function resolveMethod(value: unknown): MergeMethod | null {
  if (value === undefined || value === null) return "merge";
  if (value === "merge" || value === "squash" || value === "rebase") return value;
  return null;
}

async function handleMerge(ctx: RouteContext, prctx: PrHandlerCtx): Promise<Response> {
  const { access, pr, repo } = prctx;
  if (pr.merged !== 0) return errorResponse(409, "already_merged", "Pull request is already merged.");
  if (pr.state !== "open") return errorResponse(409, "not_open", "Pull request is not open.");

  const body = await readJson<MergeBody>(ctx);
  const method = resolveMethod(body?.merge_method ?? body?.method);
  if (!method) return errorResponse(422, "invalid_method", "merge_method must be merge, squash, or rebase.");
  const commitMessage = typeof body?.commit_message === "string" ? body.commit_message.trim() : "";

  const db = ctx.db!;
  // Enforce branch protection (approvals / required checks / up-to-date) at merge
  // time, before the refs CAS. Uses the R2-derived head + behind counts.
  const gitState = await computeGitState(ctx.env.BUCKET, repo, pr, false);
  const protection = await evaluateMergeProtection(
    db,
    access.repo.id,
    pr.id,
    pr.baseRef,
    gitState.headSha,
    access.role,
    gitState.behindBy,
  );
  if (!protection.ok) {
    return errorResponse(403, protection.code, protection.message, protection.details);
  }

  const result = await performMerge({
    db,
    bucket: ctx.env.BUCKET,
    repoKey: repo,
    pr,
    method,
    commitMessage,
    actor: mergeActor(access),
  });
  if (!result.ok) {
    return errorResponse(result.status, result.code, result.message, result.details);
  }

  await emitRepoEvent({
    type: "pull_request.merged",
    repo,
    actorId: access.auth.principal.id,
    payload: {
      number: pr.number,
      mergeCommitSha: result.mergeCommitSha,
      method: result.method,
      headSha: result.headSha,
      baseRef: pr.baseRef,
    },
  });
  if (result.previousBaseSha) {
    await emitRepoEvent({
      type: "push",
      repo,
      actorId: access.auth.principal.id,
      payload: {
        ref: `refs/heads/${pr.baseRef}`,
        before: result.previousBaseSha,
        after: result.newBaseSha,
      },
    });
  }

  const updated = await findPullRequest(db, access.repo.id, pr.number);
  const dto = await shapePullRequest(db, ctx.env.BUCKET, repo, updated ?? pr, false);
  return json({ pull_request: dto, merge_commit: result.mergeCommitSha });
}

async function handleConflicts(ctx: RouteContext, prctx: PrHandlerCtx): Promise<Response> {
  if (prctx.pr.state !== "open") return errorResponse(409, "not_open", "Pull request is not open.");
  const result = await checkConflicts(ctx.env.BUCKET, prctx.repo, prctx.pr);
  if (!result.ok) return errorResponse(result.status, result.code, result.message, result.details);
  const status = result.mergeable ? 200 : 409;
  return json(
    {
      mergeable: result.mergeable,
      mergeBase: result.mergeBase,
      conflicts: result.conflicts,
      ...(result.message ? { message: result.message } : {}),
    },
    status,
  );
}

async function handleResolve(ctx: RouteContext, prctx: PrHandlerCtx): Promise<Response> {
  const { access, pr, repo } = prctx;
  if (pr.merged !== 0) return errorResponse(409, "already_merged", "Pull request is already merged.");
  if (pr.state !== "open") return errorResponse(409, "not_open", "Pull request is not open.");

  const raw = await readJson<{ resolutions?: unknown; commit_message?: unknown }>(ctx);
  if (!raw) return errorResponse(400, "invalid_body", "Invalid JSON body.");
  const normalized = normalizeResolutions(raw.resolutions);
  if (!normalized.ok) return errorResponse(422, "invalid_resolutions", normalized.message);
  const commitMessage = typeof raw.commit_message === "string" ? raw.commit_message.trim() : "";

  const db = ctx.db!;
  const gitState = await computeGitState(ctx.env.BUCKET, repo, pr, false);
  const protection = await evaluateMergeProtection(
    db,
    access.repo.id,
    pr.id,
    pr.baseRef,
    gitState.headSha,
    access.role,
    gitState.behindBy,
  );
  if (!protection.ok) {
    return errorResponse(403, protection.code, protection.message, protection.details);
  }

  const result = await resolveConflictsAndMerge({
    db,
    bucket: ctx.env.BUCKET,
    repoKey: repo,
    pr,
    resolutions: normalized.resolutions,
    commitMessage,
    actor: mergeActor(access),
  });
  if (!result.ok) return errorResponse(result.status, result.code, result.message, result.details);

  await emitRepoEvent({
    type: "pull_request.merged",
    repo,
    actorId: access.auth.principal.id,
    payload: { number: pr.number, mergeCommitSha: result.mergeCommitSha, method: "merge", baseRef: pr.baseRef },
  });
  if (result.previousBaseSha) {
    await emitRepoEvent({
      type: "push",
      repo,
      actorId: access.auth.principal.id,
      payload: { ref: `refs/heads/${pr.baseRef}`, before: result.previousBaseSha, after: result.newBaseSha },
    });
  }

  const updated = await findPullRequest(db, access.repo.id, pr.number);
  const dto = await shapePullRequest(db, ctx.env.BUCKET, repo, updated ?? pr, false);
  return json({ pull_request: dto, merge_commit: result.mergeCommitSha });
}

export const mergeHandlers = {
  merge: prWriteHandler("pulls.merge", handleMerge),
  conflicts: prReadHandler(handleConflicts),
  resolve: prWriteHandler("pulls.merge", handleResolve),
} as const;
