import {
  browserAuthConfigured,
  handleBrowserAuth,
  readBrowserSession,
  type BrowserAuthEnv,
  type BrowserSession,
  type OAuthFetch,
} from "./browser-auth.ts";
import {
  getBlob,
  getCommitData,
  GitObjectTooLargeError,
} from "./git/object-store.ts";
import { repositoryObjectStore } from "./git/repo-object-store.ts";
import {
  isValidRepoName,
  listRepos,
  readRepoRefs,
  repoExists,
  type RefsDoc,
} from "./git/refs-store.ts";
import {
  getEntryAtPath,
  isValidGitPath,
  listDirectory,
} from "./git/tree-ops.ts";
import { isValidSha } from "./git/git-objects.ts";
import type { GitCommit } from "./git/git-objects.ts";
import {
  commitReachableFromTips,
  countCommitsBetween,
} from "./git/merge-base.ts";
import { buildDiffPayload } from "./git/commit-diff.ts";
import { blameFile } from "./git/blame.ts";
import type { ObjectStoreBinding } from "./git/types.ts";
import {
  hasValidInterfaceOAuthConfiguration,
  verifyInterfaceOAuthBearer,
} from "./interface-oauth-auth.ts";

const HOSTING_READ_PERMISSION = "source.git.hosting.read";
const MAX_COMMITS = 100;
const DEFAULT_COMMITS = 30;
const MAX_BLOB_BYTES = 1024 * 1024;
const MAX_COMMIT_BYTES = 256 * 1024;
const MAX_TREE_BYTES = 4 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 10_000;

export interface ForgeApiEnv extends BrowserAuthEnv {
  BUCKET: ObjectStoreBinding;
  APP_URL?: string;
  APP_CAPSULE_ID?: string;
}

type ForgeIdentity =
  | { readonly kind: "browser"; readonly session: BrowserSession }
  | { readonly kind: "interface" };

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "application/json; charset=utf-8");
  responseHeaders.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders,
  });
}

function bearerToken(request: Request): string | null {
  const match = /^Bearer\s+(.+)$/iu.exec(
    request.headers.get("authorization") ?? "",
  );
  return match?.[1]?.trim() || null;
}

function hostingAudience(request: Request, env: ForgeApiEnv): string {
  const requestUrl = new URL(request.url);
  const base = env.APP_URL?.trim() || requestUrl.origin;
  try {
    return new URL("/api/v1", `${base.replace(/\/$/u, "")}/`).href;
  } catch {
    return "";
  }
}

