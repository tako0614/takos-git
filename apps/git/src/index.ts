import { Hono } from "hono";
import {
  type GitCreateRepositoryRequest,
  type GitRefSummary,
  type GitRepositoryDetail,
  type GitRepositorySummary,
  type GitResolveSourceRequest,
  type GitResolveSourceResponse,
  type GitUpdateRepositoryRequest,
  TAKOS_GIT_INTERNAL_PATHS,
} from "takos-git-contract";
import { readInternalAuth } from "./auth.ts";
import {
  bytesToArrayBuffer,
  isLiteralObjectId,
  isSafeRefInput,
  notImplemented,
  readConfiguredGitPrettyObject,
  readConfiguredGitRefs,
  repositoryNotFound,
  runGit,
  verifyConfiguredGitCommit,
} from "./git.ts";
import { handleSmartHttp, isGitSmartHttpPath } from "./smart-http.ts";

const app: Hono = new Hono();
const repositories = new Map<string, StoredGitRepository>();

interface StoredGitRepository {
  id: string;
  name: string;
  ownerAccountId: string;
  defaultBranch: string;
  refs: Map<string, string>;
  createdAt: string;
  updatedAt: string;
}

app.get("/health", (c) => c.json({ ok: true, service: "takos-git" }));

app.get(TAKOS_GIT_INTERNAL_PATHS.repositories, async (c) => {
  const auth = await readInternalAuth(c.req.raw);
  if (!auth.ok) return c.json({ error: auth.error }, 401);

  const summaries: GitRepositorySummary[] = [...repositories.values()]
    .map(repositorySummary);
  return c.json({ repositories: summaries });
});

app.post(TAKOS_GIT_INTERNAL_PATHS.repositories, async (c) => {
  const auth = await readInternalAuth(c.req.raw);
  if (!auth.ok) return c.json({ error: auth.error }, 401);

  const request = await c.req.json<Partial<GitCreateRepositoryRequest>>();
  const invalid = validateRepositoryMetadata(request, true);
  if (invalid) return c.json(invalid, 400);
  if (repositories.has(request.id!)) {
    return c.json({
      error: "repository already exists",
      code: "git_repository_already_exists",
      repositoryId: request.id,
    }, 409);
  }

  const now = new Date().toISOString();
  const repository: StoredGitRepository = {
    id: request.id!,
    name: request.name!,
    ownerAccountId: request.ownerAccountId!,
    defaultBranch: request.defaultBranch ?? "main",
    refs: normalizeRefs(request.refs)!,
    createdAt: now,
    updatedAt: now,
  };
  repositories.set(repository.id, repository);
  return c.json({ repository: repositoryDetail(repository) }, 201);
});

app.get("/internal/repositories/:repositoryId", async (c) => {
  const auth = await readInternalAuth(c.req.raw);
  if (!auth.ok) return c.json({ error: auth.error }, 401);

  const repository = repositories.get(c.req.param("repositoryId"));
  if (!repository) {
    return c.json(repositoryNotFound(c.req.param("repositoryId")), 404);
  }
  return c.json({ repository: repositoryDetail(repository) });
});

app.get("/internal/repositories/:repositoryId/refs", async (c) => {
  const auth = await readInternalAuth(c.req.raw);
  if (!auth.ok) return c.json({ error: auth.error }, 401);

  const repositoryId = c.req.param("repositoryId");
  const gitRefs = await readConfiguredGitRefs(repositoryId);
  if (gitRefs.ok) {
    return c.json({ repositoryId, refs: gitRefs.refs });
  }
  if (gitRefs.status !== 501) return c.json(gitRefs.body, gitRefs.status);

  const repository = repositories.get(repositoryId);
  if (!repository) return c.json(gitRefs.body, 501);
  return c.json({ repositoryId, refs: repositoryRefs(repository) });
});

app.patch("/internal/repositories/:repositoryId", async (c) => {
  const auth = await readInternalAuth(c.req.raw);
  if (!auth.ok) return c.json({ error: auth.error }, 401);

  const repositoryId = c.req.param("repositoryId");
  const repository = repositories.get(repositoryId);
  if (!repository) return c.json(repositoryNotFound(repositoryId), 404);

  const request = await c.req.json<Partial<GitUpdateRepositoryRequest>>();
  const invalid = validateRepositoryMetadata(request, false);
  if (invalid) return c.json(invalid, 400);

  if (typeof request.name === "string") repository.name = request.name;
  if (typeof request.ownerAccountId === "string") {
    repository.ownerAccountId = request.ownerAccountId;
  }
  if (typeof request.defaultBranch === "string") {
    repository.defaultBranch = request.defaultBranch;
  }
  if (request.refs !== undefined) {
    repository.refs = normalizeRefs(request.refs)!;
  }
  repository.updatedAt = new Date().toISOString();
  return c.json({ repository: repositoryDetail(repository) });
});

app.delete("/internal/repositories/:repositoryId", async (c) => {
  const auth = await readInternalAuth(c.req.raw);
  if (!auth.ok) return c.json({ error: auth.error }, 401);

  const repositoryId = c.req.param("repositoryId");
  if (!repositories.delete(repositoryId)) {
    return c.json(repositoryNotFound(repositoryId), 404);
  }
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
    repositories.get(request.repositoryId)?.defaultBranch ?? "main",
    request.sourceRef,
  );
  if (!configuredRef.ok && configuredRef.status !== 501) {
    return c.json(configuredRef.body, configuredRef.status);
  }

  const repository = repositories.get(request.repositoryId);
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

  const object = await readConfiguredGitPrettyObject(
    c.req.param("repositoryId"),
    c.req.param("objectId"),
  );
  if (!object.ok) return c.json(object.body, object.status);
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

function validateRepositoryMetadata(
  request: Partial<GitCreateRepositoryRequest | GitUpdateRepositoryRequest>,
  requireAll: boolean,
): { error: string; code: string } | undefined {
  if (!request || typeof request !== "object") {
    return {
      error: "repository metadata request body is required",
      code: "invalid_repository_metadata_request",
    };
  }
  const checks: Array<[string, unknown, boolean]> = [
    ["id", "id" in request ? request.id : undefined, requireAll],
    ["name", request.name, requireAll],
    ["ownerAccountId", request.ownerAccountId, requireAll],
    ["defaultBranch", request.defaultBranch, false],
  ];
  for (const [field, value, required] of checks) {
    if (value === undefined && !required) continue;
    if (typeof value !== "string" || value.trim().length === 0) {
      return {
        error: `${field} must be a non-empty string`,
        code: "invalid_repository_metadata_request",
      };
    }
  }
  const refs = request.refs;
  if (refs !== undefined && normalizeRefs(refs) === undefined) {
    return {
      error: "refs must be a name-to-commit map or ref summary array",
      code: "invalid_repository_refs",
    };
  }
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
    status: 400 | 404 | 422 | 501;
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
    ownerAccountId: repository.ownerAccountId,
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
    status: 400 | 404 | 422 | 501;
  }
> {
  const verified = await verifyConfiguredGitCommit(repositoryId, sourceRef);
  if (verified.ok) return verified;
  if (verified.status === 501) return { ok: true, commit: sourceRef };
  return verified;
}

if (import.meta.main) {
  const port = Number(Deno.env.get("PORT") ?? "8790");
  Deno.serve({ port }, app.fetch);
}

export default app;
