/**
 * HTTP handlers for check runs + commit statuses.
 *
 * Every handler authorizes through `requireRepoAccess` (reuse of the Phase-3a
 * pattern): reads floor at `contents.read` (so anon reads a public repo, an
 * Interface bearer needs `hosting.read`); writes floor at `contents.write` (a
 * writer role, or an Interface bearer with the write scope — the "bot" path).
 *
 * `head_sha` (check runs) and the path `:sha` (statuses) MUST resolve to a real
 * commit in R2 before any D1 write — D1 never becomes the source of a SHA that R2
 * does not have.
 */

import { SCOPES } from "../../contract/v1.ts";
import { getCommitData } from "../../git/object-store.ts";
import { isValidSha } from "../../git/git-objects.ts";
import { repositoryObjectStore } from "../../git/repo-object-store.ts";
import { readRepoRefs } from "../../git/refs-store.ts";
import type { RouteContext } from "../../router.ts";
import type { ObjectStoreBinding } from "../../git/types.ts";
import { errorResponse, json } from "../repos/http.ts";
import {
  csrfGuard,
  requireRepoAccess,
  type RepoAccess,
} from "../repos/identity.ts";
import {
  CHECK_RUN_CONCLUSIONS,
  CHECK_RUN_STATUSES,
  COMMIT_STATUS_STATES,
  type CheckRunConclusion,
  type CheckRunStatus,
  type CommitStatusState,
} from "./dto.ts";
import type { CheckRunRecord } from "./service.ts";
import {
  combinedStatus,
  createCheckRun,
  createCommitStatus,
  getCheckRun,
  listCheckRuns,
  listCommitStatuses,
  updateCheckRun,
} from "./service.ts";

const MAX_COMMIT_BYTES = 1 << 20; // 1 MiB — plenty for a commit header.
const MAX_STRING = 65_536;

/** The canonical R2 storage key for a resolved repo (`<owner>/<name>`). */
function repoKey(access: RepoAccess): string {
  return `${access.repo.ownerLogin}/${access.repo.name}`;
}

function objectsFor(ctx: RouteContext, access: RepoAccess): ObjectStoreBinding {
  return repositoryObjectStore(ctx.env.BUCKET, repoKey(access));
}

async function readJson(
  ctx: RouteContext,
): Promise<Record<string, unknown> | Response> {
  let body: unknown;
  try {
    body = await ctx.request.json();
  } catch {
    return errorResponse(400, "invalid_json", "Request body is not valid JSON.");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return errorResponse(400, "invalid_body", "Request body must be an object.");
  }
  return body as Record<string, unknown>;
}

function optionalString(
  value: unknown,
  field: string,
): string | null | Response {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > MAX_STRING) {
    return errorResponse(400, "invalid_field", `Invalid \`${field}\`.`);
  }
  return value;
}

/** True SHA passes through; a ref name resolves against R2; else null. */
async function resolveRefOrSha(
  bucket: ObjectStoreBinding,
  repo: string,
  refOrSha: string,
): Promise<string | null> {
  if (isValidSha(refOrSha)) return refOrSha;
  const refs = await readRepoRefs(bucket, repo);
  const candidates = [
    refOrSha,
    `refs/heads/${refOrSha}`,
    `refs/tags/${refOrSha}`,
  ];
  for (const candidate of candidates) {
    const hit = refs.refs.find((ref) => ref.name === candidate);
    if (hit) return hit.sha;
  }
  return null;
}

async function commitExists(
  objects: ObjectStoreBinding,
  sha: string,
): Promise<boolean> {
  if (!isValidSha(sha)) return false;
  const commit = await getCommitData(objects, sha, MAX_COMMIT_BYTES);
  return commit !== null;
}

/** R2 spill key for a check run's long-form output text. */
function outputKey(checkRunId: string): string {
  return `checks/${checkRunId}/output.txt`;
}

async function readOutputText(
  objects: ObjectStoreBinding,
  key: string,
): Promise<string | null> {
  const object = await objects.get(key);
  if (!object) return null;
  return new TextDecoder().decode(new Uint8Array(await object.arrayBuffer()));
}

interface OutputInput {
  readonly title: string | null;
  readonly summary: string | null;
  readonly text: string | null;
  readonly present: boolean;
}

