import { Hono } from "hono";
import {
  type GitCompareFileSummary,
  type GitCompareResponse,
  type GitCreatePullRequestCommentRequest,
  type GitCreatePullRequestRequest,
  type GitCreatePullRequestReviewRequest,
  type GitCreateRepositoryRequest,
  type GitFetchExternalRepositoryRequest,
  type GitFetchExternalRepositoryResponse,
  type GitImportExternalRepositoryRequest,
  type GitImportExternalRepositoryResponse,
  type GitListCommitsResponse,
  type GitListRefsResponse,
  type GitMergePullRequestRequest,
  type GitMergePullRequestResponse,
  type GitPullRequestDiffFile,
  type GitPullRequestDiffHunk,
  type GitPullRequestDiffResponse,
  type GitReadBlobResponse,
  type GitReadCommitResponse,
  type GitReadTreeResponse,
  type GitRefSummary,
  type GitRepositoryDetail,
  type GitRepositorySummary,
  type GitResolveSourceRequest,
  type GitResolveSourceResponse,
  type GitSourceSnapshotFile,
  type GitSourceSnapshotRequest,
  type GitSourceSnapshotResponse,
  type GitUpdatePullRequestRequest,
  type GitUpdateRepositoryRequest,
  TAKOS_GIT_INTERNAL_PATHS,
} from "takos-git-contract";
import {
  canAccessRepositoryOwner,
  readInternalAuth,
  repositoryAccessDenied,
  type TakosGitInternalAuth,
} from "./auth.ts";
import {
  bytesToArrayBuffer,
  configuredRepositoryPath,
  configuredStorageReady,
  createConfiguredBareRepository,
  createConfiguredPullRequest,
  createConfiguredPullRequestComment,
  createConfiguredPullRequestReview,
  devInMemoryMetadataEnabled,
  type GitRepositoryMetadataRecord,
  isLiteralObjectId,
  isSafeRefInput,
  isSafeRepositoryId,
  notImplemented,
  readConfiguredGitPrettyObject,
  readConfiguredGitRawObject,
  readConfiguredGitRefs,
  readConfiguredPullRequest,
  readConfiguredPullRequests,
  readConfiguredRepositoryMetadata,
  repositoryNotFound,
  runGit,
  updateConfiguredPullRequest,
  verifyConfiguredGitCommit,
  writeConfiguredGitRefs,
  writeConfiguredRepositoryMetadata,
} from "./git.ts";
import { handleSmartHttp, isGitSmartHttpPath } from "./smart-http.ts";
import {
  isPullRequestStatus,
  isSafeTreePath,
  parsePullRequestNumber,
  repositoryOwnerSpaceId,
  validateCreatePullRequest,
  validateCreatePullRequestComment,
  validateCreatePullRequestReview,
  validateExternalFetchRequest,
  validateExternalImportRequest as validateExternalImportRequestBase,
  validateMergePullRequest,
  validateRepositoryMetadata as validateRepositoryMetadataBase,
  validateUpdatePullRequest,
} from "./validation.ts";

const app: Hono = new Hono();
const repositories = new Map<string, StoredGitRepository>();
const DEFAULT_MAX_BLOB_BYTES = 1024 * 1024;
const DEFAULT_MAX_SOURCE_SNAPSHOT_FILES = 5000;
const DEFAULT_MAX_SOURCE_SNAPSHOT_MANIFEST_BYTES = 256 * 1024;

interface StoredGitRepository {
  id: string;
  name: string;
  ownerSpaceId: string;
  defaultBranch: string;
  refs: Map<string, string>;
  createdAt: string;
  updatedAt: string;
}

app.get("/health", (c) => c.json({ ok: true, service: "takos-git" }));

app.get("/ready", (c) => {
  if (configuredStorageReady()) {
    return c.json({ ok: true, service: "takos-git" });
  }
  return c.json({
    ok: false,
    service: "takos-git",
    error:
      "TAKOS_GIT_REPOSITORY_ROOT is required outside dev in-memory metadata mode",
    code: "git_storage_not_configured",
  }, 503);
});

app.get(TAKOS_GIT_INTERNAL_PATHS.repositories, async (c) => {
  const auth = await readInternalAuth(c.req.raw);
  if (!auth.ok) return c.json({ error: auth.error }, 401);
  if (!configuredStorageReady()) {
    return c.json(notImplemented("git_repository_root_not_configured"), 501);
  }

  const summaries: GitRepositorySummary[] = (await readRepositories())
    .filter((repository) => canReadRepository(auth, repository))
    .map(repositorySummary);
  return c.json({ repositories: summaries });
});

app.post(TAKOS_GIT_INTERNAL_PATHS.repositories, async (c) => {
  const auth = await readInternalAuth(c.req.raw);
  if (!auth.ok) return c.json({ error: auth.error }, 401);

  const request = await c.req.json<Partial<GitCreateRepositoryRequest>>();
  const invalid = validateRepositoryMetadata(request, true);
  if (invalid) return c.json(invalid, 400);
  const ownerSpaceId = repositoryOwnerSpaceId(request);
  if (!ownerSpaceId) {
    return c.json({
      error: "ownerSpaceId must be a non-empty Takos space id",
      code: "invalid_repository_owner_space",
    }, 400);
  }
  if (!canAccessRepositoryOwner(auth, ownerSpaceId, "write")) {
    return c.json(repositoryAccessDenied(request.id!), 403);
  }
  const storedRepositories = await readRepositories();
  if (storedRepositories.some((repository) => repository.id === request.id!)) {
    return c.json({
      error: "repository already exists",
      code: "git_repository_already_exists",
      repositoryId: request.id,
    }, 409);
  }
  const createResult = await createRepositoryStorage(request.id!, {
    defaultBranch: request.defaultBranch ?? "main",
    mode: request.initialization?.mode ?? "default",
  });
  if (!createResult.ok) return c.json(createResult.body, createResult.status);

  const now = new Date().toISOString();
  const repository: StoredGitRepository = {
    id: request.id!,
    name: request.name!,
    ownerSpaceId,
    defaultBranch: request.defaultBranch ?? "main",
    refs: normalizeRefs(request.refs)!,
    createdAt: now,
    updatedAt: now,
  };
  if (request.refs !== undefined) {
    const refsResult = await writeConfiguredGitRefs(
      repository.id,
      repositoryRefs(repository),
    );
    if (!refsResult.ok && refsResult.status !== 501) {
      return c.json(refsResult.body, refsResult.status);
    }
  }
  await writeRepositories([...storedRepositories, repository]);
  return c.json({ repository: repositoryDetail(repository) }, 201);
});

app.post(TAKOS_GIT_INTERNAL_PATHS.importExternalRepository, async (c) => {
  const auth = await readInternalAuth(c.req.raw);
  if (!auth.ok) return c.json({ error: auth.error }, 401);

  const request = await c.req
    .json<Partial<GitImportExternalRepositoryRequest>>()
    .catch(() => undefined);
  const invalid = validateExternalImportRequest(request);
  if (invalid) return c.json(invalid, 400);
  if ("actor" in request!) {
    return c.json({
      error: "actor context must be provided by signed internal headers",
      code: "invalid_external_import_request",
    }, 400);
  }

  const ownerSpaceId = repositoryOwnerSpaceId(request!);
  if (!canAccessRepositoryOwner(auth, ownerSpaceId!, "write")) {
    return c.json(repositoryAccessDenied(request!.id!), 403);
  }
  const storedRepositories = await readRepositories();
  if (storedRepositories.some((repository) => repository.id === request!.id!)) {
    return c.json({
      error: "repository already exists",
      code: "git_repository_already_exists",
      repositoryId: request!.id,
    }, 409);
  }

  const createResult = await createConfiguredBareRepository(request!.id!, {
    defaultBranch: request!.defaultBranch ?? "main",
    mode: "bare",
  });
  if (!createResult.ok) {
    return c.json(createResult.body, createResult.status);
  }

  const now = new Date().toISOString();
  const pendingRepository: StoredGitRepository = {
    id: request!.id!,
    name: request!.name!,
    ownerSpaceId: ownerSpaceId!,
    defaultBranch: request!.defaultBranch ?? "main",
    refs: new Map(),
    createdAt: now,
    updatedAt: now,
  };
  await writeRepositories([...storedRepositories, pendingRepository]);

  try {
    const imported = await importExternalRemoteIntoConfiguredRepository({
      repositoryId: request!.id!,
      remoteUrl: request!.remoteUrl!,
      authHeader: request!.authHeader ?? null,
      requestedDefaultBranch: request!.defaultBranch,
      previousRefs: [],
    });
    if (!imported.ok) {
      await removeConfiguredRepositoryDirectory(request!.id!);
      await writeRepositories(storedRepositories);
      return c.json(imported.body, imported.status);
    }

    const repository: StoredGitRepository = {
      ...pendingRepository,
      defaultBranch: imported.defaultBranch,
      refs: normalizeRefs(imported.refs)!,
      updatedAt: new Date().toISOString(),
    };
    await writeRepositories([...storedRepositories, repository]);

    const response: GitImportExternalRepositoryResponse = {
      repository: repositoryDetail(repository),
      remoteUrl: request!.remoteUrl!,
      defaultBranch: imported.defaultBranch,
      branchCount: imported.branchCount,
      tagCount: imported.tagCount,
      commitCount: imported.commitCount,
    };
    return c.json(response, 201);
  } catch (error) {
    await removeConfiguredRepositoryDirectory(request!.id!);
    await writeRepositories(storedRepositories);
    return c.json({
      error: error instanceof Error ? error.message : "external import failed",
      code: "git_external_import_failed",
      repositoryId: request!.id,
    }, 422);
  }
});

