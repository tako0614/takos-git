#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const RELEASE_SURFACE = "takos-git-worker-release";

const REPOSITORY = "tako0614/takos-git";
const OWNER_GATE = "bun run check";
const root = resolve(dirname(new URL(import.meta.url).pathname), "..");

const CONTRACT = {
  kind: "takos.deploy-contract@v2",
  surfaces: [
    {
      surface: RELEASE_SURFACE,
      target: `github-release:${REPOSITORY}/v<package-version>`,
      covers: [
        "package.json",
        "release.lock.json",
        "scripts/build-worker.ts",
        "scripts/deploy.ts",
        "src/worker.ts",
        "web",
      ],
      requiresScripts: ["check"],
      requiresTools: ["git", "bun", "gh"],
      requiresEnv: [],
      triggers: ["published-identity"],
      obligations: {
        provenance:
          "refuses a dirty, detached, non-main, or unpushed worktree; runs `bun run check`; revalidates the exact commit and release absence after the gate; publishes the exact dist/worker.js bytes built by that gate; and records the commit plus Worker and manifest SHA-256 digests",
        "post-conditions":
          "reads back the annotated origin tag and GitHub Release, downloads all three immutable release assets, verifies their exact bytes and digests, imports the downloaded Worker, requires fetch and scheduled handlers, and makes a real request to its embedded SPA",
        reversal:
          "never replaces or deletes a release or tag; existing consumers keep their previous immutable release pin, and a defect or partial publication is repaired with a higher SemVer release before a separate reviewed release.lock adoption",
        "failure-handling":
          "prints raw command diagnostics and distinguishes pre-mutation failure from an indeterminate result after local tag creation; it never retries, force-pushes, overwrites an asset, or deletes a partial identity",
        "no-overwrite":
          "proves the local tag, origin tag, GitHub tag ref, and GitHub Release are all absent before and after the owner gate; creates one annotated tag, pushes without force, and creates the release once with no edit, upload, clobber, delete, or mutable-latest path",
      },
    },
  ],
} as const;

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ReleaseCandidate {
  readonly directory: string;
  readonly artifactPath: string;
  readonly checksumPath: string;
  readonly manifestPath: string;
  readonly artifactBytes: Uint8Array;
  readonly checksumBytes: Uint8Array;
  readonly manifestBytes: Uint8Array;
  readonly artifactSha256: string;
  readonly manifestSha256: string;
}

export interface DeployDependencies {
  readVersion(): string;
  run(command: string, args: string[]): CommandResult;
  prepareCandidate(commit: string, tag: string): Promise<ReleaseCandidate>;
  fetchBytes(url: string): Promise<Uint8Array>;
  probeWorker(bytes: Uint8Array): Promise<void>;
  cleanupCandidate(candidate: ReleaseCandidate): void;
  stdout(text: string): void;
  stderr(text: string): void;
}

