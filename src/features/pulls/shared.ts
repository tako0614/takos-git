/**
 * Handler-layer helpers shared across the pulls routes: repo-scoped read/write
 * wrappers (reusing the Phase-3a `requireRepoAccess`/`csrfGuard` pattern), PR
 * lookup by number, and the merge-actor projection.
 */

import { SCOPES, type RepoAction } from "../../contract/v1.ts";
import type { RouteContext, Route } from "../../router.ts";
import {
  csrfGuard,
  requireRepoAccess,
  type RepoAccess,
} from "../repos/identity.ts";
import { errorResponse } from "../repos/http.ts";
import { findPullRequest } from "./read-model.ts";
import type { PullRequestRow } from "./dto.ts";
import type { MergeActor } from "./merge.ts";

/** The R2 storage key (`<owner>/<name>`) for a resolved repo. */
export function repoKey(access: RepoAccess): string {
  return `${access.repo.ownerLogin}/${access.repo.name}`;
}

/** Project the authenticated principal into a commit-signing actor. */
export function mergeActor(access: RepoAccess): MergeActor {
  const p = access.auth.principal;
  return {
    id: p.id,
    displayName: p.displayName ?? null,
    email: p.email ?? null,
    subject: p.subject,
  };
}

/** Parse a JSON body, returning null on malformed input. */
export async function readJson<T>(ctx: RouteContext): Promise<T | null> {
  try {
    return (await ctx.request.json()) as T;
  } catch {
    return null;
  }
}

/** Parse `:number` from the path; null when not a positive integer. */
export function parseNumber(ctx: RouteContext): number | null {
  const raw = ctx.params.number;
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export interface PrHandlerCtx {
  readonly access: RepoAccess;
  readonly repo: string;
  readonly pr: PullRequestRow;
}

/** A read handler: `contents.read`, anonymous-on-public. */
export function readHandler(
  handler: (ctx: RouteContext, access: RepoAccess) => Promise<Response>,
): Route["handler"] {
  return async (ctx) => {
    const access = await requireRepoAccess(ctx, "contents.read", SCOPES.hostingRead);
    if (access instanceof Response) return access;
    return handler(ctx, access);
  };
}

/** A write handler: gates `action`, then runs the browser CSRF guard. */
export function writeHandler(
  action: RepoAction,
  handler: (ctx: RouteContext, access: RepoAccess) => Promise<Response>,
): Route["handler"] {
  return async (ctx) => {
    const access = await requireRepoAccess(ctx, action, SCOPES.hostingWrite);
    if (access instanceof Response) return access;
    const csrf = csrfGuard(ctx, access.auth);
    if (csrf) return csrf;
    return handler(ctx, access);
  };
}

/** A read handler that also resolves `:number` into a PR (404 when absent). */
export function prReadHandler(
  handler: (ctx: RouteContext, prctx: PrHandlerCtx) => Promise<Response>,
): Route["handler"] {
  return readHandler(async (ctx, access) => {
    const number = parseNumber(ctx);
    if (number === null) return errorResponse(400, "invalid_number", "Invalid pull request number.");
    const pr = await findPullRequest(ctx.db!, access.repo.id, number);
    if (!pr) return errorResponse(404, "not_found", "Not Found");
    return handler(ctx, { access, repo: repoKey(access), pr });
  });
}

/** A write handler that also resolves `:number` into a PR (404 when absent). */
export function prWriteHandler(
  action: RepoAction,
  handler: (ctx: RouteContext, prctx: PrHandlerCtx) => Promise<Response>,
): Route["handler"] {
  return writeHandler(action, async (ctx, access) => {
    const number = parseNumber(ctx);
    if (number === null) return errorResponse(400, "invalid_number", "Invalid pull request number.");
    const pr = await findPullRequest(ctx.db!, access.repo.id, number);
    if (!pr) return errorResponse(404, "not_found", "Not Found");
    return handler(ctx, { access, repo: repoKey(access), pr });
  });
}

/** True when the principal authored the PR/comment or holds maintainer+. */
export function isAuthorOrMaintainer(access: RepoAccess, authorId: string | null): boolean {
  if (authorId && authorId === access.auth.principal.id) return true;
  return access.role === "maintainer" || access.role === "owner";
}
