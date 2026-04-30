import { Hono } from "hono";
import {
  decodeActorContext,
  type GitCreateRepositoryRequest,
  type GitRefSummary,
  type GitRepositoryDetail,
  type GitRepositorySummary,
  type GitResolveSourceRequest,
  type GitResolveSourceResponse,
  type GitUpdateRepositoryRequest,
  TAKOS_GIT_INTERNAL_PATHS,
  TAKOS_INTERNAL_ACTOR_HEADER,
  TAKOS_INTERNAL_AUDIENCE_HEADER,
  TAKOS_INTERNAL_CALLER_HEADER,
  TAKOS_INTERNAL_SIGNATURE_HEADER,
  TAKOS_INTERNAL_TIMESTAMP_HEADER,
  verifySignedInternalRequestFromHeaders,
} from "takos-git-contract";

const app: Hono = new Hono();
const TAKOS_GIT_EXPECTED_AUDIENCE = "takos-git";
const TAKOS_GIT_DEFAULT_INTERNAL_CALLERS = ["takos-app", "takos-paas"];
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

  if (isLiteralCommitId(request.sourceRef)) {
    const response: GitResolveSourceResponse = {
      sourceRef: request.sourceRef,
      repositoryId: request.repositoryId,
      resolvedCommit: request.sourceRef,
    };
    return c.json(response);
  }

  const repository = repositories.get(request.repositoryId);
  const resolved = await resolveConfiguredGitRef(
    request.repositoryId,
    repository?.defaultBranch ?? "main",
    request.sourceRef,
  ) ??
    (repository ? resolveStoredRef(repository, request.sourceRef) : undefined);
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

  const object = await readConfiguredGitObject(
    c.req.param("repositoryId"),
    c.req.param("objectId"),
  );
  if (!object.ok) return c.json(object.body, object.status);
  return new Response(bytesToArrayBuffer(object.content), {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "x-takos-git-object-id": object.objectId,
      "x-takos-git-object-type": object.type,
      "x-takos-git-object-size": String(object.size),
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

function isLiteralCommitId(sourceRef: string): boolean {
  return /^[0-9a-fA-F]{40}$/.test(sourceRef) ||
    /^[0-9a-fA-F]{64}$/.test(sourceRef);
}

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
      typeof target !== "string" || !isLiteralCommitId(target)
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
    isLiteralCommitId((ref as GitRefSummary).target);
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
): Promise<{ name: string; target: string } | undefined> {
  const refs = await readConfiguredGitRefs(repositoryId);
  if (!refs.ok) return undefined;
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
        name: ref.name,
        target: textDecoder.decode(commit.stdout).trim(),
      };
    }
    return { name: ref.name, target: ref.target };
  }
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

function repositoryNotFound(repositoryId: string) {
  return {
    error: "repository not found",
    code: "git_repository_not_found",
    repositoryId,
  };
}

function notImplemented(code: string) {
  return {
    error: "not implemented or not configured in takos-git",
    code,
  };
}

function isGitSmartHttpPath(pathname: string): boolean {
  return pathname.endsWith(".git") || pathname.includes(".git/");
}

const textDecoder = new TextDecoder();

type GitJsonError = {
  body: {
    error: string;
    code: string;
    repositoryId?: string;
    objectId?: string;
  };
  status: 400 | 404 | 501;
};

async function readConfiguredGitRefs(
  repositoryId: string,
): Promise<
  | { ok: true; refs: GitRefSummary[]; repositoryPath: string }
  | ({ ok: false } & GitJsonError)
> {
  const repositoryPath = configuredRepositoryPath(repositoryId);
  if (!repositoryPath) {
    return {
      ok: false,
      status: 501,
      body: notImplemented("git_repository_root_not_configured"),
    };
  }
  if (!isSafeRepositoryId(repositoryId)) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "repositoryId must be a safe relative bare repository path",
        code: "invalid_git_repository_id",
        repositoryId,
      },
    };
  }
  if (!(await directoryExists(repositoryPath))) {
    return {
      ok: false,
      status: 404,
      body: repositoryNotFound(repositoryId),
    };
  }

  const output = await runGit([
    "--git-dir",
    repositoryPath,
    "for-each-ref",
    "--format=%(refname)%00%(objectname)",
  ]);
  if (!output.success) {
    return {
      ok: false,
      status: 404,
      body: repositoryNotFound(repositoryId),
    };
  }

  const refs = textDecoder.decode(output.stdout).trimEnd().split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, target] = line.split("\0");
      return { name, target };
    });
  return { ok: true, refs, repositoryPath };
}

