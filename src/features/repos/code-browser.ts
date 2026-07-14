/**
 * Code-browser READ handlers (info / branches / commits / tree / blob /
 * commit-detail / compare / blame / file-history) on the router + ACL.
 *
 * The git-read logic is the same R2-backed engine the M1/M2 forge API used
 * (`src/git/*`); what changes here is that every read runs through
 * `requireRepoAccess(contents.read)` — so anonymous reads succeed on PUBLIC repos,
 * private repos return 404 (existence non-disclosure), and Interface
 * `source.git.hosting.read` tokens map onto `contents.read` per repo — and every
 * error uses the standard `{ error: { code, message } }` envelope.
 */

import {
  SCOPES,
  parsePagination,
  type RepositoryDto,
} from "../../contract/v1.ts";
import type { RouteContext } from "../../router.ts";
import type { Route } from "../../router.ts";
import {
  getBlob,
  getCommitData,
  GitObjectTooLargeError,
} from "../../git/object-store.ts";
import { repositoryObjectStore } from "../../git/repo-object-store.ts";
import { readRepoRefs, type RefsDoc } from "../../git/refs-store.ts";
import {
  getEntryAtPath,
  isValidGitPath,
  listDirectory,
} from "../../git/tree-ops.ts";
import { isValidSha } from "../../git/git-objects.ts";
import type { GitCommit } from "../../git/git-objects.ts";
import {
  commitReachableFromTips,
  countCommitsBetween,
} from "../../git/merge-base.ts";
import { buildDiffPayload } from "../../git/commit-diff.ts";
import { blameFile } from "../../git/blame.ts";
import type { ObjectStoreBinding } from "../../git/types.ts";
import { json, errorResponse } from "./http.ts";
import { requireRepoAccess, resolveIdentity, type RepoAccess } from "./identity.ts";
import {
  cloneUrlFor,
  getRepoRow,
  listReadableRepos,
  repoRefCounts,
  toRepositoryDto,
} from "./repositories.ts";

const MAX_COMMITS = 100;
const DEFAULT_COMMITS = 30;
const MAX_BLOB_BYTES = 1024 * 1024;
const MAX_COMMIT_BYTES = 256 * 1024;
const MAX_TREE_BYTES = 4 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 10_000;
const MAX_HISTORY_WALK = 2000;
const GRAPH_TOO_LARGE = "commit graph too large";

function originBase(ctx: RouteContext): string {
  return ctx.env.APP_URL?.trim() || ctx.url.origin;
}

/** The canonical R2 storage key for a resolved repo (`<owner>/<name>`). */
function repoKey(access: RepoAccess): string {
  return `${access.repo.ownerLogin}/${access.repo.name}`;
}

function graphOverflowResponse(error: unknown): Response | null {
  if (error instanceof Error && error.message === GRAPH_TOO_LARGE) {
    return errorResponse(413, "commit_graph_too_large", "Commit graph too large.");
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

function commitTips(refs: RefsDoc): string[] {
  return refs.refs.map((ref) => ref.sha);
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

// --- read handlers ---------------------------------------------------------

function read(
  handler: (ctx: RouteContext, access: RepoAccess) => Promise<Response>,
): Route["handler"] {
  return async (ctx) => {
    const access = await requireRepoAccess(ctx, "contents.read", SCOPES.hostingRead);
    if (access instanceof Response) return access;
    return handler(ctx, access);
  };
}

async function handleInfo(ctx: RouteContext, access: RepoAccess): Promise<Response> {
  const row = await getRepoRow(ctx.db!, access.repo.ownerLogin, access.repo.name);
  if (!row) return errorResponse(404, "not_found", "Not Found");
  const counts = await repoRefCounts(ctx.env.BUCKET, row.storageKey);
  const dto: RepositoryDto = toRepositoryDto(row, originBase(ctx));
  return json({ repository: { ...dto, ...counts } });
}

async function handleBranches(ctx: RouteContext, access: RepoAccess): Promise<Response> {
  const refs = await readRepoRefs(ctx.env.BUCKET, repoKey(access));
  return json({ repository: repoKey(access), branches: branchRecords(refs) });
}

async function handleCommits(ctx: RouteContext, access: RepoAccess): Promise<Response> {
  const repo = repoKey(access);
  const refs = await readRepoRefs(ctx.env.BUCKET, repo);
  const branch = resolveBranch(refs, ctx.url.searchParams.get("ref"));
  if (!branch) return errorResponse(404, "branch_not_found", "Branch not found.");
  const requestedLimit = Number.parseInt(ctx.url.searchParams.get("limit") ?? "", 10);
  const limit = Number.isSafeInteger(requestedLimit)
    ? Math.max(1, Math.min(requestedLimit, MAX_COMMITS))
    : DEFAULT_COMMITS;
  const pathParam =
    ctx.url.searchParams.get("path")?.trim().replace(/^\/+|\/+$/gu, "") ?? "";
  if (pathParam && !isValidGitPath(pathParam)) {
    return errorResponse(400, "invalid_path", "Invalid path.");
  }
  const objects = repositoryObjectStore(ctx.env.BUCKET, repo);
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
      return errorResponse(413, "commit_too_large", "Commit object too large.", {
        maxBytes: MAX_COMMIT_BYTES,
      });
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
  let cursor: GitCommit | null = await getCommitData(objects, branch.sha, MAX_COMMIT_BYTES);
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
          parentOid === null ? "added" : cursorOid === null ? "deleted" : "modified",
      });
    }
    if (!parentCommit || parentOid === null) break;
    cursor = parentCommit;
    cursorOid = parentOid;
  }
  return json({ repository: repo, branch: branch.name, path, commits, truncated });
}