function parseOutput(value: unknown): OutputInput | Response {
  if (value === undefined || value === null) {
    return { title: null, summary: null, text: null, present: false };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return errorResponse(400, "invalid_field", "Invalid `output`.");
  }
  const raw = value as Record<string, unknown>;
  const title = optionalString(raw.title, "output.title");
  if (title instanceof Response) return title;
  const summary = optionalString(raw.summary, "output.summary");
  if (summary instanceof Response) return summary;
  const text = optionalString(raw.text, "output.text");
  if (text instanceof Response) return text;
  return { title, summary, text, present: true };
}

function checkRunDto(
  record: CheckRunRecord,
  text?: string | null,
): Record<string, unknown> {
  const output =
    record.output || text
      ? {
          title: record.output?.title ?? null,
          summary: record.output?.summary ?? null,
          ...(text !== undefined ? { text } : {}),
        }
      : null;
  return {
    id: record.id,
    headSha: record.headSha,
    name: record.name,
    status: record.status,
    conclusion: record.conclusion,
    detailsUrl: record.detailsUrl,
    externalId: record.externalId,
    workflowRunId: record.workflowRunId,
    output,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

// --- check run handlers -----------------------------------------------------

async function createCheckRunHandler(ctx: RouteContext): Promise<Response> {
  const access = await requireRepoAccess(
    ctx,
    "contents.write",
    SCOPES.smartHttpWrite,
  );
  if (access instanceof Response) return access;
  const csrf = csrfGuard(ctx, access.auth);
  if (csrf) return csrf;

  const body = await readJson(ctx);
  if (body instanceof Response) return body;

  const headSha = body.headSha ?? body.head_sha;
  if (typeof headSha !== "string" || !isValidSha(headSha)) {
    return errorResponse(400, "invalid_field", "`headSha` must be a 40-hex commit id.");
  }
  const name = body.name;
  if (typeof name !== "string" || name.trim().length === 0 || name.length > 255) {
    return errorResponse(400, "invalid_field", "`name` is required.");
  }
  const status: CheckRunStatus =
    body.status === undefined ? "queued" : (body.status as CheckRunStatus);
  if (!CHECK_RUN_STATUSES.has(status)) {
    return errorResponse(400, "invalid_field", "Invalid `status`.");
  }
  let conclusion: CheckRunConclusion | null = null;
  if (body.conclusion !== undefined && body.conclusion !== null) {
    if (!CHECK_RUN_CONCLUSIONS.has(body.conclusion as string)) {
      return errorResponse(400, "invalid_field", "Invalid `conclusion`.");
    }
    conclusion = body.conclusion as CheckRunConclusion;
  }
  if (status === "completed" && conclusion === null) {
    return errorResponse(
      400,
      "conclusion_required",
      "A completed check run requires a `conclusion`.",
    );
  }
  const detailsUrl = optionalString(body.detailsUrl ?? body.details_url, "detailsUrl");
  if (detailsUrl instanceof Response) return detailsUrl;
  const externalId = optionalString(body.externalId ?? body.external_id, "externalId");
  if (externalId instanceof Response) return externalId;
  const output = parseOutput(body.output);
  if (output instanceof Response) return output;

  const objects = objectsFor(ctx, access);
  if (!(await commitExists(objects, headSha))) {
    return errorResponse(422, "unknown_commit", "`headSha` is not a commit in this repository.");
  }

  const now = access.db.now();
  const effectiveConclusion = conclusion ?? (status === "completed" ? "neutral" : null);
  const startedAt = status === "queued" ? null : now;
  const completedAt = status === "completed" ? now : null;

  const record = await createCheckRun(access.db, access.repo.id, {
    headSha,
    name,
    status,
    conclusion: effectiveConclusion,
    detailsUrl,
    externalId,
    outputTitle: output.title,
    outputSummary: output.summary,
    startedAt,
    completedAt,
  });

  let text: string | null | undefined;
  if (output.text) {
    const key = outputKey(record.id);
    await objects.put(key, output.text);
    await updateCheckRun(access.db, access.repo.id, record.id, {
      outputR2Key: key,
    });
    text = output.text;
  }
  const fresh = (await getCheckRun(access.db, access.repo.id, record.id)) ?? record;
  return json({ checkRun: checkRunDto(fresh, text) }, 201);
}

async function updateCheckRunHandler(ctx: RouteContext): Promise<Response> {
  const access = await requireRepoAccess(
    ctx,
    "contents.write",
    SCOPES.smartHttpWrite,
  );
  if (access instanceof Response) return access;
  const csrf = csrfGuard(ctx, access.auth);
  if (csrf) return csrf;

  const id = ctx.params.checkRunId;
  const existing = await getCheckRun(access.db, access.repo.id, id);
  if (!existing) {
    return errorResponse(404, "not_found", "Check run not found.");
  }

  const body = await readJson(ctx);
  if (body instanceof Response) return body;

  // The service's patch type is deeply `readonly`; this handler assembles it
  // field-by-field, so build into a locally-mutable mirror of that exact type.
  const patch: {
    -readonly [K in keyof Parameters<typeof updateCheckRun>[3]]: Parameters<
      typeof updateCheckRun
    >[3][K];
  } = {};
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || body.name.trim().length === 0 || body.name.length > 255) {
      return errorResponse(400, "invalid_field", "Invalid `name`.");
    }
    patch.name = body.name;
  }
  let nextStatus: CheckRunStatus = existing.status;
  if (body.status !== undefined) {
    if (!CHECK_RUN_STATUSES.has(body.status as string)) {
      return errorResponse(400, "invalid_field", "Invalid `status`.");
    }
    nextStatus = body.status as CheckRunStatus;
    patch.status = nextStatus;
  }
  let nextConclusion: CheckRunConclusion | null = existing.conclusion;
  if (body.conclusion !== undefined) {
    if (body.conclusion !== null && !CHECK_RUN_CONCLUSIONS.has(body.conclusion as string)) {
      return errorResponse(400, "invalid_field", "Invalid `conclusion`.");
    }
    nextConclusion = (body.conclusion as CheckRunConclusion | null) ?? null;
    patch.conclusion = nextConclusion;
  }
  if (nextStatus === "completed" && nextConclusion === null) {
    return errorResponse(
      400,
      "conclusion_required",
      "A completed check run requires a `conclusion`.",
    );
  }
  if (body.detailsUrl !== undefined || body.details_url !== undefined) {
    const detailsUrl = optionalString(body.detailsUrl ?? body.details_url, "detailsUrl");
    if (detailsUrl instanceof Response) return detailsUrl;
    patch.detailsUrl = detailsUrl;
  }
  if (body.externalId !== undefined || body.external_id !== undefined) {
    const externalId = optionalString(body.externalId ?? body.external_id, "externalId");
    if (externalId instanceof Response) return externalId;
    patch.externalId = externalId;
  }

  // Derive lifecycle timestamps on transitions (only when not explicitly given).
  const now = access.db.now();
  if (patch.status !== undefined) {
    if (nextStatus !== "queued" && existing.startedAt === null) {
      patch.startedAt = now;
    }
    if (nextStatus === "completed" && existing.completedAt === null) {
      patch.completedAt = now;
    }
  }

  const objects = objectsFor(ctx, access);
  let text: string | null | undefined;
  if (body.output !== undefined) {
    const output = parseOutput(body.output);
    if (output instanceof Response) return output;
    patch.outputTitle = output.title;
    patch.outputSummary = output.summary;
    if (output.text) {
      const key = outputKey(id);
      await objects.put(key, output.text);
      patch.outputR2Key = key;
      text = output.text;
    } else {
      // Clearing output text drops the spill pointer.
      patch.outputR2Key = null;
      text = null;
    }
  }

  const updated = await updateCheckRun(access.db, access.repo.id, id, patch);
  if (!updated) return errorResponse(404, "not_found", "Check run not found.");
  if (text === undefined && updated.outputR2Key) {
    text = await readOutputText(objects, updated.outputR2Key);
  }
  return json({ checkRun: checkRunDto(updated, text) });
}

