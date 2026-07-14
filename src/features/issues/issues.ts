/**
 * Issue handlers: list, open, get, edit, close, reopen.
 *
 * Reads authorize `contents.read` (reader floor; anonymous on public repos).
 * Mutations authorize `issues.write` (writer floor). The spec's finer
 * "author|maintainer" rule for editing another user's title/body is enforced
 * in-handler on top of the writer floor: a plain writer may triage (state,
 * labels, assignees, milestone) any issue, but only the author or a maintainer
 * may rewrite an issue's title/body.
 */

import {
  SCOPES,
  paginatedBody,
  roleAtLeast,
  type Role,
} from "../../contract/v1.ts";
import type { Route } from "../../router.ts";
import type { DbClient } from "../../db/index.ts";
import { errorResponse, json } from "../repos/http.ts";
import { csrfGuard, requireRepoAccess, type RepoAccess } from "../repos/identity.ts";
import { buildEvent, emitDomainEvent } from "./events.ts";
import {
  createIssue,
  getIssueDto,
  getIssueRowByNumber,
  getMilestoneRowByNumber,
  listIssues,
  principalIdBySubject,
  resolveLabelIds,
  setAssignees,
  setIssueLabels,
  setIssueState,
  updateIssueFields,
} from "./store.ts";
import {
  parseNumberParam,
  parseStateFilter,
  readJson,
  readLimit,
  strArray,
  str,
  decodeOffsetCursor,
  encodeOffsetCursor,
} from "./common.ts";

const MAX_TITLE = 1024;

function canEditContent(access: RepoAccess, authorId: string | null): boolean {
  return (
    roleAtLeast(access.role as Role, "maintainer") ||
    (authorId !== null && authorId === access.auth.principal.id)
  );
}

/** Resolve assignee subjects to existing principal ids; unknown → error names. */
async function resolveAssignees(
  db: DbClient,
  subjects: readonly string[],
): Promise<{ ids: string[]; missing: string[] }> {
  const ids: string[] = [];
  const missing: string[] = [];
  for (const subject of subjects) {
    const id = await principalIdBySubject(db, subject);
    if (id) ids.push(id);
    else missing.push(subject);
  }
  return { ids, missing };
}

/** `GET …/issues` — filtered, paginated list (excludes pull requests). */
const listIssuesHandler: Route["handler"] = async (ctx) => {
  const access = await requireRepoAccess(ctx, "contents.read", SCOPES.hostingRead);
  if (access instanceof Response) return access;
  const url = ctx.url;
  const limit = readLimit(url);
  const offset = decodeOffsetCursor(url.searchParams.get("cursor"));
  const result = await listIssues(access.db, access.repo.id, {
    state: parseStateFilter(url.searchParams.get("state")),
    labelName: str(url.searchParams.get("label")),
    milestoneNumber: parseNumberParam(url.searchParams.get("milestone") ?? undefined),
    assigneeSubject: str(url.searchParams.get("assignee")),
    limit,
    offset,
  });
  const nextCursor = result.hasMore ? encodeOffsetCursor(offset + limit) : null;
  return json(paginatedBody("issues", result.issues, nextCursor));
};

/** `POST …/issues` — open a new issue (writer). */
const openIssueHandler: Route["handler"] = async (ctx) => {
  const access = await requireRepoAccess(ctx, "issues.write", SCOPES.hostingWrite);
  if (access instanceof Response) return access;
  const csrf = csrfGuard(ctx, access.auth);
  if (csrf) return csrf;

  const body = await readJson(ctx.request);
  if (!body) return errorResponse(400, "invalid_body", "Invalid request body.");
  const title = str(body.title);
  if (!title || title.length > MAX_TITLE) {
    return errorResponse(400, "invalid_title", "A non-empty title is required.");
  }
  const issueBody = typeof body.body === "string" ? body.body : null;

  // milestone (optional, by number)
  let milestoneId: string | null = null;
  if (body.milestone != null) {
    const number = typeof body.milestone === "number" ? body.milestone : null;
    if (number === null) {
      return errorResponse(400, "invalid_milestone", "milestone must be a number.");
    }
    const row = await getMilestoneRowByNumber(access.db, access.repo.id, number);
    if (!row) return errorResponse(404, "milestone_not_found", "Unknown milestone.");
    milestoneId = row.id;
  }

  // labels (optional, by name)
  let labelIds: string[] = [];
  if (body.labels !== undefined) {
    const names = strArray(body.labels);
    if (names === null) {
      return errorResponse(400, "invalid_labels", "labels must be an array of names.");
    }
    const resolved = await resolveLabelIds(access.db, access.repo.id, names);
    if (resolved.missing.length > 0) {
      return errorResponse(400, "unknown_label", "Unknown label.", {
        labels: resolved.missing,
      });
    }
    labelIds = resolved.ids;
  }

  // assignees (optional, by subject)
  let assigneeIds: string[] = [];
  if (body.assignees !== undefined) {
    const subjects = strArray(body.assignees);
    if (subjects === null) {
      return errorResponse(400, "invalid_assignees", "assignees must be an array.");
    }
    const resolved = await resolveAssignees(access.db, subjects);
    if (resolved.missing.length > 0) {
      return errorResponse(400, "unknown_assignee", "Unknown assignee.", {
        assignees: resolved.missing,
      });
    }
    assigneeIds = resolved.ids;
  }

  const issue = await createIssue(access.db, access.repo.id, {
    title,
    body: issueBody,
    authorId: access.auth.principal.id,
    milestoneId,
    labelIds,
    assigneeIds,
  });

  emitDomainEvent(
    buildEvent({
      type: "issue.opened",
      repoId: access.repo.id,
      owner: ctx.params.owner,
      repo: ctx.params.repo,
      issueNumber: issue.number,
      actorSubject: access.auth.principal.subject,
      actorId: access.auth.principal.id,
      at: access.db.now(),
      payload: { title: issue.title },
    }),
  );
  return json({ issue }, 201);
};

