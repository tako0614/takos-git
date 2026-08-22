import { describe, expect, test } from "bun:test";
import type {
  CommandResult,
  DeployDependencies,
  ReleaseCandidate,
} from "./deploy";
import { RELEASE_SURFACE, runDeploy } from "./deploy";

const COMMIT = "1234567890abcdef1234567890abcdef12345678";
const TAG_OBJECT = "abcdef1234567890abcdef1234567890abcdef12";
const TAG = "v0.5.2";
const ARTIFACT = new TextEncoder().encode("export default { fetch(){}, scheduled(){} };\n");
const CHECKSUM = new TextEncoder().encode(
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  worker.js\n",
);
const MANIFEST = new TextEncoder().encode('{"kind":"takosumi.worker-artifact@v1"}\n');

interface FakeOptions {
  readonly dirty?: string;
  readonly branch?: string;
  readonly remoteMain?: string;
  readonly localTag?: boolean;
  readonly remoteTag?: boolean;
  readonly githubTag?: boolean;
  readonly githubRelease?: boolean;
  readonly badAsset?: string;
}

function ok(stdout = ""): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function fail(exitCode: number, stderr = ""): CommandResult {
  return { exitCode, stdout: "", stderr };
}

function fakeCandidate(): ReleaseCandidate {
  return {
    directory: "/tmp/takos-git-candidate",
    artifactPath: "/tmp/takos-git-candidate/worker.js",
    checksumPath: "/tmp/takos-git-candidate/worker.js.sha256",
    manifestPath: "/tmp/takos-git-candidate/takosumi-artifact.json",
    artifactBytes: ARTIFACT,
    checksumBytes: CHECKSUM,
    manifestBytes: MANIFEST,
    artifactSha256: "a".repeat(64),
    manifestSha256: "b".repeat(64),
  };
}