app.get("/internal/repositories/:repositoryId", async (c) => {
  const auth = await readInternalAuth(c.req.raw);
  if (!auth.ok) return c.json({ error: auth.error }, 401);

  const repository = await findRepository(c.req.param("repositoryId"));
  if (!repository) {
    return c.json(repositoryNotFound(c.req.param("repositoryId")), 404);
  }
  if (!canReadRepository(auth, repository)) {
    return c.json(repositoryAccessDenied(repository.id), 403);
  }
  return c.json({ repository: repositoryDetail(repository) });
});

app.post("/internal/repositories/:repositoryId/fetch-external", async (c) => {
  const auth = await readInternalAuth(c.req.raw);
  if (!auth.ok) return c.json({ error: auth.error }, 401);

  const access = await requireRepositoryWrite(
    auth,
    c.req.param("repositoryId"),
  );
  if (!access.ok) return c.json(access.body, access.status);

  const request = await c.req
    .json<Partial<GitFetchExternalRepositoryRequest>>()
    .catch(() => undefined);
  const invalid = validateExternalFetchRequest(request);
  if (invalid) return c.json(invalid, 400);
  if ("actor" in request!) {
    return c.json({
      error: "actor context must be provided by signed internal headers",
      code: "invalid_external_fetch_request",
    }, 400);
  }

  const refsBefore = repositoryRefs(access.repository);
  const imported = await importExternalRemoteIntoConfiguredRepository({
    repositoryId: access.repository.id,
    remoteUrl: request!.remoteUrl!,
    authHeader: request!.authHeader ?? null,
    requestedDefaultBranch: access.repository.defaultBranch,
    previousRefs: refsBefore,
  });
  if (!imported.ok) return c.json(imported.body, imported.status);

  const repositories = await readRepositories();
  const repositoryIndex = repositories.findIndex((repository) =>
    repository.id === access.repository.id
  );
  const repository = repositories[repositoryIndex];
  if (!repository) {
    return c.json(repositoryNotFound(access.repository.id), 404);
  }
  repository.defaultBranch = imported.defaultBranch;
  repository.refs = normalizeRefs(imported.refs)!;
  repository.updatedAt = new Date().toISOString();
  await writeRepositories(repositories);

  const response: GitFetchExternalRepositoryResponse = {
    repositoryId: repository.id,
    remoteUrl: request!.remoteUrl!,
    defaultBranch: imported.defaultBranch,
    branchCount: imported.branchCount,
    tagCount: imported.tagCount,
    commitCount: imported.commitCount,
    newCommits: imported.newCommits,
    updatedBranches: imported.updatedBranches,
    newTags: imported.newTags,
    refs: imported.refs,
  };
  return c.json(response);
});

app.get("/internal/repositories/:repositoryId/refs", async (c) => {
  const auth = await readInternalAuth(c.req.raw);
  if (!auth.ok) return c.json({ error: auth.error }, 401);

  const repositoryId = c.req.param("repositoryId");
  const repository = await findRepository(repositoryId);
  if (repository && !canReadRepository(auth, repository)) {
    return c.json(repositoryAccessDenied(repositoryId), 403);
  }
  const gitRefs = await readConfiguredGitRefs(repositoryId);
  if (gitRefs.ok) {
    return c.json({ repositoryId, refs: gitRefs.refs });
  }
  if (gitRefs.status !== 501) return c.json(gitRefs.body, gitRefs.status);

  if (!repository) return c.json(gitRefs.body, 501);
  return c.json({ repositoryId, refs: repositoryRefs(repository) });
});

app.get("/internal/repositories/:repositoryId/branches", async (c) => {
  const auth = await readInternalAuth(c.req.raw);
  if (!auth.ok) return c.json({ error: auth.error }, 401);

  const access = await requireRepositoryRead(auth, c.req.param("repositoryId"));
  if (!access.ok) return c.json(access.body, access.status);
  const result = await listRepositoryRefs(access.repository, "refs/heads/");
  if (!result.ok) return c.json(result.body, result.status);
  return c.json(result.response);
});

app.get("/internal/repositories/:repositoryId/tags", async (c) => {
  const auth = await readInternalAuth(c.req.raw);
  if (!auth.ok) return c.json({ error: auth.error }, 401);

  const access = await requireRepositoryRead(auth, c.req.param("repositoryId"));
  if (!access.ok) return c.json(access.body, access.status);
  const result = await listRepositoryRefs(access.repository, "refs/tags/");
  if (!result.ok) return c.json(result.body, result.status);
  return c.json(result.response);
});

app.get("/internal/repositories/:repositoryId/tree", async (c) => {
  const auth = await readInternalAuth(c.req.raw);
  if (!auth.ok) return c.json({ error: auth.error }, 401);
  const access = await requireRepositoryRead(auth, c.req.param("repositoryId"));
  if (!access.ok) return c.json(access.body, access.status);
  const result = await buildTreeResponse({
    repository: access.repository,
    sourceRef: c.req.query("ref") || access.repository.defaultBranch,
    path: c.req.query("path") || ".",
  });
  if (!result.ok) return c.json(result.body, result.status);
  return c.json(result.response);
});

app.get("/internal/repositories/:repositoryId/blob", async (c) => {
  const auth = await readInternalAuth(c.req.raw);
  if (!auth.ok) return c.json({ error: auth.error }, 401);
  const access = await requireRepositoryRead(auth, c.req.param("repositoryId"));
  if (!access.ok) return c.json(access.body, access.status);
  const result = await buildBlobResponse({
    repository: access.repository,
    sourceRef: c.req.query("ref") || access.repository.defaultBranch,
    path: c.req.query("path") || "",
  });
  if (!result.ok) return c.json(result.body, result.status);
  return c.json(result.response);
});

app.get(
  "/internal/repositories/:repositoryId/commits",
  async (c) => {
    const auth = await readInternalAuth(c.req.raw);
    if (!auth.ok) return c.json({ error: auth.error }, 401);
    const access = await requireRepositoryRead(
      auth,
      c.req.param("repositoryId"),
    );
    if (!access.ok) return c.json(access.body, access.status);
    const limit = Number(c.req.query("limit") ?? "50");
    const offset = Number(c.req.query("offset") ?? "0");
    const result = await buildCommitsResponse({
      repository: access.repository,
      sourceRef: c.req.query("ref") || access.repository.defaultBranch,
      path: c.req.query("path") || undefined,
      limit: Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 50,
      offset: Number.isInteger(offset) ? Math.max(offset, 0) : 0,
    });
    if (!result.ok) return c.json(result.body, result.status);
    return c.json(result.response);
  },
);

app.get(
  "/internal/repositories/:repositoryId/commits/:commitish",
  async (c) => {
    const auth = await readInternalAuth(c.req.raw);
    if (!auth.ok) return c.json({ error: auth.error }, 401);
    const access = await requireRepositoryRead(
      auth,
      c.req.param("repositoryId"),
    );
    if (!access.ok) return c.json(access.body, access.status);
    const result = await buildCommitResponse({
      repository: access.repository,
      sourceRef: c.req.param("commitish"),
    });
    if (!result.ok) return c.json(result.body, result.status);
    return c.json(result.response);
  },
);

app.get(
  "/internal/repositories/:repositoryId/compare",
  async (c) => {
    const auth = await readInternalAuth(c.req.raw);
    if (!auth.ok) return c.json({ error: auth.error }, 401);
    const access = await requireRepositoryRead(
      auth,
      c.req.param("repositoryId"),
    );
    if (!access.ok) return c.json(access.body, access.status);
    const baseRef = c.req.query("base");
    const headRef = c.req.query("head");
    if (!baseRef || !headRef) {
      return c.json({
        error: "base and head query parameters are required",
        code: "invalid_git_compare_request",
        repositoryId: access.repository.id,
      }, 400);
    }
    const result = await buildCompareResponse({
      repository: access.repository,
      baseRef,
      headRef,
    });
    if (!result.ok) return c.json(result.body, result.status);
    return c.json(result.response);
  },
);

app.patch("/internal/repositories/:repositoryId", async (c) => {
  const auth = await readInternalAuth(c.req.raw);
  if (!auth.ok) return c.json({ error: auth.error }, 401);

  const repositoryId = c.req.param("repositoryId");
  const storedRepositories = await readRepositories();
  const repositoryIndex = storedRepositories.findIndex((repository) =>
    repository.id === repositoryId
  );
  const repository = storedRepositories[repositoryIndex];
  if (!repository) return c.json(repositoryNotFound(repositoryId), 404);
  if (!canWriteRepository(auth, repository)) {
    return c.json(repositoryAccessDenied(repositoryId), 403);
  }

  const request = await c.req.json<Partial<GitUpdateRepositoryRequest>>();
  const invalid = validateRepositoryMetadata(request, false);
  if (invalid) return c.json(invalid, 400);
  if (
    repositoryOwnerSpaceId(request) &&
    !canAccessRepositoryOwner(auth, repositoryOwnerSpaceId(request)!, "write")
  ) {
    return c.json(repositoryAccessDenied(repositoryId), 403);
  }

  if (typeof request.name === "string") repository.name = request.name;
  const nextOwnerSpaceId = repositoryOwnerSpaceId(request);
  if (nextOwnerSpaceId) {
    repository.ownerSpaceId = nextOwnerSpaceId;
  }
  if (typeof request.defaultBranch === "string") {
    repository.defaultBranch = request.defaultBranch;
  }
  if (request.refs !== undefined) {
    repository.refs = normalizeRefs(request.refs)!;
    const refsResult = await writeConfiguredGitRefs(
      repository.id,
      repositoryRefs(repository),
    );
    if (!refsResult.ok && refsResult.status !== 501) {
      return c.json(refsResult.body, refsResult.status);
    }
  }
  repository.updatedAt = new Date().toISOString();
  await writeRepositories(storedRepositories);
  return c.json({ repository: repositoryDetail(repository) });
});

