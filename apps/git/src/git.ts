import { DatabaseSync } from "node:sqlite";
import type {
  GitCreatePullRequestCommentRequest,
  GitCreatePullRequestRequest,
  GitCreatePullRequestReviewRequest,
  GitPullRequestComment,
  GitPullRequestDetail,
  GitPullRequestReview,
  GitPullRequestStatus,
  GitRefSummary,
  GitUpdatePullRequestRequest,
} from "takos-git-contract";
import type { TakosActorContext } from "takos-paas-contract/internal-rpc";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();
const INITIAL_COMMIT_ENV = {
  GIT_AUTHOR_NAME: "Takos Git",
  GIT_AUTHOR_EMAIL: "git@takos.local",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "Takos Git",
  GIT_COMMITTER_EMAIL: "git@takos.local",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
};
let cachedDatabase:
  | { path: string; database: DatabaseSync; migratedJsonPath?: string }
  | undefined;

const SQLITE_MIGRATIONS: Array<{ version: number; sql: string }> = [{
  version: 1,
  sql: `
    CREATE TABLE IF NOT EXISTS repositories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner_account_id TEXT NOT NULL,
      default_branch TEXT NOT NULL,
      refs_json TEXT NOT NULL DEFAULT '[]',
      state TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pull_requests (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL REFERENCES repositories(id),
      number INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      head_branch TEXT NOT NULL,
      base_branch TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      author_type TEXT NOT NULL DEFAULT 'user',
      author_id TEXT,
      run_id TEXT,
      merged_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(repository_id, number)
    );
    CREATE TABLE IF NOT EXISTS pr_comments (
      id TEXT PRIMARY KEY,
      pull_request_id TEXT NOT NULL REFERENCES pull_requests(id),
      author_type TEXT NOT NULL DEFAULT 'user',
      author_id TEXT,
      body TEXT NOT NULL,
      path TEXT,
      line INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pr_reviews (
      id TEXT PRIMARY KEY,
      pull_request_id TEXT NOT NULL REFERENCES pull_requests(id),
      reviewer_type TEXT NOT NULL DEFAULT 'user',
      reviewer_id TEXT,
      status TEXT NOT NULL,
      body TEXT,
      analysis TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS repository_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repository_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pull_requests_repository_status
      ON pull_requests(repository_id, status, number);
    CREATE INDEX IF NOT EXISTS idx_pr_comments_pull_request
      ON pr_comments(pull_request_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_pr_reviews_pull_request
      ON pr_reviews(pull_request_id, created_at);
  `,
}];

export type GitJsonError = {
  body: {
    error: string;
    code: string;
    repositoryId?: string;
    objectId?: string;
    pullRequestNumber?: number;
  };
  status: 400 | 404 | 409 | 422 | 501;
};

export interface GitRepositoryMetadataRecord {
  id: string;
  name: string;
  ownerSpaceId: string;
  /** @deprecated migrated legacy metadata may still carry this name */
  ownerAccountId?: string;
  defaultBranch: string;
  refs: GitRefSummary[];
  state?: "active" | "deleted" | "initializing" | "failed";
  createdAt: string;
  updatedAt: string;
}

export function isLiteralObjectId(value: string): boolean {
  return /^[0-9a-fA-F]{40}$/.test(value) ||
    /^[0-9a-fA-F]{64}$/.test(value);
}

export function configuredRepositoryPath(
  repositoryId: string,
): string | undefined {
  const root = configuredRepositoryRoot();
  if (!root) return undefined;
  const relative = repositoryId.endsWith(".git")
    ? repositoryId
    : `${repositoryId}.git`;
  return `${root}/${relative}`;
}

export function configuredMetadataPath(): string | undefined {
  const root = configuredRepositoryRoot();
  if (!root) return undefined;
  return `${root}/.takos/repositories.json`;
}

export function configuredDatabasePath(): string | undefined {
  const configured = Deno.env.get("TAKOS_GIT_DATABASE_URL")?.trim();
  if (configured) {
    const prefix = "sqlite://";
    if (!configured.startsWith(prefix)) {
      throw new Error(
        "TAKOS_GIT_DATABASE_URL must use sqlite:// for takos-git Production v1",
      );
    }
    return configured.slice(prefix.length);
  }
  const root = configuredRepositoryRoot();
  if (!root) return undefined;
  return `${root}/.takos/git.sqlite`;
}

