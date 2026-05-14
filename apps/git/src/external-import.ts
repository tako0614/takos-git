import type { GitRefSummary } from "takos-git-contract";
import {
  configuredRepositoryPath,
  isSafeRepositoryId,
  notImplemented,
  runGit,
} from "./git.ts";
import { textDecoder } from "./response-builders.ts";

export async function importExternalRemoteIntoConfiguredRepository(input: {
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

export async function removeConfiguredRepositoryDirectory(
  repositoryId: string,
): Promise<void> {
  const repositoryPath = configuredRepositoryPath(repositoryId);
  if (!repositoryPath) return;
  await Deno.remove(repositoryPath, { recursive: true }).catch(() => {});
}