/** `GET …/issues/:number` — single issue. */
const getIssueHandler: Route["handler"] = async (ctx) => {
  const access = await requireRepoAccess(ctx, "contents.read", SCOPES.hostingRead);
  if (access instanceof Response) return access;
  const number = parseNumberParam(ctx.params.number);
  if (number === null) return errorResponse(404, "not_found", "Not Found");
  const issue = await getIssueDto(access.db, access.repo.id, number);
  if (!issue || issue.isPullRequest) {
    return errorResponse(404, "not_found", "Not Found");
  }
  return json({ issue });
};

/** `PATCH …/issues/:number` — edit title/body/state/assignees/labels/milestone. */
const patchIssueHandler: Route["handler"] = async (ctx) => {
  const access = await requireRepoAccess(ctx, "issues.write", SCOPES.hostingWrite);
  if (access instanceof Response) return access;
  const csrf = csrfGuard(ctx, access.auth);
  if (csrf) return csrf;
  const number = parseNumberParam(ctx.params.number);
  if (number === null) return errorResponse(404, "not_found", "Not Found");
  const row = await getIssueRowByNumber(access.db, access.repo.id, number);
  if (!row || row.is_pull_request === 1) {
    return errorResponse(404, "not_found", "Not Found");
  }

  const body = await readJson(ctx.request);
  if (!body) return errorResponse(400, "invalid_body", "Invalid request body.");

  const fields: {
    title?: string;
    body?: string | null;
    milestoneId?: string | null;
  } = {};

  // title/body edits are content edits → author or maintainer only.
  if (body.title !== undefined || body.body !== undefined) {
    if (!canEditContent(access, row.author_id)) {
      return errorResponse(403, "forbidden", "Only the author or a maintainer may edit the issue body.");
    }
    if (body.title !== undefined) {
      const title = str(body.title);
      if (!title || title.length > MAX_TITLE) {
        return errorResponse(400, "invalid_title", "A non-empty title is required.");
      }
      fields.title = title;
    }
    if (body.body !== undefined) {
      fields.body = typeof body.body === "string" ? body.body : null;
    }
  }

  // milestone (number | null)
  if (body.milestone !== undefined) {
    if (body.milestone === null) {
      fields.milestoneId = null;
    } else if (typeof body.milestone === "number") {
      const ms = await getMilestoneRowByNumber(access.db, access.repo.id, body.milestone);
      if (!ms) return errorResponse(404, "milestone_not_found", "Unknown milestone.");
      fields.milestoneId = ms.id;
    } else {
      return errorResponse(400, "invalid_milestone", "milestone must be a number or null.");
    }
  }

  if (Object.keys(fields).length > 0) {
    await updateIssueFields(access.db, row.id, fields);
    if (fields.milestoneId !== undefined) {
      emitDomainEvent(
        buildEvent({
          type: "issue.milestoned",
          repoId: access.repo.id,
          owner: ctx.params.owner,
          repo: ctx.params.repo,
          issueNumber: number,
          actorSubject: access.auth.principal.subject,
          actorId: access.auth.principal.id,
          at: access.db.now(),
          payload: { milestone: body.milestone },
        }),
      );
    }
  }

  // labels (replace set)
  if (body.labels !== undefined) {
    const names = strArray(body.labels);
    if (names === null) {
      return errorResponse(400, "invalid_labels", "labels must be an array of names.");
    }
    const resolved = await resolveLabelIds(access.db, access.repo.id, names);
    if (resolved.missing.length > 0) {
      return errorResponse(400, "unknown_label", "Unknown label.", { labels: resolved.missing });
    }
    await setIssueLabels(access.db, row.id, resolved.ids);
    emitDomainEvent(
      buildEvent({
        type: "issue.labeled",
        repoId: access.repo.id,
        owner: ctx.params.owner,
        repo: ctx.params.repo,
        issueNumber: number,
        actorSubject: access.auth.principal.subject,
        actorId: access.auth.principal.id,
        at: access.db.now(),
        payload: { labels: names },
      }),
    );
  }

  // assignees (replace set)
  if (body.assignees !== undefined) {
    const subjects = strArray(body.assignees);
    if (subjects === null) {
      return errorResponse(400, "invalid_assignees", "assignees must be an array.");
    }
    const resolved = await resolveAssignees(access.db, subjects);
    if (resolved.missing.length > 0) {
      return errorResponse(400, "unknown_assignee", "Unknown assignee.", { assignees: resolved.missing });
    }
    await setAssignees(access.db, row.id, resolved.ids);
    emitDomainEvent(
      buildEvent({
        type: "issue.assigned",
        repoId: access.repo.id,
        owner: ctx.params.owner,
        repo: ctx.params.repo,
        issueNumber: number,
        actorSubject: access.auth.principal.subject,
        actorId: access.auth.principal.id,
        at: access.db.now(),
        payload: { assignees: subjects },
      }),
    );
  }

  // state (open | closed) via PATCH
  if (body.state !== undefined) {
    if (body.state !== "open" && body.state !== "closed") {
      return errorResponse(400, "invalid_state", "state must be 'open' or 'closed'.");
    }
    const reason =
      body.state === "closed"
        ? body.stateReason === "not_planned"
          ? "not_planned"
          : "completed"
        : null;
    await setIssueState(access.db, row.id, body.state, reason);
    emitDomainEvent(
      buildEvent({
        type: body.state === "closed" ? "issue.closed" : "issue.reopened",
        repoId: access.repo.id,
        owner: ctx.params.owner,
        repo: ctx.params.repo,
        issueNumber: number,
        actorSubject: access.auth.principal.subject,
        actorId: access.auth.principal.id,
        at: access.db.now(),
        payload: reason ? { stateReason: reason } : undefined,
      }),
    );
  }

  const issue = await getIssueDto(access.db, access.repo.id, number);
  emitDomainEvent(
    buildEvent({
      type: "issue.edited",
      repoId: access.repo.id,
      owner: ctx.params.owner,
      repo: ctx.params.repo,
      issueNumber: number,
      actorSubject: access.auth.principal.subject,
      actorId: access.auth.principal.id,
      at: access.db.now(),
    }),
  );
  return json({ issue });
};

