/**
 * HTTP handlers for the Actions control plane.
 *
 * Every handler authorizes through `requireRepoAccess` (the Phase-3 pattern):
 * reads floor at `contents.read`; run write/dispatch/cancel floor at
 * `contents.write` (the "bot"/writer path); secrets floor at `repo.admin`. Reads
 * of `sha` / workflow files are always resolved against R2 (authoritative), never
 * from a D1 projection.
 *
 * Ported from the Takos worker `routes/repos/{workflows,actions/*}.ts`, rebound to
 * the takos-git router + ACL + `/api/v1` envelope, with the Cloudflare-Queue /
 * `RUNTIME_HOST` dispatch replaced by the Phase-5b seam (`dispatch.ts`).
 */

import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  SCOPES,
} from "../../contract/v1.ts";
import { getBlob, getCommitData } from "../../git/object-store.ts";
import { getEntryAtPath } from "../../git/tree-ops.ts";
import { isValidSha } from "../../git/git-objects.ts";
import { repositoryObjectStore } from "../../git/repo-object-store.ts";
import { readRepoRefs } from "../../git/refs-store.ts";
import type { ObjectStoreBinding } from "../../git/types.ts";
import type { RouteContext } from "../../router.ts";
import { errorResponse, json } from "../repos/http.ts";
import {
  csrfGuard,
  requireRepoAccess,
  type RepoAccess,
} from "../repos/identity.ts";
import { actionsEnv, actionsSecretKey } from "./env.ts";
import { loadAndValidateWorkflow, listWorkflowFiles } from "./discovery.ts";
import { hasWorkflowDispatch } from "./triggers.ts";
import {
  getJobDetail,
  getWorkflowRunDetail,
  getWorkflowRunJobs,
  listWorkflowRuns,
} from "./read-model.ts";
import {
  allocateRunNumber,
  cancelRun,
  nextRunAttempt,
} from "./service.ts";
import { persistAndDispatchRun } from "./orchestrator.ts";
import {
  deleteWorkflowSecret,
  listWorkflowSecrets,
  MAX_SECRET_VALUE_BYTES,
  putWorkflowSecret,
  SECRET_NAME_PATTERN,
} from "./secrets.ts";
import type { WorkflowDto } from "./dto.ts";

const MAX_COMMIT_BYTES = 1 << 20;

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

/**
 * Resolve a branch short-name to its tip commit SHA via R2 refs, or null.
 * Refs live in the per-repo doc on the RAW bucket (not the repo-scoped object
 * store), so this takes the raw `BUCKET`.
 */
async function resolveBranchSha(
  bucket: ObjectStoreBinding,
  repo: string,
  branch: string,
): Promise<string | null> {
  const refs = await readRepoRefs(bucket, repo);
  const hit = refs.refs.find((ref) => ref.name === `refs/heads/${branch}`);
  return hit?.sha ?? null;
}

interface LoadedWorkflowFile {
  readonly content: string;
  readonly contentSha: string;
}

/** Load a workflow file blob (+ its blob SHA) from a commit, or null when absent. */
async function loadWorkflowFile(
  objects: ObjectStoreBinding,
  commitSha: string,
  path: string,
): Promise<LoadedWorkflowFile | null> {
  const commit = await getCommitData(objects, commitSha, MAX_COMMIT_BYTES);
  if (!commit) return null;
  const entry = await getEntryAtPath(objects, commit.tree, path);
  if (!entry || entry.type !== "blob") return null;
  const blob = await getBlob(objects, entry.sha);
  if (!blob) return null;
  return { content: new TextDecoder().decode(blob), contentSha: entry.sha };
}

// ============================================================================
// Workflows + runs (reads)
// ============================================================================