app.post(TAKOS_GIT_INTERNAL_PATHS.sourceSnapshot, async (c) => {
  const auth = await readInternalAuth(c.req.raw);
  if (!auth.ok) return c.json({ error: auth.error }, 401);

  const request = await c.req.json<Partial<GitSourceSnapshotRequest>>();
  if (
    !request || typeof request !== "object" ||
    "actor" in request ||
    typeof request.repositoryId !== "string" ||
    typeof request.sourceRef !== "string"
  ) {
    return c.json({
      error:
        "repositoryId and sourceRef are required; actor context must be provided by signed internal headers",
      code: "invalid_source_snapshot_request",
    }, 400);
  }
  const repository = await findRepository(request.repositoryId);
  if (repository && !canReadRepository(auth, repository)) {
    return c.json(repositoryAccessDenied(request.repositoryId), 403);
  }

  const snapshot = await buildSourceSnapshot({
    repositoryId: request.repositoryId,
    sourceRef: request.sourceRef,
    path: request.path,
    manifestPath: request.manifestPath,
  });
  if (!snapshot.ok) return c.json(snapshot.body, snapshot.status);
  return c.json(snapshot.response);
});

app.delete("/internal/repositories/:repositoryId", async (c) => {
  const auth = await readInternalAuth(c.req.raw);
  if (!auth.ok) return c.json({ error: auth.error }, 401);

  const repositoryId = c.req.param("repositoryId");
  const storedRepositories = await readRepositories();
  const repository = storedRepositories.find((candidate) =>
    candidate.id === repositoryId
  );
  if (repository && !canWriteRepository(auth, repository)) {
    return c.json(repositoryAccessDenied(repositoryId), 403);
  }
  const remainingRepositories = storedRepositories.filter((repository) =>
    repository.id !== repositoryId
  );
  if (remainingRepositories.length === storedRepositories.length) {
    return c.json(repositoryNotFound(repositoryId), 404);
  }
  await writeRepositories(remainingRepositories);
  return new Response(null, { status: 204 });
});

app.post(TAKOS_GIT_INTERNAL_PATHS.resolveSource, async (c) => {
  const auth = await readInternalAuth(c.req.raw);
  if (!auth.ok) return c.json({ error: auth.error }, 401);

  const request = await c.req.json<Partial<GitResolveSourceRequest>>();
  if (
    !request || typeof request !== "object" ||
    "actor" in request ||
    typeof request.repositoryId !== "string" ||
    typeof request.sourceRef !== "string"
  ) {
    return c.json({
      error:
        "repositoryId and sourceRef are required; actor context must be provided by signed internal headers",
      code: "invalid_source_resolution_request",
    }, 400);
  }
  const repositoryForAccess = await findRepository(request.repositoryId);
  if (repositoryForAccess && !canReadRepository(auth, repositoryForAccess)) {
    return c.json(repositoryAccessDenied(request.repositoryId), 403);
  }

  if (isLiteralObjectId(request.sourceRef)) {
    const verified = await verifyLiteralSourceCommit(
      request.repositoryId,
      request.sourceRef,
    );
    if (!verified.ok) return c.json(verified.body, verified.status);
    const response: GitResolveSourceResponse = {
      sourceRef: request.sourceRef,
      repositoryId: request.repositoryId,
      resolvedCommit: verified.commit,
    };
    return c.json(response);
  }

  const configuredRef = await resolveConfiguredGitRef(
    request.repositoryId,
    (await findRepository(request.repositoryId))?.defaultBranch ?? "main",
    request.sourceRef,
  );
  if (!configuredRef.ok && configuredRef.status !== 501) {
    return c.json(configuredRef.body, configuredRef.status);
  }

  const repository = await findRepository(request.repositoryId);
  const resolved = configuredRef.ok
    ? configuredRef.resolved
    : (repository
      ? resolveStoredRef(repository, request.sourceRef)
      : undefined);
  if (!resolved) {
    return c.json({
      error: "real ref resolution is not implemented/configured for takos-git",
      code: "git_ref_resolution_not_configured",
      repositoryId: request.repositoryId,
      sourceRef: request.sourceRef,
    }, 422);
  }

  const response: GitResolveSourceResponse = {
    sourceRef: request.sourceRef,
    repositoryId: request.repositoryId,
    resolvedCommit: resolved.target,
    resolvedRef: resolved.name,
  };
  return c.json(response);
});

app.get("/internal/objects/:repositoryId/:objectId", async (c) => {
  const auth = await readInternalAuth(c.req.raw);
  if (!auth.ok) return c.json({ error: auth.error }, 401);
  const repository = await findRepository(c.req.param("repositoryId"));
  if (repository && !canReadRepository(auth, repository)) {
    return c.json(repositoryAccessDenied(repository.id), 403);
  }

  const object = await readConfiguredGitPrettyObject(
    c.req.param("repositoryId"),
    c.req.param("objectId"),
  );
  if (!object.ok) return c.json(object.body, object.status);
  if (object.size > maxGitBlobBytes()) {
    return c.json(gitObjectTooLarge(object.objectId, object.size), 413);
  }
  return new Response(bytesToArrayBuffer(object.prettyContent), {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-takos-git-object-id": object.objectId,
      "x-takos-git-object-type": object.type,
      "x-takos-git-object-size": String(object.size),
      "x-takos-git-object-format": "git-cat-file-pretty",
    },
  });
});

app.get("/internal/objects/:repositoryId/:objectId/raw", async (c) => {
  const auth = await readInternalAuth(c.req.raw);
  if (!auth.ok) return c.json({ error: auth.error }, 401);
  const repository = await findRepository(c.req.param("repositoryId"));
  if (repository && !canReadRepository(auth, repository)) {
    return c.json(repositoryAccessDenied(repository.id), 403);
  }

  const object = await readConfiguredGitRawObject(
    c.req.param("repositoryId"),
    c.req.param("objectId"),
  );
  if (!object.ok) return c.json(object.body, object.status);
  if (object.size > maxGitBlobBytes()) {
    return c.json(gitObjectTooLarge(object.objectId, object.size), 413);
  }
  return new Response(bytesToArrayBuffer(object.content), {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "x-takos-git-object-id": object.objectId,
      "x-takos-git-object-type": object.type,
      "x-takos-git-object-size": String(object.size),
      "x-takos-git-object-format": "git-cat-file-raw",
    },
  });
});

app.get("/internal/repositories/:repositoryId/pull-requests", async (c) => {
  const auth = await readInternalAuth(c.req.raw);
  if (!auth.ok) return c.json({ error: auth.error }, 401);
  const access = await requireRepositoryRead(auth, c.req.param("repositoryId"));
  if (!access.ok) return c.json(access.body, access.status);
  const status = c.req.query("status");
  if (status !== undefined && !isPullRequestStatus(status)) {
    return c.json({
      error: "status must be open, closed, or merged",
      code: "invalid_pull_request_status",
    }, 400);
  }
  const result = await readConfiguredPullRequests(
    c.req.param("repositoryId"),
    status,
  );
  if (!result.ok) return c.json(result.body, result.status);
  return c.json({ pullRequests: result.pullRequests });
});

app.post("/internal/repositories/:repositoryId/pull-requests", async (c) => {
  const auth = await readInternalAuth(c.req.raw);
  if (!auth.ok) return c.json({ error: auth.error }, 401);
  const access = await requireRepositoryWrite(
    auth,
    c.req.param("repositoryId"),
  );
  if (!access.ok) return c.json(access.body, access.status);
  const request = await c.req.json<Partial<GitCreatePullRequestRequest>>();
  const invalid = validateCreatePullRequest(request);
  if (invalid) return c.json(invalid, 400);
  const result = await createConfiguredPullRequest(
    c.req.param("repositoryId"),
    request as GitCreatePullRequestRequest,
    auth.actor,
  );
  if (!result.ok) return c.json(result.body, result.status);
  return c.json({ pullRequest: result.pullRequest }, 201);
});

app.get(
  "/internal/repositories/:repositoryId/pull-requests/:number",
  async (c) => {
    const auth = await readInternalAuth(c.req.raw);
    if (!auth.ok) return c.json({ error: auth.error }, 401);
    const access = await requireRepositoryRead(
      auth,
      c.req.param("repositoryId"),
    );
    if (!access.ok) return c.json(access.body, access.status);
    const number = parsePullRequestNumber(c.req.param("number"));
    if (!number.ok) return c.json(number.body, 400);
    const result = await readConfiguredPullRequest(
      c.req.param("repositoryId"),
      number.value,
    );
    if (!result.ok) return c.json(result.body, result.status);
    return c.json({ pullRequest: result.pullRequest });
  },
);

app.get(
  "/internal/repositories/:repositoryId/pull-requests/:number/diff",
  async (c) => {
    const auth = await readInternalAuth(c.req.raw);
    if (!auth.ok) return c.json({ error: auth.error }, 401);
    const access = await requireRepositoryRead(
      auth,
      c.req.param("repositoryId"),
    );
    if (!access.ok) return c.json(access.body, access.status);
    const number = parsePullRequestNumber(c.req.param("number"));
    if (!number.ok) return c.json(number.body, 400);
    const pullRequestResult = await readConfiguredPullRequest(
      c.req.param("repositoryId"),
      number.value,
    );
    if (!pullRequestResult.ok) {
      return c.json(pullRequestResult.body, pullRequestResult.status);
    }
    const diff = await buildPullRequestDiffResponse({
      repository: access.repository,
      pullRequestNumber: number.value,
      baseRef: pullRequestResult.pullRequest.baseBranch,
      headRef: pullRequestResult.pullRequest.headBranch,
    });
    if (!diff.ok) return c.json(diff.body, diff.status);
    return c.json(diff.response);
  },
);