function fakeDependencies(options: FakeOptions = {}) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const cleaned: ReleaseCandidate[] = [];
  const probed: Uint8Array[] = [];
  let pushed = false;
  let released = false;
  const candidate = fakeCandidate();
  const assetBytes = new Map<string, Uint8Array>([
    ["worker.js", ARTIFACT],
    ["worker.js.sha256", CHECKSUM],
    ["takosumi-artifact.json", MANIFEST],
  ]);

  const dependencies: DeployDependencies = {
    readVersion: () => "0.5.2",
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    async prepareCandidate(commit, tag) {
      expect(commit).toBe(COMMIT);
      expect(tag).toBe(TAG);
      return candidate;
    },
    async fetchBytes(url) {
      const name = url.split("/").at(-1) ?? "";
      const bytes = assetBytes.get(name);
      if (!bytes) throw new Error(`unexpected asset URL ${url}`);
      if (options.badAsset === name) {
        return new TextEncoder().encode("tampered");
      }
      return bytes;
    },
    async probeWorker(bytes) {
      probed.push(bytes);
    },
    cleanupCandidate(value) {
      cleaned.push(value);
    },
    run(command, args) {
      calls.push({ command, args: [...args] });
      const invocation = `${command} ${args.join(" ")}`;
      if (invocation === "git status --porcelain=v1 --untracked-files=all") {
        return ok(options.dirty ?? "");
      }
      if (invocation === "git symbolic-ref --quiet --short HEAD") {
        return options.branch === "<detached>"
          ? fail(1, "detached")
          : ok(options.branch ?? "main");
      }
      if (invocation === "git rev-parse HEAD") return ok(COMMIT);
      if (invocation === "git ls-remote origin refs/heads/main") {
        return ok(
          `${options.remoteMain ?? COMMIT}\trefs/heads/main\n`,
        );
      }
      if (invocation === `git show-ref --verify --quiet refs/tags/${TAG}`) {
        return options.localTag ? ok() : fail(1);
      }
      if (
        invocation ===
        `git ls-remote --tags origin refs/tags/${TAG} refs/tags/${TAG}^{}`
      ) {
        if (pushed) {
          return ok(
            `${TAG_OBJECT}\trefs/tags/${TAG}\n${COMMIT}\trefs/tags/${TAG}^{}\n`,
          );
        }
        return options.remoteTag
          ? ok(`${TAG_OBJECT}\trefs/tags/${TAG}\n`)
          : ok();
      }
      if (invocation === `gh api repos/tako0614/takos-git/git/ref/tags/${TAG}`) {
        return options.githubTag
          ? ok(JSON.stringify({ ref: `refs/tags/${TAG}` }))
          : fail(1, "gh: Not Found (HTTP 404)");
      }
      if (invocation === `gh release view ${TAG} --repo tako0614/takos-git`) {
        return options.githubRelease
          ? ok(`Takos Git ${TAG}`)
          : fail(1, "release not found");
      }
      if (invocation === "bun run check") return ok();
      if (
        invocation ===
        `git tag --annotate ${TAG} ${COMMIT} --message Takos Git ${TAG}\n\nSource-Commit: ${COMMIT}`
      ) {
        return ok();
      }
      if (invocation === `git rev-parse refs/tags/${TAG}`) return ok(TAG_OBJECT);
      if (invocation === `git cat-file -t refs/tags/${TAG}`) return ok("tag");
      if (invocation === `git rev-parse refs/tags/${TAG}^{}`) return ok(COMMIT);
      if (
        invocation ===
        `git push origin refs/tags/${TAG}:refs/tags/${TAG}`
      ) {
        pushed = true;
        return ok();
      }
      if (invocation.startsWith(`gh release create ${TAG} `)) {
        released = true;
        return ok(`https://github.com/tako0614/takos-git/releases/tag/${TAG}\n`);
      }
      if (
        invocation ===
        `gh release view ${TAG} --repo tako0614/takos-git --json tagName,isDraft,isPrerelease,url,assets`
      ) {
        if (!released) return fail(1, "release not found");
        return ok(
          JSON.stringify({
            tagName: TAG,
            isDraft: false,
            isPrerelease: false,
            url: `https://github.com/tako0614/takos-git/releases/tag/${TAG}`,
            assets: [...assetBytes.entries()].map(([name, bytes]) => ({
              name,
              size: bytes.byteLength,
              url: `https://github.com/tako0614/takos-git/releases/download/${TAG}/${name}`,
            })),
          }),
        );
      }
      return fail(127, `unexpected command: ${invocation}`);
    },
  };
  return { dependencies, calls, stdout, stderr, cleaned, probed };
}

function commandStrings(
  calls: Array<{ command: string; args: string[] }>,
): string[] {
  return calls.map(({ command, args }) => `${command} ${args.join(" ")}`);
}

