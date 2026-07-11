import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import worker, { type Env } from "./worker.ts";
import { MemoryBucket } from "./test-bucket.ts";
import { seedRepo } from "./seed.ts";
import { mintGitToken } from "./git-token.ts";

const SIGNING_KEY = "git-clone-e2e-signing-key-000";
const REPO = "acme/widgets";
const FILE_CONTENT = "hello from the standalone takos-git service\n";

function gitAvailable(): boolean {
  try {
    return Bun.spawnSync(["git", "--version"]).exitCode === 0;
  } catch {
    return false;
  }
}

async function runGit(
  args: string[],
  options: { cwd?: string } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const process = Bun.spawn(["git", ...args], {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: { ...globalThis.process.env, GIT_TERMINAL_PROMPT: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test("real `git clone` works end-to-end against the standalone worker", async () => {
  if (!gitAvailable()) {
    console.warn("git binary not available — skipping real clone E2E");
    return;
  }

  const bucket = new MemoryBucket();
  const seeded = await seedRepo(bucket, { repo: REPO, content: FILE_CONTENT, fileName: "README.md" });

  const token = await mintGitToken(SIGNING_KEY, {
    v: 1,
    ws: "space_e2e",
    sub: "inst_e2e",
    pfx: REPO,
    cap: ["r"],
    aud: "source.git.smart_http",
    iat: Math.floor(Date.now() / 1000),
  });

  const env: Env = { BUCKET: bucket, GIT_TOKEN_SIGNING_KEY: SIGNING_KEY };
  const server = Bun.serve({ port: 0, fetch: (request) => worker.fetch(request, env) });
  const dir = mkdtempSync(join(tmpdir(), "takos-git-clone-"));

  try {
    // git sends the token as the HTTP Basic password (username ignored).
    const cloneUrl = `http://x:${token}@127.0.0.1:${server.port}/git/${REPO}.git`;
    const clone = Bun.spawn(
      ["git", "-c", "protocol.version=1", "clone", "-q", cloneUrl, dir],
      { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, stdout: "pipe", stderr: "pipe" },
    );
    const exitCode = await clone.exited;
    const stderr = await new Response(clone.stderr).text();
    expect(exitCode, `git clone failed: ${stderr}`).toBe(0);

    // The working tree came through intact...
    expect(readFileSync(join(dir, "README.md"), "utf8")).toBe(FILE_CONTENT);

    // ...and points at the exact commit we seeded.
    const revParse = Bun.spawnSync(["git", "-C", dir, "rev-parse", "HEAD"]);
    expect(new TextDecoder().decode(revParse.stdout).trim()).toBe(seeded.commitSha);
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test("git clone is refused without a valid token", async () => {
  if (!gitAvailable()) return;
  const bucket = new MemoryBucket();
  await seedRepo(bucket, { repo: REPO, content: FILE_CONTENT });
  const env: Env = { BUCKET: bucket, GIT_TOKEN_SIGNING_KEY: SIGNING_KEY };
  const server = Bun.serve({ port: 0, fetch: (request) => worker.fetch(request, env) });
  const dir = mkdtempSync(join(tmpdir(), "takos-git-noauth-"));
  try {
    const clone = Bun.spawn(
      ["git", "-c", "protocol.version=1", "clone", "-q", `http://x:bad@127.0.0.1:${server.port}/git/${REPO}.git`, dir],
      { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, stdout: "pipe", stderr: "pipe" },
    );
    expect(await clone.exited).not.toBe(0);
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test("real Git CLI can push, fast-forward, and reclone while force-push is rejected", async () => {
  if (!gitAvailable()) {
    console.warn("git binary not available — skipping push/reclone E2E");
    return;
  }

  const bucket = new MemoryBucket();
  const token = await mintGitToken(SIGNING_KEY, {
    v: 1,
    ws: "workspace_e2e",
    sub: "consumer_e2e",
    pfx: REPO,
    cap: ["r", "w"],
    aud: "source.git.smart_http",
    iat: Math.floor(Date.now() / 1000),
  });
  const env: Env = { BUCKET: bucket, GIT_TOKEN_SIGNING_KEY: SIGNING_KEY };
  const created = await worker.fetch(
    new Request("https://git.example/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "git_repo_create", arguments: { repo: REPO } },
      }),
    }),
    env,
  );
  expect(created.status).toBe(200);
  expect(await created.text()).not.toContain('"error"');

  const server = Bun.serve({ port: 0, fetch: (request) => worker.fetch(request, env) });
  const root = mkdtempSync(join(tmpdir(), "takos-git-push-"));
  const source = join(root, "source");
  const clone = join(root, "clone");
  mkdirSync(source);

  try {
    const remote = `http://x:${token}@127.0.0.1:${server.port}/git/${REPO}.git`;
    expect((await runGit(["init", "-q", "-b", "main"], { cwd: source })).exitCode).toBe(0);
    await runGit(["config", "user.name", "Takos Git Test"], { cwd: source });
    await runGit(["config", "user.email", "git-test@takos.test"], { cwd: source });
    writeFileSync(join(source, "README.md"), "first\n");
    await runGit(["add", "README.md"], { cwd: source });
    await runGit(["commit", "-q", "-m", "first"], { cwd: source });
    await runGit(["remote", "add", "origin", remote], { cwd: source });

    const initialPush = await runGit(["push", "-q", "-u", "origin", "main"], { cwd: source });
    expect(initialPush.exitCode, initialPush.stderr).toBe(0);

    writeFileSync(join(source, "README.md"), "second\n");
    await runGit(["add", "README.md"], { cwd: source });
    await runGit(["commit", "-q", "-m", "second"], { cwd: source });
    const fastForward = await runGit(["push", "-q", "origin", "main"], { cwd: source });
    expect(fastForward.exitCode, fastForward.stderr).toBe(0);

    const remoteTip = (await runGit(["rev-parse", "HEAD"], { cwd: source })).stdout.trim();
    const reclone = await runGit(["-c", "protocol.version=1", "clone", "-q", remote, clone]);
    expect(reclone.exitCode, reclone.stderr).toBe(0);
    expect(readFileSync(join(clone, "README.md"), "utf8")).toBe("second\n");
    expect((await runGit(["rev-parse", "HEAD"], { cwd: clone })).stdout.trim()).toBe(remoteTip);

    await runGit(["reset", "--hard", "HEAD~1"], { cwd: source });
    const force = await runGit(["push", "--force", "origin", "main"], { cwd: source });
    expect(force.exitCode).not.toBe(0);
    expect(force.stderr).toContain("non-fast-forward branch update");
  } finally {
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
