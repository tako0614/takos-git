/**
 * PR lifecycle + diff/files/commits read handlers.
 *
 * Ported from the takos worker's `pull-requests/routes.ts` (create/list/get/
 * update/close) + `diff.ts`, severed from `checkRepoAccess`/`accounts` and
 * rebased onto `requireRepoAccess` + the shared issue/PR number space. A PR row
 * extends an `issues` row: opening one inserts BOTH (issue carries title/body/
 * state/author; pull_requests carries the git head/base projection).
 */

import { parsePagination } from "../../contract/v1.ts";
import type { RouteContext } from "../../router.ts";
import { readRepoRefs } from "../../git/refs-store.ts";
import { repositoryObjectStore } from "../../git/repo-object-store.ts";
import { getCommitData, GitObjectTooLargeError } from "../../git/object-store.ts";
import { findMergeBase } from "../../git/merge-base.ts";
import { buildDiffPayload } from "../../git/commit-diff.ts";
import { isValidRefName } from "../../git/refs-store.ts";
import { json, errorResponse } from "../repos/http.ts";
import type { RepoAccess } from "../repos/identity.ts";
import {
  allocateSharedNumber,
  findPullRequest,
  findPullRequestById,
  listPullRequests,
  shapePullRequest,
} from "./read-model.ts";
import { emitRepoEvent } from "./events.ts";
import {
  isAuthorOrMaintainer,
  prReadHandler,
  prWriteHandler,
  readHandler,
  readJson,
  repoKey,
  writeHandler,
  type PrHandlerCtx,
} from "./shared.ts";

const MAX_COMMIT_BYTES = 256 * 1024;
const MAX_BLOB_BYTES = 1024 * 1024;
const MAX_PR_COMMITS = 250;

interface OpenBody {
  title?: unknown;
  body?: unknown;
  head?: unknown;
  head_branch?: unknown;
  base?: unknown;
  base_branch?: unknown;
  draft?: unknown;
}

function shortBranch(ref: unknown): string | null {
  if (typeof ref !== "string") return null;
  const name = ref.trim().replace(/^refs\/heads\//u, "");
  if (!name || name.length > 255) return null;
  if (!isValidRefName(`refs/heads/${name}`)) return null;
  return name;
}

// --- open ------------------------------------------------------------------

async function handleOpen(ctx: RouteContext, access: RepoAccess): Promise<Response> {
  const db = ctx.db!;
  const body = await readJson<OpenBody>(ctx);
  if (!body) return errorResponse(400, "invalid_body", "Invalid JSON body.");

  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) return errorResponse(422, "title_required", "Title is required.");

  const headRef = shortBranch(body.head ?? body.head_branch);
  if (!headRef) return errorResponse(422, "invalid_head", "A valid head branch is required.");
  const baseRef = shortBranch(body.base ?? body.base_branch) ?? access.repo.defaultBranch;
  if (!baseRef) return errorResponse(422, "invalid_base", "A valid base branch is required.");
  if (headRef === baseRef) {
    return errorResponse(422, "identical_branches", "Head and base branches must differ.");
  }

  const repo = repoKey(access);
  const refs = await readRepoRefs(ctx.env.BUCKET, repo);
  const head = refs.refs.find((r) => r.name === `refs/heads/${headRef}`);
  const base = refs.refs.find((r) => r.name === `refs/heads/${baseRef}`);
  if (!head) return errorResponse(422, "head_not_found", `Head branch '${headRef}' does not exist.`);
  if (!base) return errorResponse(422, "base_not_found", `Base branch '${baseRef}' does not exist.`);

  const bodyText = typeof body.body === "string" ? body.body : null;
  const draft = body.draft === true ? 1 : 0;
  const now = db.now();
  const number = await allocateSharedNumber(db, access.repo.id);
  const authorId = access.auth.principal.id === "anon" ? null : access.auth.principal.id;

  const issueId = db.id();
  await db.run(
    `INSERT INTO issues (id, repo_id, number, title, body, state, author_id, is_pull_request, comment_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'open', ?, 1, 0, ?, ?)`,
    [issueId, access.repo.id, number, title, bodyText, authorId, now, now],
  );
  const prId = db.id();
  await db.run(
    `INSERT INTO pull_requests
       (id, issue_id, repo_id, head_repo_id, head_ref, head_sha, base_repo_id, base_ref, base_sha,
        merge_base_sha, mergeable, draft, merged, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', ?, 0, ?, ?)`,
    [
      prId,
      issueId,
      access.repo.id,
      access.repo.id, // head lives in this repo (same-repo PRs in this MVP)
      headRef,
      head.sha,
      access.repo.id,
      baseRef,
      base.sha,
      null,
      draft,
      now,
      now,
    ],
  );

  const resolved = await findPullRequestById(db, prId);
  if (!resolved) return errorResponse(500, "create_failed", "Failed to load created pull request.");

  await emitRepoEvent({
    type: "pull_request.opened",
    repo,
    actorId: authorId ?? "anon",
    payload: { number, title, headRef, baseRef, draft: draft === 1 },
  });

  const dto = await shapePullRequest(db, ctx.env.BUCKET, repo, resolved, false);
  return json({ pull_request: dto }, 201);
}