describe("Takos Git immutable Worker release", () => {
  test("--contract is side-effect free and answers immutable publication obligations", async () => {
    const fake = fakeDependencies();
    expect(await runDeploy(["--contract"], fake.dependencies)).toBe(0);
    expect(fake.calls).toEqual([]);
    expect(fake.cleaned).toEqual([]);
    const contract = JSON.parse(fake.stdout.join("")) as {
      kind: string;
      surfaces: Array<{
        surface: string;
        triggers: string[];
        obligations: Record<string, string>;
      }>;
    };
    expect(contract.kind).toBe("takos.deploy-contract@v2");
    expect(contract.surfaces).toHaveLength(1);
    expect(contract.surfaces[0]?.surface).toBe(RELEASE_SURFACE);
    expect(contract.surfaces[0]?.triggers).toEqual(["published-identity"]);
    expect(Object.keys(contract.surfaces[0]?.obligations ?? {}).sort()).toEqual([
      "failure-handling",
      "no-overwrite",
      "post-conditions",
      "provenance",
      "reversal",
    ]);
  });

  test.each([
    ["dirty source", { dirty: " M package.json" }, "worktree is not clean"],
    ["detached source", { branch: "<detached>" }, "detached HEAD"],
    ["non-main source", { branch: "feature/release" }, "requires main"],
    [
      "unpushed source",
      { remoteMain: "c".repeat(40) },
      "does not equal origin main",
    ],
  ] as const)("%s is blocked before the owner gate", async (_label, options, error) => {
    const fake = fakeDependencies(options);
    expect(await runDeploy([RELEASE_SURFACE], fake.dependencies)).toBe(1);
    expect(fake.stderr.join("")).toContain(error);
    expect(commandStrings(fake.calls)).not.toContain("bun run check");
  });

  test.each([
    ["local tag", { localTag: true }, "local tag"],
    ["remote tag", { remoteTag: true }, "remote tag"],
    ["GitHub tag", { githubTag: true }, "GitHub tag"],
    ["GitHub Release", { githubRelease: true }, "GitHub Release"],
  ] as const)("%s is never overwritten", async (_label, options, error) => {
    const fake = fakeDependencies(options);
    expect(await runDeploy([RELEASE_SURFACE], fake.dependencies)).toBe(1);
    expect(fake.stderr.join("")).toContain(error);
    expect(commandStrings(fake.calls)).not.toContain("bun run check");
  });

  test("default invocation verifies candidate bytes without publishing", async () => {
    const fake = fakeDependencies();
    expect(await runDeploy([RELEASE_SURFACE], fake.dependencies)).toBe(0);
    const calls = commandStrings(fake.calls);
    expect(calls.filter((call) => call === "bun run check")).toHaveLength(1);
    expect(calls.some((call) => call.startsWith("git tag --annotate"))).toBe(false);
    expect(calls.some((call) => call.startsWith("gh release create"))).toBe(false);
    expect(fake.stdout.join("")).toContain('"status": "DRY_RUN_VERIFIED"');
    expect(fake.stdout.join("")).toContain(`"commit": "${COMMIT}"`);
    expect(fake.stdout.join("")).toContain(`"tag": "${TAG}"`);
    expect(fake.cleaned).toHaveLength(1);
  });

  test("--execute publishes once and verifies exact downloaded assets and Worker", async () => {
    const fake = fakeDependencies();
    expect(
      await runDeploy([RELEASE_SURFACE, "--execute"], fake.dependencies),
    ).toBe(0);
    const calls = commandStrings(fake.calls);
    const gate = calls.indexOf("bun run check");
    const tag = calls.findIndex((call) => call.startsWith("git tag --annotate"));
    const push = calls.findIndex((call) => call.startsWith("git push origin"));
    const release = calls.findIndex((call) => call.startsWith("gh release create"));
    expect(tag).toBeGreaterThan(gate);
    expect(push).toBeGreaterThan(tag);
    expect(release).toBeGreaterThan(push);
    expect(calls.join("\n")).not.toMatch(/--force|--clobber|release edit|release delete/u);
    expect(fake.probed).toEqual([ARTIFACT]);
    expect(fake.cleaned).toHaveLength(1);
    expect(fake.stdout.join("")).toContain('"status": "PUBLISHED"');
    expect(fake.stdout.join("")).toContain(
      '"postConditions": "EXACT_TAG_RELEASE_ASSET_AND_WORKER_READBACK"',
    );
  });

  test("asset mismatch is indeterminate and never deletes or overwrites", async () => {
    const fake = fakeDependencies({ badAsset: "worker.js" });
    expect(
      await runDeploy([RELEASE_SURFACE, "--execute"], fake.dependencies),
    ).toBe(1);
    expect(fake.stderr.join("")).toContain("result is indeterminate");
    expect(fake.stderr.join("")).toContain("differs from the reviewed candidate");
    const calls = commandStrings(fake.calls).join("\n");
    expect(calls).not.toMatch(/--force|--clobber|release edit|release delete|tag -d/u);
    expect(fake.cleaned).toHaveLength(1);
  });
});