async function readConfiguredGitObject(
  repositoryId: string,
  objectId: string,
): Promise<
  | {
    ok: true;
    objectId: string;
    type: string;
    size: number;
    content: Uint8Array;
  }
  | ({ ok: false } & GitJsonError)
> {
  const refs = await readConfiguredGitRefs(repositoryId);
  if (!refs.ok) return refs;
  if (!isLiteralCommitId(objectId)) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "objectId must be a literal SHA-1 or SHA-256 object id",
        code: "invalid_git_object_id",
        repositoryId,
        objectId,
      },
    };
  }

  const baseArgs = ["--git-dir", refs.repositoryPath] as const;
  const type = await runGit([...baseArgs, "cat-file", "-t", objectId]);
  if (!type.success) {
    return {
      ok: false,
      status: 404,
      body: {
        error: "git object not found",
        code: "git_object_not_found",
        repositoryId,
        objectId,
      },
    };
  }
  const size = await runGit([...baseArgs, "cat-file", "-s", objectId]);
  if (!size.success) {
    return {
      ok: false,
      status: 404,
      body: {
        error: "git object not found",
        code: "git_object_not_found",
        repositoryId,
        objectId,
      },
    };
  }
  const content = await runGit([...baseArgs, "cat-file", "-p", objectId]);
  if (!content.success) {
    return {
      ok: false,
      status: 404,
      body: {
        error: "git object not found",
        code: "git_object_not_found",
        repositoryId,
        objectId,
      },
    };
  }
  return {
    ok: true,
    objectId,
    type: textDecoder.decode(type.stdout).trim(),
    size: Number(textDecoder.decode(size.stdout).trim()),
    content: content.stdout,
  };
}

async function handleSmartHttp(request: Request): Promise<Response> {
  const root = configuredRepositoryRoot();
  if (!root) {
    return Response.json(notImplemented("git_smart_http_not_implemented"), {
      status: 501,
    });
  }

  const url = new URL(request.url);
  if (!isSafeSmartHttpPath(url.pathname)) {
    return Response.json({
      error: "invalid Git Smart HTTP path",
      code: "invalid_git_smart_http_path",
    }, { status: 400 });
  }

  const body = new Uint8Array(await request.arrayBuffer());
  const contentType = request.headers.get("content-type");
  const output = await runGit(["http-backend"], body, {
    GIT_PROJECT_ROOT: root,
    GIT_HTTP_EXPORT_ALL: "1",
    PATH_INFO: url.pathname,
    QUERY_STRING: url.search.startsWith("?") ? url.search.slice(1) : "",
    REQUEST_METHOD: request.method,
    CONTENT_TYPE: contentType ?? "",
    CONTENT_LENGTH: String(body.byteLength),
    REMOTE_USER: "takos-git",
  });
  if (!output.success) {
    return Response.json({
      error: "git http-backend failed",
      code: "git_smart_http_backend_failed",
    }, { status: 500 });
  }
  return cgiResponse(output.stdout);
}

function cgiResponse(output: Uint8Array): Response {
  const boundary = findHeaderBoundary(output);
  if (!boundary) {
    return Response.json({
      error: "git http-backend returned an invalid CGI response",
      code: "git_smart_http_invalid_backend_response",
    }, { status: 500 });
  }

  const headersText = textDecoder.decode(output.slice(0, boundary.headerEnd));
  const headers = new Headers();
  let status = 200;
  for (const line of headersText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (name.toLowerCase() === "status") {
      status = Number(value.split(/\s+/, 1)[0]) || status;
    } else {
      headers.append(name, value);
    }
  }
  return new Response(bytesToArrayBuffer(output.slice(boundary.bodyStart)), {
    status,
    headers,
  });
}

function findHeaderBoundary(
  output: Uint8Array,
): { headerEnd: number; bodyStart: number } | undefined {
  for (let index = 0; index < output.length - 3; index++) {
    if (
      output[index] === 13 && output[index + 1] === 10 &&
      output[index + 2] === 13 && output[index + 3] === 10
    ) {
      return { headerEnd: index, bodyStart: index + 4 };
    }
  }
  for (let index = 0; index < output.length - 1; index++) {
    if (output[index] === 10 && output[index + 1] === 10) {
      return { headerEnd: index, bodyStart: index + 2 };
    }
  }
}