// --- list ------------------------------------------------------------------

async function handleList(ctx: RouteContext, access: RepoAccess): Promise<Response> {
  const db = ctx.db!;
  const { limit, cursor } = parsePagination(ctx.url);
  const offset = cursor ? Math.max(0, Number.parseInt(cursor, 10) || 0) : 0;
  const stateParam = ctx.url.searchParams.get("state");
  const state =
    stateParam === "closed" ? "closed" : stateParam === "all" ? "all" : "open";
  const repo = repoKey(access);
  const rows = await listPullRequests(db, access.repo.id, { state, limit, offset });
  const items = await Promise.all(
    rows.map((row) => shapePullRequest(db, ctx.env.BUCKET, repo, row, false)),
  );
  const nextCursor = rows.length === limit ? String(offset + limit) : null;
  return json({ pull_requests: items, nextCursor });
}

// --- get -------------------------------------------------------------------

async function handleGet(ctx: RouteContext, prctx: PrHandlerCtx): Promise<Response> {
  const dto = await shapePullRequest(ctx.db!, ctx.env.BUCKET, prctx.repo, prctx.pr, true);
  return json({ pull_request: dto });
}

// --- update ----------------------------------------------------------------

interface PatchBody {
  title?: unknown;
  body?: unknown;
  base?: unknown;
  base_branch?: unknown;
}

async function handleUpdate(ctx: RouteContext, prctx: PrHandlerCtx): Promise<Response> {
  const { access, pr, repo } = prctx;
  if (!isAuthorOrMaintainer(access, pr.authorId)) {
    return errorResponse(403, "forbidden", "Only the author or a maintainer may edit this pull request.");
  }
  if (pr.state !== "open") {
    return errorResponse(409, "not_open", "Cannot edit a closed or merged pull request.");
  }
  const body = await readJson<PatchBody>(ctx);
  if (!body) return errorResponse(400, "invalid_body", "Invalid JSON body.");
  const db = ctx.db!;
  const now = db.now();

  const issueSets: string[] = [];
  const issueParams: unknown[] = [];
  if (typeof body.title === "string" && body.title.trim().length > 0) {
    issueSets.push("title = ?");
    issueParams.push(body.title.trim());
  }
  if (typeof body.body === "string") {
    issueSets.push("body = ?");
    issueParams.push(body.body);
  }

  const newBase = shortBranch(body.base ?? body.base_branch);
  if (newBase && newBase !== pr.baseRef) {
    if (newBase === pr.headRef) {
      return errorResponse(422, "identical_branches", "Head and base branches must differ.");
    }
    const refs = await readRepoRefs(ctx.env.BUCKET, repo);
    const base = refs.refs.find((r) => r.name === `refs/heads/${newBase}`);
    if (!base) return errorResponse(422, "base_not_found", `Base branch '${newBase}' does not exist.`);
    await db.run(
      `UPDATE pull_requests SET base_ref = ?, base_sha = ?, merge_base_sha = NULL, mergeable = 'unknown', updated_at = ? WHERE id = ?`,
      [newBase, base.sha, now, pr.id],
    );
  }

  if (issueSets.length === 0 && !(newBase && newBase !== pr.baseRef)) {
    return errorResponse(422, "no_updates", "No valid updates provided.");
  }
  if (issueSets.length > 0) {
    issueSets.push("updated_at = ?");
    issueParams.push(now, pr.issueId);
    await db.run(`UPDATE issues SET ${issueSets.join(", ")} WHERE id = ?`, issueParams);
  }

  await emitRepoEvent({
    type: "pull_request.edited",
    repo,
    actorId: access.auth.principal.id,
    payload: { number: pr.number },
  });

  const updated = await findPullRequest(db, access.repo.id, pr.number);
  const dto = await shapePullRequest(db, ctx.env.BUCKET, repo, updated ?? pr, true);
  return json({ pull_request: dto });
}