app.patch(
  "/internal/repositories/:repositoryId/pull-requests/:number",
  async (c) => {
    const auth = await readInternalAuth(c.req.raw);
    if (!auth.ok) return c.json({ error: auth.error }, 401);
    const access = await requireRepositoryWrite(
      auth,
      c.req.param("repositoryId"),
    );
    if (!access.ok) return c.json(access.body, access.status);
    const number = parsePullRequestNumber(c.req.param("number"));
    if (!number.ok) return c.json(number.body, 400);
    const request = await c.req.json<Partial<GitUpdatePullRequestRequest>>();
    const invalid = validateUpdatePullRequest(request);
    if (invalid) return c.json(invalid, 400);
    const result = await updateConfiguredPullRequest(
      c.req.param("repositoryId"),
      number.value,
      request,
    );
    if (!result.ok) return c.json(result.body, result.status);
    return c.json({ pullRequest: result.pullRequest });
  },
);

app.post(
  "/internal/repositories/:repositoryId/pull-requests/:number/comments",
  async (c) => {
    const auth = await readInternalAuth(c.req.raw);
    if (!auth.ok) return c.json({ error: auth.error }, 401);
    const access = await requireRepositoryWrite(
      auth,
      c.req.param("repositoryId"),
    );
    if (!access.ok) return c.json(access.body, access.status);
    const number = parsePullRequestNumber(c.req.param("number"));
    if (!number.ok) return c.json(number.body, 400);
    const request = await c.req.json<
      Partial<GitCreatePullRequestCommentRequest>
    >();
    const invalid = validateCreatePullRequestComment(request);
    if (invalid) return c.json(invalid, 400);
    const result = await createConfiguredPullRequestComment(
      c.req.param("repositoryId"),
      number.value,
      request as GitCreatePullRequestCommentRequest,
      auth.actor,
    );
    if (!result.ok) return c.json(result.body, result.status);
    return c.json({ comment: result.comment }, 201);
  },
);

app.post(
  "/internal/repositories/:repositoryId/pull-requests/:number/reviews",
  async (c) => {
    const auth = await readInternalAuth(c.req.raw);
    if (!auth.ok) return c.json({ error: auth.error }, 401);
    const access = await requireRepositoryWrite(
      auth,
      c.req.param("repositoryId"),
    );
    if (!access.ok) return c.json(access.body, access.status);
    const number = parsePullRequestNumber(c.req.param("number"));
    if (!number.ok) return c.json(number.body, 400);
    const request = await c.req.json<
      Partial<GitCreatePullRequestReviewRequest>
    >();
    const invalid = validateCreatePullRequestReview(request);
    if (invalid) return c.json(invalid, 400);
    const result = await createConfiguredPullRequestReview(
      c.req.param("repositoryId"),
      number.value,
      request as GitCreatePullRequestReviewRequest,
      auth.actor,
    );
    if (!result.ok) return c.json(result.body, result.status);
    return c.json({ review: result.review }, 201);
  },
);

app.post(
  "/internal/repositories/:repositoryId/pull-requests/:number/merge",
  async (c) => {
    const auth = await readInternalAuth(c.req.raw);
    if (!auth.ok) return c.json({ error: auth.error }, 401);
    const access = await requireRepositoryWrite(
      auth,
      c.req.param("repositoryId"),
    );
    if (!access.ok) return c.json(access.body, access.status);
    const number = parsePullRequestNumber(c.req.param("number"));
    if (!number.ok) return c.json(number.body, 400);
    const request = await c.req.json<Partial<GitMergePullRequestRequest>>()
      .catch(() => ({}));
    const invalid = validateMergePullRequest(request);
    if (invalid) return c.json(invalid, 400);
    const result = await mergePullRequestFastForward(
      access.repository,
      number.value,
      request,
    );
    if (!result.ok) return c.json(result.body, result.status);
    return c.json(result.response);
  },
);

app.all(TAKOS_GIT_INTERNAL_PATHS.objects, async (c) => {
  const auth = await readInternalAuth(c.req.raw);
  if (!auth.ok) return c.json({ error: auth.error }, 401);

  return c.json(notImplemented("git_object_storage_not_implemented"), 501);
});

app.all("/internal/objects/*", async (c) => {
  const auth = await readInternalAuth(c.req.raw);
  if (!auth.ok) return c.json({ error: auth.error }, 401);

  return c.json(notImplemented("git_object_storage_not_implemented"), 501);
});

app.all("*", (c) => {
  const pathname = new URL(c.req.url).pathname;
  if (isGitSmartHttpPath(pathname)) {
    return handleSmartHttp(c.req.raw);
  }
  return c.json({ error: "not found" }, 404);
});

async function readRepositories(): Promise<StoredGitRepository[]> {
  const persisted = await readConfiguredRepositoryMetadata();
  if (persisted) return persisted.map(metadataToStoredRepository);
  if (!devInMemoryMetadataEnabled()) return [];
  return [...repositories.values()];
}

async function findRepository(
  repositoryId: string,
): Promise<StoredGitRepository | undefined> {
  return (await readRepositories()).find((repository) =>
    repository.id === repositoryId
  );
}

async function writeRepositories(
  updatedRepositories: StoredGitRepository[],
): Promise<void> {
  const persisted = await readConfiguredRepositoryMetadata();
  if (persisted) {
    await writeConfiguredRepositoryMetadata(
      updatedRepositories.map(storedRepositoryToMetadata),
    );
    return;
  }
  if (!devInMemoryMetadataEnabled()) return;
  repositories.clear();
  for (const repository of updatedRepositories) {
    repositories.set(repository.id, repository);
  }
}

function canReadRepository(
  auth: TakosGitInternalAuth,
  repository: StoredGitRepository,
): boolean {
  return canAccessRepositoryOwner(auth, repository.ownerSpaceId, "read");
}

function canWriteRepository(
  auth: TakosGitInternalAuth,
  repository: StoredGitRepository,
): boolean {
  return canAccessRepositoryOwner(auth, repository.ownerSpaceId, "write");
}

async function requireRepositoryRead(
  auth: TakosGitInternalAuth,
  repositoryId: string,
): Promise<
  | { ok: true; repository: StoredGitRepository }
  | {
    ok: false;
    body: { error: string; code: string; repositoryId: string };
    status: 403 | 404;
  }
> {
  const repository = await findRepository(repositoryId);
  if (!repository) {
    return { ok: false, body: repositoryNotFound(repositoryId), status: 404 };
  }
  if (!canReadRepository(auth, repository)) {
    return {
      ok: false,
      body: repositoryAccessDenied(repositoryId),
      status: 403,
    };
  }
  return { ok: true, repository };
}

async function requireRepositoryWrite(
  auth: TakosGitInternalAuth,
  repositoryId: string,
): Promise<
  | { ok: true; repository: StoredGitRepository }
  | {
    ok: false;
    body: { error: string; code: string; repositoryId: string };
    status: 403 | 404;
  }
> {
  const access = await requireRepositoryRead(auth, repositoryId);
  if (!access.ok) return access;
  if (!canWriteRepository(auth, access.repository)) {
    return {
      ok: false,
      body: repositoryAccessDenied(repositoryId),
      status: 403,
    };
  }
  return access;
}

async function createRepositoryStorage(
  repositoryId: string,
  options: { defaultBranch: string; mode: "default" | "bare" },
): Promise<
  | { ok: true }
  | {
    ok: false;
    body: { error: string; code: string; repositoryId?: string };
    status: 400 | 404 | 409 | 422 | 500 | 501;
  }
> {
  const result = await createConfiguredBareRepository(repositoryId, options);
  if (result.ok) return { ok: true };
  if (
    result.status === 501 &&
    result.body.code === "git_repository_root_not_configured" &&
    devInMemoryMetadataEnabled()
  ) {
    return { ok: true };
  }
  return result;
}

function metadataToStoredRepository(
  repository: GitRepositoryMetadataRecord,
): StoredGitRepository {
  return {
    ...repository,
    refs: normalizeRefs(repository.refs)!,
  };
}

function storedRepositoryToMetadata(
  repository: StoredGitRepository,
): GitRepositoryMetadataRecord {
  return {
    ...repository,
    refs: repositoryRefs(repository),
  };
}

async function listRepositoryRefs(
  repository: StoredGitRepository,
  prefix: "refs/heads/" | "refs/tags/",
): Promise<
  | { ok: true; response: GitListRefsResponse }
  | {
    ok: false;
    body: {
      error: string;
      code: string;
      repositoryId?: string;
    };
    status: 400 | 404 | 409 | 413 | 422 | 501;
  }
> {
  const configured = await readConfiguredGitRefs(repository.id);
  if (configured.ok) {
    return {
      ok: true,
      response: {
        repositoryId: repository.id,
        refs: configured.refs.filter((ref) => ref.name.startsWith(prefix)),
      },
    };
  }
  if (configured.status !== 501) return configured;
  return {
    ok: true,
    response: {
      repositoryId: repository.id,
      refs: repositoryRefs(repository).filter((ref) =>
        ref.name.startsWith(prefix)
      ),
    },
  };
}

async function buildTreeResponse(input: {
  repository: StoredGitRepository;
  sourceRef: string;
  path: string;
}): Promise<
  | { ok: true; response: GitReadTreeResponse }
  | {
    ok: false;
    body: {
      error: string;
      code: string;
      repositoryId?: string;
      sourceRef?: string;
    };
    status: 400 | 404 | 409 | 413 | 422 | 501;
  }