async function listWorkflowsHandler(ctx: RouteContext): Promise<Response> {
  const access = await requireRepoAccess(ctx, "contents.read", SCOPES.hostingRead);
  if (access instanceof Response) return access;
  const db = access.db;

  const cached = await db.query<{
    id: string;
    path: string;
    name: string | null;
    triggers: string | null;
    state: string;
    parsed_at: number | null;
    updated_at: number | null;
  }>(
    `SELECT id, path, name, triggers, state, parsed_at, updated_at
       FROM workflows WHERE repo_id = ? ORDER BY path ASC`,
    [access.repo.id],
  );
  const cachedByPath = new Map(cached.map((row) => [row.path, row]));

  const branch = ctx.url.searchParams.get("branch") || access.repo.defaultBranch;
  const objects = objectsFor(ctx, access);
  let paths: string[] = [...cachedByPath.keys()];
  const sha = await resolveBranchSha(ctx.env.BUCKET, repoKey(access), branch);
  if (sha) {
    const files = await listWorkflowFiles(objects, sha);
    const gitPaths = files.map((file) => file.path);
    // Git is authoritative for which workflows exist; union with any cached-only.
    paths = [...new Set([...gitPaths, ...cachedByPath.keys()])].sort();
  }

  const workflows: WorkflowDto[] = paths.map((path) => {
    const row = cachedByPath.get(path);
    if (!row) {
      return {
        id: null,
        path,
        name: null,
        triggers: [],
        state: "active",
        parsedAt: null,
        updatedAt: null,
      };
    }
    let triggers: string[] = [];
    try {
      triggers = row.triggers ? (JSON.parse(row.triggers) as string[]) : [];
    } catch {
      triggers = [];
    }
    return {
      id: row.id,
      path: row.path,
      name: row.name,
      triggers,
      state: row.state,
      parsedAt: row.parsed_at,
      updatedAt: row.updated_at,
    };
  });

  return json({ ref: branch, workflows });
}

function parseOffsetPagination(url: URL): { limit: number; offset: number } {
  const requested = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Number.isSafeInteger(requested)
    ? Math.max(1, Math.min(requested, MAX_PAGE_LIMIT))
    : DEFAULT_PAGE_LIMIT;
  const cursorRaw = Number.parseInt(url.searchParams.get("cursor") ?? "", 10);
  const offset = Number.isSafeInteger(cursorRaw) && cursorRaw > 0 ? cursorRaw : 0;
  return { limit, offset };
}

async function listRunsHandler(ctx: RouteContext): Promise<Response> {
  const access = await requireRepoAccess(ctx, "contents.read", SCOPES.hostingRead);
  if (access instanceof Response) return access;
  const { limit, offset } = parseOffsetPagination(ctx.url);
  const filters = {
    workflow: ctx.url.searchParams.get("workflow") || undefined,
    status: ctx.url.searchParams.get("status") || undefined,
    branch: ctx.url.searchParams.get("branch") || undefined,
    event: ctx.url.searchParams.get("event") || undefined,
    limit,
    offset,
  };
  const result = await listWorkflowRuns(access.db, access.repo.id, filters);
  return json({
    runs: result.runs,
    nextCursor: result.hasMore ? String(offset + limit) : null,
  });
}

async function getRunHandler(ctx: RouteContext): Promise<Response> {
  const access = await requireRepoAccess(ctx, "contents.read", SCOPES.hostingRead);
  if (access instanceof Response) return access;
  const detail = await getWorkflowRunDetail(access.db, access.repo.id, ctx.params.runId);
  if (!detail) return errorResponse(404, "not_found", "Run not found.");
  return json(detail);
}

async function getRunJobsHandler(ctx: RouteContext): Promise<Response> {
  const access = await requireRepoAccess(ctx, "contents.read", SCOPES.hostingRead);
  if (access instanceof Response) return access;
  const jobs = await getWorkflowRunJobs(access.db, access.repo.id, ctx.params.runId);
  if (!jobs) return errorResponse(404, "not_found", "Run not found.");
  return json({ jobs });
}

async function getJobHandler(ctx: RouteContext): Promise<Response> {
  const access = await requireRepoAccess(ctx, "contents.read", SCOPES.hostingRead);
  if (access instanceof Response) return access;
  const detail = await getJobDetail(access.db, access.repo.id, ctx.params.jobId);
  if (!detail) return errorResponse(404, "not_found", "Job not found.");
  return json({ job: detail.job, runId: detail.runId });
}