// --- close / reopen --------------------------------------------------------

async function setState(
  ctx: RouteContext,
  prctx: PrHandlerCtx,
  target: "open" | "closed",
): Promise<Response> {
  const { access, pr, repo } = prctx;
  if (!isAuthorOrMaintainer(access, pr.authorId)) {
    return errorResponse(403, "forbidden", "Only the author or a maintainer may change this pull request's state.");
  }
  if (pr.merged !== 0) {
    return errorResponse(409, "already_merged", "A merged pull request cannot change state.");
  }
  if (pr.state === target) {
    return errorResponse(409, "no_op", `Pull request is already ${target}.`);
  }
  const db = ctx.db!;
  const now = db.now();
  if (target === "closed") {
    await db.run(
      `UPDATE issues SET state = 'closed', state_reason = 'not_planned', closed_at = ?, updated_at = ? WHERE id = ?`,
      [now, now, pr.issueId],
    );
  } else {
    await db.run(
      `UPDATE issues SET state = 'open', state_reason = NULL, closed_at = NULL, updated_at = ? WHERE id = ?`,
      [now, pr.issueId],
    );
  }
  await emitRepoEvent({
    type: target === "closed" ? "pull_request.closed" : "pull_request.reopened",
    repo,
    actorId: access.auth.principal.id,
    payload: { number: pr.number, merged: false },
  });
  const updated = await findPullRequest(db, access.repo.id, pr.number);
  const dto = await shapePullRequest(db, ctx.env.BUCKET, repo, updated ?? pr, true);
  return json({ pull_request: dto });
}

// --- diff / files / commits ------------------------------------------------

async function threeDotBaseTree(
  ctx: RouteContext,
  prctx: PrHandlerCtx,
): Promise<
  | { ok: true; baseTree: string | null; headTree: string; mergeBase: string | null; headSha: string; baseSha: string }
  | { ok: false; response: Response }
> {
  const objects = repositoryObjectStore(ctx.env.BUCKET, prctx.repo);
  const refs = await readRepoRefs(ctx.env.BUCKET, prctx.repo);
  const head = refs.refs.find((r) => r.name === `refs/heads/${prctx.pr.headRef}`);
  const base = refs.refs.find((r) => r.name === `refs/heads/${prctx.pr.baseRef}`);
  if (!head || !base) {
    return { ok: false, response: errorResponse(404, "branch_not_found", "Head or base branch no longer exists.") };
  }
  try {
    const headCommit = await getCommitData(objects, head.sha, MAX_COMMIT_BYTES);
    if (!headCommit) return { ok: false, response: errorResponse(404, "commit_not_found", "Head commit not found.") };
    const mergeBase = await findMergeBase(objects, base.sha, head.sha);
    const mbCommit = mergeBase ? await getCommitData(objects, mergeBase, MAX_COMMIT_BYTES) : null;
    return {
      ok: true,
      baseTree: mbCommit ? mbCommit.tree : null,
      headTree: headCommit.tree,
      mergeBase,
      headSha: head.sha,
      baseSha: base.sha,
    };
  } catch (error) {
    if (error instanceof GitObjectTooLargeError) {
      return { ok: false, response: errorResponse(413, "commit_too_large", "Commit object too large.") };
    }
    throw error;
  }
}

