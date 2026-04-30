import type { GitRefSummary } from "takos-git-contract";

const textDecoder = new TextDecoder();

export type GitJsonError = {
  body: {
    error: string;
    code: string;
    repositoryId?: string;
    objectId?: string;
  };
  status: 400 | 404 | 422 | 501;
};

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

export function configuredRepositoryRoot(): string | undefined {
  const root = Deno.env.get("TAKOS_GIT_REPOSITORY_ROOT")?.trim();
  if (!root) return undefined;
  return root.replace(/\/+$/, "") || "/";
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
  if (!(await directoryExists(repositoryPath))) {
    return {
      ok: false,
      status: 404,
      body: repositoryNotFound(repositoryId),
    };
  }
  return { ok: true, repositoryPath };
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

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

function isSafePathSegment(segment: string): boolean {
  return segment.length > 0 &&
    segment !== "." &&
    segment !== ".." &&
    !segment.includes("\\") &&
    /^[A-Za-z0-9._-]+$/.test(segment);
}