> {
  const resolved = await resolveRepositorySourceCommit(
    input.repository,
    input.sourceRef,
  );
  if (!resolved.ok) return resolved;
  if (!isSafeTreePath(input.path)) {
    return invalidTreePath(input.repository.id);
  }
  const repositoryPath = configuredRepositoryPath(input.repository.id);
  if (!repositoryPath) {
    return {
      ok: false,
      status: 501,
      body: notImplemented("git_repository_root_not_configured"),
    };
  }
  const treeish = `${resolved.commit}:${input.path === "." ? "" : input.path}`;
  const output = await runGit([
    "--git-dir",
    repositoryPath,
    "ls-tree",
    "-z",
    "--long",
    treeish,
  ]);
  if (!output.success) {
    return {
      ok: false,
      status: 404,
      body: {
        error: "tree path not found",
        code: "git_tree_path_not_found",
        repositoryId: input.repository.id,
      },
    };
  }
  const entries = textDecoder.decode(output.stdout).split("\0").filter(Boolean)
    .map((entry) => {
      const tab = entry.indexOf("\t");
      const metadata = entry.slice(0, tab).trim().split(/\s+/);
      const path = entry.slice(tab + 1);
      return {
        path: input.path === "." ? path : `${input.path}/${path}`,
        name: path.split("/").pop() ?? path,
        mode: metadata[0] ?? "",
        type: metadata[1] ?? "",
        objectId: metadata[2] ?? "",
        size: metadata[3] === "-" ? undefined : Number(metadata[3]) || 0,
      };
    });
  return {
    ok: true,
    response: {
      repositoryId: input.repository.id,
      sourceRef: input.sourceRef,
      resolvedCommit: resolved.commit,
      path: input.path,
      entries,
    },
  };
}

async function buildBlobResponse(input: {
  repository: StoredGitRepository;
  sourceRef: string;
  path: string;
}): Promise<
  | { ok: true; response: GitReadBlobResponse }
  | {
    ok: false;
    body: {
      error: string;
      code: string;
      repositoryId?: string;
      sourceRef?: string;
      objectId?: string;
    };
    status: 400 | 404 | 409 | 413 | 422 | 501;
  }