async function getCheckRunHandler(ctx: RouteContext): Promise<Response> {
  const access = await requireRepoAccess(ctx, "contents.read", SCOPES.hostingRead);
  if (access instanceof Response) return access;
  const record = await getCheckRun(access.db, access.repo.id, ctx.params.checkRunId);
  if (!record) return errorResponse(404, "not_found", "Check run not found.");
  let text: string | null | undefined;
  if (record.outputR2Key) {
    text = await readOutputText(objectsFor(ctx, access), record.outputR2Key);
  }
  return json({ checkRun: checkRunDto(record, text) });
}

async function listCheckRunsHandler(ctx: RouteContext): Promise<Response> {
  const access = await requireRepoAccess(ctx, "contents.read", SCOPES.hostingRead);
  if (access instanceof Response) return access;
  const objects = objectsFor(ctx, access);
  const sha = await resolveRefOrSha(objects, repoKey(access), ctx.params.sha);
  if (!sha) return errorResponse(404, "ref_not_found", "Ref or commit not found.");
  const records = await listCheckRuns(access.db, access.repo.id, sha);
  return json({
    sha,
    totalCount: records.length,
    checkRuns: records.map((record) => checkRunDto(record)),
  });
}

// --- commit status handlers -------------------------------------------------

async function createCommitStatusHandler(ctx: RouteContext): Promise<Response> {
  const access = await requireRepoAccess(
    ctx,
    "contents.write",
    SCOPES.smartHttpWrite,
  );
  if (access instanceof Response) return access;
  const csrf = csrfGuard(ctx, access.auth);
  if (csrf) return csrf;

  const sha = ctx.params.sha;
  if (!isValidSha(sha)) {
    return errorResponse(400, "invalid_field", "Status target must be a 40-hex commit id.");
  }

  const body = await readJson(ctx);
  if (body instanceof Response) return body;

  const state = body.state;
  if (typeof state !== "string" || !COMMIT_STATUS_STATES.has(state)) {
    return errorResponse(400, "invalid_field", "Invalid `state`.");
  }
  const contextRaw = body.context;
  const context =
    contextRaw === undefined || contextRaw === null ? "default" : contextRaw;
  if (typeof context !== "string" || context.length === 0 || context.length > 255) {
    return errorResponse(400, "invalid_field", "Invalid `context`.");
  }
  const description = optionalString(body.description, "description");
  if (description instanceof Response) return description;
  const targetUrl = optionalString(body.targetUrl ?? body.target_url, "targetUrl");
  if (targetUrl instanceof Response) return targetUrl;

  const objects = objectsFor(ctx, access);
  if (!(await commitExists(objects, sha))) {
    return errorResponse(422, "unknown_commit", "The status target is not a commit in this repository.");
  }

  const creatorId =
    access.auth.principal.id === "anon" ? null : access.auth.principal.id;
  const record = await createCommitStatus(access.db, access.repo.id, {
    sha,
    context,
    state: state as CommitStatusState,
    description,
    targetUrl,
    creatorId,
  });
  return json({ status: record }, 201);
}

