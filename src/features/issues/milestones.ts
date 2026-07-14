/**
 * Milestone handlers: list, create, get, edit (incl. close/reopen), delete.
 *
 * List/read authorize `contents.read` (reader). Create/edit/delete authorize
 * `repo.admin` (maintainer floor — milestones are repo planning config, matching
 * the route table §4.6 "admin / maintainer").
 */

import { SCOPES } from "../../contract/v1.ts";
import type { Route } from "../../router.ts";
import { errorResponse, json } from "../repos/http.ts";
import { csrfGuard, requireRepoAccess } from "../repos/identity.ts";
import {
  createMilestone,
  deleteMilestone,
  getMilestone,
  listMilestones,
  updateMilestone,
} from "./store.ts";
import { parseNumberParam, parseStateFilter, readJson, str } from "./common.ts";

const MAX_TITLE = 1024;

/** `GET …/milestones` — list milestones (filter state=open|closed|all). */
const listMilestonesHandler: Route["handler"] = async (ctx) => {
  const access = await requireRepoAccess(ctx, "contents.read", SCOPES.hostingRead);
  if (access instanceof Response) return access;
  const state = parseStateFilter(ctx.url.searchParams.get("state"));
  return json({ milestones: await listMilestones(access.db, access.repo.id, state) });
};

/** `POST …/milestones` — create a milestone (maintainer). */
const createMilestoneHandler: Route["handler"] = async (ctx) => {
  const access = await requireRepoAccess(ctx, "repo.admin", SCOPES.hostingAdmin);
  if (access instanceof Response) return access;
  const csrf = csrfGuard(ctx, access.auth);
  if (csrf) return csrf;
  const body = await readJson(ctx.request);
  if (!body) return errorResponse(400, "invalid_body", "Invalid request body.");
  const title = str(body.title);
  if (!title || title.length > MAX_TITLE) {
    return errorResponse(400, "invalid_title", "A non-empty title is required.");
  }
  const description = typeof body.description === "string" ? body.description : null;
  let dueOn: number | null = null;
  if (body.dueOn != null) {
    if (typeof body.dueOn !== "number" || !Number.isSafeInteger(body.dueOn)) {
      return errorResponse(400, "invalid_due_on", "dueOn must be epoch milliseconds.");
    }
    dueOn = body.dueOn;
  }
  const milestone = await createMilestone(access.db, access.repo.id, {
    title,
    description,
    dueOn,
  });
  return json({ milestone }, 201);
};

/** `GET …/milestones/:number` — single milestone. */
const getMilestoneHandler: Route["handler"] = async (ctx) => {
  const access = await requireRepoAccess(ctx, "contents.read", SCOPES.hostingRead);
  if (access instanceof Response) return access;
  const number = parseNumberParam(ctx.params.number);
  if (number === null) return errorResponse(404, "not_found", "Not Found");
  const milestone = await getMilestone(access.db, access.repo.id, number);
  if (!milestone) return errorResponse(404, "not_found", "Not Found");
  return json({ milestone });
};

/** `PATCH …/milestones/:number` — edit / close / reopen (maintainer). */
const patchMilestoneHandler: Route["handler"] = async (ctx) => {
  const access = await requireRepoAccess(ctx, "repo.admin", SCOPES.hostingAdmin);
  if (access instanceof Response) return access;
  const csrf = csrfGuard(ctx, access.auth);
  if (csrf) return csrf;
  const number = parseNumberParam(ctx.params.number);
  if (number === null) return errorResponse(404, "not_found", "Not Found");
  const body = await readJson(ctx.request);
  if (!body) return errorResponse(400, "invalid_body", "Invalid request body.");
  const input: {
    title?: string;
    description?: string | null;
    state?: "open" | "closed";
    dueOn?: number | null;
  } = {};
  if (body.title !== undefined) {
    const title = str(body.title);
    if (!title || title.length > MAX_TITLE) {
      return errorResponse(400, "invalid_title", "A non-empty title is required.");
    }
    input.title = title;
  }
  if (body.description !== undefined) {
    input.description = typeof body.description === "string" ? body.description : null;
  }
  if (body.state !== undefined) {
    if (body.state !== "open" && body.state !== "closed") {
      return errorResponse(400, "invalid_state", "state must be 'open' or 'closed'.");
    }
    input.state = body.state;
  }
  if (body.dueOn !== undefined) {
    if (body.dueOn === null) {
      input.dueOn = null;
    } else if (typeof body.dueOn === "number" && Number.isSafeInteger(body.dueOn)) {
      input.dueOn = body.dueOn;
    } else {
      return errorResponse(400, "invalid_due_on", "dueOn must be epoch milliseconds or null.");
    }
  }
  const milestone = await updateMilestone(access.db, access.repo.id, number, input);
  if (!milestone) return errorResponse(404, "not_found", "Not Found");
  return json({ milestone });
};

/** `DELETE …/milestones/:number` — delete (maintainer). */
const deleteMilestoneHandler: Route["handler"] = async (ctx) => {
  const access = await requireRepoAccess(ctx, "repo.admin", SCOPES.hostingAdmin);
  if (access instanceof Response) return access;
  const csrf = csrfGuard(ctx, access.auth);
  if (csrf) return csrf;
  const number = parseNumberParam(ctx.params.number);
  if (number === null) return errorResponse(404, "not_found", "Not Found");
  const ok = await deleteMilestone(access.db, access.repo.id, number);
  if (!ok) return errorResponse(404, "not_found", "Not Found");
  return json({ deleted: true });
};

export const milestoneHandlers = {
  list: listMilestonesHandler,
  create: createMilestoneHandler,
  get: getMilestoneHandler,
  patch: patchMilestoneHandler,
  remove: deleteMilestoneHandler,
} as const;