> {
  const resolved = await resolveRepositorySourceCommit(
    input.repository,
    input.sourceRef,
  );
  if (!resolved.ok) return resolved;
  if (!isSafeTreePath(input.path) || input.path === ".") {
    return invalidTreePath(input.repository.id);
  }
  const repositoryPath = configuredRepositoryPath(input.repository.id);
  if (!repositoryPath) {
    return {
      ok: false,
      status: 501,
      body: notImplemented("git_repository_root_not_configured"),
    };
  }
  const objectId = await runGit([
    "--git-dir",
    repositoryPath,
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${resolved.commit}:${input.path}`,
  ]);
  if (!objectId.success) {
    return {
      ok: false,
      status: 404,
      body: {
        error: "blob path not found",
        code: "git_blob_path_not_found",
        repositoryId: input.repository.id,
      },
    };
  }
  const object = await readConfiguredGitRawObject(
    input.repository.id,
    textDecoder.decode(objectId.stdout).trim(),
  );
  if (!object.ok) return object;
  if (object.type !== "blob") {
    return {
      ok: false,
      status: 422,
      body: {
        error: "path does not resolve to a blob",
        code: "git_path_not_blob",
        repositoryId: input.repository.id,
        objectId: object.objectId,
      },
    };
  }
  if (object.size > maxGitBlobBytes()) {
    return {
      ok: false,
      status: 413,
      body: gitObjectTooLarge(object.objectId, object.size),
    };
  }
  const encoding = object.content.some((byte) => byte === 0)
    ? "base64"
    : "utf-8";
  return {
    ok: true,
    response: {
      repositoryId: input.repository.id,
      sourceRef: input.sourceRef,
      resolvedCommit: resolved.commit,
      path: input.path,
      objectId: object.objectId,
      size: object.size,
      encoding,
      content: encoding === "utf-8"
        ? textDecoder.decode(object.content)
        : base64Encode(object.content),
    },
  };
}

async function buildCommitResponse(input: {
  repository: StoredGitRepository;
  sourceRef: string;
}): Promise<
  | { ok: true; response: GitReadCommitResponse }
  | {
    ok: false;
    body: {
      error: string;
      code: string;
      repositoryId?: string;
      sourceRef?: string;
    };
    status: 400 | 404 | 409 | 422 | 501;
  }
> {
  const commits = await buildCommitsResponse({
    repository: input.repository,
    sourceRef: input.sourceRef,
    limit: 1,
  });
  if (!commits.ok) return commits;
  const commit = commits.response.commits[0];
  if (!commit) {
    return {
      ok: false,
      status: 404,
      body: {
        error: "commit not found",
        code: "git_commit_not_found",
        repositoryId: input.repository.id,
        sourceRef: input.sourceRef,
      },
    };
  }
  return {
    ok: true,
    response: {
      repositoryId: input.repository.id,
      sourceRef: input.sourceRef,
      resolvedCommit: commits.response.resolvedCommit,
      commit,
    },
  };
}

async function buildCompareResponse(input: {
  repository: StoredGitRepository;
  baseRef: string;
  headRef: string;
}): Promise<
  | { ok: true; response: GitCompareResponse }
  | {
    ok: false;
    body: {
      error: string;
      code: string;
      repositoryId?: string;
      sourceRef?: string;
    };
    status: 400 | 404 | 409 | 422 | 501;
  }
> {
  const base = await resolveRepositorySourceCommit(
    input.repository,
    input.baseRef,
  );
  if (!base.ok) return base;
  const head = await resolveRepositorySourceCommit(
    input.repository,
    input.headRef,
  );
  if (!head.ok) return head;
  const repositoryPath = configuredRepositoryPath(input.repository.id);
  if (!repositoryPath) {
    return {
      ok: false,
      status: 501,
      body: notImplemented("git_repository_root_not_configured"),
    };
  }
  const counts = await runGit([
    "--git-dir",
    repositoryPath,
    "rev-list",
    "--left-right",
    "--count",
    `${base.commit}...${head.commit}`,
  ]);
  if (!counts.success) {
    return {
      ok: false,
      status: 422,
      body: {
        error: "failed to compare commits",
        code: "git_compare_unreadable",
        repositoryId: input.repository.id,
      },
    };
  }
  const [behindText, aheadText] = textDecoder.decode(counts.stdout).trim()
    .split(/\s+/);
  const mergeBase = await runGit([
    "--git-dir",
    repositoryPath,
    "merge-base",
    base.commit,
    head.commit,
  ]);
  const filesOutput = await runGit([
    "--git-dir",
    repositoryPath,
    "diff",
    "--name-status",
    "-z",
    `${base.commit}..${head.commit}`,
  ]);
  if (!filesOutput.success) {
    return {
      ok: false,
      status: 422,
      body: {
        error: "failed to compare files",
        code: "git_compare_files_unreadable",
        repositoryId: input.repository.id,
      },
    };
  }
  return {
    ok: true,
    response: {
      repositoryId: input.repository.id,
      baseRef: input.baseRef,
      headRef: input.headRef,
      baseCommit: base.commit,
      headCommit: head.commit,
      mergeBase: mergeBase.success
        ? textDecoder.decode(mergeBase.stdout).trim()
        : undefined,
      aheadBy: Number(aheadText) || 0,
      behindBy: Number(behindText) || 0,
      files: parseNameStatus(filesOutput.stdout),
    },
  };
}

async function buildPullRequestDiffResponse(input: {
  repository: StoredGitRepository;
  pullRequestNumber: number;
  baseRef: string;
  headRef: string;
}): Promise<
  | { ok: true; response: GitPullRequestDiffResponse }
  | {
    ok: false;
    body: {
      error: string;
      code: string;
      repositoryId?: string;
      sourceRef?: string;
    };
    status: 400 | 404 | 409 | 422 | 501;
  }
> {
  const compare = await buildCompareResponse({
    repository: input.repository,
    baseRef: input.baseRef,
    headRef: input.headRef,
  });
  if (!compare.ok) return compare;
  const repositoryPath = configuredRepositoryPath(input.repository.id);
  if (!repositoryPath) {
    return {
      ok: false,
      status: 501,
      body: notImplemented("git_repository_root_not_configured"),
    };
  }
  const diffOutput = await runGit([
    "--git-dir",
    repositoryPath,
    "diff",
    "--unified=3",
    "--no-color",
    "--no-ext-diff",
    `${compare.response.baseCommit}..${compare.response.headCommit}`,
  ]);
  if (!diffOutput.success) {
    return {
      ok: false,
      status: 422,
      body: {
        error: "failed to build pull request diff",
        code: "git_pull_request_diff_unreadable",
        repositoryId: input.repository.id,
      },
    };
  }
  const files = parsePullRequestUnifiedDiff(
    textDecoder.decode(diffOutput.stdout),
    compare.response.files,
  );
  return {
    ok: true,
    response: {
      repositoryId: input.repository.id,
      pullRequestNumber: input.pullRequestNumber,
      baseRef: input.baseRef,
      headRef: input.headRef,
      baseCommit: compare.response.baseCommit,
      headCommit: compare.response.headCommit,
      files,
      stats: {
        totalAdditions: files.reduce((sum, file) => sum + file.additions, 0),
        totalDeletions: files.reduce((sum, file) => sum + file.deletions, 0),
        filesChanged: files.length,
      },
    },
  };
}

async function buildCommitsResponse(input: {
  repository: StoredGitRepository;
  sourceRef: string;
  path?: string;
  limit: number;
  offset?: number;
}): Promise<
  | { ok: true; response: GitListCommitsResponse }
  | {
    ok: false;
    body: {
      error: string;
      code: string;
      repositoryId?: string;
      sourceRef?: string;
    };
    status: 400 | 404 | 409 | 422 | 501;
  }
> {
  const resolved = await resolveRepositorySourceCommit(
    input.repository,
    input.sourceRef,
  );
  if (!resolved.ok) return resolved;
  if (input.path !== undefined && !isSafeTreePath(input.path)) {
    return invalidTreePath(input.repository.id);
  }
  const repositoryPath = configuredRepositoryPath(input.repository.id);
  if (!repositoryPath) {
    return {
      ok: false,
      status: 501,
      body: notImplemented("git_repository_root_not_configured"),
    };
  }
  const output = await runGit([
    "--git-dir",
    repositoryPath,
    "log",
    `-${input.limit}`,
    ...(input.offset ? [`--skip=${input.offset}`] : []),
    "--format=%H%x1f%T%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%ce%x1f%cI%x1f%s%x1e",
    resolved.commit,
    ...(input.path ? ["--", input.path] : []),
  ]);
  if (!output.success) {
    return {
      ok: false,
      status: 422,
      body: {
        error: "failed to list commits",
        code: "git_commits_unreadable",
        repositoryId: input.repository.id,
      },
    };
  }
  const commits = textDecoder.decode(output.stdout).split("\x1e")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [
        sha,
        tree,
        parents,
        authorName,
        authorEmail,
        authorDate,
        committerName,
        committerEmail,
        committerDate,
        message,
      ] = entry.split("\x1f");
      return {
        sha,
        tree,
        parents: parents ? parents.split(/\s+/).filter(Boolean) : [],
        authorName,
        authorEmail,
        authorDate,
        committerName,
        committerEmail,
        committerDate,
        message: message ?? "",
      };
    });
  return {
    ok: true,
    response: {
      repositoryId: input.repository.id,
      sourceRef: input.sourceRef,
      resolvedCommit: resolved.commit,
      commits,
    },
  };
}

async function resolveRepositorySourceCommit(
  repository: StoredGitRepository,
  sourceRef: string,
): Promise<
  | { ok: true; commit: string }
  | {
    ok: false;
    body: {
      error: string;
      code: string;
      repositoryId?: string;
      sourceRef?: string;
      objectId?: string;
    };
    status: 400 | 404 | 409 | 422 | 501;
  }
> {
  if (isLiteralObjectId(sourceRef)) {
    const verified = await verifyLiteralSourceCommit(repository.id, sourceRef);
    if (!verified.ok) return verified;
    return { ok: true, commit: verified.commit };
  }
  const resolved = await resolveConfiguredGitRef(
    repository.id,
    repository.defaultBranch,
    sourceRef,
  );
  if (!resolved.ok) return resolved;
  if (!resolved.resolved) {
    return {
      ok: false,
      status: 422,
      body: {
        error: "git ref could not be resolved",
        code: "git_ref_not_found",
        repositoryId: repository.id,
        sourceRef,
      },
    };
  }
  return { ok: true, commit: resolved.resolved.target };
}

function invalidTreePath(repositoryId: string) {
  return {
    ok: false as const,
    status: 400 as const,
    body: {
      error: "path must be a safe repository-relative path",
      code: "invalid_git_tree_path",
      repositoryId,
    },
  };
}

async function buildSourceSnapshot(input: {
  repositoryId: string;
  sourceRef: string;
  path?: string;
  manifestPath?: string;
}): Promise<
  | { ok: true; response: GitSourceSnapshotResponse }
  | {
    ok: false;
    body: {
      error: string;
      code: string;
      repositoryId?: string;
      sourceRef?: string;
      objectId?: string;
    };
    status: 400 | 404 | 409 | 422 | 501;
  }
> {
  const repository = await findRepository(input.repositoryId);
  const resolved = isLiteralObjectId(input.sourceRef)
    ? await verifyLiteralSourceCommit(input.repositoryId, input.sourceRef)
    : await resolveConfiguredGitRef(
      input.repositoryId,
      repository?.defaultBranch ?? "main",
      input.sourceRef,
    );
  if (!resolved.ok) return resolved;

  const commitSha = "commit" in resolved
    ? resolved.commit
    : resolved.resolved?.target;
  if (!commitSha) {
    return {
      ok: false,
      status: 422,
      body: {
        error:
          "real ref resolution is not implemented/configured for takos-git",
        code: "git_ref_resolution_not_configured",
        repositoryId: input.repositoryId,
        sourceRef: input.sourceRef,
      },
    };
  }

  const repositoryPath = configuredRepositoryPath(input.repositoryId);
  if (!repositoryPath) {
    return {
      ok: false,
      status: 501,
      body: notImplemented("git_repository_root_not_configured"),
    };
  }
  const snapshotPath = input.path?.trim() || ".";
  const manifestPath = input.manifestPath?.trim() || "takos.json";
  if (!isSafeTreePath(snapshotPath) || !isSafeTreePath(manifestPath)) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "path and manifestPath must be safe repository-relative paths",
        code: "invalid_git_tree_path",
        repositoryId: input.repositoryId,
      },
    };
  }

  const filesResult = await readTreeFiles(
    repositoryPath,
    commitSha,
    snapshotPath,
    configuredSourceSnapshotFileLimit(),
  );
  if (!filesResult.ok) {
    const tooLarge =
      filesResult.code === "git_source_snapshot_file_limit_exceeded";
    return {
      ok: false,
      status: 422,
      body: {
        error: tooLarge
          ? "source snapshot exceeds configured file limit"
          : "failed to read source tree",
        code: filesResult.code,
        repositoryId: input.repositoryId,
        sourceRef: input.sourceRef,
      },
    };
  }

  const manifestFile = filesResult.files.find((file) =>
    file.path === manifestPath
  );
  const maxManifestBytes = configuredSourceSnapshotManifestByteLimit();
  if (manifestFile && manifestFile.size > maxManifestBytes) {
    return {
      ok: false,
      status: 422,
      body: {
        error: "source snapshot manifest exceeds configured byte limit",
        code: "git_source_snapshot_manifest_too_large",
        repositoryId: input.repositoryId,
        sourceRef: input.sourceRef,
        objectId: manifestFile.objectId,
      },
    };
  }
  const manifest = manifestFile
    ? await readManifest(repositoryPath, manifestFile)
    : undefined;
  const digest = await snapshotDigest({
    repositoryId: input.repositoryId,
    sourceRef: input.sourceRef,
    commitSha,
    path: snapshotPath,
    manifestPath,
    files: filesResult.files,
    manifestDigest: manifest?.digest,
  });
  return {
    ok: true,
    response: {
      kind: "git",
      repositoryId: input.repositoryId,
      sourceRef: input.sourceRef,
      resolvedRef: "resolved" in resolved ? resolved.resolved?.name : undefined,
      commitSha,
      digest,
      path: snapshotPath,
      manifestPath,
      manifest,
      files: filesResult.files,
      capturedAt: new Date().toISOString(),
    },
  };
}

async function readTreeFiles(
  repositoryPath: string,
  commitSha: string,
  snapshotPath: string,
  maxFiles: number,
): Promise<
  | { ok: true; files: GitSourceSnapshotFile[] }
  | { ok: false; code: "git_source_tree_unreadable" }
  | {
    ok: false;
    code: "git_source_snapshot_file_limit_exceeded";
    maxFiles: number;
  }
> {
  const args = [
    "--git-dir",
    repositoryPath,
    "ls-tree",
    "-r",
    "-z",
    "--long",
    commitSha,
    "--",
    ...(snapshotPath === "." ? [] : [snapshotPath]),
  ];
  const output = await runGit(args);
  if (!output.success) return { ok: false, code: "git_source_tree_unreadable" };
  const entries = textDecoder.decode(output.stdout).split("\0").filter(Boolean);
  if (entries.length > maxFiles) {
    return {
      ok: false,
      code: "git_source_snapshot_file_limit_exceeded",
      maxFiles,
    };
  }
  const files: GitSourceSnapshotFile[] = [];
  for (const entry of entries) {
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const metadata = entry.slice(0, tab).trim().split(/\s+/);
    if (metadata.length < 4) continue;
    const [mode, type, objectId, sizeText] = metadata;
    files.push({
      mode,
      type,
      objectId,
      size: Number(sizeText) || 0,
      path: entry.slice(tab + 1),
    });
  }
  return { ok: true, files };
}

async function readManifest(
  repositoryPath: string,
  file: GitSourceSnapshotFile,
): Promise<GitSourceSnapshotResponse["manifest"]> {
  const output = await runGit([
    "--git-dir",
    repositoryPath,
    "cat-file",
    "-p",
    file.objectId,
  ]);
  if (!output.success) return undefined;
  const content = textDecoder.decode(output.stdout);
  return {
    path: file.path,
    objectId: file.objectId,
    digest: await sha256Hex(content),
    content,
  };
}

async function snapshotDigest(input: {
  repositoryId: string;
  sourceRef: string;
  commitSha: string;
  path: string;
  manifestPath: string;
  manifestDigest?: string;
  files: GitSourceSnapshotFile[];
}): Promise<string> {
  return await sha256Hex(JSON.stringify({
    ...input,
    files: [...input.files].sort((a, b) => a.path.localeCompare(b.path)),
  }));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function parseNameStatus(output: Uint8Array): GitCompareFileSummary[] {
  const tokens = textDecoder.decode(output).split("\0").filter(Boolean);
  const files: GitCompareFileSummary[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const statusToken = tokens[index] ?? "";
    const status = nameStatus(statusToken);
    if (status === "renamed" || status === "copied") {
      const oldPath = tokens[++index];
      const path = tokens[++index];
      if (path) files.push({ path, oldPath, status });
      continue;
    }
    const path = tokens[++index];
    if (path) files.push({ path, status });
  }
  return files;
}

function parsePullRequestUnifiedDiff(
  diffText: string,
  summaries: readonly GitCompareFileSummary[],
): GitPullRequestDiffFile[] {
  const files = summaries.map((summary) => ({
    ...summary,
    additions: 0,
    deletions: 0,
    hunks: [] as GitPullRequestDiffHunk[],
  }));
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  let currentFile: GitPullRequestDiffFile | undefined;
  let currentHunk: GitPullRequestDiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;

  for (const line of diffText.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const path = parseDiffGitNewPath(line);
      currentFile = path ? filesByPath.get(path) : undefined;
      currentHunk = undefined;
      continue;
    }
    if (!currentFile) continue;
    if (line.startsWith("@@ ")) {
      const header = parseUnifiedHunkHeader(line);
      if (!header) {
        currentHunk = undefined;
        continue;
      }
      oldLine = header.oldStart;
      newLine = header.newStart;
      currentHunk = {
        oldStart: header.oldStart,
        oldLines: header.oldLines,
        newStart: header.newStart,
        newLines: header.newLines,
        lines: [],
      };
      currentFile.hunks.push(currentHunk);
      continue;
    }
    if (!currentHunk || line.length === 0 || line.startsWith("\\")) continue;
    const marker = line[0];
    const content = line.slice(1);
    if (marker === " ") {
      currentHunk.lines.push({
        type: "context",
        content,
        oldLine,
        newLine,
      });
      oldLine++;
      newLine++;
    } else if (marker === "-") {
      currentFile.deletions++;
      currentHunk.lines.push({ type: "deletion", content, oldLine });
      oldLine++;
    } else if (marker === "+") {
      currentFile.additions++;
      currentHunk.lines.push({ type: "addition", content, newLine });
      newLine++;
    }
  }

  return files;
}

function parseDiffGitNewPath(line: string): string | undefined {
  const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
  return match?.[2];
}

function parseUnifiedHunkHeader(line: string):
  | {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
  }
  | undefined {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!match) return undefined;
  return {
    oldStart: Number(match[1]),
    oldLines: match[2] ? Number(match[2]) : 1,
    newStart: Number(match[3]),
    newLines: match[4] ? Number(match[4]) : 1,
  };
}

function nameStatus(status: string): GitCompareFileSummary["status"] {
  const code = status[0];
  if (code === "A") return "added";
  if (code === "M") return "modified";
  if (code === "D") return "deleted";
  if (code === "R") return "renamed";
  if (code === "C") return "copied";
  return status;
}

function maxGitBlobBytes(): number {
  const configured = Number(Deno.env.get("TAKOS_GIT_MAX_BLOB_BYTES"));
  if (Number.isInteger(configured) && configured > 0) return configured;
  return DEFAULT_MAX_BLOB_BYTES;
}

function configuredSourceSnapshotFileLimit(): number {
  const configured = Number(
    Deno.env.get("TAKOS_GIT_MAX_SOURCE_SNAPSHOT_FILES"),
  );
  if (Number.isInteger(configured) && configured >= 0) return configured;
  return DEFAULT_MAX_SOURCE_SNAPSHOT_FILES;
}

function configuredSourceSnapshotManifestByteLimit(): number {
  const configured = Number(
    Deno.env.get("TAKOS_GIT_MAX_SOURCE_SNAPSHOT_MANIFEST_BYTES"),
  );
  if (Number.isInteger(configured) && configured >= 0) return configured;
  return DEFAULT_MAX_SOURCE_SNAPSHOT_MANIFEST_BYTES;
}

async function importExternalRemoteIntoConfiguredRepository(input: {
  repositoryId: string;
  remoteUrl: string;
  authHeader: string | null;
  requestedDefaultBranch?: string;
  previousRefs: GitRefSummary[];
}): Promise<
  | {
    ok: true;
    refs: GitRefSummary[];
    defaultBranch: string;
    branchCount: number;
    tagCount: number;
    commitCount: number;
    newCommits: number;
    updatedBranches: string[];
    newTags: string[];
  }
  | {
    ok: false;
    body: {
      error: string;
      code: string;
      repositoryId?: string;
    };
    status: 400 | 404 | 409 | 422 | 501;
  }
> {
  const repositoryPath = configuredRepositoryPath(input.repositoryId);
  if (!repositoryPath) {
    return {
      ok: false,
      status: 501,
      body: notImplemented("git_repository_root_not_configured"),
    };
  }
  if (!isSafeRepositoryId(input.repositoryId)) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "repositoryId must be a safe relative bare repository path",
        code: "invalid_git_repository_id",
        repositoryId: input.repositoryId,
      },
    };
  }

  const commitCountBefore = await countConfiguredRepositoryCommits(
    repositoryPath,
  );
  const fetch = await runGit([
    "--git-dir",
    repositoryPath,
    ...gitAuthConfigArgs(input.authHeader),
    "fetch",
    "--prune",
    "--no-recurse-submodules",
    input.remoteUrl,
    "+refs/heads/*:refs/heads/*",
    "+refs/tags/*:refs/tags/*",
  ]);
  if (!fetch.success) {
    return {
      ok: false,
      status: 422,
      body: {
        error: gitCommandError("failed to fetch external repository", fetch),
        code: "git_external_fetch_failed",
        repositoryId: input.repositoryId,
      },
    };
  }

  const refs = await readGitRefsFromRepositoryPath(
    input.repositoryId,
    repositoryPath,
  );

  const branchRefs = refs.filter((ref) => ref.name.startsWith("refs/heads/"));
  if (branchRefs.length === 0) {
    return {
      ok: false,
      status: 422,
      body: {
        error: "external repository has no branches",
        code: "git_external_repository_empty",
        repositoryId: input.repositoryId,
      },
    };
  }

  const tagRefs = refs.filter((ref) =>
    ref.name.startsWith("refs/tags/") && !ref.name.includes("^{}")
  );
  const remoteHead = await readRemoteHeadBranch(
    input.remoteUrl,
    input.authHeader,
  );
  const defaultBranch = chooseDefaultBranch(
    branchRefs,
    input.requestedDefaultBranch,
    remoteHead,
  );
  await runGit([
    "--git-dir",
    repositoryPath,
    "symbolic-ref",
    "HEAD",
    `refs/heads/${defaultBranch}`,
  ]);

  const previousByName = new Map(
    input.previousRefs.map((ref) => [ref.name, ref.target]),
  );
  const updatedBranches = branchRefs
    .filter((ref) => previousByName.get(ref.name) !== ref.target)
    .map((ref) => ref.name.slice("refs/heads/".length));
  const newTags = tagRefs
    .filter((ref) => !previousByName.has(ref.name))
    .map((ref) => ref.name.slice("refs/tags/".length));
  const commitCount = await countConfiguredRepositoryCommits(repositoryPath);
  const newCommits = Math.max(0, commitCount - commitCountBefore);

  return {
    ok: true,
    refs,
    defaultBranch,
    branchCount: branchRefs.length,
    tagCount: tagRefs.length,
    commitCount,
    newCommits,
    updatedBranches,
    newTags,
  };
}

function gitAuthConfigArgs(authHeader: string | null): string[] {
  const value = authHeader?.trim();
  if (!value) return [];
  return ["-c", `http.extraHeader=Authorization: ${value}`];
}

async function readRemoteHeadBranch(
  remoteUrl: string,
  authHeader: string | null,
): Promise<string | undefined> {
  const output = await runGit([
    ...gitAuthConfigArgs(authHeader),
    "ls-remote",
    "--symref",
    remoteUrl,
    "HEAD",
  ]);
  if (!output.success) return undefined;
  for (const line of textDecoder.decode(output.stdout).split("\n")) {
    const match = /^ref:\s+refs\/heads\/([^\t ]+)\s+HEAD$/.exec(line.trim());
    if (match?.[1]) return match[1];
  }
}

function chooseDefaultBranch(
  branchRefs: GitRefSummary[],
  requestedDefaultBranch?: string,
  remoteHead?: string,
): string {
  const branchNames = branchRefs.map((ref) =>
    ref.name.slice(
      "refs/heads/".length,
    )
  );
  if (requestedDefaultBranch && branchNames.includes(requestedDefaultBranch)) {
    return requestedDefaultBranch;
  }
  if (remoteHead && branchNames.includes(remoteHead)) return remoteHead;
  if (branchNames.includes("main")) return "main";
  if (branchNames.includes("master")) return "master";
  return branchNames[0]!;
}

async function countConfiguredRepositoryCommits(
  repositoryPath: string,
): Promise<number> {
  const output = await runGit([
    "--git-dir",
    repositoryPath,
    "rev-list",
    "--all",
    "--count",
  ]);
  if (!output.success) return 0;
  return Number(textDecoder.decode(output.stdout).trim()) || 0;
}

async function readGitRefsFromRepositoryPath(
  repositoryId: string,
  repositoryPath: string,
): Promise<GitRefSummary[]> {
  const output = await runGit([
    "--git-dir",
    repositoryPath,
    "for-each-ref",
    "--format=%(refname)%00%(objectname)",
  ]);
  if (!output.success) throw new Error(`repository not found: ${repositoryId}`);
  return textDecoder.decode(output.stdout).trimEnd().split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, target] = line.split("\0");
      return { name, target };
    });
}

function gitCommandError(prefix: string, output: Deno.CommandOutput): string {
  const stderr = textDecoder.decode(output.stderr).trim();
  return stderr ? `${prefix}: ${stderr.slice(0, 200)}` : prefix;
}

async function removeConfiguredRepositoryDirectory(
  repositoryId: string,
): Promise<void> {
  const repositoryPath = configuredRepositoryPath(repositoryId);
  if (!repositoryPath) return;
  await Deno.remove(repositoryPath, { recursive: true }).catch(() => {});
}

function gitObjectTooLarge(objectId: string, size: number) {
  return {
    error: "git object exceeds configured response size limit",
    code: "git_object_too_large",
    objectId,
    size,
    maxBytes: maxGitBlobBytes(),
  };
}

function validateRepositoryMetadata(
  request: Partial<GitCreateRepositoryRequest | GitUpdateRepositoryRequest>,
  requireAll: boolean,
): { error: string; code: string } | undefined {
  return validateRepositoryMetadataBase(request, requireAll, normalizeRefs);
}

function validateExternalImportRequest(
  request: Partial<GitImportExternalRepositoryRequest> | undefined,
): { error: string; code: string } | undefined {
  return validateExternalImportRequestBase(request, normalizeRefs);
}

async function mergePullRequestFastForward(
  repository: StoredGitRepository,
  number: number,
  request: Partial<GitMergePullRequestRequest>,
): Promise<
  | { ok: true; response: GitMergePullRequestResponse }
  | {
    ok: false;
    body: {
      error: string;
      code: string;
      repositoryId?: string;
      pullRequestNumber?: number;
      sourceRef?: string;
      objectId?: string;
    };
    status: 400 | 404 | 409 | 422 | 501;
  }
> {
  const pullRequestResult = await readConfiguredPullRequest(
    repository.id,
    number,
  );
  if (!pullRequestResult.ok) return pullRequestResult;
  const pullRequest = pullRequestResult.pullRequest;
  if (pullRequest.status !== "open") {
    return {
      ok: false,
      status: 409,
      body: {
        error: "pull request is not open",
        code: "git_pull_request_not_open",
        repositoryId: repository.id,
        pullRequestNumber: number,
      },
    };
  }
  const repositoryPath = configuredRepositoryPath(repository.id);
  if (!repositoryPath) {
    return {
      ok: false,
      status: 501,
      body: notImplemented("git_repository_root_not_configured"),
    };
  }
  const base = await resolveRepositorySourceCommit(
    repository,
    pullRequest.baseBranch,
  );
  if (!base.ok) return base;
  const head = await resolveRepositorySourceCommit(
    repository,
    pullRequest.headBranch,
  );
  if (!head.ok) return head;
  if (request.expectedHead && request.expectedHead !== head.commit) {
    return {
      ok: false,
      status: 409,
      body: {
        error: "pull request head changed",
        code: "git_pull_request_head_changed",
        repositoryId: repository.id,
        pullRequestNumber: number,
        objectId: head.commit,
      },
    };
  }
  const ancestor = await runGit([
    "--git-dir",
    repositoryPath,
    "merge-base",
    "--is-ancestor",
    base.commit,
    head.commit,
  ]);
  if (!ancestor.success) {
    return {
      ok: false,
      status: 409,
      body: {
        error: "pull request is not fast-forward mergeable",
        code: "git_pull_request_not_fast_forward",
        repositoryId: repository.id,
        pullRequestNumber: number,
      },
    };
  }
  const baseRef = canonicalRefName(pullRequest.baseBranch);
  const updated = await runGit([
    "--git-dir",
    repositoryPath,
    "update-ref",
    baseRef,
    head.commit,
    base.commit,
  ]);
  if (!updated.success) {
    return {
      ok: false,
      status: 409,
      body: {
        error: "failed to update base branch",
        code: "git_pull_request_merge_failed",
        repositoryId: repository.id,
        pullRequestNumber: number,
      },
    };
  }
  const mergedAt = new Date().toISOString();
  const merged = await updateConfiguredPullRequest(repository.id, number, {
    status: "merged",
  });
  if (!merged.ok) return merged;
  return {
    ok: true,
    response: {
      merged: true,
      repositoryId: repository.id,
      pullRequestNumber: number,
      method: "ff-only",
      baseBranch: pullRequest.baseBranch,
      headBranch: pullRequest.headBranch,
      baseCommit: base.commit,
      headCommit: head.commit,
      mergedAt: merged.pullRequest.mergedAt ?? mergedAt,
      pullRequest: merged.pullRequest,
    },
  };
}

function normalizeRefs(
  refs: GitCreateRepositoryRequest["refs"],
): Map<string, string> | undefined {
  const normalized = new Map<string, string>();
  if (refs === undefined) return normalized;
  if (Array.isArray(refs)) {
    for (const ref of refs) {
      if (!isValidRefSummary(ref)) return undefined;
      normalized.set(canonicalRefName(ref.name), ref.target);
    }
    return normalized;
  }
  if (!refs || typeof refs !== "object") return undefined;
  for (const [name, target] of Object.entries(refs)) {
    if (
      typeof name !== "string" || name.trim().length === 0 ||
      typeof target !== "string" || !isLiteralObjectId(target)
    ) {
      return undefined;
    }
    normalized.set(canonicalRefName(name), target);
  }
  return normalized;
}

function isValidRefSummary(ref: unknown): ref is GitRefSummary {
  return !!ref && typeof ref === "object" &&
    typeof (ref as GitRefSummary).name === "string" &&
    (ref as GitRefSummary).name.trim().length > 0 &&
    typeof (ref as GitRefSummary).target === "string" &&
    isLiteralObjectId((ref as GitRefSummary).target);
}

function canonicalRefName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.startsWith("refs/")) return trimmed;
  return `refs/heads/${trimmed}`;
}

function resolveStoredRef(
  repository: StoredGitRepository,
  sourceRef: string,
): { name: string; target: string } | undefined {
  const candidates = refResolutionCandidates(repository, sourceRef);
  for (const candidate of candidates) {
    const target = repository.refs.get(candidate);
    if (target) return { name: candidate, target };
  }
}

function refResolutionCandidates(
  repository: StoredGitRepository,
  sourceRef: string,
): string[] {
  const trimmed = sourceRef.trim();
  const candidates = new Set<string>([trimmed]);
  if (!trimmed.startsWith("refs/")) {
    candidates.add(`refs/heads/${trimmed}`);
    candidates.add(`refs/tags/${trimmed}`);
  }
  if (trimmed === repository.defaultBranch) {
    candidates.add(`refs/heads/${repository.defaultBranch}`);
  }
  return [...candidates];
}

async function resolveConfiguredGitRef(
  repositoryId: string,
  defaultBranch: string,
  sourceRef: string,
): Promise<
  | { ok: true; resolved?: { name: string; target: string } }
  | {
    ok: false;
    body: {
      error: string;
      code: string;
      repositoryId?: string;
      objectId?: string;
    };
    status: 400 | 404 | 409 | 422 | 501;
  }
> {
  const refs = await readConfiguredGitRefs(repositoryId);
  if (!refs.ok) return refs;
  const candidates = refResolutionCandidatesForBranch(defaultBranch, sourceRef);
  for (const candidate of candidates) {
    const ref = refs.refs.find((entry) => entry.name === candidate);
    if (!ref) continue;
    const commit = await runGit([
      "--git-dir",
      refs.repositoryPath,
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${ref.name}^{commit}`,
    ]);
    if (commit.success) {
      return {
        ok: true,
        resolved: {
          name: ref.name,
          target: textDecoder.decode(commit.stdout).trim(),
        },
      };
    }
    return { ok: true, resolved: { name: ref.name, target: ref.target } };
  }
  return { ok: true };
}