export function configuredRepositoryRoot(): string | undefined {
  const root = Deno.env.get("TAKOS_GIT_REPOSITORY_ROOT")?.trim();
  if (!root) return undefined;
  return root.replace(/\/+$/, "") || "/";
}

export function devInMemoryMetadataEnabled(): boolean {
  return Deno.env.get("TAKOS_GIT_DEV_IN_MEMORY_METADATA") === "true";
}

export function configuredStorageReady(): boolean {
  return devInMemoryMetadataEnabled() || !!configuredRepositoryRoot();
}

export function isSafeRepositoryId(repositoryId: string): boolean {
  return repositoryId.length > 0 &&
    !repositoryId.startsWith("/") &&
    repositoryId.split("/").every(isSafePathSegment);
}

export function isSafeSmartHttpPath(pathname: string): boolean {
  if (!pathname.startsWith("/") || !pathname.includes(".git")) return false;
  return pathname.slice(1).split("/").every(isSafePathSegment);
}

export function isSafeRefInput(ref: string): boolean {
  return ref.length > 0 &&
    !ref.includes("\0") &&
    !ref.includes("..") &&
    !ref.includes("@{") &&
    !ref.includes("\\") &&
    !ref.startsWith("/") &&
    !ref.endsWith("/") &&
    /^[A-Za-z0-9._/-]+$/.test(ref);
}