async function authorizeRead(
  request: Request,
  env: ForgeApiEnv,
  interfaceUserInfoFetch?: OAuthFetch,
): Promise<ForgeIdentity | Response> {
  const session = await readBrowserSession(request, env);
  if (session) return { kind: "browser", session };

  const token = bearerToken(request);
  const audience = hostingAudience(request, env);
  const interfaceConfigured = hasValidInterfaceOAuthConfiguration({
    issuerUrl: env.OIDC_ISSUER_URL,
    audience,
    workspaceId: env.APP_WORKSPACE_ID,
    capsuleId: env.APP_CAPSULE_ID,
  });
  if (
    token &&
    interfaceConfigured &&
    (await verifyInterfaceOAuthBearer(request, token, HOSTING_READ_PERMISSION, {
      issuerUrl: env.OIDC_ISSUER_URL,
      expectedAudience: audience,
      expectedWorkspaceId: env.APP_WORKSPACE_ID,
      expectedCapsuleId: env.APP_CAPSULE_ID,
      ...(interfaceUserInfoFetch ? { fetchImpl: interfaceUserInfoFetch } : {}),
    }))
  ) {
    return { kind: "interface" };
  }

  if (!browserAuthConfigured(env) && !interfaceConfigured) {
    return json({ error: "hosting_authentication_unconfigured" }, 503);
  }
  return json({ error: "hosting_unauthorized" }, 401, {
    "www-authenticate": 'Bearer realm="Takos Git Hosting"',
  });
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

type RepoRoute =
  | {
      readonly repo: string;
      readonly action: "info" | "branches" | "commits" | "tree" | "blob" | "blame";
    }
  | { readonly repo: string; readonly action: "commit-detail"; readonly sha: string }
  | {
      readonly repo: string;
      readonly action: "compare";
      readonly base: string;
      readonly head: string;
    };

function parseRepoRoute(pathname: string): RepoRoute | null {
  const segments = pathname.split("/").filter(Boolean);
  if (
    segments.length < 5 ||
    segments[0] !== "api" ||
    segments[1] !== "v1" ||
    segments[2] !== "repos"
  ) {
    return null;
  }
  const owner = safeDecode(segments[3]);
  const name = safeDecode(segments[4]);
  if (!owner || !name) return null;
  const repo = `${owner}/${name}`;
  if (!isValidRepoName(repo)) return null;
  if (segments.length === 5) return { repo, action: "info" };
  const action = segments[5];

  if (segments.length === 6) {
    return action === "branches" ||
      action === "commits" ||
      action === "tree" ||
      action === "blob" ||
      action === "blame"
      ? { repo, action }
      : null;
  }

  // `.../commits/:sha` — single-commit detail.
  if (segments.length === 7 && action === "commits") {
    const sha = safeDecode(segments[6]);
    if (!sha) return null;
    return { repo, action: "commit-detail", sha };
  }

  // `.../compare/:base...:head` — refs may contain slashes, so join the rest and
  // split on the `...` separator (a ref name can never contain `..`).
  if (action === "compare" && segments.length >= 7) {
    const rest = segments.slice(6).map(safeDecode);
    if (rest.some((part) => part === null)) return null;
    const joined = (rest as string[]).join("/");
    const idx = joined.indexOf("...");
    if (idx === -1) return null;
    const base = joined.slice(0, idx);
    const head = joined.slice(idx + 3);
    if (!base || !head) return null;
    return { repo, action: "compare", base, head };
  }

  return null;
}

function encodedRepoPath(repo: string): string {
  return repo.split("/").map(encodeURIComponent).join("/");
}

function repositoryCloneUrl(request: Request, env: ForgeApiEnv, repo: string) {
  const base = env.APP_URL?.trim() || new URL(request.url).origin;
  return new URL(
    `/git/${encodedRepoPath(repo)}.git`,
    `${base.replace(/\/$/u, "")}/`,
  ).href;
}

function branchRecords(refs: RefsDoc) {
  return refs.refs
    .flatMap((ref) => {
      if (!ref.name.startsWith("refs/heads/")) return [];
      const name = ref.name.slice("refs/heads/".length);
      return [{ name, sha: ref.sha, default: name === refs.defaultBranch }];
    })
    .sort((left, right) => {
      if (left.default !== right.default) return left.default ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
}

function resolveBranch(refs: RefsDoc, requested: string | null) {
  const name = requested?.trim() || refs.defaultBranch;
  if (!name) return null;
  const record = refs.refs.find((ref) => ref.name === `refs/heads/${name}`);
  return record ? { name, sha: record.sha } : null;
}

/**
 * Resolve a ref *name* (branch or tag) to a commit SHA. Raw object ids never
 * match a `refs/heads/*` or `refs/tags/*` entry, so this preserves the M1
 * "browse by branch/tag name, not arbitrary SHA" invariant.
 */
function resolveRefToCommit(
  refs: RefsDoc,
  requested: string | null,
): { name: string; sha: string; kind: "branch" | "tag" } | null {
  const name = requested?.trim() || refs.defaultBranch;
  if (!name) return null;
  const branch = refs.refs.find((ref) => ref.name === `refs/heads/${name}`);
  if (branch) return { name, sha: branch.sha, kind: "branch" };
  const tag = refs.refs.find((ref) => ref.name === `refs/tags/${name}`);
  if (tag) return { name, sha: tag.sha, kind: "tag" };
  return null;
}

/** All advertised ref tips — the reachability roots for commit-by-SHA browse. */
function commitTips(refs: RefsDoc): string[] {
  return refs.refs.map((ref) => ref.sha);
}

function shapeCommit(commit: GitCommit): Record<string, unknown> {
  return {
    sha: commit.sha,
    tree: commit.tree,
    parents: commit.parents,
    author: {
      name: commit.author.name,
      email: commit.author.email,
      date: commitTimestamp(commit.author.timestamp),
    },
    committer: {
      name: commit.committer.name,
      email: commit.committer.email,
      date: commitTimestamp(commit.committer.timestamp),
    },
    message: commit.message,
  };
}

async function blobOidAtPath(
  store: ObjectStoreBinding,
  treeSha: string,
  path: string,
): Promise<string | null> {
  const entry = await getEntryAtPath(store, treeSha, path, {
    maxTreeBytes: MAX_TREE_BYTES,
  });
  if (!entry || entry.type !== "blob") return null;
  return entry.sha;
}

const GRAPH_TOO_LARGE = "commit graph too large";

/** Map the bounded-walk overflow error to a 413 response, else rethrow. */
function graphOverflowResponse(error: unknown): Response | null {
  if (error instanceof Error && error.message === GRAPH_TOO_LARGE) {
    return json({ error: "commit_graph_too_large" }, 413);
  }
  return null;
}

function commitTimestamp(timestamp: number): string | null {
  if (!Number.isSafeInteger(timestamp)) return null;
  try {
    return new Date(timestamp * 1000).toISOString();
  } catch {
    return null;
  }
}

function isBinary(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 8 * 1024));
  if (sample.includes(0)) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return false;
  } catch {
    return true;
  }
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 16 * 1024;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    for (const byte of chunk) binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

async function repositoryInfo(
  request: Request,
  env: ForgeApiEnv,
  repo: string,
): Promise<Response> {
  if (!(await repoExists(env.BUCKET, repo))) {
    return json({ error: "repository_not_found" }, 404);
  }
  const refs = await readRepoRefs(env.BUCKET, repo);
  const branches = branchRecords(refs);
  return json({
    repository: {
      name: repo,
      cloneUrl: repositoryCloneUrl(request, env, repo),
      defaultBranch: refs.defaultBranch,
      branchCount: branches.length,
      tagCount: refs.refs.filter((ref) => ref.name.startsWith("refs/tags/"))
        .length,
    },
  });
}

async function repositoryBranches(
  env: ForgeApiEnv,
  repo: string,
): Promise<Response> {
  if (!(await repoExists(env.BUCKET, repo))) {
    return json({ error: "repository_not_found" }, 404);
  }
  const refs = await readRepoRefs(env.BUCKET, repo);
  return json({ repository: repo, branches: branchRecords(refs) });
}

// Upper bound on commits examined when filtering history by path, so a file
// that changed rarely deep in a long history cannot fan out an unbounded walk.
const MAX_HISTORY_WALK = 2000;

async function repositoryCommits(
  url: URL,
  env: ForgeApiEnv,
  repo: string,
): Promise<Response> {
  if (!(await repoExists(env.BUCKET, repo))) {
    return json({ error: "repository_not_found" }, 404);
  }
  const refs = await readRepoRefs(env.BUCKET, repo);
  const branch = resolveBranch(refs, url.searchParams.get("ref"));
  if (!branch) return json({ error: "branch_not_found" }, 404);
  const requestedLimit = Number.parseInt(
    url.searchParams.get("limit") ?? "",
    10,
  );
  const limit = Number.isSafeInteger(requestedLimit)
    ? Math.max(1, Math.min(requestedLimit, MAX_COMMITS))
    : DEFAULT_COMMITS;

  const pathParam =
    url.searchParams
      .get("path")
      ?.trim()
      .replace(/^\/+|\/+$/gu, "") ?? "";
  if (pathParam && !isValidGitPath(pathParam)) {
    return json({ error: "invalid_path" }, 400);
  }

  const objects = repositoryObjectStore(env.BUCKET, repo);

  try {
    if (pathParam) {
      return await fileHistory(objects, repo, branch, pathParam, limit);
    }
    const commits: Array<Record<string, unknown>> = [];
    const visited = new Set<string>();
    let cursor: string | undefined = branch.sha;
    while (cursor && commits.length < limit && !visited.has(cursor)) {
      visited.add(cursor);
      const commit = await getCommitData(objects, cursor, MAX_COMMIT_BYTES);
      if (!commit) break;
      commits.push(shapeCommit(commit));
      cursor = commit.parents[0];
    }
    return json({ repository: repo, branch: branch.name, commits });
  } catch (error) {
    if (error instanceof GitObjectTooLargeError) {
      return json({ error: "commit_too_large", maxBytes: MAX_COMMIT_BYTES }, 413);
    }
    throw error;
  }
}

async function fileHistory(
  objects: ObjectStoreBinding,
  repo: string,
  branch: { name: string; sha: string },
  path: string,
  limit: number,
): Promise<Response> {
  const commits: Array<Record<string, unknown>> = [];
  let cursor: GitCommit | null = await getCommitData(
    objects,
    branch.sha,
    MAX_COMMIT_BYTES,
  );
  let cursorOid = cursor ? await blobOidAtPath(objects, cursor.tree, path) : null;
  let walked = 0;
  let truncated = false;

  while (cursor && commits.length < limit) {
    if (walked++ >= MAX_HISTORY_WALK) {
      truncated = true;
      break;
    }
    const parentSha: string | null = cursor.parents[0] || null;
    const parentCommit: GitCommit | null = parentSha
      ? await getCommitData(objects, parentSha, MAX_COMMIT_BYTES)
      : null;
    const parentOid = parentCommit
      ? await blobOidAtPath(objects, parentCommit.tree, path)
      : null;

    if (cursorOid !== parentOid) {
      commits.push({
        ...shapeCommit(cursor),
        pathStatus:
          parentOid === null
            ? "added"
            : cursorOid === null
              ? "deleted"
              : "modified",
      });
    }

    if (!parentCommit || parentOid === null) break;
    cursor = parentCommit;
    cursorOid = parentOid;
  }

  return json({
    repository: repo,
    branch: branch.name,
    path,
    commits,
    truncated,
  });
}

async function repositoryTree(
  url: URL,
  env: ForgeApiEnv,
  repo: string,
): Promise<Response> {
  if (!(await repoExists(env.BUCKET, repo))) {
    return json({ error: "repository_not_found" }, 404);
  }
  const refs = await readRepoRefs(env.BUCKET, repo);
  const branch = resolveBranch(refs, url.searchParams.get("ref"));
  if (!branch) return json({ error: "branch_not_found" }, 404);
  const path =
    url.searchParams
      .get("path")
      ?.trim()
      .replace(/^\/+|\/+$/gu, "") ?? "";
  if (path && !isValidGitPath(path)) {
    return json({ error: "invalid_path" }, 400);
  }
  const objects = repositoryObjectStore(env.BUCKET, repo);
  let commit;
  try {
    commit = await getCommitData(objects, branch.sha, MAX_COMMIT_BYTES);
  } catch (error) {
    if (error instanceof GitObjectTooLargeError) {
      return json(
        { error: "commit_too_large", maxBytes: MAX_COMMIT_BYTES },
        413,
      );
    }
    throw error;
  }
  if (!commit) return json({ error: "commit_not_found" }, 409);
  let entries;
  try {
    entries = await listDirectory(objects, commit.tree, path, {
      maxTreeBytes: MAX_TREE_BYTES,
    });
  } catch (error) {
    if (error instanceof GitObjectTooLargeError) {
      return json({ error: "tree_too_large", maxBytes: MAX_TREE_BYTES }, 413);
    }
    throw error;
  }
  if (!entries) return json({ error: "path_not_found" }, 404);
  if (entries.length > MAX_DIRECTORY_ENTRIES) {
    return json(
      { error: "directory_too_large", maxEntries: MAX_DIRECTORY_ENTRIES },
      413,
    );
  }
  return json({
    repository: repo,
    branch: branch.name,
    commit: commit.sha,
    path,
    entries: entries
      .map((entry) => ({
        name: entry.name,
        path: path ? `${path}/${entry.name}` : entry.name,
        sha: entry.sha,
        mode: entry.mode,
        kind:
          entry.mode === "040000" || entry.mode === "40000"
            ? "tree"
            : entry.mode === "160000"
              ? "gitlink"
              : "blob",
      }))
      .sort((left, right) => {
        if (left.kind !== right.kind) {
          if (left.kind === "tree") return -1;
          if (right.kind === "tree") return 1;
        }
        return left.name.localeCompare(right.name);
      }),
  });
}

async function repositoryBlob(
  url: URL,
  env: ForgeApiEnv,
  repo: string,
): Promise<Response> {
  if (!(await repoExists(env.BUCKET, repo))) {
    return json({ error: "repository_not_found" }, 404);
  }
  const path =
    url.searchParams
      .get("path")
      ?.trim()
      .replace(/^\/+|\/+$/gu, "") ?? "";
  if (!path || !isValidGitPath(path)) {
    return json({ error: "invalid_path" }, 400);
  }
  const refs = await readRepoRefs(env.BUCKET, repo);
  const branch = resolveBranch(refs, url.searchParams.get("ref"));
  if (!branch) return json({ error: "branch_not_found" }, 404);
  const objects = repositoryObjectStore(env.BUCKET, repo);
  let commit;
  try {
    commit = await getCommitData(objects, branch.sha, MAX_COMMIT_BYTES);
  } catch (error) {
    if (error instanceof GitObjectTooLargeError) {
      return json(
        { error: "commit_too_large", maxBytes: MAX_COMMIT_BYTES },
        413,
      );
    }
    throw error;
  }
  if (!commit) return json({ error: "commit_not_found" }, 409);
  let entries;
  try {
    entries = await listDirectory(
      objects,
      commit.tree,
      path.split("/").slice(0, -1).join("/"),
      { maxTreeBytes: MAX_TREE_BYTES },
    );
  } catch (error) {
    if (error instanceof GitObjectTooLargeError) {
      return json({ error: "tree_too_large", maxBytes: MAX_TREE_BYTES }, 413);
    }
    throw error;
  }
  const name = path.split("/").at(-1) as string;
  const entry = entries?.find((candidate) => candidate.name === name);
  if (
    !entry ||
    entry.mode === "040000" ||
    entry.mode === "40000" ||
    entry.mode === "160000" ||
    entry.mode === "120000"
  ) {
    return json({ error: "file_not_found" }, 404);
  }
  let bytes: Uint8Array | null;
  try {
    bytes = await getBlob(objects, entry.sha, MAX_BLOB_BYTES);
  } catch (error) {
    if (error instanceof GitObjectTooLargeError) {
      return json({ error: "blob_too_large", maxBytes: MAX_BLOB_BYTES }, 413);
    }
    throw error;
  }
  if (!bytes) return json({ error: "blob_not_found" }, 409);
  const binary = isBinary(bytes);
  return json({
    repository: repo,
    branch: branch.name,
    commit: commit.sha,
    path,
    sha: entry.sha,
    size: bytes.byteLength,
    encoding: binary ? "base64" : "utf-8",
    content: binary ? base64(bytes) : new TextDecoder().decode(bytes),
  });
}

async function repositoryCommitDetail(
  env: ForgeApiEnv,
  repo: string,
  sha: string,
): Promise<Response> {
  if (!isValidSha(sha)) return json({ error: "invalid_object_id" }, 400);
  if (!(await repoExists(env.BUCKET, repo))) {
    return json({ error: "repository_not_found" }, 404);
  }
  const refs = await readRepoRefs(env.BUCKET, repo);
  const objects = repositoryObjectStore(env.BUCKET, repo);

  // Only commits reachable from an advertised ref are viewable — a rejected
  // push's dangling object stays unbrowsable (M1 invariant).
  try {
    const reachable = await commitReachableFromTips(
      objects,
      commitTips(refs),
      sha,
    );
    if (!reachable) return json({ error: "commit_not_found" }, 404);
  } catch (error) {
    const overflow = graphOverflowResponse(error);
    if (overflow) return overflow;
    throw error;
  }

  try {
    const commit = await getCommitData(objects, sha, MAX_COMMIT_BYTES);
    if (!commit) return json({ error: "commit_not_found" }, 404);
    const parentSha = commit.parents[0] ?? null;
    const parent = parentSha
      ? await getCommitData(objects, parentSha, MAX_COMMIT_BYTES)
      : null;
    const diff = await buildDiffPayload(
      objects,
      parent ? parent.tree : null,
      commit.tree,
      { includeHunks: true, maxFileBytes: MAX_BLOB_BYTES },
    );
    return json({
      repository: repo,
      commit: shapeCommit(commit),
      diff: { base: parentSha, ...diff },
    });
  } catch (error) {
    if (error instanceof GitObjectTooLargeError) {
      return json({ error: "commit_too_large", maxBytes: MAX_COMMIT_BYTES }, 413);
    }
    throw error;
  }
}

async function repositoryCompare(
  env: ForgeApiEnv,
  repo: string,
  baseRef: string,
  headRef: string,
): Promise<Response> {
  if (!(await repoExists(env.BUCKET, repo))) {
    return json({ error: "repository_not_found" }, 404);
  }
  const refs = await readRepoRefs(env.BUCKET, repo);
  const base = resolveRefToCommit(refs, baseRef);
  const head = resolveRefToCommit(refs, headRef);
  if (!base || !head) return json({ error: "ref_not_found" }, 404);

  const objects = repositoryObjectStore(env.BUCKET, repo);
  try {
    const { ahead, behind, hasMergeBase, mergeBaseSha } =
      await countCommitsBetween(objects, base.sha, head.sha);

    const headCommit = await getCommitData(objects, head.sha, MAX_COMMIT_BYTES);
    if (!headCommit) return json({ error: "commit_not_found" }, 404);

    // Three-dot semantics: diff from the merge base to head.
    const diffBaseSha = mergeBaseSha ?? base.sha;
    const diffBaseCommit = await getCommitData(
      objects,
      diffBaseSha,
      MAX_COMMIT_BYTES,
    );
    const diff = await buildDiffPayload(
      objects,
      diffBaseCommit ? diffBaseCommit.tree : null,
      headCommit.tree,
      { includeHunks: true, maxFileBytes: MAX_BLOB_BYTES },
    );

    // Commits unique to head (merge-base..head), bounded.
    const commits: Array<Record<string, unknown>> = [];
    const visited = new Set<string>();
    let cursor: string | undefined = head.sha;
    while (
      cursor &&
      cursor !== mergeBaseSha &&
      commits.length < MAX_COMMITS &&
      !visited.has(cursor)
    ) {
      visited.add(cursor);
      const commit = await getCommitData(objects, cursor, MAX_COMMIT_BYTES);
      if (!commit) break;
      commits.push(shapeCommit(commit));
      cursor = commit.parents[0];
    }

    const status =
      ahead === 0 && behind === 0
        ? "identical"
        : ahead > 0 && behind === 0
          ? "ahead"
          : ahead === 0 && behind > 0
            ? "behind"
            : "diverged";

    return json({
      repository: repo,
      base: base.name,
      head: head.name,
      baseSha: base.sha,
      headSha: head.sha,
      mergeBaseSha,
      hasMergeBase,
      aheadBy: ahead,
      behindBy: behind,
      status,
      commits,
      ...diff,
    });
  } catch (error) {
    const overflow = graphOverflowResponse(error);
    if (overflow) return overflow;
    if (error instanceof GitObjectTooLargeError) {
      return json({ error: "commit_too_large", maxBytes: MAX_COMMIT_BYTES }, 413);
    }
    throw error;
  }
}

async function repositoryBlame(
  url: URL,
  env: ForgeApiEnv,
  repo: string,
): Promise<Response> {
  const path =
    url.searchParams
      .get("path")
      ?.trim()
      .replace(/^\/+|\/+$/gu, "") ?? "";
  if (!path || !isValidGitPath(path)) {
    return json({ error: "invalid_path" }, 400);
  }
  if (!(await repoExists(env.BUCKET, repo))) {
    return json({ error: "repository_not_found" }, 404);
  }
  const refs = await readRepoRefs(env.BUCKET, repo);
  const resolved = resolveRefToCommit(refs, url.searchParams.get("ref"));
  if (!resolved) return json({ error: "ref_not_found" }, 404);

  const objects = repositoryObjectStore(env.BUCKET, repo);
  const result = await blameFile(objects, resolved.sha, path, {
    maxFileBytes: MAX_BLOB_BYTES,
  });
  if (!result.ok) {
    switch (result.reason) {
      case "file_not_found":
      case "commit_not_found":
        return json({ error: "file_not_found" }, 404);
      case "too_large":
        return json({ error: "blob_too_large", maxBytes: MAX_BLOB_BYTES }, 413);
      case "binary":
        return json({ error: "blame_unavailable_binary" }, 422);
    }
  }
  return json({
    repository: repo,
    ref: resolved.name,
    path,
    resolvedCommitSha: result.resolvedCommitSha,
    truncated: result.truncated,
    lines: result.lines,
  });
}

export async function handleForgeApi(
  request: Request,
  env: ForgeApiEnv,
  interfaceUserInfoFetch?: OAuthFetch,
): Promise<Response | null> {
  const authResponse = await handleBrowserAuth(
    request,
    env,
    interfaceUserInfoFetch ?? fetch,
  );
  if (authResponse) return authResponse;

  const url = new URL(request.url);
  if (url.pathname !== "/api/v1" && !url.pathname.startsWith("/api/v1/")) {
    return null;
  }
  if (request.method !== "GET") {
    return json({ error: "method_not_allowed" }, 405, { allow: "GET" });
  }
  const identity = await authorizeRead(request, env, interfaceUserInfoFetch);
  if (identity instanceof Response) return identity;

  if (url.pathname === "/api/v1/repos") {
    const requestedLimit = Number.parseInt(
      url.searchParams.get("limit") ?? "",
      10,
    );
    const limit = Number.isSafeInteger(requestedLimit)
      ? Math.max(1, Math.min(requestedLimit, 100))
      : 100;
    const page = await listRepos(env.BUCKET, {
      ...(url.searchParams.get("cursor")
        ? { cursor: url.searchParams.get("cursor") as string }
        : {}),
      limit,
    });
    return json({
      repositories: page.repos.map((repo) => ({
        name: repo,
        cloneUrl: repositoryCloneUrl(request, env, repo),
      })),
      nextCursor: page.cursor,
    });
  }

  const route = parseRepoRoute(url.pathname);
  if (!route) return json({ error: "not_found" }, 404);
  switch (route.action) {
    case "info":
      return repositoryInfo(request, env, route.repo);
    case "branches":
      return repositoryBranches(env, route.repo);
    case "commits":
      return repositoryCommits(url, env, route.repo);
    case "commit-detail":
      return repositoryCommitDetail(env, route.repo, route.sha);
    case "compare":
      return repositoryCompare(env, route.repo, route.base, route.head);
    case "blame":
      return repositoryBlame(url, env, route.repo);
    case "tree":
      return repositoryTree(url, env, route.repo);
    case "blob":
      return repositoryBlob(url, env, route.repo);
  }
}

export { HOSTING_READ_PERMISSION };
