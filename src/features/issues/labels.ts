/**
 * Repo label handlers, plus issue label assignment.
 *
 * Label CRUD authorizes `repo.admin` (maintainer floor — labels are repo config).
 * Assigning/unassigning labels to an issue is triage and authorizes `issues.write`
 * (writer floor).
 */

import { SCOPES } from "../../contract/v1.ts";
import type { Route } from "../../router.ts";
import { errorResponse, json } from "../repos/http.ts";
import { csrfGuard, requireRepoAccess, type RepoAccess } from "../repos/identity.ts";
import type { RouteContext } from "../../router.ts";
import { buildEvent, emitDomainEvent } from "./events.ts";
import {
  addIssueLabels,
  createLabel,
  deleteLabel,
  getIssueDto,
  getIssueRowByNumber,
  isValidColor,
  isValidLabelName,
  listLabels,
  removeIssueLabelByName,
  resolveLabelIds,
  setIssueLabels,
  updateLabel,
} from "./store.ts";
import { parseNumberParam, readJson, str, strArray } from "./common.ts";

/** `GET …/labels` — list repo labels. */
const listLabelsHandler: Route["handler"] = async (ctx) => {
  const access = await requireRepoAccess(ctx, "contents.read", SCOPES.hostingRead);
  if (access instanceof Response) return access;
  return json({ labels: await listLabels(access.db, access.repo.id) });
};

/** `POST …/labels` — create a label (maintainer). */
const createLabelHandler: Route["handler"] = async (ctx) => {
  const access = await requireRepoAccess(ctx, "repo.admin", SCOPES.hostingAdmin);
  if (access instanceof Response) return access;
  const csrf = csrfGuard(ctx, access.auth);
  if (csrf) return csrf;
  const body = await readJson(ctx.request);
  if (!body) return errorResponse(400, "invalid_body", "Invalid request body.");
  const name = str(body.name);
  if (!name || !isValidLabelName(name)) {
    return errorResponse(400, "invalid_name", "A valid label name is required.");
  }
  const color = str(body.color) ?? "888888";
  if (!isValidColor(color)) {
    return errorResponse(400, "invalid_color", "color must be a 6-hex string.");
  }
  const description = typeof body.description === "string" ? body.description : null;
  const result = await createLabel(access.db, access.repo.id, { name, color, description });
  if (!result.ok) {
    return errorResponse(409, "label_exists", "A label with that name already exists.");
  }
  return json({ label: result.label }, 201);
};

/** `PATCH …/labels/:name` — edit a label (maintainer). */
const patchLabelHandler: Route["handler"] = async (ctx) => {
  const access = await requireRepoAccess(ctx, "repo.admin", SCOPES.hostingAdmin);
  if (access instanceof Response) return access;
  const csrf = csrfGuard(ctx, access.auth);
  if (csrf) return csrf;
  const body = await readJson(ctx.request);
  if (!body) return errorResponse(400, "invalid_body", "Invalid request body.");
  const input: { name?: string; color?: string; description?: string | null } = {};
  if (body.name !== undefined) {
    const name = str(body.name);
    if (!name || !isValidLabelName(name)) {
      return errorResponse(400, "invalid_name", "A valid label name is required.");
    }
    input.name = name;
  }
  if (body.color !== undefined) {
    const color = str(body.color);
    if (!color || !isValidColor(color)) {
      return errorResponse(400, "invalid_color", "color must be a 6-hex string.");
    }
    input.color = color;
  }
  if (body.description !== undefined) {
    input.description = typeof body.description === "string" ? body.description : null;
  }
  const updated = await updateLabel(access.db, access.repo.id, ctx.params.name, input);
  if (!updated) return errorResponse(404, "not_found", "Not Found");
  return json({ label: updated });
};

/** `DELETE …/labels/:name` — delete a label (maintainer). */
const deleteLabelHandler: Route["handler"] = async (ctx) => {
  const access = await requireRepoAccess(ctx, "repo.admin", SCOPES.hostingAdmin);
  if (access instanceof Response) return access;
  const csrf = csrfGuard(ctx, access.auth);
  if (csrf) return csrf;
  const ok = await deleteLabel(access.db, access.repo.id, ctx.params.name);
  if (!ok) return errorResponse(404, "not_found", "Not Found");
  return json({ deleted: true });
};