async function getJobLogsHandler(ctx: RouteContext): Promise<Response> {
  const access = await requireRepoAccess(ctx, "contents.read", SCOPES.hostingRead);
  if (access instanceof Response) return access;
  const detail = await getJobDetail(access.db, access.repo.id, ctx.params.jobId);
  if (!detail) return errorResponse(404, "not_found", "Job not found.");
  const bucket = actionsEnv(ctx.env).R2_ACTIONS;
  if (!detail.logsR2Key || !bucket) {
    // No logs yet (control plane has not executed anything — Phase 5b writes logs).
    return errorResponse(404, "logs_not_found", "No logs for this job.");
  }
  const object = await bucket.get(detail.logsR2Key);
  if (!object) return errorResponse(404, "logs_not_found", "No logs for this job.");
  const logs = new TextDecoder().decode(new Uint8Array(await object.arrayBuffer()));
  return json({ jobId: ctx.params.jobId, logs });
}

// ============================================================================
// Artifacts (reads)
// ============================================================================

interface RawArtifact {
  id: string;
  name: string;
  r2_key: string;
  size_bytes: number | null;
  content_type: string | null;
  expires_at: number | null;
  created_at: number;
}

async function listArtifactsHandler(ctx: RouteContext): Promise<Response> {
  const access = await requireRepoAccess(ctx, "contents.read", SCOPES.hostingRead);
  if (access instanceof Response) return access;
  const run = await access.db.queryOne<{ id: string }>(
    `SELECT id FROM workflow_runs WHERE id = ? AND repo_id = ? LIMIT 1`,
    [ctx.params.runId, access.repo.id],
  );
  if (!run) return errorResponse(404, "not_found", "Run not found.");
  const rows = await access.db.query<RawArtifact>(
    `SELECT id, name, r2_key, size_bytes, content_type, expires_at, created_at
       FROM workflow_run_artifacts WHERE run_id = ? ORDER BY created_at ASC`,
    [ctx.params.runId],
  );
  return json({
    artifacts: rows.map((row) => ({
      id: row.id,
      name: row.name,
      sizeBytes: row.size_bytes,
      contentType: row.content_type,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    })),
  });
}

async function downloadArtifactHandler(ctx: RouteContext): Promise<Response> {
  const access = await requireRepoAccess(ctx, "contents.read", SCOPES.hostingRead);
  if (access instanceof Response) return access;
  const row = await access.db.queryOne<RawArtifact>(
    `SELECT a.id, a.name, a.r2_key, a.size_bytes, a.content_type, a.expires_at, a.created_at
       FROM workflow_run_artifacts a
       JOIN workflow_runs r ON r.id = a.run_id
      WHERE a.id = ? AND r.repo_id = ? LIMIT 1`,
    [ctx.params.artifactId, access.repo.id],
  );
  if (!row) return errorResponse(404, "not_found", "Artifact not found.");
  if (row.expires_at !== null && row.expires_at < access.db.now()) {
    return errorResponse(410, "artifact_expired", "Artifact has expired.");
  }
  const bucket = actionsEnv(ctx.env).R2_ACTIONS;
  if (!bucket) return errorResponse(404, "not_found", "Artifact storage not configured.");
  const object = await bucket.get(row.r2_key);
  if (!object) return errorResponse(404, "not_found", "Artifact bytes not found.");
  const headers = new Headers();
  headers.set("content-type", row.content_type || "application/octet-stream");
  headers.set(
    "content-disposition",
    `attachment; filename="${encodeURIComponent(row.name)}"`,
  );
  headers.set("cache-control", "private, max-age=3600");
  return new Response(await object.arrayBuffer(), { headers });
}

// ============================================================================
// Dispatch / rerun / cancel (writes)
// ============================================================================

