import type { GitRefSummary } from "takos-git-contract";
import {
  configuredRepositoryPath,
  isSafeRepositoryId,
  notImplemented,
  runGit,
} from "./git.ts";
import { textDecoder } from "./response-builders.ts";

// Opt-in escape hatch for tests that need to import / fetch from an
// on-disk bare repository fixture. Production callers must use https://
// or git@ SSH shorthand; this env var is only honored in dev / test.
function devAllowLocalRemoteUrl(): boolean {
  return Deno.env.get("TAKOS_GIT_DEV_ALLOW_LOCAL_REMOTE_URL") === "true";
}

export type RemoteUrlValidationError = {
  ok: false;
  status: 400;
  body: { error: string; code: string; repositoryId?: string };
};

/**
 * Validate that `remoteUrl` uses one of the explicitly allowed transports
 * and does not point at a private/loopback/link-local IP.
 *
 * Allowed forms:
 *   - https://<host>/...
 *   - http://localhost[:port]/... or http://127.0.0.1[:port]/...
 *   - git@<host>:<path> SSH shorthand
 *
 * Rejected forms (all return `unsupported_remote_protocol`):
 *   - file://, ext::, git://, ssh:// (full URL scheme)
 *   - http:// to any host other than localhost / 127.0.0.1
 *   - any other scheme or naked filesystem path
 *
 * In addition, IP literals that resolve to loopback (for non-localhost
 * forms), RFC1918, link-local, multicast, or cloud metadata ranges are
 * rejected as `unsupported_remote_protocol_host`. DNS hostnames are not
 * resolved here — operators must constrain takos-git egress.
 */
export function validateRemoteUrl(
  remoteUrl: string,
  repositoryId?: string,
): { ok: true } | RemoteUrlValidationError {
  if (typeof remoteUrl !== "string" || remoteUrl.length === 0) {
    return remoteUrlError(
      "remoteUrl must be a non-empty string",
      "unsupported_remote_protocol",
      repositoryId,
    );
  }
  if (remoteUrl.startsWith("-")) {
    return remoteUrlError(
      "remoteUrl must not start with '-' (option-flag smuggling)",
      "unsupported_remote_protocol",
      repositoryId,
    );
  }
  // Reject embedded control characters defensively.
  if (/[\r\n\0\t]/.test(remoteUrl)) {
    return remoteUrlError(
      "remoteUrl must not contain control characters",
      "unsupported_remote_protocol",
      repositoryId,
    );
  }

  if (remoteUrl.startsWith("https://")) {
    const host = extractHttpHost(remoteUrl);
    if (host === undefined) {
      return remoteUrlError(
        "https remoteUrl has no host",
        "unsupported_remote_protocol",
        repositoryId,
      );
    }
    if (!isHostAllowed(host)) {
      return remoteUrlError(
        `remoteUrl host is not allowed: ${host}`,
        "unsupported_remote_protocol_host",
        repositoryId,
      );
    }
    return { ok: true };
  }

  if (remoteUrl.startsWith("http://")) {
    const host = extractHttpHost(remoteUrl);
    if (host === undefined) {
      return remoteUrlError(
        "http remoteUrl has no host",
        "unsupported_remote_protocol",
        repositoryId,
      );
    }
    // Only allow plaintext http:// when host is loopback. Production
    // remotes must use https://.
    if (host !== "localhost" && host !== "127.0.0.1") {
      return remoteUrlError(
        `http remoteUrl is only allowed for localhost / 127.0.0.1, got: ${host}`,
        "unsupported_remote_protocol",
        repositoryId,
      );
    }
    return { ok: true };
  }

  if (isSshShorthand(remoteUrl)) {
    const host = extractSshShorthandHost(remoteUrl);
    if (host === undefined) {
      return remoteUrlError(
        "ssh shorthand remoteUrl has no host",
        "unsupported_remote_protocol",
        repositoryId,
      );
    }
    if (!isHostAllowed(host)) {
      return remoteUrlError(
        `remoteUrl host is not allowed: ${host}`,
        "unsupported_remote_protocol_host",
        repositoryId,
      );
    }
    return { ok: true };
  }

  // Dev / test only: accept on-disk fixture paths when explicitly opted in.
  if (devAllowLocalRemoteUrl() && !/^[a-z][a-z0-9+.-]*:/i.test(remoteUrl)) {
    return { ok: true };
  }

  return remoteUrlError(
    "remoteUrl must use https://, http://localhost, http://127.0.0.1, or git@<host>:<path>",
    "unsupported_remote_protocol",
    repositoryId,
  );
}

function remoteUrlError(
  message: string,
  code: string,
  repositoryId?: string,
): RemoteUrlValidationError {
  return {
    ok: false,
    status: 400,
    body: repositoryId === undefined
      ? { error: message, code }
      : { error: message, code, repositoryId },
  };
}