function refResolutionCandidatesForBranch(
  defaultBranch: string,
  sourceRef: string,
): string[] {
  const trimmed = sourceRef.trim();
  const candidates = new Set<string>([trimmed]);
  if (!trimmed.startsWith("refs/")) {
    candidates.add(`refs/heads/${trimmed}`);
    candidates.add(`refs/tags/${trimmed}`);
  }
  if (trimmed === defaultBranch) candidates.add(`refs/heads/${defaultBranch}`);
  return [...candidates].filter(isSafeRefInput);
}

function repositoryRefs(repository: StoredGitRepository): GitRefSummary[] {
  return [...repository.refs.entries()].map(([name, target]) => ({
    name,
    target,
  }));
}

function repositorySummary(
  repository: StoredGitRepository,
): GitRepositorySummary {
  return {
    id: repository.id,
    name: repository.name,
    ownerSpaceId: repository.ownerSpaceId,
    defaultBranch: repository.defaultBranch,
  };
}

function repositoryDetail(
  repository: StoredGitRepository,
): GitRepositoryDetail {
  return {
    ...repositorySummary(repository),
    refs: repositoryRefs(repository),
    createdAt: repository.createdAt,
    updatedAt: repository.updatedAt,
  };
}

const textDecoder = new TextDecoder();

async function verifyLiteralSourceCommit(
  repositoryId: string,
  sourceRef: string,
): Promise<
  | { ok: true; commit: string }
  | {
    ok: false;
    body: {
      error: string;
      code: string;
      repositoryId?: string;
      objectId?: string;
    };
    status: 400 | 404 | 409 | 422 | 501;
  }
> {
  const verified = await verifyConfiguredGitCommit(repositoryId, sourceRef);
  if (verified.ok) return verified;
  if (verified.status === 501 && devInMemoryMetadataEnabled()) {
    return { ok: true, commit: sourceRef };
  }
  return verified;
}

if (import.meta.main) {
  const port = Number(Deno.env.get("PORT") ?? "8790");
  Deno.serve({ port }, app.fetch);
}

export default app;
