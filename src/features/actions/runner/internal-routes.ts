/**
 * `/internal/actions/{checkout,logs,artifacts}` — the container's callback surface.
 *
 * This is a SEPARATE trust boundary from Interface OAuth / browser sessions:
 * every call is authenticated by the run-scoped HMAC bearer minted from
 * `ACTIONS_RUNNER_SECRET` ({@link verifyRunnerToken}). It is fail-closed (no
 * secret ⇒ every call is 401) and is dispatched in `worker.ts` BEFORE the router,
 * so it is never reachable through `/api/v1`, `/git/`, or `/mcp`.
 *
 * Authority note: the token binds `runId` + `jobId`; the route derives the repo,
 * commit, and pin FROM D1/R2 by `runId` (never trusts container-supplied repo or
 * commit inputs), so a leaked token cannot reach another run's tree or logs.
 */

import { createDbClient, type D1Binding, type DbClient } from "../../../db/index.ts";
import { getBlob, getCommitData } from "../../../git/object-store.ts";
import { flattenTree } from "../../../git/tree-ops.ts";
import { readRunPin } from "../../../git/refs-store.ts";
import { repositoryObjectStore } from "../../../git/repo-object-store.ts";
import type { ObjectStoreBinding } from "../../../git/types.ts";
import { actionsEnv } from "../env.ts";
import { bearerFromRequest, verifyRunnerToken, type RunnerTokenClaims } from "./hmac.ts";
import { writeTar, type TarEntry } from "./tar.ts";

const INTERNAL_PREFIX = "/internal/actions/";
const MAX_COMMIT_BYTES = 1 << 20;
const MAX_CHECKOUT_FILE_BYTES = 32 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

interface RunLocator {
  readonly repoId: string;
  readonly repoKey: string;
  readonly sha: string;
}

/** Resolve a run's repo storage key + pinned commit from D1/R2 (authoritative). */
async function locateRun(
  db: DbClient,
  bucket: ObjectStoreBinding,
  runId: string,
): Promise<RunLocator | null> {
  const row = await db.queryOne<{ repo_id: string; sha: string | null; owner_login: string; name: string }>(
    `SELECT r.repo_id AS repo_id, r.sha AS sha, o.login AS owner_login, repo.name AS name
       FROM workflow_runs r
       JOIN repositories repo ON repo.id = r.repo_id
       JOIN owners o ON o.id = repo.owner_id
      WHERE r.id = ? LIMIT 1`,
    [runId],
  );
  if (!row || !row.sha) return null;
  const repoKey = `${row.owner_login}/${row.name}`;
  // Prefer the run pin; fall back to the run's recorded sha when unpinned.
  const pinned = (await readRunPin(bucket, repoKey, runId)) ?? row.sha;
  return { repoId: row.repo_id, repoKey, sha: pinned };
}

function dbFor(env: unknown): DbClient | null {
  const bag = (env ?? {}) as { ACTIONS_DB?: D1Binding; DB?: D1Binding };
  const d1 = bag.ACTIONS_DB ?? bag.DB;
  return d1 ? createDbClient(d1) : null;
}

/**
 * Dispatch an `/internal/actions/*` request. Returns `null` when the path is not
 * an internal-actions route (so the worker's normal dispatch continues), or a
 * `Response` when it is (authenticated and served, or rejected). Never falls
 * through open.
 */
export async function handleInternalActionsRoute(
  request: Request,
  env: unknown,
  url: URL,
): Promise<Response | null> {
  if (!url.pathname.startsWith(INTERNAL_PREFIX)) return null;

  const secret = actionsEnv(env).ACTIONS_RUNNER_SECRET;
  const token = bearerFromRequest(request);
  if (!token) return json(401, { error: "runner_unauthorized" });
  const claims = await verifyRunnerToken(secret, token, Date.now());
  if (!claims) return json(401, { error: "runner_unauthorized" });

  const bucket = actionsEnv(env).R2_ACTIONS;
  const gitBucket = (env as { BUCKET?: ObjectStoreBinding }).BUCKET;
  const db = dbFor(env);
  if (!db || !gitBucket) return json(503, { error: "actions_unconfigured" });

  const sub = url.pathname.slice(INTERNAL_PREFIX.length);
  if (sub === "checkout" && request.method === "GET") {
    return checkout(db, gitBucket, url, claims);
  }
  if (sub === "logs" && request.method === "POST") {
    if (!bucket) return json(503, { error: "actions_logs_unconfigured" });
    return appendLogs(db, bucket, request, claims);
  }
  if (sub === "artifacts" && request.method === "POST") {
    if (!bucket) return json(503, { error: "actions_artifacts_unconfigured" });
    return uploadArtifact(db, bucket, request, url, claims);
  }
  return json(404, { error: "not_found" });
}