async function handleTree(ctx: RouteContext, access: RepoAccess): Promise<Response> {
  const repo = repoKey(access);
  const refs = await readRepoRefs(ctx.env.BUCKET, repo);
  const branch = resolveBranch(refs, ctx.url.searchParams.get("ref"));
  if (!branch) return errorResponse(404, "branch_not_found", "Branch not found.");
  const path =
    ctx.url.searchParams.get("path")?.trim().replace(/^\/+|\/+$/gu, "") ?? "";
  if (path && !isValidGitPath(path)) {
    return errorResponse(400, "invalid_path", "Invalid path.");
  }
  const objects = repositoryObjectStore(ctx.env.BUCKET, repo);
  let commit;
  try {
    commit = await getCommitData(objects, branch.sha, MAX_COMMIT_BYTES);
  } catch (error) {
    if (error instanceof GitObjectTooLargeError) {
      return errorResponse(413, "commit_too_large", "Commit object too large.", {
        maxBytes: MAX_COMMIT_BYTES,
      });
    }
    throw error;
  }
  if (!commit) return errorResponse(409, "commit_not_found", "Commit not found.");
  let entries;
  try {
    entries = await listDirectory(objects, commit.tree, path, {
      maxTreeBytes: MAX_TREE_BYTES,
    });
  } catch (error) {
    if (error instanceof GitObjectTooLargeError) {
      return errorResponse(413, "tree_too_large", "Tree too large.", {
        maxBytes: MAX_TREE_BYTES,
      });
    }
    throw error;
  }
  if (!entries) return errorResponse(404, "path_not_found", "Path not found.");
  if (entries.length > MAX_DIRECTORY_ENTRIES) {
    return errorResponse(413, "directory_too_large", "Directory too large.", {
      maxEntries: MAX_DIRECTORY_ENTRIES,
    });
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

async function handleBlob(ctx: RouteContext, access: RepoAccess): Promise<Response> {
  const repo = repoKey(access);
  const path =
    ctx.url.searchParams.get("path")?.trim().replace(/^\/+|\/+$/gu, "") ?? "";
  if (!path || !isValidGitPath(path)) {
    return errorResponse(400, "invalid_path", "Invalid path.");
  }
  const refs = await readRepoRefs(ctx.env.BUCKET, repo);
  const branch = resolveBranch(refs, ctx.url.searchParams.get("ref"));
  if (!branch) return errorResponse(404, "branch_not_found", "Branch not found.");
  const objects = repositoryObjectStore(ctx.env.BUCKET, repo);
  let commit;
  try {
    commit = await getCommitData(objects, branch.sha, MAX_COMMIT_BYTES);
  } catch (error) {
    if (error instanceof GitObjectTooLargeError) {
      return errorResponse(413, "commit_too_large", "Commit object too large.", {
        maxBytes: MAX_COMMIT_BYTES,
      });
    }
    throw error;
  }
  if (!commit) return errorResponse(409, "commit_not_found", "Commit not found.");
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
      return errorResponse(413, "tree_too_large", "Tree too large.", {
        maxBytes: MAX_TREE_BYTES,
      });
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
    return errorResponse(404, "file_not_found", "File not found.");
  }
  let bytes: Uint8Array | null;
  try {
    bytes = await getBlob(objects, entry.sha, MAX_BLOB_BYTES);
  } catch (error) {
    if (error instanceof GitObjectTooLargeError) {
      return errorResponse(413, "blob_too_large", "Blob too large.", {
        maxBytes: MAX_BLOB_BYTES,
      });
    }
    throw error;
  }
  if (!bytes) return errorResponse(409, "blob_not_found", "Blob not found.");
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

async function handleCommitDetail(
  ctx: RouteContext,
  access: RepoAccess,
): Promise<Response> {
  const repo = repoKey(access);
  const sha = ctx.params.sha;
  if (!isValidSha(sha)) return errorResponse(400, "invalid_object_id", "Invalid object id.");
  const refs = await readRepoRefs(ctx.env.BUCKET, repo);
  const objects = repositoryObjectStore(ctx.env.BUCKET, repo);
  try {
    const reachable = await commitReachableFromTips(objects, commitTips(refs), sha);
    if (!reachable) return errorResponse(404, "commit_not_found", "Commit not found.");
  } catch (error) {
    const overflow = graphOverflowResponse(error);
    if (overflow) return overflow;
    throw error;
  }
  try {
    const commit = await getCommitData(objects, sha, MAX_COMMIT_BYTES);
    if (!commit) return errorResponse(404, "commit_not_found", "Commit not found.");
    const parentSha = commit.parents[0] ?? null;
    const parent = parentSha
      ? await getCommitData(objects, parentSha, MAX_COMMIT_BYTES)
      : null;
    const diff = await buildDiffPayload(objects, parent ? parent.tree : null, commit.tree, {
      includeHunks: true,
      maxFileBytes: MAX_BLOB_BYTES,
    });
    return json({
      repository: repo,
      commit: shapeCommit(commit),
      diff: { base: parentSha, ...diff },
    });
  } catch (error) {
    if (error instanceof GitObjectTooLargeError) {
      return errorResponse(413, "commit_too_large", "Commit object too large.", {
        maxBytes: MAX_COMMIT_BYTES,
      });
    }
    throw error;
  }
}

async function handleCompare(ctx: RouteContext, access: RepoAccess): Promise<Response> {
  const repo = repoKey(access);
  const spec = ctx.params.spec ?? "";
  const idx = spec.indexOf("...");
  if (idx === -1) return errorResponse(400, "invalid_compare_spec", "Expected base...head.");
  const baseRef = spec.slice(0, idx);
  const headRef = spec.slice(idx + 3);
  if (!baseRef || !headRef) {
    return errorResponse(400, "invalid_compare_spec", "Expected base...head.");
  }
  const refs = await readRepoRefs(ctx.env.BUCKET, repo);
  const base = resolveRefToCommit(refs, baseRef);
  const head = resolveRefToCommit(refs, headRef);
  if (!base || !head) return errorResponse(404, "ref_not_found", "Ref not found.");
  const objects = repositoryObjectStore(ctx.env.BUCKET, repo);
  try {
    const { ahead, behind, hasMergeBase, mergeBaseSha } = await countCommitsBetween(
      objects,
      base.sha,
      head.sha,
    );
    const headCommit = await getCommitData(objects, head.sha, MAX_COMMIT_BYTES);
    if (!headCommit) return errorResponse(404, "commit_not_found", "Commit not found.");
    const diffBaseSha = mergeBaseSha ?? base.sha;
    const diffBaseCommit = await getCommitData(objects, diffBaseSha, MAX_COMMIT_BYTES);
    const diff = await buildDiffPayload(
      objects,
      diffBaseCommit ? diffBaseCommit.tree : null,
      headCommit.tree,
      { includeHunks: true, maxFileBytes: MAX_BLOB_BYTES },
    );
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
      return errorResponse(413, "commit_too_large", "Commit object too large.", {
        maxBytes: MAX_COMMIT_BYTES,
      });
    }
    throw error;
  }
}

async function handleBlame(ctx: RouteContext, access: RepoAccess): Promise<Response> {
  const repo = repoKey(access);
  const path =
    ctx.url.searchParams.get("path")?.trim().replace(/^\/+|\/+$/gu, "") ?? "";
  if (!path || !isValidGitPath(path)) {
    return errorResponse(400, "invalid_path", "Invalid path.");
  }
  const refs = await readRepoRefs(ctx.env.BUCKET, repo);
  const resolved = resolveRefToCommit(refs, ctx.url.searchParams.get("ref"));
  if (!resolved) return errorResponse(404, "ref_not_found", "Ref not found.");
  const objects = repositoryObjectStore(ctx.env.BUCKET, repo);
  const result = await blameFile(objects, resolved.sha, path, {
    maxFileBytes: MAX_BLOB_BYTES,
  });
  if (!result.ok) {
    switch (result.reason) {
      case "file_not_found":
      case "commit_not_found":
        return errorResponse(404, "file_not_found", "File not found.");
      case "too_large":
        return errorResponse(413, "blob_too_large", "Blob too large.", {
          maxBytes: MAX_BLOB_BYTES,
        });
      case "binary":
        return errorResponse(422, "blame_unavailable_binary", "Blame unavailable for binary.");
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

/** `GET /api/v1/repos` — repos the caller can read (anonymous ⇒ public only). */
export const listReposHandler: Route["handler"] = async (ctx) => {
  const identity = await resolveIdentity(ctx, SCOPES.hostingRead);
  if (identity instanceof Response) return identity;
  const { limit, cursor } = parsePagination(ctx.url);
  const page = await listReadableRepos(ctx.db!, identity.principal, { limit, cursor });
  const base = originBase(ctx);
  return json({
    repositories: page.repos.map((repo) => toRepositoryDto(repo, base)),
    nextCursor: page.nextCursor,
  });
};

export const codeBrowserHandlers = {
  info: read(handleInfo),
  branches: read(handleBranches),
  commits: read(handleCommits),
  tree: read(handleTree),
  blob: read(handleBlob),
  commitDetail: read(handleCommitDetail),
  compare: read(handleCompare),
  blame: read(handleBlame),
} as const;

export { cloneUrlFor };