function configuredRepositoryPath(repositoryId: string): string | undefined {
  const root = configuredRepositoryRoot();
  if (!root) return undefined;
  const relative = repositoryId.endsWith(".git")
    ? repositoryId
    : `${repositoryId}.git`;
  return `${root}/${relative}`;
}

function configuredRepositoryRoot(): string | undefined {
  const root = Deno.env.get("TAKOS_GIT_REPOSITORY_ROOT")?.trim();
  if (!root) return undefined;
  return root.replace(/\/+$/, "") || "/";
}

function isSafeRepositoryId(repositoryId: string): boolean {
  return repositoryId.length > 0 &&
    !repositoryId.startsWith("/") &&
    repositoryId.split("/").every(isSafePathSegment);
}

function isSafeSmartHttpPath(pathname: string): boolean {
  if (!pathname.startsWith("/") || !pathname.includes(".git")) return false;
  return pathname.slice(1).split("/").every(isSafePathSegment);
}

function isSafePathSegment(segment: string): boolean {
  return segment.length > 0 &&
    segment !== "." &&
    segment !== ".." &&
    !segment.includes("\\") &&
    /^[A-Za-z0-9._-]+$/.test(segment);
}

function isSafeRefInput(ref: string): boolean {
  return ref.length > 0 &&
    !ref.includes("\0") &&
    !ref.includes("..") &&
    !ref.includes("@{") &&
    !ref.includes("\\") &&
    !ref.startsWith("/") &&
    !ref.endsWith("/") &&
    /^[A-Za-z0-9._/-]+$/.test(ref);
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function runGit(
  args: string[],
  stdin?: Uint8Array,
  env?: Record<string, string>,
): Promise<Deno.CommandOutput> {
  if (!stdin) {
    return await new Deno.Command("git", {
      args,
      stdout: "piped",
      stderr: "piped",
      env,
    }).output();
  }

  const child = new Deno.Command("git", {
    args,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    env,
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(stdin);
  await writer.close();
  return await child.output();
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function readInternalAuth(
  request: Request,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const secret = Deno.env.get("TAKOS_INTERNAL_SERVICE_SECRET");
  return readInternalAuthWithSecret(request, secret);
}

async function readInternalAuthWithSecret(
  request: Request,
  secret: string | undefined,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!secret) return { ok: false, error: "internal service secret missing" };
  const signature = request.headers.get(TAKOS_INTERNAL_SIGNATURE_HEADER);
  if (!signature) {
    return { ok: false, error: "missing internal signature" };
  }
  const timestamp = request.headers.get(TAKOS_INTERNAL_TIMESTAMP_HEADER);
  if (!timestamp) {
    return { ok: false, error: "missing internal timestamp" };
  }
  const actorHeader = request.headers.get(TAKOS_INTERNAL_ACTOR_HEADER);
  if (!actorHeader) return { ok: false, error: "missing actor context" };
  try {
    decodeActorContext(actorHeader);
  } catch {
    return { ok: false, error: "invalid actor context" };
  }
  const caller = request.headers.get(TAKOS_INTERNAL_CALLER_HEADER);
  if (!caller) return { ok: false, error: "missing internal caller" };
  if (!allowedInternalCallers().includes(caller)) {
    return { ok: false, error: "invalid internal caller" };
  }
  const audience = request.headers.get(TAKOS_INTERNAL_AUDIENCE_HEADER);
  if (!audience) return { ok: false, error: "missing internal audience" };
  const body = await request.clone().text();
  const path = new URL(request.url).pathname;
  const valid = await verifySignedInternalRequestFromHeaders({
    method: request.method,
    path,
    body,
    secret,
    headers: request.headers,
    expectedCaller: caller,
    expectedAudience: TAKOS_GIT_EXPECTED_AUDIENCE,
  });
  if (!valid) return { ok: false, error: "invalid internal signature" };
  return { ok: true };
}

function allowedInternalCallers(): string[] {
  const configured = Deno.env.get("TAKOS_GIT_INTERNAL_CALLERS");
  return (configured?.split(",") ?? TAKOS_GIT_DEFAULT_INTERNAL_CALLERS)
    .map((caller) => caller.trim())
    .filter(Boolean);
}

if (import.meta.main) {
  const port = Number(Deno.env.get("PORT") ?? "8790");
  Deno.serve({ port }, app.fetch);
}

export default app;