/** Serve the run-pinned tree as a USTAR archive. */
async function checkout(
  db: DbClient,
  gitBucket: ObjectStoreBinding,
  url: URL,
  claims: RunnerTokenClaims,
): Promise<Response> {
  const runId = url.searchParams.get("runId");
  if (runId !== claims.runId) return json(403, { error: "run_scope_mismatch" });
  const located = await locateRun(db, gitBucket, claims.runId);
  if (!located) return json(404, { error: "run_not_found" });

  const objects = repositoryObjectStore(gitBucket, located.repoKey);
  const commit = await getCommitData(objects, located.sha, MAX_COMMIT_BYTES);
  if (!commit) return json(404, { error: "commit_not_found" });

  const files = await flattenTree(objects, commit.tree, "", { skipSymlinks: true });
  const entries: TarEntry[] = [];
  for (const file of files) {
    const bytes = await getBlob(objects, file.sha, MAX_CHECKOUT_FILE_BYTES);
    if (!bytes) continue;
    entries.push({ path: file.path, bytes, gitMode: file.mode });
  }
  const tar = writeTar(entries);
  return new Response(tar.buffer as ArrayBuffer, {
    status: 200,
    headers: {
      "content-type": "application/x-tar",
      "cache-control": "no-store",
      "x-takos-git-commit": located.sha,
    },
  });
}

/** Append a (pre-redacted) log chunk to `logs/<repoId>/<runId>/<jobId>.log`. */
async function appendLogs(
  db: DbClient,
  bucket: ObjectStoreBinding,
  request: Request,
  claims: RunnerTokenClaims,
): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    runId?: string;
    jobId?: string;
    chunk?: string;
  } | null;
  if (!body || body.runId !== claims.runId || body.jobId !== claims.jobId) {
    return json(403, { error: "run_scope_mismatch" });
  }
  // logs only need repoId; resolve it from the run row directly (no R2 needed).
  const repoId = (
    await db.queryOne<{ repo_id: string }>(`SELECT repo_id FROM workflow_runs WHERE id = ? LIMIT 1`, [
      claims.runId,
    ])
  )?.repo_id;
  if (!repoId) return json(404, { error: "run_not_found" });
  const key = `logs/${repoId}/${claims.runId}/${claims.jobId}.log`;
  const existing = await bucket.get(key);
  const prefix = existing ? new Uint8Array(await existing.arrayBuffer()) : new Uint8Array(0);
  const addition = new TextEncoder().encode(body.chunk ?? "");
  const merged = new Uint8Array(prefix.byteLength + addition.byteLength);
  merged.set(prefix, 0);
  merged.set(addition, prefix.byteLength);
  await bucket.put(key, merged);
  return json(200, { logsR2Key: key });
}

/** Store one artifact + register its `workflow_run_artifacts` row. */
async function uploadArtifact(
  db: DbClient,
  bucket: ObjectStoreBinding,
  request: Request,
  url: URL,
  claims: RunnerTokenClaims,
): Promise<Response> {
  const runId = url.searchParams.get("runId");
  const jobId = url.searchParams.get("jobId");
  const name = url.searchParams.get("name");
  if (runId !== claims.runId || jobId !== claims.jobId) {
    return json(403, { error: "run_scope_mismatch" });
  }
  if (!name || !/^[\w.\- ]{1,128}$/u.test(name)) {
    return json(400, { error: "invalid_artifact_name" });
  }
  const run = await db.queryOne<{ repo_id: string }>(
    `SELECT repo_id FROM workflow_runs WHERE id = ? LIMIT 1`,
    [claims.runId],
  );
  if (!run) return json(404, { error: "run_not_found" });
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_ARTIFACT_BYTES) return json(413, { error: "artifact_too_large" });
  const contentType = request.headers.get("content-type") || "application/octet-stream";
  const key = `artifacts/${run.repo_id}/${claims.runId}/${name}`;
  await bucket.put(key, bytes);
  const now = db.now();
  await db.run(
    `INSERT INTO workflow_run_artifacts (id, run_id, name, r2_key, size_bytes, content_type, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
    [db.id(), claims.runId, name, key, bytes.byteLength, contentType, now],
  );
  return json(201, { r2Key: key, sizeBytes: bytes.byteLength });
}