async function handleDiff(ctx: RouteContext, prctx: PrHandlerCtx, hunks: boolean): Promise<Response> {
  const trees = await threeDotBaseTree(ctx, prctx);
  if (!trees.ok) return trees.response;
  const objects = repositoryObjectStore(ctx.env.BUCKET, prctx.repo);
  try {
    const diff = await buildDiffPayload(objects, trees.baseTree, trees.headTree, {
      includeHunks: hunks,
      maxFileBytes: MAX_BLOB_BYTES,
    });
    return json({
      number: prctx.pr.number,
      base: prctx.pr.baseRef,
      head: prctx.pr.headRef,
      baseSha: trees.baseSha,
      headSha: trees.headSha,
      mergeBaseSha: trees.mergeBase,
      ...diff,
    });
  } catch (error) {
    if (error instanceof GitObjectTooLargeError) {
      return errorResponse(413, "blob_too_large", "Blob too large.");
    }
    throw error;
  }
}

async function handleCommits(ctx: RouteContext, prctx: PrHandlerCtx): Promise<Response> {
  const objects = repositoryObjectStore(ctx.env.BUCKET, prctx.repo);
  const refs = await readRepoRefs(ctx.env.BUCKET, prctx.repo);
  const head = refs.refs.find((r) => r.name === `refs/heads/${prctx.pr.headRef}`);
  const base = refs.refs.find((r) => r.name === `refs/heads/${prctx.pr.baseRef}`);
  if (!head || !base) return errorResponse(404, "branch_not_found", "Head or base branch no longer exists.");
  try {
    const mergeBase = await findMergeBase(objects, base.sha, head.sha);
    const commits: Array<Record<string, unknown>> = [];
    const visited = new Set<string>();
    let cursor: string | undefined = head.sha;
    while (cursor && cursor !== mergeBase && commits.length < MAX_PR_COMMITS && !visited.has(cursor)) {
      visited.add(cursor);
      const commit = await getCommitData(objects, cursor, MAX_COMMIT_BYTES);
      if (!commit) break;
      commits.push({
        sha: commit.sha,
        parents: commit.parents,
        message: commit.message,
        author: { name: commit.author.name, email: commit.author.email, at: commit.author.timestamp },
        committer: { name: commit.committer.name, email: commit.committer.email, at: commit.committer.timestamp },
      });
      cursor = commit.parents[0];
    }
    return json({ number: prctx.pr.number, mergeBaseSha: mergeBase, commits });
  } catch (error) {
    if (error instanceof GitObjectTooLargeError) {
      return errorResponse(413, "commit_too_large", "Commit object too large.");
    }
    throw error;
  }
}

// --- exports ---------------------------------------------------------------

export const crudHandlers = {
  open: writeHandler("pulls.write", handleOpen),
  list: readHandler(handleList),
  get: prReadHandler(handleGet),
  update: prWriteHandler("pulls.write", handleUpdate),
  close: prWriteHandler("pulls.write", (ctx, prctx) => setState(ctx, prctx, "closed")),
  reopen: prWriteHandler("pulls.write", (ctx, prctx) => setState(ctx, prctx, "open")),
  diff: prReadHandler((ctx, prctx) => handleDiff(ctx, prctx, true)),
  files: prReadHandler((ctx, prctx) => handleDiff(ctx, prctx, false)),
  commits: prReadHandler(handleCommits),
} as const;