function emitLabeled(
  ctx: RouteContext,
  access: RepoAccess,
  number: number,
  type: "issue.labeled" | "issue.unlabeled",
  payload: Record<string, unknown>,
): void {
  emitDomainEvent(
    buildEvent({
      type,
      repoId: access.repo.id,
      owner: ctx.params.owner,
      repo: ctx.params.repo,
      issueNumber: number,
      actorSubject: access.auth.principal.subject,
      actorId: access.auth.principal.id,
      at: access.db.now(),
      payload,
    }),
  );
}

/** `PUT …/issues/:number/labels` — replace the issue's label set (writer). */
const setIssueLabelsHandler: Route["handler"] = async (ctx) => {
  const access = await requireRepoAccess(ctx, "issues.write", SCOPES.hostingWrite);
  if (access instanceof Response) return access;
  const csrf = csrfGuard(ctx, access.auth);
  if (csrf) return csrf;
  const number = parseNumberParam(ctx.params.number);
  if (number === null) return errorResponse(404, "not_found", "Not Found");
  const issue = await getIssueRowByNumber(access.db, access.repo.id, number);
  if (!issue) return errorResponse(404, "not_found", "Not Found");
  const body = await readJson(ctx.request);
  const names = body ? strArray(body.labels) : null;
  if (names === null) {
    return errorResponse(400, "invalid_labels", "labels must be an array of names.");
  }
  const resolved = await resolveLabelIds(access.db, access.repo.id, names);
  if (resolved.missing.length > 0) {
    return errorResponse(400, "unknown_label", "Unknown label.", { labels: resolved.missing });
  }
  await setIssueLabels(access.db, issue.id, resolved.ids);
  emitLabeled(ctx, access, number, "issue.labeled", { labels: names });
  const dto = await getIssueDto(access.db, access.repo.id, number);
  return json({ labels: dto?.labels ?? [] });
};

/** `POST …/issues/:number/labels` — add labels to the issue (writer). */
const addIssueLabelsHandler: Route["handler"] = async (ctx) => {
  const access = await requireRepoAccess(ctx, "issues.write", SCOPES.hostingWrite);
  if (access instanceof Response) return access;
  const csrf = csrfGuard(ctx, access.auth);
  if (csrf) return csrf;
  const number = parseNumberParam(ctx.params.number);
  if (number === null) return errorResponse(404, "not_found", "Not Found");
  const issue = await getIssueRowByNumber(access.db, access.repo.id, number);
  if (!issue) return errorResponse(404, "not_found", "Not Found");
  const body = await readJson(ctx.request);
  const names = body ? strArray(body.labels) : null;
  if (names === null) {
    return errorResponse(400, "invalid_labels", "labels must be an array of names.");
  }
  const resolved = await resolveLabelIds(access.db, access.repo.id, names);
  if (resolved.missing.length > 0) {
    return errorResponse(400, "unknown_label", "Unknown label.", { labels: resolved.missing });
  }
  await addIssueLabels(access.db, issue.id, resolved.ids);
  emitLabeled(ctx, access, number, "issue.labeled", { labels: names });
  const dto = await getIssueDto(access.db, access.repo.id, number);
  return json({ labels: dto?.labels ?? [] });
};

/** `DELETE …/issues/:number/labels/:name` — remove one label (writer). */
const removeIssueLabelHandler: Route["handler"] = async (ctx) => {
  const access = await requireRepoAccess(ctx, "issues.write", SCOPES.hostingWrite);
  if (access instanceof Response) return access;
  const csrf = csrfGuard(ctx, access.auth);
  if (csrf) return csrf;
  const number = parseNumberParam(ctx.params.number);
  if (number === null) return errorResponse(404, "not_found", "Not Found");
  const issue = await getIssueRowByNumber(access.db, access.repo.id, number);
  if (!issue) return errorResponse(404, "not_found", "Not Found");
  const removed = await removeIssueLabelByName(
    access.db,
    access.repo.id,
    issue.id,
    ctx.params.name,
  );
  if (!removed) return errorResponse(404, "not_found", "Label not on issue.");
  emitLabeled(ctx, access, number, "issue.unlabeled", { label: ctx.params.name });
  const dto = await getIssueDto(access.db, access.repo.id, number);
  return json({ labels: dto?.labels ?? [] });
};

export const labelHandlers = {
  list: listLabelsHandler,
  create: createLabelHandler,
  patch: patchLabelHandler,
  remove: deleteLabelHandler,
  setIssueLabels: setIssueLabelsHandler,
  addIssueLabels: addIssueLabelsHandler,
  removeIssueLabel: removeIssueLabelHandler,
} as const;