async function dispatchRunHandler(ctx: RouteContext): Promise<Response> {
  const access = await requireRepoAccess(ctx, "contents.write", SCOPES.smartHttpWrite);
  if (access instanceof Response) return access;
  const csrf = csrfGuard(ctx, access.auth);
  if (csrf) return csrf;

  const body = await readJson(ctx);
  if (body instanceof Response) return body;
  const workflowPath = body.workflow ?? body.workflowPath;
  if (typeof workflowPath !== "string" || workflowPath.length === 0) {
    return errorResponse(400, "invalid_field", "`workflow` path is required.");
  }
  const branchRaw = body.ref ?? body.branch;
  const branch =
    typeof branchRaw === "string" && branchRaw.length > 0
      ? branchRaw.replace(/^refs\/heads\//u, "")
      : access.repo.defaultBranch;
  let inputs: Record<string, unknown> | null = null;
  if (body.inputs !== undefined && body.inputs !== null) {
    if (typeof body.inputs !== "object" || Array.isArray(body.inputs)) {
      return errorResponse(400, "invalid_field", "`inputs` must be an object.");
    }
    inputs = body.inputs as Record<string, unknown>;
  }

  const objects = objectsFor(ctx, access);
  const sha = await resolveBranchSha(ctx.env.BUCKET, repoKey(access), branch);
  if (!sha) return errorResponse(404, "ref_not_found", "Branch not found.");
  const file = await loadWorkflowFile(objects, sha, workflowPath);
  if (!file) return errorResponse(404, "not_found", "Workflow file not found on this branch.");

  const result = loadAndValidateWorkflow(file.content);
  if (!result.ok) {
    return errorResponse(400, "invalid_workflow", result.message, {
      details: result.details,
    });
  }
  if (!hasWorkflowDispatch(result.workflow.on)) {
    return errorResponse(
      400,
      "dispatch_unsupported",
      "Workflow does not declare a workflow_dispatch trigger.",
    );
  }

  const actorId =
    access.auth.principal.id === "anon" ? null : access.auth.principal.id;
  const runNumber = await allocateRunNumber(access.db, access.repo.id, workflowPath);
  const created = await persistAndDispatchRun(access.db, ctx.env, {
    repoId: access.repo.id,
    repoFullName: repoKey(access),
    workflowPath,
    workflowName: result.workflow.name ?? null,
    contentSha: file.contentSha,
    event: "workflow_dispatch",
    ref: `refs/heads/${branch}`,
    sha,
    actorId,
    inputs,
    workflow: result.workflow,
    runNumber,
  });
  const detail = await getWorkflowRunDetail(access.db, access.repo.id, created.id);
  return json({ ...detail, dispatched: created.dispatched }, 201);
}

interface RunRow {
  id: string;
  workflow_path: string;
  event: string;
  ref: string | null;
  sha: string | null;
  status: string;
  run_number: number;
  inputs: string | null;
}

async function rerunHandler(ctx: RouteContext): Promise<Response> {
  const access = await requireRepoAccess(ctx, "contents.write", SCOPES.smartHttpWrite);
  if (access instanceof Response) return access;
  const csrf = csrfGuard(ctx, access.auth);
  if (csrf) return csrf;

  const run = await access.db.queryOne<RunRow>(
    `SELECT id, workflow_path, event, ref, sha, status, run_number, inputs
       FROM workflow_runs WHERE id = ? AND repo_id = ? LIMIT 1`,
    [ctx.params.runId, access.repo.id],
  );
  if (!run) return errorResponse(404, "not_found", "Run not found.");
  if (run.status !== "completed") {
    return errorResponse(400, "not_terminal", "Only a completed run can be re-run.");
  }
  if (!run.sha || !isValidSha(run.sha)) {
    return errorResponse(422, "unknown_commit", "Run has no pinned commit to re-run.");
  }

  const objects = objectsFor(ctx, access);
  const file = await loadWorkflowFile(objects, run.sha, run.workflow_path);
  if (!file) return errorResponse(404, "not_found", "Workflow file no longer exists at that commit.");
  const result = loadAndValidateWorkflow(file.content);
  if (!result.ok) {
    return errorResponse(400, "invalid_workflow", result.message, {
      details: result.details,
    });
  }

  const actorId =
    access.auth.principal.id === "anon" ? null : access.auth.principal.id;
  let inputs: Record<string, unknown> | null = null;
  if (run.inputs) {
    try {
      inputs = JSON.parse(run.inputs) as Record<string, unknown>;
    } catch {
      inputs = null;
    }
  }
  const runAttempt = await nextRunAttempt(
    access.db,
    access.repo.id,
    run.workflow_path,
    run.run_number,
  );
  const created = await persistAndDispatchRun(access.db, ctx.env, {
    repoId: access.repo.id,
    repoFullName: repoKey(access),
    workflowPath: run.workflow_path,
    workflowName: result.workflow.name ?? null,
    contentSha: file.contentSha,
    event: run.event,
    ref: run.ref ?? `refs/heads/${access.repo.defaultBranch}`,
    sha: run.sha,
    actorId,
    inputs,
    workflow: result.workflow,
    runNumber: run.run_number,
    runAttempt,
  });
  const detail = await getWorkflowRunDetail(access.db, access.repo.id, created.id);
  return json({ ...detail, dispatched: created.dispatched }, 201);
}

async function cancelHandler(ctx: RouteContext): Promise<Response> {
  const access = await requireRepoAccess(ctx, "contents.write", SCOPES.smartHttpWrite);
  if (access instanceof Response) return access;
  const csrf = csrfGuard(ctx, access.auth);
  if (csrf) return csrf;

  const run = await access.db.queryOne<{ status: string }>(
    `SELECT status FROM workflow_runs WHERE id = ? AND repo_id = ? LIMIT 1`,
    [ctx.params.runId, access.repo.id],
  );
  if (!run) return errorResponse(404, "not_found", "Run not found.");
  if (run.status === "completed") {
    return errorResponse(400, "already_terminal", "Run is already completed.");
  }
  await cancelRun(access.db, access.repo.id, ctx.params.runId);
  return json({ cancelled: true });
}

// ============================================================================
// Secrets (admin)
// ============================================================================

async function listSecretsHandler(ctx: RouteContext): Promise<Response> {
  const access = await requireRepoAccess(ctx, "repo.admin", SCOPES.hostingAdmin);
  if (access instanceof Response) return access;
  const secrets = await listWorkflowSecrets(access.db, access.repo.id);
  return json({ secrets });
}

async function putSecretHandler(ctx: RouteContext): Promise<Response> {
  const access = await requireRepoAccess(ctx, "repo.admin", SCOPES.hostingAdmin);
  if (access instanceof Response) return access;
  const csrf = csrfGuard(ctx, access.auth);
  if (csrf) return csrf;

  const name = ctx.params.name;
  if (!SECRET_NAME_PATTERN.test(name)) {
    return errorResponse(
      400,
      "invalid_name",
      "Secret name must be uppercase letters, digits, and underscores, starting with a letter or underscore.",
    );
  }
  const body = await readJson(ctx);
  if (body instanceof Response) return body;
  const value = body.value;
  if (typeof value !== "string" || value.length === 0) {
    return errorResponse(400, "invalid_field", "`value` is required.");
  }
  if (value.length > MAX_SECRET_VALUE_BYTES) {
    return errorResponse(400, "value_too_large", "Secret value is too large.");
  }
  const key = actionsSecretKey(ctx.env);
  if (!key) {
    return errorResponse(
      503,
      "secret_encryption_unconfigured",
      "An Actions secret cannot be stored because encryption is not configured.",
    );
  }
  const secret = await putWorkflowSecret(access.db, access.repo.id, name, value, key);
  return json({ secret }, 201);
}

async function deleteSecretHandler(ctx: RouteContext): Promise<Response> {
  const access = await requireRepoAccess(ctx, "repo.admin", SCOPES.hostingAdmin);
  if (access instanceof Response) return access;
  const csrf = csrfGuard(ctx, access.auth);
  if (csrf) return csrf;
  const removed = await deleteWorkflowSecret(access.db, access.repo.id, ctx.params.name);
  if (!removed) return errorResponse(404, "not_found", "Secret not found.");
  return json({ removed: true });
}

export const actionsHandlers = {
  listWorkflows: listWorkflowsHandler,
  listRuns: listRunsHandler,
  getRun: getRunHandler,
  getRunJobs: getRunJobsHandler,
  getJob: getJobHandler,
  getJobLogs: getJobLogsHandler,
  listArtifacts: listArtifactsHandler,
  downloadArtifact: downloadArtifactHandler,
  dispatchRun: dispatchRunHandler,
  rerun: rerunHandler,
  cancel: cancelHandler,
  listSecrets: listSecretsHandler,
  putSecret: putSecretHandler,
  deleteSecret: deleteSecretHandler,
};
