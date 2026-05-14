import { Hono } from "hono";
import {
  type GitCreatePullRequestCommentRequest,
  type GitCreatePullRequestRequest,
  type GitCreatePullRequestReviewRequest,
  type GitCreateRepositoryRequest,
  type GitFetchExternalRepositoryRequest,
  type GitFetchExternalRepositoryResponse,
  type GitImportExternalRepositoryRequest,
  type GitImportExternalRepositoryResponse,
  type GitListRefsResponse,
  type GitMergePullRequestRequest,
  type GitRefSummary,
  type GitRepositoryDetail,
  type GitRepositorySummary,
  type GitResolveSourceRequest,
  type GitResolveSourceResponse,
  type GitSourceSnapshotRequest,
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
  writeConfiguredGitRefs,
  writeConfiguredRepositoryMetadata,
} from "./git.ts";
import {
  buildBlobResponse,
  buildCommitResponse,
  buildCommitsResponse,
  buildCompareResponse,
  buildPullRequestDiffResponse,
  buildSourceSnapshot,
  buildTreeResponse,
  canonicalRefName,
  gitObjectTooLarge,
  maxGitBlobBytes,
  mergePullRequestFastForward,
  resolveConfiguredGitRef,
  textDecoder,
  verifyLiteralSourceCommit,
} from "./response-builders.ts";
import { handleSmartHttp, isGitSmartHttpPath } from "./smart-http.ts";
import {
  isPullRequestStatus,
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
    defaultBranch: repository?.defaultBranch ?? "main",
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

if (import.meta.main) {
  const port = Number(Deno.env.get("PORT") ?? "8790");
  Deno.serve({ port }, app.fetch);
}

export default app;