/** Shared close/reopen state transition. */
function stateTransitionHandler(target: "open" | "closed"): Route["handler"] {
  return async (ctx) => {
    const access = await requireRepoAccess(ctx, "issues.write", SCOPES.hostingWrite);
    if (access instanceof Response) return access;
    const csrf = csrfGuard(ctx, access.auth);
    if (csrf) return csrf;
    const number = parseNumberParam(ctx.params.number);
    if (number === null) return errorResponse(404, "not_found", "Not Found");
    const row = await getIssueRowByNumber(access.db, access.repo.id, number);
    if (!row || row.is_pull_request === 1) {
      return errorResponse(404, "not_found", "Not Found");
    }
    let reason: string | null = null;
    if (target === "closed") {
      const body = await readJson(ctx.request);
      reason = body?.stateReason === "not_planned" ? "not_planned" : "completed";
    }
    await setIssueState(access.db, row.id, target, reason);
    emitDomainEvent(
      buildEvent({
        type: target === "closed" ? "issue.closed" : "issue.reopened",
        repoId: access.repo.id,
        owner: ctx.params.owner,
        repo: ctx.params.repo,
        issueNumber: number,
        actorSubject: access.auth.principal.subject,
        actorId: access.auth.principal.id,
        at: access.db.now(),
        payload: reason ? { stateReason: reason } : undefined,
      }),
    );
    const issue = await getIssueDto(access.db, access.repo.id, number);
    return json({ issue });
  };
}

export const issueHandlers = {
  list: listIssuesHandler,
  open: openIssueHandler,
  get: getIssueHandler,
  patch: patchIssueHandler,
  close: stateTransitionHandler("closed"),
  reopen: stateTransitionHandler("open"),
} as const;