export async function readConfiguredGitRefs(
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
  const active = await configuredRepositoryIsActive(repositoryId);
  if (active === false) {
    return {
      ok: false,
      status: 404,
      body: repositoryNotFound(repositoryId),
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

export async function createConfiguredBareRepository(
  repositoryId: string,
  options: { defaultBranch?: string; mode?: "default" | "bare" } = {},
): Promise<
  | { ok: true; repositoryPath: string }
  | ({ ok: false } & GitJsonError)
  | {
    ok: false;
    status: 409 | 500;
    body: { error: string; code: string; repositoryId: string };
  }
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
  if (await exists(repositoryPath)) {
    return {
      ok: false,
      status: 409,
      body: {
        error: "repository already exists",
        code: "git_repository_already_exists",
        repositoryId,
      },
    };
  }

  await Deno.mkdir(parentDirectory(repositoryPath), { recursive: true });
  const output = await runGit(["init", "--bare", repositoryPath]);
  if (!output.success) {
    return {
      ok: false,
      status: 500,
      body: {
        error: "failed to initialize bare repository",
        code: "git_repository_init_failed",
        repositoryId,
      },
    };
  }
  if (options.mode !== "bare") {
    const initialized = await initializeDefaultBranch(
      repositoryPath,
      options.defaultBranch ?? "main",
    );
    if (!initialized.ok) {
      await removeDirectoryIfExists(repositoryPath);
      return {
        ok: false,
        status: 500,
        body: {
          error: initialized.error,
          code: "git_repository_init_failed",
          repositoryId,
        },
      };
    }
  }
  return { ok: true, repositoryPath };
}

export async function readConfiguredRepositoryMetadata(): Promise<
  GitRepositoryMetadataRecord[] | undefined
> {
  const database = await configuredDatabase();
  if (database) {
    return readDatabaseRepositoryMetadata(database).filter((repository) =>
      repository.state === "active"
    );
  }

  const metadataPath = configuredMetadataPath();
  if (!metadataPath) return undefined;
  try {
    const parsed = JSON.parse(await Deno.readTextFile(metadataPath));
    if (!Array.isArray(parsed.repositories)) return [];
    return parsed.repositories.filter(isRepositoryMetadataRecord).map(
      normalizeRepositoryMetadataRecord,
    );
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
}

export async function writeConfiguredRepositoryMetadata(
  repositories: GitRepositoryMetadataRecord[],
): Promise<void> {
  const database = await configuredDatabase();
  if (database) {
    writeDatabaseRepositoryMetadata(database, repositories);
    return;
  }

  const metadataPath = configuredMetadataPath();
  if (!metadataPath) return;
  await Deno.mkdir(parentDirectory(metadataPath), { recursive: true });
  await Deno.writeFile(
    metadataPath,
    textEncoder.encode(
      `${JSON.stringify({ repositories }, null, 2)}\n`,
    ),
  );
}

export async function readConfiguredRepositoryRecord(
  repositoryId: string,
): Promise<GitRepositoryMetadataRecord | undefined> {
  const database = await configuredDatabase();
  if (database) return readDatabaseRepositoryRecord(database, repositoryId);
  return (await readConfiguredRepositoryMetadata())?.find((repository) =>
    repository.id === repositoryId
  );
}

export async function configuredRepositoryIsActive(
  repositoryId: string,
): Promise<boolean | undefined> {
  const database = await configuredDatabase();
  if (!database && !configuredMetadataPath()) return undefined;
  const record = await readConfiguredRepositoryRecord(repositoryId);
  return record?.state === "active" || !!record && record.state === undefined;
}

export async function writeConfiguredGitRefs(
  repositoryId: string,
  refs: GitRefSummary[],
): Promise<
  | { ok: true }
  | ({ ok: false } & GitJsonError)
> {
  const repository = await readConfiguredGitRepository(repositoryId);
  if (!repository.ok) return repository;
  for (const ref of refs) {
    if (!isSafeRefInput(ref.name) || !isLiteralObjectId(ref.target)) {
      return {
        ok: false,
        status: 400,
        body: {
          error: "refs must contain safe ref names and literal object ids",
          code: "invalid_repository_refs",
          repositoryId,
        },
      };
    }
    const output = await runGit([
      "--git-dir",
      repository.repositoryPath,
      "update-ref",
      ref.name,
      ref.target,
    ]);
    if (!output.success) {
      return {
        ok: false,
        status: 422,
        body: {
          error: "ref target was not found in repository",
          code: "git_ref_target_not_found",
          repositoryId,
          objectId: ref.target,
        },
      };
    }
  }
  return { ok: true };
}

export async function verifyConfiguredGitCommit(
  repositoryId: string,
  objectId: string,
): Promise<{ ok: true; commit: string } | ({ ok: false } & GitJsonError)> {
  const repository = await readConfiguredGitRepository(repositoryId);
  if (!repository.ok) return repository;

  const output = await runGit([
    "--git-dir",
    repository.repositoryPath,
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${objectId}^{commit}`,
  ]);
  if (!output.success) {
    return {
      ok: false,
      status: 422,
      body: {
        error: "literal commit id was not found in repository",
        code: "git_commit_not_found",
        repositoryId,
        objectId,
      },
    };
  }
  return { ok: true, commit: textDecoder.decode(output.stdout).trim() };
}

export async function readConfiguredGitPrettyObject(
  repositoryId: string,
  objectId: string,
): Promise<
  | {
    ok: true;
    objectId: string;
    type: string;
    size: number;
    prettyContent: Uint8Array;
  }
  | ({ ok: false } & GitJsonError)
> {
  const repository = await readConfiguredGitRepository(repositoryId);
  if (!repository.ok) return repository;
  if (!isLiteralObjectId(objectId)) {
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

  const baseArgs = ["--git-dir", repository.repositoryPath] as const;
  const type = await runGit([...baseArgs, "cat-file", "-t", objectId]);
  if (!type.success) return gitObjectNotFound(repositoryId, objectId);
  const size = await runGit([...baseArgs, "cat-file", "-s", objectId]);
  if (!size.success) return gitObjectNotFound(repositoryId, objectId);
  const prettyContent = await runGit([...baseArgs, "cat-file", "-p", objectId]);
  if (!prettyContent.success) return gitObjectNotFound(repositoryId, objectId);
  return {
    ok: true,
    objectId,
    type: textDecoder.decode(type.stdout).trim(),
    size: Number(textDecoder.decode(size.stdout).trim()),
    prettyContent: prettyContent.stdout,
  };
}

export async function readConfiguredGitRawObject(
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
  const repository = await readConfiguredGitRepository(repositoryId);
  if (!repository.ok) return repository;
  if (!isLiteralObjectId(objectId)) {
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

  const baseArgs = ["--git-dir", repository.repositoryPath] as const;
  const type = await runGit([...baseArgs, "cat-file", "-t", objectId]);
  if (!type.success) return gitObjectNotFound(repositoryId, objectId);
  const objectType = textDecoder.decode(type.stdout).trim();
  const size = await runGit([...baseArgs, "cat-file", "-s", objectId]);
  if (!size.success) return gitObjectNotFound(repositoryId, objectId);
  const content = await runGit([
    ...baseArgs,
    "cat-file",
    objectType,
    objectId,
  ]);
  if (!content.success) return gitObjectNotFound(repositoryId, objectId);
  return {
    ok: true,
    objectId,
    type: objectType,
    size: Number(textDecoder.decode(size.stdout).trim()),
    content: content.stdout,
  };
}

export async function createConfiguredPullRequest(
  repositoryId: string,
  request: GitCreatePullRequestRequest,
  actor: TakosActorContext,
): Promise<
  | { ok: true; pullRequest: GitPullRequestDetail }
  | ({ ok: false } & GitJsonError)
> {
  const database = await configuredDatabase();
  if (!database) {
    return {
      ok: false,
      status: 501,
      body: notImplemented("git_pull_request_metadata_not_configured"),
    };
  }
  const repository = await readDatabaseRepositoryRecord(database, repositoryId);
  if (!repository || repository.state === "deleted") {
    return { ok: false, status: 404, body: repositoryNotFound(repositoryId) };
  }

  const duplicate = database.prepare(`
    SELECT id FROM pull_requests
    WHERE repository_id = ? AND head_branch = ? AND base_branch = ? AND status = 'open'
  `).get(repositoryId, request.headBranch, request.baseBranch);
  if (duplicate) {
    return {
      ok: false,
      status: 409,
      body: {
        error: "open pull request already exists for head and base branches",
        code: "git_pull_request_already_exists",
        repositoryId,
      },
    };
  }

  const now = new Date().toISOString();
  const nextNumber = nextPullRequestNumber(database, repositoryId);
  const id = `pr_${crypto.randomUUID()}`;
  database.prepare(`
    INSERT INTO pull_requests (
      id, repository_id, number, title, description, head_branch, base_branch,
      status, author_type, author_id, run_id, merged_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', 'account', ?, ?, NULL, ?, ?)
  `).run(
    id,
    repositoryId,
    nextNumber,
    request.title,
    request.description ?? null,
    request.headBranch,
    request.baseBranch,
    actor.actorAccountId,
    request.runId ?? null,
    now,
    now,
  );
  const pullRequest = readDatabasePullRequestDetailByNumber(
    database,
    repositoryId,
    nextNumber,
  );
  if (!pullRequest) {
    throw new Error("created pull request could not be read back");
  }
  return { ok: true, pullRequest };
}

export async function readConfiguredPullRequests(
  repositoryId: string,
  status?: GitPullRequestStatus,
): Promise<
  | { ok: true; pullRequests: GitPullRequestDetail[] }
  | ({ ok: false } & GitJsonError)
> {
  const database = await configuredDatabase();
  if (!database) {
    return {
      ok: false,
      status: 501,
      body: notImplemented("git_pull_request_metadata_not_configured"),
    };
  }
  const repository = await readDatabaseRepositoryRecord(database, repositoryId);
  if (!repository || repository.state === "deleted") {
    return { ok: false, status: 404, body: repositoryNotFound(repositoryId) };
  }
  const rows = status
    ? database.prepare(`
      SELECT id, repository_id, number, title, description, head_branch,
        base_branch, status, author_id, run_id, merged_at, created_at, updated_at
      FROM pull_requests
      WHERE repository_id = ? AND status = ?
      ORDER BY number DESC
    `).all(repositoryId, status)
    : database.prepare(`
      SELECT id, repository_id, number, title, description, head_branch,
        base_branch, status, author_id, run_id, merged_at, created_at, updated_at
      FROM pull_requests
      WHERE repository_id = ?
      ORDER BY number DESC
    `).all(repositoryId);
  return {
    ok: true,
    pullRequests: rows.map((row) => databasePullRequestDetail(database, row)),
  };
}

export async function readConfiguredPullRequest(
  repositoryId: string,
  number: number,
): Promise<
  | { ok: true; pullRequest: GitPullRequestDetail }
  | ({ ok: false } & GitJsonError)
> {
  const database = await configuredDatabase();
  if (!database) {
    return {
      ok: false,
      status: 501,
      body: notImplemented("git_pull_request_metadata_not_configured"),
    };
  }
  const pullRequest = readDatabasePullRequestDetailByNumber(
    database,
    repositoryId,
    number,
  );
  if (!pullRequest) return pullRequestNotFound(repositoryId, number);
  return { ok: true, pullRequest };
}

export async function updateConfiguredPullRequest(
  repositoryId: string,
  number: number,
  request: GitUpdatePullRequestRequest,
): Promise<
  | { ok: true; pullRequest: GitPullRequestDetail }
  | ({ ok: false } & GitJsonError)
> {
  const database = await configuredDatabase();
  if (!database) {
    return {
      ok: false,
      status: 501,
      body: notImplemented("git_pull_request_metadata_not_configured"),
    };
  }
  const existing = readDatabasePullRequestDetailByNumber(
    database,
    repositoryId,
    number,
  );
  if (!existing) return pullRequestNotFound(repositoryId, number);
  const nextStatus = request.status ?? existing.status;
  const mergedAt = nextStatus === "merged"
    ? existing.mergedAt ?? new Date().toISOString()
    : existing.mergedAt;
  database.prepare(`
    UPDATE pull_requests
    SET title = ?, description = ?, status = ?, merged_at = ?, updated_at = ?
    WHERE repository_id = ? AND number = ?
  `).run(
    request.title ?? existing.title,
    request.description ?? existing.description ?? null,
    nextStatus,
    mergedAt ?? null,
    new Date().toISOString(),
    repositoryId,
    number,
  );
  const pullRequest = readDatabasePullRequestDetailByNumber(
    database,
    repositoryId,
    number,
  );
  if (!pullRequest) return pullRequestNotFound(repositoryId, number);
  return { ok: true, pullRequest };
}

export async function createConfiguredPullRequestComment(
  repositoryId: string,
  number: number,
  request: GitCreatePullRequestCommentRequest,
  actor: TakosActorContext,
): Promise<
  | { ok: true; comment: GitPullRequestComment }
  | ({ ok: false } & GitJsonError)
> {
  const database = await configuredDatabase();
  if (!database) {
    return {
      ok: false,
      status: 501,
      body: notImplemented("git_pull_request_metadata_not_configured"),
    };
  }
  const pullRequest = readDatabasePullRequestRowByNumber(
    database,
    repositoryId,
    number,
  );
  if (!pullRequest) return pullRequestNotFound(repositoryId, number);
  const now = new Date().toISOString();
  const id = `prc_${crypto.randomUUID()}`;
  database.prepare(`
    INSERT INTO pr_comments (
      id, pull_request_id, author_type, author_id, body, path, line, created_at
    ) VALUES (?, ?, 'account', ?, ?, ?, ?, ?)
  `).run(
    id,
    pullRequest.id,
    actor.actorAccountId,
    request.body,
    request.path ?? null,
    request.line ?? null,
    now,
  );
  return {
    ok: true,
    comment: {
      id,
      pullRequestId: pullRequest.id,
      authorAccountId: actor.actorAccountId,
      body: request.body,
      path: request.path,
      line: request.line,
      createdAt: now,
    },
  };
}

export async function createConfiguredPullRequestReview(
  repositoryId: string,
  number: number,
  request: GitCreatePullRequestReviewRequest,
  actor: TakosActorContext,
): Promise<
  | { ok: true; review: GitPullRequestReview }
  | ({ ok: false } & GitJsonError)
> {
  const database = await configuredDatabase();
  if (!database) {
    return {
      ok: false,
      status: 501,
      body: notImplemented("git_pull_request_metadata_not_configured"),
    };
  }
  const pullRequest = readDatabasePullRequestRowByNumber(
    database,
    repositoryId,
    number,
  );
  if (!pullRequest) return pullRequestNotFound(repositoryId, number);
  const now = new Date().toISOString();
  const id = `prr_${crypto.randomUUID()}`;
  database.prepare(`
    INSERT INTO pr_reviews (
      id, pull_request_id, reviewer_type, reviewer_id, status, body, analysis, created_at
    ) VALUES (?, ?, 'account', ?, ?, ?, ?, ?)
  `).run(
    id,
    pullRequest.id,
    actor.actorAccountId,
    request.status,
    request.body ?? null,
    request.analysis ?? null,
    now,
  );
  return {
    ok: true,
    review: {
      id,
      pullRequestId: pullRequest.id,
      reviewerAccountId: actor.actorAccountId,
      status: request.status,
      body: request.body,
      analysis: request.analysis,
      createdAt: now,
    },
  };
}

export async function runGit(
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

export function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

export function repositoryNotFound(repositoryId: string) {
  return {
    error: "repository not found",
    code: "git_repository_not_found",
    repositoryId,
  };
}

export function notImplemented(code: string) {
  return {
    error: "not implemented or not configured in takos-git",
    code,
  };
}

async function readConfiguredGitRepository(
  repositoryId: string,
): Promise<
  | { ok: true; repositoryPath: string }
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
  const active = await configuredRepositoryIsActive(repositoryId);
  if (active === false) {
    return {
      ok: false,
      status: 404,
      body: repositoryNotFound(repositoryId),
    };
  }
  if (!(await directoryExists(repositoryPath))) {
    return {
      ok: false,
      status: 404,
      body: repositoryNotFound(repositoryId),
    };
  }
  return { ok: true, repositoryPath };
}

async function configuredDatabase(): Promise<DatabaseSync | undefined> {
  const path = configuredDatabasePath();
  if (!path) return undefined;
  if (cachedDatabase?.path === path) return cachedDatabase.database;
  cachedDatabase?.database.close();

  await Deno.mkdir(parentDirectory(path), { recursive: true });
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  runSqliteMigrations(database);
  cachedDatabase = { path, database };
  migrateJsonMetadataToDatabase(database);
  return database;
}

function runSqliteMigrations(database: DatabaseSync): void {
  const hasMigration = database.prepare(
    "SELECT 1 FROM schema_migrations WHERE version = ?",
  );
  const insertMigration = database.prepare(
    "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
  );
  for (const migration of SQLITE_MIGRATIONS) {
    if (hasMigration.get(migration.version)) continue;
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(migration.sql);
      insertMigration.run(migration.version, new Date().toISOString());
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}

function migrateJsonMetadataToDatabase(database: DatabaseSync): void {
  const jsonPath = configuredMetadataPath();
  if (!jsonPath || cachedDatabase?.migratedJsonPath === jsonPath) return;
  const existing = database.prepare(
    "SELECT COUNT(*) AS count FROM repositories",
  )
    .get() as { count: number };
  if (existing.count > 0) {
    cachedDatabase = cachedDatabase
      ? { ...cachedDatabase, migratedJsonPath: jsonPath }
      : cachedDatabase;
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Deno.readTextFileSync(jsonPath));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  if (!parsed || typeof parsed !== "object") return;
  const repositories = (parsed as { repositories?: unknown }).repositories;
  if (!Array.isArray(repositories)) return;
  writeDatabaseRepositoryMetadata(
    database,
    repositories.filter(isRepositoryMetadataRecord).map(
      normalizeRepositoryMetadataRecord,
    ),
  );
  cachedDatabase = cachedDatabase
    ? { ...cachedDatabase, migratedJsonPath: jsonPath }
    : cachedDatabase;
}

function readDatabaseRepositoryMetadata(
  database: DatabaseSync,
): GitRepositoryMetadataRecord[] {
  return database.prepare(
    `SELECT id, name, owner_account_id, default_branch, refs_json, state, created_at, updated_at
     FROM repositories
     ORDER BY updated_at DESC, id ASC`,
  ).all().map(databaseRepositoryRecord);
}

function readDatabaseRepositoryRecord(
  database: DatabaseSync,
  repositoryId: string,
): GitRepositoryMetadataRecord | undefined {
  const row = database.prepare(
    `SELECT id, name, owner_account_id, default_branch, refs_json, state, created_at, updated_at
     FROM repositories
     WHERE id = ?`,
  ).get(repositoryId);
  return row ? databaseRepositoryRecord(row) : undefined;
}

function writeDatabaseRepositoryMetadata(
  database: DatabaseSync,
  repositories: GitRepositoryMetadataRecord[],
): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    const activeRows = database.prepare(
      "SELECT id FROM repositories WHERE state = 'active'",
    ).all() as Array<{ id: string }>;
    const nextIds = new Set(repositories.map((repository) => repository.id));
    for (const row of activeRows) {
      if (!nextIds.has(row.id)) {
        database.prepare(
          "UPDATE repositories SET state = 'deleted', updated_at = ? WHERE id = ?",
        ).run(new Date().toISOString(), row.id);
      }
    }
    const upsert = database.prepare(`
      INSERT INTO repositories (
        id, name, owner_account_id, default_branch, refs_json, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        owner_account_id = excluded.owner_account_id,
        default_branch = excluded.default_branch,
        refs_json = excluded.refs_json,
        state = excluded.state,
        updated_at = excluded.updated_at
    `);
    for (const repository of repositories) {
      upsert.run(
        repository.id,
        repository.name,
        repository.ownerSpaceId,
        repository.defaultBranch,
        JSON.stringify(repository.refs),
        repository.state ?? "active",
        repository.createdAt,
        repository.updatedAt,
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function databaseRepositoryRecord(row: unknown): GitRepositoryMetadataRecord {
  const record = row as {
    id: string;
    name: string;
    owner_account_id: string;
    default_branch: string;
    refs_json: string;
    state: GitRepositoryMetadataRecord["state"];
    created_at: string;
    updated_at: string;
  };
  return {
    id: record.id,
    name: record.name,
    ownerSpaceId: record.owner_account_id,
    defaultBranch: record.default_branch,
    refs: parseRefsJson(record.refs_json),
    state: record.state,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

function nextPullRequestNumber(
  database: DatabaseSync,
  repositoryId: string,
): number {
  const row = database.prepare(
    "SELECT COALESCE(MAX(number), 0) + 1 AS next_number FROM pull_requests WHERE repository_id = ?",
  ).get(repositoryId) as { next_number: number };
  return row.next_number;
}

function readDatabasePullRequestDetailByNumber(
  database: DatabaseSync,
  repositoryId: string,
  number: number,
): GitPullRequestDetail | undefined {
  const row = database.prepare(`
    SELECT id, repository_id, number, title, description, head_branch,
      base_branch, status, author_id, run_id, merged_at, created_at, updated_at
    FROM pull_requests
    WHERE repository_id = ? AND number = ?
  `).get(repositoryId, number);
  return row ? databasePullRequestDetail(database, row) : undefined;
}

function readDatabasePullRequestRowByNumber(
  database: DatabaseSync,
  repositoryId: string,
  number: number,
): PullRequestRow | undefined {
  const row = database.prepare(`
    SELECT id, repository_id, number, title, description, head_branch,
      base_branch, status, author_id, run_id, merged_at, created_at, updated_at
    FROM pull_requests
    WHERE repository_id = ? AND number = ?
  `).get(repositoryId, number);
  return row ? pullRequestRow(row) : undefined;
}

function databasePullRequestDetail(
  database: DatabaseSync,
  row: unknown,
): GitPullRequestDetail {
  const pullRequest = pullRequestRow(row);
  const comments = database.prepare(`
    SELECT id, pull_request_id, author_id, body, path, line, created_at
    FROM pr_comments
    WHERE pull_request_id = ?
    ORDER BY created_at ASC, id ASC
  `).all(pullRequest.id).map(databasePullRequestComment);
  const reviews = database.prepare(`
    SELECT id, pull_request_id, reviewer_id, status, body, analysis, created_at
    FROM pr_reviews
    WHERE pull_request_id = ?
    ORDER BY created_at ASC, id ASC
  `).all(pullRequest.id).map(databasePullRequestReview);
  return {
    id: pullRequest.id,
    repositoryId: pullRequest.repositoryId,
    number: pullRequest.number,
    title: pullRequest.title,
    description: pullRequest.description ?? undefined,
    headBranch: pullRequest.headBranch,
    baseBranch: pullRequest.baseBranch,
    status: pullRequest.status,
    authorAccountId: pullRequest.authorId ?? undefined,
    runId: pullRequest.runId ?? undefined,
    mergedAt: pullRequest.mergedAt ?? undefined,
    createdAt: pullRequest.createdAt,
    updatedAt: pullRequest.updatedAt,
    comments,
    reviews,
  };
}

type PullRequestRow = {
  id: string;
  repositoryId: string;
  number: number;
  title: string;
  description?: string;
  headBranch: string;
  baseBranch: string;
  status: GitPullRequestStatus;
  authorId?: string;
  runId?: string;
  mergedAt?: string;
  createdAt: string;
  updatedAt: string;
};

function pullRequestRow(row: unknown): PullRequestRow {
  const record = row as {
    id: string;
    repository_id: string;
    number: number;
    title: string;
    description: string | null;
    head_branch: string;
    base_branch: string;
    status: GitPullRequestStatus;
    author_id: string | null;
    run_id: string | null;
    merged_at: string | null;
    created_at: string;
    updated_at: string;
  };
  return {
    id: record.id,
    repositoryId: record.repository_id,
    number: record.number,
    title: record.title,
    description: record.description ?? undefined,
    headBranch: record.head_branch,
    baseBranch: record.base_branch,
    status: record.status,
    authorId: record.author_id ?? undefined,
    runId: record.run_id ?? undefined,
    mergedAt: record.merged_at ?? undefined,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

function databasePullRequestComment(row: unknown): GitPullRequestComment {
  const record = row as {
    id: string;
    pull_request_id: string;
    author_id: string | null;
    body: string;
    path: string | null;
    line: number | null;
    created_at: string;
  };
  return {
    id: record.id,
    pullRequestId: record.pull_request_id,
    authorAccountId: record.author_id ?? undefined,
    body: record.body,
    path: record.path ?? undefined,
    line: record.line ?? undefined,
    createdAt: record.created_at,
  };
}

function databasePullRequestReview(row: unknown): GitPullRequestReview {
  const record = row as {
    id: string;
    pull_request_id: string;
    reviewer_id: string | null;
    status: GitPullRequestReview["status"];
    body: string | null;
    analysis: string | null;
    created_at: string;
  };
  return {
    id: record.id,
    pullRequestId: record.pull_request_id,
    reviewerAccountId: record.reviewer_id ?? undefined,
    status: record.status,
    body: record.body ?? undefined,
    analysis: record.analysis ?? undefined,
    createdAt: record.created_at,
  };
}

function pullRequestNotFound(
  repositoryId: string,
  pullRequestNumber: number,
): { ok: false } & GitJsonError {
  return {
    ok: false,
    status: 404,
    body: {
      error: "pull request not found",
      code: "git_pull_request_not_found",
      repositoryId,
      pullRequestNumber,
    },
  };
}

function parseRefsJson(value: string): GitRefSummary[] {
  try {
    const refs: unknown = JSON.parse(value);
    if (!Array.isArray(refs)) return [];
    return refs.filter((ref): ref is GitRefSummary =>
      ref && typeof ref === "object" &&
      typeof (ref as GitRefSummary).name === "string" &&
      typeof (ref as GitRefSummary).target === "string"
    );
  } catch {
    return [];
  }
}

function gitObjectNotFound(
  repositoryId: string,
  objectId: string,
): { ok: false } & GitJsonError {
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

async function initializeDefaultBranch(
  repositoryPath: string,
  defaultBranch: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isSafeRefInput(defaultBranch) || defaultBranch.startsWith("refs/")) {
    return { ok: false, error: "invalid default branch" };
  }
  const emptyTree = await runGit([
    "--git-dir",
    repositoryPath,
    "mktree",
  ], new Uint8Array());
  if (!emptyTree.success) {
    return { ok: false, error: "failed to create empty tree" };
  }
  const treeId = textDecoder.decode(emptyTree.stdout).trim();
  const commit = await runGit(
    [
      "--git-dir",
      repositoryPath,
      "commit-tree",
      treeId,
      "-m",
      "Initial commit",
    ],
    undefined,
    INITIAL_COMMIT_ENV,
  );
  if (!commit.success) {
    return { ok: false, error: "failed to create initial commit" };
  }
  const commitId = textDecoder.decode(commit.stdout).trim();
  const ref = `refs/heads/${defaultBranch}`;
  const update = await runGit([
    "--git-dir",
    repositoryPath,
    "update-ref",
    ref,
    commitId,
  ]);
  if (!update.success) {
    return { ok: false, error: "failed to update default branch" };
  }
  const head = await runGit([
    "--git-dir",
    repositoryPath,
    "symbolic-ref",
    "HEAD",
    ref,
  ]);
  if (!head.success) return { ok: false, error: "failed to update HEAD" };
  return { ok: true };
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function removeDirectoryIfExists(path: string): Promise<void> {
  try {
    await Deno.remove(path, { recursive: true });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
}

function parentDirectory(path: string): string {
  const normalized = path.replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return "/";
  return normalized.slice(0, index);
}

function isRepositoryMetadataRecord(
  value: unknown,
): value is GitRepositoryMetadataRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<GitRepositoryMetadataRecord>;
  return typeof record.id === "string" &&
    typeof record.name === "string" &&
    (typeof record.ownerSpaceId === "string" ||
      typeof record.ownerAccountId === "string") &&
    typeof record.defaultBranch === "string" &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string" &&
    Array.isArray(record.refs) &&
    record.refs.every((ref) =>
      ref && typeof ref === "object" &&
      typeof (ref as GitRefSummary).name === "string" &&
      typeof (ref as GitRefSummary).target === "string"
    );
}

function normalizeRepositoryMetadataRecord(
  record: GitRepositoryMetadataRecord,
): GitRepositoryMetadataRecord {
  return {
    ...record,
    ownerSpaceId: record.ownerSpaceId ?? record.ownerAccountId!,
  };
}

function isSafePathSegment(segment: string): boolean {
  return segment.length > 0 &&
    segment !== "." &&
    segment !== ".." &&
    !segment.includes("\\") &&
    /^[A-Za-z0-9._-]+$/.test(segment);
}