class DeployBlocked extends Error {
  constructor(
    message: string,
    readonly mutationStarted = false,
  ) {
    super(message);
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && Buffer.compare(left, right) === 0;
}

async function probeWorkerFile(path: string): Promise<void> {
  const built = await import(
    `${pathToFileURL(path).href}?release-probe=${Date.now()}`
  );
  const worker = built.default as
    | {
        fetch?: (request: Request, env: object) => Promise<Response>;
        scheduled?: (...args: unknown[]) => Promise<void>;
      }
    | undefined;
  if (typeof worker?.fetch !== "function") {
    throw new DeployBlocked("the release Worker does not export fetch");
  }
  if (typeof worker.scheduled !== "function") {
    throw new DeployBlocked("the release Worker does not export scheduled");
  }
  const response = await worker.fetch(new Request("https://takos-git.invalid/"), {});
  if (response.status !== 200) {
    throw new DeployBlocked(
      `the release Worker embedded-SPA probe returned ${response.status}`,
    );
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("text/html")) {
    throw new DeployBlocked(
      `the release Worker embedded-SPA probe returned ${contentType || "no content type"}`,
    );
  }
}

function defaultDependencies(): DeployDependencies {
  return {
    readVersion() {
      const parsed = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
        version?: unknown;
      };
      return String(parsed.version ?? "");
    },
    run(command, args) {
      const result = spawnSync(command, args, {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return {
        exitCode: result.status ?? 1,
        stdout: result.stdout ?? "",
        stderr:
          (result.stderr ?? "") +
          (result.error ? `${result.error.message}\n` : ""),
      };
    },
    async prepareCandidate(commit, tag) {
      const source = resolve(root, "dist/worker.js");
      const artifactBytes = new Uint8Array(readFileSync(source));
      await probeWorkerFile(source);
      const artifactSha256 = sha256(artifactBytes);
      const directory = mkdtempSync(join(tmpdir(), "takos-git-release-"));
      const artifactPath = join(directory, "worker.js");
      const checksumPath = join(directory, "worker.js.sha256");
      const manifestPath = join(directory, "takosumi-artifact.json");
      copyFileSync(source, artifactPath);
      const checksumBytes = new TextEncoder().encode(
        `${artifactSha256}  worker.js\n`,
      );
      writeFileSync(checksumPath, checksumBytes);
      const artifactUrl = `https://github.com/${REPOSITORY}/releases/download/${tag}/worker.js`;
      const manifestUrl = `https://github.com/${REPOSITORY}/releases/download/${tag}/takosumi-artifact.json`;
      const manifestBytes = new TextEncoder().encode(
        `${JSON.stringify(
          {
            kind: "takosumi.worker-artifact@v1",
            app: "takos-git",
            commit,
            ref: tag,
            releaseTag: tag,
            handlers: ["fetch", "queue", "scheduled"],
            artifact: {
              filename: "worker.js",
              url: artifactUrl,
              sha256: artifactSha256,
              sha256Prefixed: `sha256:${artifactSha256}`,
              contentType: "application/javascript",
            },
            manifestUrl,
          },
          null,
          2,
        )}\n`,
      );
      writeFileSync(manifestPath, manifestBytes);
      return {
        directory,
        artifactPath,
        checksumPath,
        manifestPath,
        artifactBytes,
        checksumBytes,
        manifestBytes,
        artifactSha256,
        manifestSha256: sha256(manifestBytes),
      };
    },
    async fetchBytes(url) {
      const response = await fetch(url, {
        headers: { "cache-control": "no-cache" },
        redirect: "follow",
      });
      if (!response.ok) {
        throw new DeployBlocked(
          `published asset ${url} responded ${response.status}`,
          true,
        );
      }
      return new Uint8Array(await response.arrayBuffer());
    },
    async probeWorker(bytes) {
      const directory = mkdtempSync(join(tmpdir(), "takos-git-readback-"));
      const path = join(directory, "worker.mjs");
      try {
        writeFileSync(path, bytes);
        await probeWorkerFile(path);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    cleanupCandidate(candidate) {
      rmSync(candidate.directory, { recursive: true, force: true });
    },
    stdout(text) {
      process.stdout.write(text);
    },
    stderr(text) {
      process.stderr.write(text);
    },
  };
}

function outputJson(
  dependencies: DeployDependencies,
  value: Record<string, unknown>,
): void {
  dependencies.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

function commandDetail(result: CommandResult): string {
  return [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
}

function requireSuccess(
  dependencies: DeployDependencies,
  command: string,
  args: string[],
  label: string,
  mutationStarted = false,
): string {
  const result = dependencies.run(command, args);
  if (result.exitCode !== 0) {
    const detail = commandDetail(result);
    throw new DeployBlocked(
      `${label} failed${detail ? `:\n${detail}` : ""}`,
      mutationStarted,
    );
  }
  return result.stdout.trim();
}

function semverTag(version: string): string {
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(version)) {
    throw new DeployBlocked(
      `package.json version ${JSON.stringify(version)} must be a stable SemVer`,
    );
  }
  return `v${version}`;
}

function parseRemoteRef(output: string, ref: string): string {
  for (const line of output.split(/\r?\n/u)) {
    const [sha, name] = line.trim().split(/\s+/u);
    if (name === ref && sha) return sha;
  }
  return "";
}

function requireSourceIdentity(dependencies: DeployDependencies): string {
  const status = requireSuccess(
    dependencies,
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    "cannot inspect the worktree",
  );
  if (status !== "") {
    throw new DeployBlocked(
      `the worktree is not clean; release bytes must belong to one commit:\n${status}`,
    );
  }
  const branch = requireSuccess(
    dependencies,
    "git",
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    "release publication refuses detached HEAD",
  );
  if (branch !== "main") {
    throw new DeployBlocked(`release publication requires main, found ${branch}`);
  }
  const commit = requireSuccess(
    dependencies,
    "git",
    ["rev-parse", "HEAD"],
    "cannot resolve HEAD",
  );
  if (!/^[a-f0-9]{40,64}$/u.test(commit)) {
    throw new DeployBlocked(`HEAD resolved to an invalid commit id: ${commit}`);
  }
  const remote = requireSuccess(
    dependencies,
    "git",
    ["ls-remote", "origin", "refs/heads/main"],
    "cannot read origin main",
  );
  const remoteCommit = parseRemoteRef(remote, "refs/heads/main");
  if (remoteCommit !== commit) {
    throw new DeployBlocked(
      `local main ${commit} does not equal origin main ${remoteCommit || "<missing>"}`,
    );
  }
  return commit;
}

function requireNotFound(result: CommandResult, label: string): void {
  if (result.exitCode === 0) throw new DeployBlocked(`${label} already exists`);
  const detail = commandDetail(result);
  if (!/(?:HTTP\s+404|Not Found|release not found)/iu.test(detail)) {
    throw new DeployBlocked(
      `cannot prove ${label} is absent${detail ? `:\n${detail}` : ""}`,
    );
  }
}

function requireNoExistingIdentity(
  dependencies: DeployDependencies,
  tag: string,
): void {
  const local = dependencies.run("git", [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/tags/${tag}`,
  ]);
  if (local.exitCode === 0) throw new DeployBlocked(`local tag ${tag} already exists`);
  if (local.exitCode !== 1) {
    throw new DeployBlocked(
      `cannot prove local tag ${tag} is absent${commandDetail(local) ? `:\n${commandDetail(local)}` : ""}`,
    );
  }
  const remote = requireSuccess(
    dependencies,
    "git",
    [
      "ls-remote",
      "--tags",
      "origin",
      `refs/tags/${tag}`,
      `refs/tags/${tag}^{}`,
    ],
    `cannot inspect origin tag ${tag}`,
  );
  if (remote !== "") throw new DeployBlocked(`remote tag ${tag} already exists`);
  requireNotFound(
    dependencies.run("gh", ["api", `repos/${REPOSITORY}/git/ref/tags/${tag}`]),
    `GitHub tag ${tag}`,
  );
  requireNotFound(
    dependencies.run("gh", ["release", "view", tag, "--repo", REPOSITORY]),
    `GitHub Release ${tag}`,
  );
}

function createTag(
  dependencies: DeployDependencies,
  commit: string,
  tag: string,
): string {
  requireSuccess(
    dependencies,
    "git",
    [
      "tag",
      "--annotate",
      tag,
      commit,
      "--message",
      `Takos Git ${tag}\n\nSource-Commit: ${commit}`,
    ],
    `cannot create local annotated tag ${tag}`,
    true,
  );
  const tagObject = requireSuccess(
    dependencies,
    "git",
    ["rev-parse", `refs/tags/${tag}`],
    `cannot resolve local tag ${tag}`,
    true,
  );
  const type = requireSuccess(
    dependencies,
    "git",
    ["cat-file", "-t", `refs/tags/${tag}`],
    `cannot inspect local tag ${tag}`,
    true,
  );
  const peeled = requireSuccess(
    dependencies,
    "git",
    ["rev-parse", `refs/tags/${tag}^{}`],
    `cannot peel local tag ${tag}`,
    true,
  );
  if (type !== "tag" || peeled !== commit) {
    throw new DeployBlocked(
      `local annotated tag ${tag} does not resolve exactly to ${commit}`,
      true,
    );
  }
  requireSuccess(
    dependencies,
    "git",
    ["push", "origin", `refs/tags/${tag}:refs/tags/${tag}`],
    `push of ${tag} did not complete cleanly`,
    true,
  );
  return tagObject;
}

function verifyRemoteTag(
  dependencies: DeployDependencies,
  commit: string,
  tag: string,
  tagObject: string,
): void {
  const remote = requireSuccess(
    dependencies,
    "git",
    [
      "ls-remote",
      "--tags",
      "origin",
      `refs/tags/${tag}`,
      `refs/tags/${tag}^{}`,
    ],
    `cannot read origin tag ${tag}`,
    true,
  );
  if (
    parseRemoteRef(remote, `refs/tags/${tag}`) !== tagObject ||
    parseRemoteRef(remote, `refs/tags/${tag}^{}`) !== commit
  ) {
    throw new DeployBlocked(
      `origin tag ${tag} does not match object ${tagObject} and commit ${commit}`,
      true,
    );
  }
}

interface ReleaseAssetReadback {
  readonly name: string;
  readonly size: number;
  readonly url: string;
}

interface ReleaseReadback {
  readonly tagName?: unknown;
  readonly isDraft?: unknown;
  readonly isPrerelease?: unknown;
  readonly url?: unknown;
  readonly assets?: unknown;
}

function parseReleaseReadback(source: string, tag: string): {
  readonly url: string;
  readonly assets: readonly ReleaseAssetReadback[];
} {
  let decoded: ReleaseReadback;
  try {
    decoded = JSON.parse(source) as ReleaseReadback;
  } catch {
    throw new DeployBlocked("GitHub Release readback was not JSON", true);
  }
  if (
    decoded.tagName !== tag ||
    decoded.isDraft !== false ||
    decoded.isPrerelease !== false ||
    typeof decoded.url !== "string" ||
    !Array.isArray(decoded.assets)
  ) {
    throw new DeployBlocked(
      `GitHub Release ${tag} did not resolve as one published stable release`,
      true,
    );
  }
  const assets: ReleaseAssetReadback[] = [];
  for (const candidate of decoded.assets) {
    const asset = candidate as { name?: unknown; size?: unknown; url?: unknown };
    if (
      typeof asset.name !== "string" ||
      typeof asset.size !== "number" ||
      typeof asset.url !== "string"
    ) {
      throw new DeployBlocked(`GitHub Release ${tag} has a malformed asset`, true);
    }
    assets.push({ name: asset.name, size: asset.size, url: asset.url });
  }
  return { url: decoded.url, assets };
}

async function verifyReleaseAssets(
  dependencies: DeployDependencies,
  candidate: ReleaseCandidate,
  tag: string,
): Promise<string> {
  const source = requireSuccess(
    dependencies,
    "gh",
    [
      "release",
      "view",
      tag,
      "--repo",
      REPOSITORY,
      "--json",
      "tagName,isDraft,isPrerelease,url,assets",
    ],
    `cannot read GitHub Release ${tag}`,
    true,
  );
  const release = parseReleaseReadback(source, tag);
  const expected = new Map<string, Uint8Array>([
    ["worker.js", candidate.artifactBytes],
    ["worker.js.sha256", candidate.checksumBytes],
    ["takosumi-artifact.json", candidate.manifestBytes],
  ]);
  if (release.assets.length !== expected.size) {
    throw new DeployBlocked(
      `GitHub Release ${tag} has ${release.assets.length} assets, expected ${expected.size}`,
      true,
    );
  }
  for (const asset of release.assets) {
    const expectedBytes = expected.get(asset.name);
    if (!expectedBytes) {
      throw new DeployBlocked(
        `GitHub Release ${tag} contains unexpected asset ${asset.name}`,
        true,
      );
    }
    if (asset.size !== expectedBytes.byteLength) {
      throw new DeployBlocked(
        `GitHub Release ${tag} asset ${asset.name} has size ${asset.size}, expected ${expectedBytes.byteLength}`,
        true,
      );
    }
    const downloaded = await dependencies.fetchBytes(asset.url);
    if (!bytesEqual(downloaded, expectedBytes)) {
      throw new DeployBlocked(
        `GitHub Release ${tag} asset ${asset.name} differs from the reviewed candidate`,
        true,
      );
    }
    if (asset.name === "worker.js") await dependencies.probeWorker(downloaded);
  }
  return release.url;
}

export async function runDeploy(
  argv: readonly string[],
  dependencies: DeployDependencies = defaultDependencies(),
): Promise<number> {
  if (argv.includes("--contract")) {
    outputJson(dependencies, CONTRACT as unknown as Record<string, unknown>);
    return 0;
  }
  const requested = argv.filter((argument) => !argument.startsWith("--"));
  if (requested.length !== 1 || requested[0] !== RELEASE_SURFACE) {
    dependencies.stderr(
      `usage: bun run deploy -- ${RELEASE_SURFACE} [--execute]\n`,
    );
    return 1;
  }
  const execute = argv.includes("--execute");
  let candidate: ReleaseCandidate | undefined;
  let mutationStarted = false;
  try {
    const tag = semverTag(dependencies.readVersion());
    const firstCommit = requireSourceIdentity(dependencies);
    requireNoExistingIdentity(dependencies, tag);

    dependencies.stdout(`\n==> ${OWNER_GATE}\n`);
    const gate = dependencies.run("bun", ["run", "check"]);
    if (gate.stdout) dependencies.stdout(gate.stdout);
    if (gate.stderr) dependencies.stderr(gate.stderr);
    if (gate.exitCode !== 0) throw new DeployBlocked(`${OWNER_GATE} failed`);

    const commit = requireSourceIdentity(dependencies);
    if (commit !== firstCommit) {
      throw new DeployBlocked(
        `source commit changed during the owner gate: ${firstCommit} -> ${commit}`,
      );
    }
    requireNoExistingIdentity(dependencies, tag);
    candidate = await dependencies.prepareCandidate(commit, tag);
    dependencies.stdout(
      `candidate ${tag} worker sha256:${candidate.artifactSha256} manifest sha256:${candidate.manifestSha256}\n`,
    );

    if (!execute) {
      outputJson(dependencies, {
        kind: "takos.deploy-result@v1",
        surface: RELEASE_SURFACE,
        target: `github-release:${REPOSITORY}/${tag}`,
        commit,
        tag,
        artifactSha256: `sha256:${candidate.artifactSha256}`,
        manifestSha256: `sha256:${candidate.manifestSha256}`,
        status: "DRY_RUN_VERIFIED",
      });
      return 0;
    }

    mutationStarted = true;
    const tagObject = createTag(dependencies, commit, tag);
    verifyRemoteTag(dependencies, commit, tag, tagObject);
    requireSuccess(
      dependencies,
      "gh",
      [
        "release",
        "create",
        tag,
        candidate.artifactPath,
        candidate.checksumPath,
        candidate.manifestPath,
        "--repo",
        REPOSITORY,
        "--verify-tag",
        "--title",
        `Takos Git ${tag}`,
        "--notes",
        `Immutable Takos Git Worker release from ${commit}.`,
      ],
      `cannot create GitHub Release ${tag}`,
      true,
    );
    const releaseUrl = await verifyReleaseAssets(
      dependencies,
      candidate,
      tag,
    );
    outputJson(dependencies, {
      kind: "takos.deploy-result@v1",
      surface: RELEASE_SURFACE,
      target: `github-release:${REPOSITORY}/${tag}`,
      commit,
      tag,
      tagObject,
      releaseUrl,
      artifactSha256: `sha256:${candidate.artifactSha256}`,
      manifestSha256: `sha256:${candidate.manifestSha256}`,
      postConditions: "EXACT_TAG_RELEASE_ASSET_AND_WORKER_READBACK",
      status: "PUBLISHED",
    });
    return 0;
  } catch (error) {
    const blocked =
      error instanceof DeployBlocked
        ? error
        : new DeployBlocked(
            error instanceof Error ? error.message : String(error),
            mutationStarted,
          );
    const afterMutation = mutationStarted || blocked.mutationStarted;
    dependencies.stderr(
      `deploy blocked ${afterMutation ? "after publication started; result is indeterminate" : "before publication; production is untouched"}: ${blocked.message}\n`,
    );
    return 1;
  } finally {
    if (candidate) dependencies.cleanupCandidate(candidate);
  }
}

if (import.meta.main) {
  process.exit(await runDeploy(process.argv.slice(2)));
}