function extractHttpHost(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function isSshShorthand(url: string): boolean {
  // git@host:path form; reject full `ssh://...` URLs explicitly so
  // callers cannot smuggle path traversal through the SSH scheme parser.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return false;
  return /^[A-Za-z0-9_.-]+@([A-Za-z0-9_.:\[\]-]+):/.test(url);
}

function extractSshShorthandHost(url: string): string | undefined {
  const at = url.indexOf("@");
  if (at < 0) return undefined;
  if (url[at + 1] === "[") {
    const closingBracket = url.indexOf("]", at + 2);
    if (closingBracket === -1) return undefined;
    return url.slice(at + 1, closingBracket + 1).toLowerCase();
  }
  const colon = url.indexOf(":", at + 1);
  if (colon < 0) return undefined;
  return url.slice(at + 1, colon).toLowerCase();
}

function isHostAllowed(host: string): boolean {
  const literal = stripIpv6Brackets(host);
  if (isIpv4Literal(literal)) return !isBlockedIpv4(literal);
  if (isIpv6Literal(literal)) return !isBlockedIpv6(literal);
  // DNS hostnames are not resolved here. Operators control egress.
  return true;
}

function stripIpv6Brackets(host: string): string {
  if (host.startsWith("[") && host.endsWith("]")) {
    return host.slice(1, -1);
  }
  return host;
}

function isIpv4Literal(value: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(value);
}

function isIpv6Literal(value: string): boolean {
  return value.includes(":");
}

function isBlockedIpv4(value: string): boolean {
  const parts = value.split(".").map((segment) => Number.parseInt(segment, 10));
  if (
    parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)
  ) {
    return true;
  }
  const [a, b, , d] = parts;
  if (a === 127) return true; // loopback 127.0.0.0/8
  if (a === 10) return true; // RFC1918 10/8
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918 172.16/12
  if (a === 192 && b === 168) return true; // RFC1918 192.168/16
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 0) return true; // 0.0.0.0/8
  if (a >= 224) return true; // multicast / reserved
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 255 && b === 255 && parts[2] === 255 && d === 255) return true;
  return false;
}

function isBlockedIpv6(value: string): boolean {
  const lower = value.toLowerCase();
  if (lower === "::1") return true;
  if (lower === "::") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;
  if (/^fe[89ab][0-9a-f]?:/.test(lower)) return true;
  if (lower.startsWith("ff")) return true;
  const mappedDotted = lower.match(
    /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/,
  );
  if (mappedDotted && isBlockedIpv4(mappedDotted[1])) return true;
  const mappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const reconstructed = reconstructIpv4FromHexPair(
      mappedHex[1],
      mappedHex[2],
    );
    if (reconstructed && isBlockedIpv4(reconstructed)) return true;
  }
  const compatDotted = lower.match(
    /^::(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/,
  );
  if (compatDotted && isBlockedIpv4(compatDotted[1])) return true;
  const compatHex = lower.match(/^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (compatHex) {
    const reconstructed = reconstructIpv4FromHexPair(
      compatHex[1],
      compatHex[2],
    );
    if (reconstructed && isBlockedIpv4(reconstructed)) return true;
  }
  return false;
}

function reconstructIpv4FromHexPair(
  highHex: string,
  lowHex: string,
): string | undefined {
  const high = Number.parseInt(highHex, 16);
  const low = Number.parseInt(lowHex, 16);
  if (
    !Number.isFinite(high) || !Number.isFinite(low) ||
    high < 0 || high > 0xffff || low < 0 || low > 0xffff
  ) {
    return undefined;
  }
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${
    low & 0xff
  }`;
}

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

  const remoteUrlCheck = validateRemoteUrl(input.remoteUrl, input.repositoryId);
  if (!remoteUrlCheck.ok) return remoteUrlCheck;

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
  // Always prepend protocol-allowlist hardening so that even an empty
  // authHeader caller gets the same protections. These -c flags disable
  // git's `ext::` transport helper, generic transport-helper resolution,
  // and (for the `file` scheme) prevent submodule-style indirection from
  // following file:// pointers that we have not explicitly chosen. We
  // keep `file` at `user` rather than `never` so that test fixtures can
  // still operate when TAKOS_GIT_DEV_ALLOW_LOCAL_REMOTE_URL is set.
  const protocolGuards = [
    "-c",
    "protocol.ext.allow=never",
    "-c",
    "protocol.transport-helper.allow=never",
    "-c",
    "protocol.file.allow=user",
  ];
  // Defense in depth: callers should reject control chars via
  // validateExternalImportRequest / validateExternalFetchRequest, but
  // strip CR / LF / NUL again here so a malformed value cannot inject
  // additional HTTP headers via git's `http.extraHeader` mechanism.
  const trimmed = authHeader?.trim();
  if (!trimmed) return protocolGuards;
  const sanitized = trimmed.replace(/[\r\n\0]/g, "");
  if (!sanitized) return protocolGuards;
  return [
    ...protocolGuards,
    "-c",
    `http.extraHeader=Authorization: ${sanitized}`,
  ];
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