async function listCommitStatusesHandler(ctx: RouteContext): Promise<Response> {
  const access = await requireRepoAccess(ctx, "contents.read", SCOPES.hostingRead);
  if (access instanceof Response) return access;
  const objects = objectsFor(ctx, access);
  const sha = await resolveRefOrSha(objects, repoKey(access), ctx.params.sha);
  if (!sha) return errorResponse(404, "ref_not_found", "Ref or commit not found.");
  const statuses = await listCommitStatuses(access.db, access.repo.id, sha);
  return json({ sha, totalCount: statuses.length, statuses });
}

async function combinedStatusHandler(ctx: RouteContext): Promise<Response> {
  const access = await requireRepoAccess(ctx, "contents.read", SCOPES.hostingRead);
  if (access instanceof Response) return access;
  const objects = objectsFor(ctx, access);
  const sha = await resolveRefOrSha(objects, repoKey(access), ctx.params.sha);
  if (!sha) return errorResponse(404, "ref_not_found", "Ref or commit not found.");
  const combined = await combinedStatus(access.db, access.repo.id, sha);
  return json(combined);
}

export const checksHandlers = {
  createCheckRun: createCheckRunHandler,
  updateCheckRun: updateCheckRunHandler,
  getCheckRun: getCheckRunHandler,
  listCheckRuns: listCheckRunsHandler,
  createCommitStatus: createCommitStatusHandler,
  listCommitStatuses: listCommitStatusesHandler,
  combinedStatus: combinedStatusHandler,
};
